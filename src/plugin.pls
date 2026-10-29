-- PDF Annotation region plug-in (TechRevX, www.techrevx.com)
-- render: writes the annotator container and a JSON block with the settings, the first document row
--         (id, name, url, has content) and its saved annotations, then calls techrevx.pdfAnnotator.init.
-- ajax:   x01 = FILE  streams the PDF of the document (x02 = id)
--         x01 = SAVE  runs the Save Code with :ANNOTATIONS (p_clob_01) and :ID (x02); the ID must be
--                     the region's own document and the region must not be in Review mode.

type t_doc is record (
    id          varchar2(4000),
    name        varchar2(4000),
    url         varchar2(4000),
    content     blob,
    annotations clob );

-- position of a column by name; no data type check, so the annotations column may be CLOB or VARCHAR2
function column_position( p_context in apex_exec.t_context, p_name in varchar2 ) return pls_integer is
begin
    for i in 1 .. apex_exec.get_column_count( p_context ) loop
        if apex_exec.get_column( p_context, i ).name = upper( p_name ) then
            return i;
        end if;
    end loop;
    raise_application_error( -20001, 'PDF Annotation: column ' || p_name || ' is not in the region source.' );
end column_position;

-- reads the first row of the region source
function first_document( p_region in apex_plugin.t_region ) return t_doc is
    l_columns apex_exec.t_columns;
    l_context apex_exec.t_context;
    l_doc     t_doc;
    l_id      varchar2(255) := p_region.attributes.get_varchar2( 'ID_COLUMN' );
    l_name    varchar2(255) := p_region.attributes.get_varchar2( 'NAME_COLUMN' );
    l_blob    varchar2(255) := p_region.attributes.get_varchar2( 'CONTENT_COLUMN' );
    l_url     varchar2(255) := p_region.attributes.get_varchar2( 'URL_COLUMN' );
    l_notes   varchar2(255) := p_region.attributes.get_varchar2( 'ANNOTATIONS_COLUMN' );
    l_pos     pls_integer;
begin
    apex_exec.add_column( p_columns => l_columns, p_column_name => l_id );
    if l_name <> l_id then
        apex_exec.add_column( p_columns => l_columns, p_column_name => l_name );
    end if;
    if l_blob is not null then
        apex_exec.add_column( p_columns => l_columns, p_column_name => l_blob, p_data_type => apex_exec.c_data_type_blob );
    end if;
    if l_url is not null then
        apex_exec.add_column( p_columns => l_columns, p_column_name => l_url );
    end if;
    if l_notes is not null then
        apex_exec.add_column( p_columns => l_columns, p_column_name => l_notes );
    end if;

    l_context := apex_exec.open_query_context( p_columns => l_columns, p_max_rows => 1 );
    if apex_exec.next_row( l_context ) then
        l_doc.id   := apex_exec.get_varchar2( l_context, column_position( l_context, l_id ) );
        l_doc.name := apex_exec.get_varchar2( l_context, column_position( l_context, l_name ) );
        if l_blob is not null then
            l_doc.content := apex_exec.get_blob( l_context, column_position( l_context, l_blob ) );
        end if;
        if l_url is not null then
            l_doc.url := apex_plugin_util.replace_substitutions( apex_exec.get_varchar2( l_context, column_position( l_context, l_url ) ), false );
        end if;
        if l_notes is not null then
            l_pos := column_position( l_context, l_notes );
            l_doc.annotations := case
                                     when apex_exec.get_column( l_context, l_pos ).data_type = apex_exec.c_data_type_clob
                                         then apex_exec.get_clob( l_context, l_pos )
                                     else to_clob( apex_exec.get_varchar2( l_context, l_pos ) )
                                 end;
        end if;
    end if;
    apex_exec.close( l_context );
    return l_doc;
exception
    when others then
        apex_exec.close( l_context );
        raise;
end first_document;

procedure render (
    p_plugin in            apex_plugin.t_plugin,
    p_region in            apex_plugin.t_region,
    p_param  in            apex_plugin.t_region_render_param,
    p_result in out nocopy apex_plugin.t_region_render_result )
is
    l_doc  t_doc := first_document( p_region );
    l_json clob;
