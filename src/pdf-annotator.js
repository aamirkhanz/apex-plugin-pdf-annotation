/*
 * PDF Annotation region plug-in for Oracle APEX (TechRevX, www.techrevx.com)
 *
 * techrevx.pdfAnnotator.init( regionId ) is called by the render procedure. It reads the settings, the document
 * and the saved annotations from #<regionId>_annotations and builds the annotator in #<regionId>_annotator.
 *
 * Pages are drawn with PDF.js (canvas + text layer); every page has an SVG layer whose viewBox is the page at
 * scale 1, so annotations are stored in page units and stay in place at any zoom.
 *
 * Annotation JSON: { version: 1, annotations: [ { id, type, page, color, width, author, created, comment, ...geometry } ] }
 *   highlight: rects [ [ x, y, w, h ], ... ]     pen: points [ [ x, y ], ... ]
 *   rectangle / ellipse / line / arrow: x1, y1, x2, y2     text: x, y, text, size     note: x, y     stamp: x, y, text
 *
 * apex.region( id ).getAnnotations() / setAnnotations( json ) / save() / exportPdf()
 * Events on the region: tx-pdfannot-change { count }, tx-pdfannot-save { count }.
 */
( function( $, apex ) {
    "use strict";

    const ns = window.techrevx = window.techrevx || {},
        SVGNS = "http://www.w3.org/2000/svg";
    let pdfjsPromise = null, pdfLibPromise = null;

    const esc = v => apex.util.escapeHTML( v === null || v === undefined ? "" : String( v ) );
    const has = ( list, flag ) => String( list || "" ).split( ":" ).indexOf( flag ) > -1;
    const uid = () => "a" + Date.now().toString( 36 ) + Math.random().toString( 36 ).substr( 2, 6 );
    const abs = url => new URL( url, document.baseURI ).href;

    const TOOLS = {
        select: [ "fa-mouse-pointer", "Select, move and delete" ],
        highlight: [ "fa-paint-brush", "Highlight text (or drag an area on scanned pages)" ],
        pen: [ "fa-pencil", "Pen" ],
        rectangle: [ "fa-square-o", "Rectangle" ],
        ellipse: [ "fa-circle-o", "Ellipse" ],
        arrow: [ "fa-long-arrow-right", "Arrow" ],
        line: [ "fa-minus", "Line" ],
        text: [ "fa-font", "Text box" ],
        note: [ "fa-sticky-note-o", "Sticky note" ],
        stamp: [ "fa-certificate", "Stamp" ],
        eraser: [ "fa-eraser", "Eraser: click an annotation to remove it" ]
    };
    const TYPE_NAMES = { highlight: "Highlight", pen: "Drawing", rectangle: "Rectangle", ellipse: "Ellipse", arrow: "Arrow",
                         line: "Line", text: "Text", note: "Note", stamp: "Stamp" };

    function loadPdfjs( prefix ) {
        if ( !pdfjsPromise ) {
            const base = abs( prefix );
            pdfjsPromise = import( base + "pdf.min.mjs" ).then( lib => {
                lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
                return lib;
            } );
        }
        return pdfjsPromise;
    }

    // pdf-lib is only needed for Export PDF; loaded on first use
    function loadPdfLib( prefix ) {
        if ( !pdfLibPromise ) {
            pdfLibPromise = new Promise( ( resolve, reject ) => {
                if ( window.PDFLib ) { return resolve( window.PDFLib ); }
                const s = document.createElement( "script" );
                s.src = abs( prefix ) + "pdf-lib.min.js";
                s.onload = () => resolve( window.PDFLib );
                s.onerror = reject;
                document.head.appendChild( s );
            } );
        }
        return pdfLibPromise;
    }

    // stamp color from its text: approvals green, rejections red, everything else blue
    function stampColor( text ) {
        const t = String( text || "" ).toLowerCase();
        if ( /approv|accept|paid|done|ok/.test( t ) ) { return "#2b8a3e"; }
        if ( /reject|declin|void|denied|confidential/.test( t ) ) { return "#c92a2a"; }
        return "#1c7ed6";
    }

    function hexRgb( hex ) {
        const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec( String( hex ).trim() );
        if ( !m ) { return [ 0.12, 0.14, 0.2 ]; }
        let h = m[ 1 ];
        if ( h.length === 3 ) { h = h.replace( /./g, "$&$&" ); }
        return [ 0, 2, 4 ].map( i => parseInt( h.substr( i, 2 ), 16 ) / 255 );
    }

    const pathOf = points => points.map( ( p, i ) => ( i ? "L" : "M" ) + p[ 0 ].toFixed( 1 ) + " " + p[ 1 ].toFixed( 1 ) ).join( " " );

    function svgEl( tag, attrs, parent ) {
        const el = document.createElementNS( SVGNS, tag );
        Object.keys( attrs || {} ).forEach( k => { if ( attrs[ k ] !== undefined && attrs[ k ] !== null ) { el.setAttribute( k, attrs[ k ] ); } } );
        if ( parent ) { parent.appendChild( el ); }
        return el;
    }

    function timeText( iso ) {
        const d = new Date( iso );
        return isNaN( d ) ? "" : d.toLocaleString( ( apex.locale && apex.locale.getLanguage && apex.locale.getLanguage() ) || undefined,
            { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } );
    }

    class Annotator {
        constructor( regionId ) {
            this.regionId = regionId;
            this.el = document.getElementById( regionId + "_annotator" );
            this.cfg = JSON.parse( document.getElementById( regionId + "_annotations" ).textContent );
            this.doc = this.cfg.document;
            this.readOnly = this.cfg.mode === "review";
            this.colors = String( this.cfg.colors || "#ffd400" ).split( "," ).map( c => c.trim() ).filter( Boolean );
            this.stamps = String( this.cfg.stamps || "" ).split( "," ).map( s => s.trim() ).filter( Boolean );
            this.color = this.colors[ 0 ];
            this.width = 3;
            this.stamp = this.stamps[ 0 ] || "Approved";
            this.tool = this.readOnly ? "select" : ( has( this.cfg.tools, "highlight" ) ? "highlight" : "select" );
            this.annotations = this.parse( this.cfg.annotations );
            this.history = [ JSON.stringify( this.annotations ) ];
            this.future = [];
            this.dirty = false;
            this.selected = null;
            this.scale = 1;
            this.pages = [];
            this.build();
            if ( !this.doc ) {
                this.stage.innerHTML = "<div class=\"tx-PdfAnnot-message\">" + esc( this.cfg.noDataFound || "No document found." ) + "</div>";
                return;
            }
            this.open();
        }

        parse( json ) {
            if ( !json ) { return []; }
            try {
                const data = typeof json === "string" ? JSON.parse( json ) : json;
                const list = Array.isArray( data ) ? data : data.annotations || [];
                return list.filter( a => a && a.type && a.page );
            } catch ( e ) {
                apex.debug.warn( "PDF Annotation: saved annotations are not valid JSON" );
                return [];
            }
        }

        toJSON() {
            return { version: 1, document: this.doc && this.doc.id, annotations: this.annotations };
        }

        // ---------- frame ----------
        build() {
            const tools = [ "select" ].concat( Object.keys( TOOLS ).filter( t => t !== "select" && has( this.cfg.tools, t ) ) ),
                f = this.cfg.features,
                btn = ( action, icon, label, extra ) => "<button type=\"button\" class=\"tx-PdfAnnot-btn" + ( extra || "" ) + "\" data-tx-action=\"" + action + "\" title=\"" + esc( label ) + "\" aria-label=\"" + esc( label ) + "\"><span class=\"fa " + icon + "\" aria-hidden=\"true\"></span></button>";
            this.el.classList.toggle( "is-review", this.readOnly );
            this.el.innerHTML =
                "<div class=\"tx-PdfAnnot-toolbar\" role=\"toolbar\" aria-label=\"Annotation tools\">" +
                  ( this.readOnly ? "<span class=\"tx-PdfAnnot-badge\">Review</span>" :
                    "<div class=\"tx-PdfAnnot-group\" role=\"radiogroup\" aria-label=\"Tool\">" + tools.map( t =>
                        "<button type=\"button\" class=\"tx-PdfAnnot-btn tx-PdfAnnot-tool\" role=\"radio\" aria-checked=\"false\" data-tool=\"" + t + "\" title=\"" + esc( TOOLS[ t ][ 1 ] ) + "\" aria-label=\"" + esc( TOOLS[ t ][ 1 ] ) + "\"><span class=\"fa " + TOOLS[ t ][ 0 ] + "\" aria-hidden=\"true\"></span></button>" ).join( "" ) + "</div>" +
                    "<div class=\"tx-PdfAnnot-group\" aria-label=\"Color\">" + this.colors.map( c =>
                        "<button type=\"button\" class=\"tx-PdfAnnot-swatch\" data-color=\"" + esc( c ) + "\" style=\"--swatch:" + esc( c ) + "\" title=\"" + esc( c ) + "\" aria-label=\"Color " + esc( c ) + "\"></button>" ).join( "" ) + "</div>" +
                    "<div class=\"tx-PdfAnnot-group\"><select class=\"tx-PdfAnnot-select\" data-tx-setting=\"width\" aria-label=\"Line width\" title=\"Line width\">" +
                        [ 1, 2, 3, 5, 8 ].map( w => "<option value=\"" + w + "\"" + ( w === 3 ? " selected" : "" ) + ">" + w + " px</option>" ).join( "" ) + "</select>" +
                      ( has( this.cfg.tools, "stamp" ) ? "<select class=\"tx-PdfAnnot-select\" data-tx-setting=\"stamp\" aria-label=\"Stamp\" title=\"Stamp text\">" +
                        this.stamps.map( s => "<option>" + esc( s ) + "</option>" ).join( "" ) + "</select>" : "" ) + "</div>" +
                    "<div class=\"tx-PdfAnnot-group\">" + btn( "undo", "fa-undo", "Undo (Ctrl+Z)" ) + btn( "redo", "fa-repeat", "Redo (Ctrl+Y)" ) + btn( "delete", "fa-trash-o", "Delete selected (Delete)" ) + "</div>" ) +
                  "<div class=\"tx-PdfAnnot-group tx-PdfAnnot-end\">" +
                    ( has( f, "pages" ) ? btn( "prev", "fa-chevron-up", "Previous page" ) + "<span class=\"tx-PdfAnnot-pageText\" aria-live=\"polite\">1</span>" + btn( "next", "fa-chevron-down", "Next page" ) : "" ) +
                    ( has( f, "zoom" ) ? btn( "zoomOut", "fa-search-minus", "Zoom out" ) + "<button type=\"button\" class=\"tx-PdfAnnot-btn tx-PdfAnnot-zoomText\" data-tx-action=\"fit\" title=\"Fit width\">100%</button>" + btn( "zoomIn", "fa-search-plus", "Zoom in" ) : "" ) +
                    ( has( f, "comments" ) ? btn( "comments", "fa-comments-o", "Comments", " tx-PdfAnnot-commentsBtn" ) : "" ) +
                    ( has( f, "export" ) ? btn( "export", "fa-file-pdf-o", "Export annotated PDF" ) : "" ) +
                    ( this.cfg.saveMode === "button" && !this.readOnly ? "<button type=\"button\" class=\"tx-PdfAnnot-save\" data-tx-action=\"save\" disabled><span class=\"fa fa-save\" aria-hidden=\"true\"></span>Save</button>" : "" ) +
                    ( this.cfg.saveMode === "auto" && !this.readOnly ? "<span class=\"tx-PdfAnnot-status\" aria-live=\"polite\"></span>" : "" ) +
                  "</div>" +
                "</div>" +
                "<div class=\"tx-PdfAnnot-body\"><div class=\"tx-PdfAnnot-stage\" tabindex=\"0\"></div>" +
                "<aside class=\"tx-PdfAnnot-panel\" aria-label=\"Comments\"" + ( has( f, "comments" ) ? "" : " hidden" ) + "><div class=\"tx-PdfAnnot-panelHead\">Comments <span class=\"tx-PdfAnnot-count\"></span></div><ol class=\"tx-PdfAnnot-list\"></ol></aside></div>";
            this.stage = this.el.querySelector( ".tx-PdfAnnot-stage" );
            this.panel = this.el.querySelector( ".tx-PdfAnnot-panel" );
            this.list = this.el.querySelector( ".tx-PdfAnnot-list" );

            this.el.querySelector( ".tx-PdfAnnot-toolbar" ).addEventListener( "click", e => {
                const tool = e.target.closest( "[data-tool]" ), action = e.target.closest( "[data-tx-action]" ), swatch = e.target.closest( "[data-color]" );
                if ( tool ) { this.setTool( tool.dataset.tool ); }
                if ( action ) { this.action( action.dataset.txAction ); }
                if ( swatch ) { this.setColor( swatch.dataset.color ); }
            } );
            this.el.querySelectorAll( "[data-tx-setting]" ).forEach( s => s.addEventListener( "change", () => {
                if ( s.dataset.txSetting === "width" ) {
                    this.width = Number( s.value );
                    if ( this.selected && this.selected.width !== undefined ) { this.selected.width = this.width; this.commit(); }
                } else {
                    this.stamp = s.value;
                    this.setTool( "stamp" );
                }
            } ) );
            this.el.addEventListener( "keydown", e => {
                if ( e.target.matches( "textarea, input, select" ) ) { return; }
                if ( ( e.ctrlKey || e.metaKey ) && e.key.toLowerCase() === "z" ) { e.preventDefault(); this.action( e.shiftKey ? "redo" : "undo" ); }
                else if ( ( e.ctrlKey || e.metaKey ) && e.key.toLowerCase() === "y" ) { e.preventDefault(); this.action( "redo" ); }
                else if ( ( e.key === "Delete" || e.key === "Backspace" ) && this.selected && !this.readOnly ) { e.preventDefault(); this.remove( this.selected ); }
                else if ( e.key === "Escape" ) { this.select( null ); }
            } );
            this.list.addEventListener( "click", e => {
                const item = e.target.closest( "[data-id]" );
                if ( !item ) { return; }
                if ( e.target.closest( "[data-tx-action=remove]" ) ) { this.remove( this.find( item.dataset.id ) ); return; }
                if ( !e.target.closest( "textarea" ) ) { this.reveal( this.find( item.dataset.id ) ); }
            } );
            this.list.addEventListener( "change", e => {
                const item = e.target.closest( "[data-id]" ), a = item && this.find( item.dataset.id );
                if ( a && e.target.matches( "textarea" ) ) { a.comment = e.target.value; a.modified = new Date().toISOString(); this.commit( true ); }
            } );
            window.addEventListener( "beforeunload", e => {
                if ( this.dirty && this.cfg.saveMode === "button" ) { e.preventDefault(); e.returnValue = ""; }
            } );
            this.setTool( this.tool );
            this.setColor( this.color );
            this.renderList();
        }

        setTool( tool ) {
            this.tool = tool;
            this.el.dataset.tool = tool;
            this.el.querySelectorAll( "[data-tool]" ).forEach( b => b.setAttribute( "aria-checked", String( b.dataset.tool === tool ) ) );
            if ( tool !== "select" ) { this.select( null ); }
        }

        setColor( color ) {
            this.color = color;
            this.el.querySelectorAll( "[data-color]" ).forEach( b => b.classList.toggle( "is-active", b.dataset.color === color ) );
            if ( this.selected && this.selected.type !== "stamp" ) { this.selected.color = color; this.commit(); }
        }

        // ---------- document ----------
        async open() {
            this.stage.innerHTML = "<div class=\"tx-PdfAnnot-message\"><span class=\"tx-PdfAnnot-spinner\" aria-hidden=\"true\"></span>Loading " + esc( this.doc.name ) + "</div>";
            try {
                this.lib = await loadPdfjs( this.cfg.filePrefix );
                this.fileUrl = this.doc.hasContent
                    ? abs( apex.server.pluginUrl( this.cfg.ajaxIdentifier, { x01: "FILE", x02: this.doc.id } ) )
                    : ( this.doc.url ? abs( this.doc.url ) : "" );
                const task = this.lib.getDocument( { url: this.fileUrl, withCredentials: true, isEvalSupported: false } );
                this.pdf = await task.promise;
            } catch ( e ) {
                window.console.warn( "PDF Annotation: could not open " + this.doc.name, e );
                this.stage.innerHTML = "<div class=\"tx-PdfAnnot-message\">This PDF could not be opened.</div>";
                return;
            }
            this.stage.innerHTML = "<div class=\"tx-PdfAnnot-pages\"></div>";
            const wrap = this.stage.firstChild;
            for ( let n = 1; n <= this.pdf.numPages; n++ ) {
                const vp = ( await this.pdf.getPage( n ) ).getViewport( { scale: 1 } ),
                    div = document.createElement( "div" );
                div.className = "tx-PdfAnnot-page";
                div.dataset.page = n;
                div.setAttribute( "aria-label", "Page " + n );
                wrap.appendChild( div );
                const p = { n, div, w: vp.width, h: vp.height, rendered: null };
                // highlight tool on pages with text: the text layer takes the selection, the highlight follows it
                div.addEventListener( "pointerup", () => {
                    if ( this.tool === "highlight" && p.hasText && !this.readOnly ) { setTimeout( () => this.highlightSelection( p ), 0 ); }
                } );
                this.pages.push( p );
            }
            this.io = new IntersectionObserver( entries => entries.forEach( e => {
                if ( e.isIntersecting ) { this.renderPage( this.pages[ e.target.dataset.page - 1 ] ); }
            } ), { root: this.stage, rootMargin: "500px 0px" } );
            this.pages.forEach( p => this.io.observe( p.div ) );
            this.stage.addEventListener( "scroll", () => this.trackPage(), { passive: true } );
            new ResizeObserver( () => { if ( this.fitMode !== false ) { this.layout(); } } ).observe( this.stage );
            this.fitMode = true;
            this.layout();
        }

        layout() {
            if ( !this.pdf ) { return; }
            if ( this.fitMode ) { this.scale = Math.max( 0.3, ( this.stage.clientWidth - 40 ) / this.pages[ 0 ].w ); }
            this.pages.forEach( p => {
                p.div.style.width = Math.floor( p.w * this.scale ) + "px";
                p.div.style.height = Math.floor( p.h * this.scale ) + "px";
                p.rendered = null;
                p.div.textContent = "";
                p.svg = null;
            } );
            const z = this.el.querySelector( ".tx-PdfAnnot-zoomText" );
            if ( z ) { z.textContent = Math.round( this.scale * 100 ) + "%"; }
            const s = this.stage.getBoundingClientRect();
            this.pages.forEach( p => {
                const r = p.div.getBoundingClientRect();
                if ( r.bottom > s.top - 500 && r.top < s.bottom + 500 ) { this.renderPage( p ); }
            } );
        }

        async renderPage( p ) {
            const key = String( this.scale );
            if ( p.rendered === key ) { return; }
            p.rendered = key;
            const page = await this.pdf.getPage( p.n );
            if ( p.rendered !== key ) { return; }
            const vp = page.getViewport( { scale: this.scale } ), ratio = window.devicePixelRatio || 1,
                canvas = document.createElement( "canvas" ), text = document.createElement( "div" );
            canvas.width = Math.floor( vp.width * ratio );
            canvas.height = Math.floor( vp.height * ratio );
            canvas.style.width = Math.floor( vp.width ) + "px";
            canvas.style.height = Math.floor( vp.height ) + "px";
            text.className = "textLayer";
            p.div.style.setProperty( "--scale-factor", this.scale );
            p.div.style.setProperty( "--total-scale-factor", this.scale );
            const svg = svgEl( "svg", { class: "tx-PdfAnnot-layer", viewBox: "0 0 " + p.w + " " + p.h, width: Math.floor( vp.width ), height: Math.floor( vp.height ) } );
            p.div.textContent = "";
            p.div.append( canvas, text, svg );
            p.svg = svg;
            this.drawPage( p );
            this.bindPage( p );
            await page.render( { canvas, canvasContext: canvas.getContext( "2d" ), viewport: vp, transform: ratio !== 1 ? [ ratio, 0, 0, ratio, 0, 0 ] : null } ).promise.catch( () => null );
            try {
                await new this.lib.TextLayer( { textContentSource: page.streamTextContent(), container: text, viewport: vp } ).render();
            } catch ( e ) { /* scanned page without text */ }
            p.hasText = text.querySelectorAll( "span" ).length > 0;
            p.div.classList.toggle( "has-text", p.hasText );
        }

        trackPage() {
            const mid = this.stage.getBoundingClientRect().top + this.stage.clientHeight / 3;
            let current = 1;
            this.pages.forEach( p => { if ( p.div.getBoundingClientRect().top <= mid ) { current = p.n; } } );
            this.currentPage = current;
            const t = this.el.querySelector( ".tx-PdfAnnot-pageText" );
            if ( t ) { t.textContent = current + " / " + this.pages.length; }
        }

        goToPage( n ) {
            const p = this.pages[ Math.max( 1, Math.min( this.pages.length, n ) ) - 1 ];
            if ( p ) { this.stage.scrollTop = p.div.offsetTop - 20; }
        }

        // ---------- drawing ----------
        drawPage( p ) {
            if ( !p.svg ) { return; }
            p.svg.textContent = "";
            this.annotations.filter( a => a.page === p.n ).forEach( a => this.drawAnnotation( p.svg, a ) );
            if ( this.selected && this.selected.page === p.n ) { this.drawSelection( p ); }
        }

        drawAnnotation( svg, a ) {
            const g = svgEl( "g", { "data-id": a.id, class: "tx-PdfAnnot-item tx-PdfAnnot-item--" + a.type }, svg ),
                stroke = { stroke: a.color, "stroke-width": a.width || 3, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" },
                hit = d => svgEl( "path", { d, class: "tx-PdfAnnot-hit", "stroke-width": Math.max( 12, ( a.width || 3 ) + 10 ) }, g );
            switch ( a.type ) {
                case "highlight":
                    ( a.rects || [] ).forEach( r => svgEl( "rect", { x: r[ 0 ], y: r[ 1 ], width: r[ 2 ], height: r[ 3 ], fill: a.color, class: "tx-PdfAnnot-mark" }, g ) );
                    break;
                case "pen":
                    svgEl( "path", Object.assign( { d: pathOf( a.points || [] ) }, stroke ), g );
                    hit( pathOf( a.points || [] ) );
                    break;
                case "rectangle":
                    svgEl( "rect", Object.assign( { x: Math.min( a.x1, a.x2 ), y: Math.min( a.y1, a.y2 ), width: Math.abs( a.x2 - a.x1 ), height: Math.abs( a.y2 - a.y1 ), rx: 2 }, stroke ), g );
                    svgEl( "rect", { x: Math.min( a.x1, a.x2 ), y: Math.min( a.y1, a.y2 ), width: Math.abs( a.x2 - a.x1 ), height: Math.abs( a.y2 - a.y1 ), class: "tx-PdfAnnot-hit", "stroke-width": 12 }, g );
                    break;
                case "ellipse":
                    svgEl( "ellipse", Object.assign( { cx: ( a.x1 + a.x2 ) / 2, cy: ( a.y1 + a.y2 ) / 2, rx: Math.abs( a.x2 - a.x1 ) / 2, ry: Math.abs( a.y2 - a.y1 ) / 2 }, stroke ), g );
                    svgEl( "ellipse", { cx: ( a.x1 + a.x2 ) / 2, cy: ( a.y1 + a.y2 ) / 2, rx: Math.abs( a.x2 - a.x1 ) / 2, ry: Math.abs( a.y2 - a.y1 ) / 2, class: "tx-PdfAnnot-hit", "stroke-width": 12 }, g );
                    break;
                case "line":
                case "arrow": {
                    const d = "M" + a.x1 + " " + a.y1 + " L" + a.x2 + " " + a.y2;
                    svgEl( "path", Object.assign( { d }, stroke ), g );
                    if ( a.type === "arrow" ) { svgEl( "path", Object.assign( { d: this.arrowHead( a ) }, stroke ), g ); }
                    hit( d );
                    break;
                }
                case "text": {
                    const size = a.size || 14, t = svgEl( "text", { x: a.x, y: a.y + size, fill: a.color, "font-size": size, class: "tx-PdfAnnot-text" }, g );
                    String( a.text || "" ).split( "\n" ).forEach( ( line, i ) => {
                        const span = svgEl( "tspan", { x: a.x, dy: i ? size * 1.25 : 0 }, t );
                        span.textContent = line || " ";
                    } );
                    break;
                }
                case "note":
                    svgEl( "path", { d: "M" + a.x + " " + a.y + " h20 v14 l-6 6 h-14 z", fill: a.color, stroke: "rgba(0,0,0,.35)", "stroke-width": 1, class: "tx-PdfAnnot-noteIcon" }, g );
                    svgEl( "path", { d: "M" + ( a.x + 4 ) + " " + ( a.y + 6 ) + " h12 M" + ( a.x + 4 ) + " " + ( a.y + 10 ) + " h12 M" + ( a.x + 4 ) + " " + ( a.y + 14 ) + " h7", stroke: "rgba(0,0,0,.45)", "stroke-width": 1.2 }, g );
                    break;
                case "stamp": {
                    const text = String( a.text || "" ).toUpperCase(), w = text.length * 11 + 28, h = 34,
                        color = a.color || stampColor( a.text ),
                        sg = svgEl( "g", { transform: "rotate(-8 " + ( a.x + w / 2 ) + " " + ( a.y + h / 2 ) + ")" }, g );
                    svgEl( "rect", { x: a.x, y: a.y, width: w, height: h, rx: 5, fill: color, "fill-opacity": 0.07, stroke: color, "stroke-width": 2.5 }, sg );
                    const t = svgEl( "text", { x: a.x + w / 2, y: a.y + 23, fill: color, "font-size": 17, "font-weight": 800, "text-anchor": "middle", "letter-spacing": 1.5, class: "tx-PdfAnnot-stampText" }, sg );
                    t.textContent = text;
                    break;
                }
            }
            return g;
        }

        arrowHead( a ) {
            const ang = Math.atan2( a.y2 - a.y1, a.x2 - a.x1 ), len = 10 + ( a.width || 3 ) * 2, spread = Math.PI / 7,
                p1 = [ a.x2 - len * Math.cos( ang - spread ), a.y2 - len * Math.sin( ang - spread ) ],
                p2 = [ a.x2 - len * Math.cos( ang + spread ), a.y2 - len * Math.sin( ang + spread ) ];
            return "M" + p1[ 0 ] + " " + p1[ 1 ] + " L" + a.x2 + " " + a.y2 + " L" + p2[ 0 ] + " " + p2[ 1 ];
        }

        drawSelection( p ) {
            const g = p.svg.querySelector( "[data-id=\"" + this.selected.id + "\"]" );
            if ( !g ) { return; }
            const b = g.getBBox();
            svgEl( "rect", { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8, class: "tx-PdfAnnot-selection" }, p.svg );
        }

        // ---------- pointer input ----------
        point( p, e ) {
            const pt = p.svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const r = pt.matrixTransform( p.svg.getScreenCTM().inverse() );
            return [ Math.max( 0, Math.min( p.w, r.x ) ), Math.max( 0, Math.min( p.h, r.y ) ) ];
        }

        bindPage( p ) {
            const svg = p.svg;
            svg.addEventListener( "pointerdown", e => {
                if ( e.button !== 0 ) { return; }
                const target = e.target.closest( "[data-id]" ), a = target && this.find( target.dataset.id );
                if ( this.tool === "select" || this.readOnly ) {
                    this.select( a || null );
                    if ( a && !this.readOnly ) { this.startMove( p, a, e ); }
                    return;
                }
                if ( this.tool === "eraser" ) { if ( a ) { this.remove( a ); } return; }
                this.startDraw( p, e );
            } );
            svg.addEventListener( "dblclick", e => {
                const target = e.target.closest( "[data-id]" ), a = target && this.find( target.dataset.id );
                if ( a && a.type === "text" && !this.readOnly ) { this.editText( p, a ); }
            } );
        }

        startDraw( p, e ) {
            const start = this.point( p, e ), base = { id: uid(), page: p.n, color: this.color, author: this.cfg.author, created: new Date().toISOString() };
            let a;
            switch ( this.tool ) {
                case "highlight": a = Object.assign( base, { type: "highlight", rects: [ [ start[ 0 ], start[ 1 ], 0, 0 ] ] } ); break;
                case "pen": a = Object.assign( base, { type: "pen", width: this.width, points: [ start ] } ); break;
                case "rectangle":
                case "ellipse":
                case "line":
                case "arrow": a = Object.assign( base, { type: this.tool, width: this.width, x1: start[ 0 ], y1: start[ 1 ], x2: start[ 0 ], y2: start[ 1 ] } ); break;
                case "text": a = Object.assign( base, { type: "text", x: start[ 0 ], y: start[ 1 ], text: "", size: 14 } ); break;
                case "note": a = Object.assign( base, { type: "note", x: start[ 0 ] - 10, y: start[ 1 ] - 10, color: this.color, comment: "" } ); break;
                case "stamp": a = Object.assign( base, { type: "stamp", x: start[ 0 ], y: start[ 1 ] - 17, text: this.stamp, color: stampColor( this.stamp ) } ); break;
                default: return;
            }
            if ( a.type === "text" ) { this.annotations.push( a ); this.drawPage( p ); this.editText( p, a ); return; }
            if ( a.type === "note" || a.type === "stamp" ) {
                this.annotations.push( a );
                this.commit();
                if ( a.type === "note" ) { this.select( a ); this.openPanel(); this.focusComment( a ); }
                return;
            }
            e.preventDefault();
            p.svg.setPointerCapture( e.pointerId );
            this.annotations.push( a );
            const move = ev => {
                const pt = this.point( p, ev );
                if ( a.type === "pen" ) { a.points.push( pt ); }
                else if ( a.type === "highlight" ) { a.rects[ 0 ] = [ Math.min( start[ 0 ], pt[ 0 ] ), Math.min( start[ 1 ], pt[ 1 ] ), Math.abs( pt[ 0 ] - start[ 0 ] ), Math.abs( pt[ 1 ] - start[ 1 ] ) ]; }
                else { a.x2 = pt[ 0 ]; a.y2 = pt[ 1 ]; }
                this.drawPage( p );
            };
            const up = () => {
                p.svg.removeEventListener( "pointermove", move );
                p.svg.removeEventListener( "pointerup", up );
                const tiny = a.type === "pen" ? a.points.length < 2
                    : a.type === "highlight" ? a.rects[ 0 ][ 2 ] < 4 || a.rects[ 0 ][ 3 ] < 4
                    : Math.hypot( a.x2 - a.x1, a.y2 - a.y1 ) < 4;
                if ( tiny ) {
                    this.annotations.splice( this.annotations.indexOf( a ), 1 );
                    this.drawPage( p );
                } else {
                    if ( a.type === "pen" ) { a.points = this.simplify( a.points ); }
                    this.commit();
                }
            };
            p.svg.addEventListener( "pointermove", move );
            p.svg.addEventListener( "pointerup", up );
        }

        // keeps every point at least 1.5 page units from the previous one
        simplify( points ) {
            return points.filter( ( pt, i ) => i === 0 || i === points.length - 1 || Math.hypot( pt[ 0 ] - points[ i - 1 ][ 0 ], pt[ 1 ] - points[ i - 1 ][ 1 ] ) > 1.5 );
        }

        highlightSelection( p ) {
            const sel = window.getSelection();
            if ( !sel || sel.isCollapsed || !sel.rangeCount ) { return; }
            const box = p.div.getBoundingClientRect(), rects = [];
            Array.from( sel.getRangeAt( 0 ).getClientRects() ).forEach( r => {
                if ( r.width < 1 || r.height < 1 || r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom ) { return; }
                rects.push( [ ( r.left - box.left ) / this.scale, ( r.top - box.top ) / this.scale, r.width / this.scale, r.height / this.scale ] );
            } );
            if ( !rects.length ) { return; }
            const text = sel.toString();
            sel.removeAllRanges();
            this.annotations.push( { id: uid(), type: "highlight", page: p.n, color: this.color, rects: this.mergeRects( rects ),
                                     text: text.substr( 0, 500 ), author: this.cfg.author, created: new Date().toISOString() } );
            this.commit();
        }

        // joins the per-span rectangles of one line into one band
        mergeRects( rects ) {
            const out = [];
            rects.sort( ( a, b ) => a[ 1 ] - b[ 1 ] || a[ 0 ] - b[ 0 ] ).forEach( r => {
                const last = out[ out.length - 1 ];
                if ( last && Math.abs( last[ 1 ] - r[ 1 ] ) < r[ 3 ] * 0.5 && r[ 0 ] <= last[ 0 ] + last[ 2 ] + 4 ) {
                    const right = Math.max( last[ 0 ] + last[ 2 ], r[ 0 ] + r[ 2 ] );
                    last[ 1 ] = Math.min( last[ 1 ], r[ 1 ] );
                    last[ 3 ] = Math.max( last[ 3 ], r[ 3 ] );
                    last[ 2 ] = right - last[ 0 ];
                } else {
                    out.push( r.slice() );
                }
            } );
            return out;
        }

        startMove( p, a, e ) {
            const start = this.point( p, e ), before = JSON.stringify( a );
            let moved = false;
            p.svg.setPointerCapture( e.pointerId );
            const move = ev => {
                const pt = this.point( p, ev ), dx = pt[ 0 ] - start[ 0 ], dy = pt[ 1 ] - start[ 1 ];
                Object.assign( a, JSON.parse( before ) );
                this.translate( a, dx, dy );
                moved = moved || Math.hypot( dx, dy ) > 1;
                this.drawPage( p );
            };
            const up = () => {
                p.svg.removeEventListener( "pointermove", move );
                p.svg.removeEventListener( "pointerup", up );
                if ( moved ) { this.commit(); }
            };
            p.svg.addEventListener( "pointermove", move );
            p.svg.addEventListener( "pointerup", up );
        }

        translate( a, dx, dy ) {
            if ( a.rects ) { a.rects = a.rects.map( r => [ r[ 0 ] + dx, r[ 1 ] + dy, r[ 2 ], r[ 3 ] ] ); }
            if ( a.points ) { a.points = a.points.map( pt => [ pt[ 0 ] + dx, pt[ 1 ] + dy ] ); }
            [ "x", "x1", "x2" ].forEach( k => { if ( a[ k ] !== undefined ) { a[ k ] += dx; } } );
            [ "y", "y1", "y2" ].forEach( k => { if ( a[ k ] !== undefined ) { a[ k ] += dy; } } );
        }

        editText( p, a ) {
            const ta = document.createElement( "textarea" );
            ta.className = "tx-PdfAnnot-editor";
            ta.value = a.text || "";
            ta.style.left = ( a.x * this.scale ) + "px";
            ta.style.top = ( a.y * this.scale ) + "px";
            ta.style.color = a.color;
            ta.style.fontSize = ( ( a.size || 14 ) * this.scale ) + "px";
            ta.setAttribute( "aria-label", "Text" );
            p.div.appendChild( ta );
            const g = p.svg.querySelector( "[data-id=\"" + a.id + "\"]" );
            if ( g ) { g.style.visibility = "hidden"; }
            setTimeout( () => ta.focus(), 0 );
            const done = () => {
                ta.removeEventListener( "blur", done );
                a.text = ta.value.trim();
                ta.remove();
                if ( !a.text ) { this.annotations.splice( this.annotations.indexOf( a ), 1 ); this.drawPage( p ); }
                else { a.modified = new Date().toISOString(); this.commit(); }
            };
            ta.addEventListener( "blur", done );
            ta.addEventListener( "keydown", e => { if ( e.key === "Escape" || ( e.key === "Enter" && ( e.ctrlKey || e.metaKey ) ) ) { ta.blur(); } } );
        }

        // ---------- model ----------
        find( id ) { return this.annotations.find( a => a.id === id ); }

        select( a ) {
            const old = this.selected;
            this.selected = a;
            [ old, a ].forEach( x => { if ( x ) { const p = this.pages[ x.page - 1 ]; if ( p ) { this.drawPage( p ); } } } );
            this.list.querySelectorAll( "[data-id]" ).forEach( li => li.classList.toggle( "is-selected", !!a && li.dataset.id === a.id ) );
        }

        remove( a ) {
            if ( !a || this.readOnly ) { return; }
            this.annotations.splice( this.annotations.indexOf( a ), 1 );
            if ( this.selected === a ) { this.selected = null; }
            this.commit();
        }

        // records a change: history, redraw, list, events, saving
        commit( keepList ) {
            const snap = JSON.stringify( this.annotations );
            if ( snap !== this.history[ this.history.length - 1 ] ) {
                this.history.push( snap );
                if ( this.history.length > 200 ) { this.history.shift(); }
                this.future = [];
            }
            this.afterChange( keepList );
        }

        afterChange( keepList ) {
            this.pages.forEach( p => this.drawPage( p ) );
            if ( !keepList ) { this.renderList(); }
            this.dirty = true;
            const save = this.el.querySelector( ".tx-PdfAnnot-save" );
            if ( save ) { save.disabled = false; }
            apex.event.trigger( "#" + this.regionId, "tx-pdfannot-change", { count: this.annotations.length } );
            if ( this.cfg.saveMode === "auto" && !this.readOnly ) {
                clearTimeout( this.autoTimer );
                this.status( "Unsaved changes" );
                this.autoTimer = setTimeout( () => this.save(), 2000 );
            }
        }

        undoRedo( from, to ) {
            if ( !from.length || ( from === this.history && from.length < 2 ) ) { return; }
            if ( from === this.history ) {
                this.future.push( this.history.pop() );
                this.annotations = JSON.parse( this.history[ this.history.length - 1 ] );
            } else {
                const snap = this.future.pop();
                this.history.push( snap );
                this.annotations = JSON.parse( snap );
            }
            this.selected = null;
            this.afterChange();
        }

        // ---------- comments panel ----------
        openPanel() {
            if ( this.panel ) { this.panel.hidden = false; }
        }

        renderList() {
            const items = this.annotations.slice().sort( ( a, b ) => a.page - b.page || ( ( a.y || a.y1 || ( a.rects && a.rects[ 0 ][ 1 ] ) || 0 ) - ( b.y || b.y1 || ( b.rects && b.rects[ 0 ][ 1 ] ) || 0 ) ) );
            this.el.querySelector( ".tx-PdfAnnot-count" ).textContent = items.length ? "(" + items.length + ")" : "";
            this.list.innerHTML = items.length ? items.map( a =>
                "<li class=\"tx-PdfAnnot-entry" + ( this.selected === a ? " is-selected" : "" ) + "\" data-id=\"" + esc( a.id ) + "\">" +
                  "<div class=\"tx-PdfAnnot-entryHead\"><span class=\"tx-PdfAnnot-dot\" style=\"--dot:" + esc( a.color || stampColor( a.text ) ) + "\"></span>" +
                    "<strong>" + esc( a.type === "stamp" ? "Stamp: " + a.text : TYPE_NAMES[ a.type ] || a.type ) + "</strong><span>Page " + a.page + "</span>" +
                    ( this.readOnly ? "" : "<button type=\"button\" class=\"tx-PdfAnnot-btn tx-PdfAnnot-remove\" data-tx-action=\"remove\" title=\"Delete\" aria-label=\"Delete annotation\"><span class=\"fa fa-trash-o\" aria-hidden=\"true\"></span></button>" ) + "</div>" +
                  ( a.type === "text" ? "<p class=\"tx-PdfAnnot-quote\">" + esc( a.text ) + "</p>" : "" ) +
                  ( a.type === "highlight" && a.text ? "<p class=\"tx-PdfAnnot-quote\">“" + esc( a.text ) + "”</p>" : "" ) +
                  ( this.readOnly
                      ? ( a.comment ? "<p class=\"tx-PdfAnnot-comment\">" + esc( a.comment ) + "</p>" : "" )
                      : "<textarea class=\"tx-PdfAnnot-commentInput\" rows=\"2\" placeholder=\"Add a comment\" aria-label=\"Comment\">" + esc( a.comment || "" ) + "</textarea>" ) +
                  "<div class=\"tx-PdfAnnot-meta\">" + esc( [ a.author, timeText( a.modified || a.created ) ].filter( Boolean ).join( ", " ) ) + "</div>" +
                "</li>" ).join( "" )
                : "<li class=\"tx-PdfAnnot-empty\">" + ( this.readOnly ? "No annotations." : "No annotations yet. Pick a tool and mark up the page." ) + "</li>";
        }

        focusComment( a ) {
            const ta = this.list.querySelector( "[data-id=\"" + a.id + "\"] textarea" );
            if ( ta ) { ta.focus(); }
        }

        reveal( a ) {
            if ( !a ) { return; }
            const p = this.pages[ a.page - 1 ], y = ( a.y || a.y1 || ( a.rects && a.rects[ 0 ][ 1 ] ) || 0 ) * this.scale;
            this.stage.scrollTop = p.div.offsetTop + y - this.stage.clientHeight / 3;
            this.select( a );
        }

        // ---------- saving and export ----------
        status( text ) {
            const s = this.el.querySelector( ".tx-PdfAnnot-status" );
            if ( s ) { s.textContent = text; }
        }

        save() {
            if ( this.cfg.saveMode === "none" || this.readOnly ) { return $.Deferred().resolve().promise(); }
            const json = JSON.stringify( this.toJSON() );
            this.status( "Saving" );
            return apex.server.plugin( this.cfg.ajaxIdentifier, { x01: "SAVE", x02: this.doc.id, p_clob_01: json, pageItems: this.cfg.itemsToSubmit } )
                .done( () => {
                    this.dirty = false;
                    const save = this.el.querySelector( ".tx-PdfAnnot-save" );
                    if ( save ) { save.disabled = true; }
                    this.status( "Saved" );
                    if ( this.cfg.saveMode === "button" ) { apex.message.showPageSuccess( "Annotations saved." ); }
                    apex.event.trigger( "#" + this.regionId, "tx-pdfannot-save", { count: this.annotations.length } );
                } )
                .fail( () => {
                    this.status( "Not saved" );
                    apex.message.showErrors( [ { type: "error", location: "page", message: "The annotations could not be saved.", unsafe: false } ] );
                } );
        }

        async exportPdf() {
            const lib = await loadPdfLib( this.cfg.filePrefix ),
                bytes = await ( await fetch( this.fileUrl, { credentials: "same-origin" } ) ).arrayBuffer(),
                pdf = await lib.PDFDocument.load( bytes ),
                font = await pdf.embedFont( lib.StandardFonts.Helvetica ),
                bold = await pdf.embedFont( lib.StandardFonts.HelveticaBold ),
                pages = pdf.getPages(),
                color = c => lib.rgb.apply( null, hexRgb( c ) ),
                safe = t => String( t || "" ).replace( /[^\x20-\x7e\xa0-\xff\n]/g, "?" );
            this.annotations.forEach( a => {
                const page = pages[ a.page - 1 ];
                if ( !page ) { return; }
                const H = page.getSize().height, w = a.width || 3, c = color( a.color || stampColor( a.text ) );
                switch ( a.type ) {
                    case "highlight":
                        a.rects.forEach( r => page.drawRectangle( { x: r[ 0 ], y: H - r[ 1 ] - r[ 3 ], width: r[ 2 ], height: r[ 3 ], color: c, opacity: 0.35, blendMode: lib.BlendMode.Multiply } ) );
                        break;
                    case "pen":
                        page.drawSvgPath( pathOf( a.points ), { x: 0, y: H, borderColor: c, borderWidth: w, borderLineCap: lib.LineCapStyle.Round } );
                        break;
                    case "rectangle":
                        page.drawRectangle( { x: Math.min( a.x1, a.x2 ), y: H - Math.max( a.y1, a.y2 ), width: Math.abs( a.x2 - a.x1 ), height: Math.abs( a.y2 - a.y1 ), borderColor: c, borderWidth: w } );
                        break;
                    case "ellipse":
                        page.drawEllipse( { x: ( a.x1 + a.x2 ) / 2, y: H - ( a.y1 + a.y2 ) / 2, xScale: Math.abs( a.x2 - a.x1 ) / 2, yScale: Math.abs( a.y2 - a.y1 ) / 2, borderColor: c, borderWidth: w } );
                        break;
                    case "line":
                    case "arrow":
                        page.drawLine( { start: { x: a.x1, y: H - a.y1 }, end: { x: a.x2, y: H - a.y2 }, thickness: w, color: c, lineCap: lib.LineCapStyle.Round } );
                        if ( a.type === "arrow" ) { page.drawSvgPath( this.arrowHead( a ), { x: 0, y: H, borderColor: c, borderWidth: w, borderLineCap: lib.LineCapStyle.Round } ); }
                        break;
                    case "text":
                        page.drawText( safe( a.text ), { x: a.x, y: H - a.y - ( a.size || 14 ), size: a.size || 14, font, color: c, lineHeight: ( a.size || 14 ) * 1.25 } );
                        break;
                    case "note":
                        page.drawRectangle( { x: a.x, y: H - a.y - 20, width: 20, height: 20, color: c, borderColor: lib.rgb( 0.4, 0.4, 0.4 ), borderWidth: 0.6 } );
                        if ( a.comment ) {
                            // beside the note, or below it when the note sits near the right edge
                            const W = page.getSize().width, beside = a.x + 26 + 200 <= W;
                            page.drawText( safe( a.comment ), {
                                x: beside ? a.x + 26 : Math.max( 12, W - 212 ),
                                y: beside ? H - a.y - 12 : H - a.y - 34,
                                size: 9, font, color: lib.rgb( 0.15, 0.15, 0.2 ), maxWidth: 200, lineHeight: 11 } );
                        }
                        break;
                    case "stamp": {
                        const text = safe( String( a.text ).toUpperCase() ), tw = text.length * 11 + 28;
                        page.drawRectangle( { x: a.x, y: H - a.y - 34, width: tw, height: 34, borderColor: c, borderWidth: 2.5, color: c, opacity: 0.07, borderOpacity: 1, rotate: lib.degrees( 8 ) } );
                        page.drawText( text, { x: a.x + 14, y: H - a.y - 23, size: 17, font: bold, color: c, rotate: lib.degrees( 8 ) } );
                        break;
                    }
                }
            } );
            const out = await pdf.save(), blob = new Blob( [ out ], { type: "application/pdf" } ), link = document.createElement( "a" );
            link.href = URL.createObjectURL( blob );
            link.download = String( this.doc.name || "document.pdf" ).replace( /\.pdf$/i, "" ) + "-annotated.pdf";
            document.body.appendChild( link );
            link.click();
            setTimeout( () => { URL.revokeObjectURL( link.href ); link.remove(); }, 1000 );
            return blob;
        }

        action( name ) {
            switch ( name ) {
                case "undo": this.undoRedo( this.history, this.future ); break;
                case "redo": this.undoRedo( this.future, this.history ); break;
                case "delete": this.remove( this.selected ); break;
                case "prev": this.goToPage( ( this.currentPage || 1 ) - 1 ); break;
                case "next": this.goToPage( ( this.currentPage || 1 ) + 1 ); break;
                case "zoomIn": this.fitMode = false; this.scale = Math.min( 4, this.scale * 1.2 ); this.layout(); break;
                case "zoomOut": this.fitMode = false; this.scale = Math.max( 0.3, this.scale / 1.2 ); this.layout(); break;
                case "fit": this.fitMode = true; this.layout(); break;
                case "comments": this.panel.hidden = !this.panel.hidden; if ( this.fitMode ) { this.layout(); } break;
                case "save": this.save(); break;
                case "export":
                    this.exportPdf().catch( e => {
                        window.console.warn( "PDF Annotation: export failed", e );
                        apex.message.showErrors( [ { type: "error", location: "page", message: "The annotated PDF could not be created.", unsafe: false } ] );
                    } );
                    break;
            }
        }

        setAnnotations( json ) {
            this.annotations = this.parse( json );
            this.history = [ JSON.stringify( this.annotations ) ];
            this.future = [];
            this.selected = null;
            this.pages.forEach( p => this.drawPage( p ) );
            this.renderList();
            this.dirty = false;
        }
    }

    const annotators = {};
    ns.pdfAnnotator = {
        init( regionId ) {
            const a = new Annotator( regionId );
            annotators[ regionId ] = a;
            apex.region.create( regionId, {
                type: "TechRevXPdfAnnotation",
                getAnnotations: () => a.toJSON(),
                setAnnotations: json => a.setAnnotations( json ),
                save: () => a.save(),
                exportPdf: () => a.exportPdf(),
                widget: () => $( a.el )
            } );
        },
        get: regionId => annotators[ regionId ]
    };
} )( apex.jQuery, apex );