begin
    apex_json.initialize_clob_output;
    apex_json.open_object;
    apex_json.write( 'ajaxIdentifier', apex_plugin.get_ajax_identifier );
    apex_json.write( 'itemsToSubmit', apex_plugin_util.page_item_names_to_jquery( p_region.ajax_items_to_submit ) );
    apex_json.write( 'noDataFound', apex_plugin_util.replace_substitutions( p_region.no_data_found_message, false ) );
    apex_json.write( 'filePrefix', p_plugin.file_prefix );
    apex_json.write( 'tools', p_region.attributes.get_varchar2( 'TOOLS' ) );
    apex_json.write( 'stamps', p_region.attributes.get_varchar2( 'STAMPS' ) );
    apex_json.write( 'colors', p_region.attributes.get_varchar2( 'COLORS' ) );
    apex_json.write( 'author', p_region.attributes.get_varchar2( 'AUTHOR', p_do_substitutions => true ) );
    apex_json.write( 'mode', p_region.attributes.get_varchar2( 'MODE' ) );
    apex_json.write( 'saveMode', case when p_region.attributes.get_varchar2( 'SAVE_CODE' ) is null then 'none' else p_region.attributes.get_varchar2( 'SAVE_MODE' ) end );
    apex_json.write( 'features', p_region.attributes.get_varchar2( 'FEATURES' ) );
    apex_json.write( 'height', p_region.attributes.get_number( 'HEIGHT' ) );
    if l_doc.id is not null then
        apex_json.open_object( 'document' );
        apex_json.write( 'id', l_doc.id );
        apex_json.write( 'name', l_doc.name );
        apex_json.write( 'url', l_doc.url );
        apex_json.write( 'hasContent', l_doc.content is not null and dbms_lob.getlength( l_doc.content ) > 0 );
        apex_json.close_object;
        if l_doc.annotations is not null then
            apex_json.write( 'annotations', l_doc.annotations );
        end if;
    end if;
    apex_json.close_object;
    l_json := apex_json.get_clob_output;
    apex_json.free_output;

    sys.htp.p( '<div id="' || apex_escape.html_attribute( p_region.static_id ) || '_annotator" class="tx-PdfAnnot" style="height:'
               || nvl( p_region.attributes.get_number( 'HEIGHT' ), 720 ) || 'px"></div>' );
    sys.htp.p( '<script type="application/json" id="' || apex_escape.html_attribute( p_region.static_id ) || '_annotations">' );
    apex_util.prn( p_clob => replace( l_json, '</', '<\/' ), p_escape => false );
    sys.htp.p( '</script>' );
    dbms_lob.freetemporary( l_json );

    apex_javascript.add_onload_code(
        p_code => 'techrevx.pdfAnnotator.init(' || apex_javascript.add_value( p_region.static_id, false ) || ');' );
end render;

procedure ajax (
    p_plugin in            apex_plugin.t_plugin,
    p_region in            apex_plugin.t_region,
    p_param  in            apex_plugin.t_region_ajax_param,
    p_result in out nocopy apex_plugin.t_region_ajax_result )
is
    l_doc    t_doc;
    l_params apex_exec.t_parameters;
begin
    l_doc := first_document( p_region );
    if l_doc.id is null or l_doc.id <> apex_application.g_x02 then
        raise_application_error( -20002, 'PDF Annotation: unknown document.' );
    end if;

    if apex_application.g_x01 = 'FILE' then
        if l_doc.content is null then
            sys.owa_util.status_line( 404, 'Not Found', false );
            sys.owa_util.http_header_close;
            apex_application.stop_apex_engine;
        end if;
        sys.htp.init;
        sys.owa_util.mime_header( 'application/pdf', false );
        sys.htp.p( 'Content-Length: ' || dbms_lob.getlength( l_doc.content ) );
        sys.htp.p( 'Content-Disposition: inline; filename="' || regexp_replace( l_doc.name, '["\\' || chr(10) || chr(13) || ']', '_' ) || '"' );
        sys.htp.p( 'X-Content-Type-Options: nosniff' );
        sys.htp.p( 'Cache-Control: private, max-age=300' );
        sys.owa_util.http_header_close;
        sys.wpg_docload.download_file( l_doc.content );
        apex_application.stop_apex_engine;

    elsif apex_application.g_x01 = 'SAVE' then
        if p_region.attributes.get_varchar2( 'MODE' ) = 'review' or p_region.attributes.get_varchar2( 'SAVE_CODE' ) is null then
            raise_application_error( -20003, 'PDF Annotation: saving is not enabled for this region.' );
        end if;
        apex_exec.add_parameter( l_params, 'ANNOTATIONS', apex_application.g_clob_01 );
        apex_exec.add_parameter( l_params, 'ID', l_doc.id );
        apex_exec.execute_plsql(
            p_plsql_code     => p_region.attributes.get_varchar2( 'SAVE_CODE' ),
            p_sql_parameters => l_params );
        apex_json.open_object;
        apex_json.write( 'saved', true );
        apex_json.close_object;
    end if;
end ajax;
