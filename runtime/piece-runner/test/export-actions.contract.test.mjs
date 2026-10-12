import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pieceCatalog } from '../catalog.mjs';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(packageRoot, 'package.json'));
function propsMetadata(declarations) {
  return Object.fromEntries(Object.entries(declarations).map(([name, prop]) => [name, {
    type: prop.type, required: prop.required, description: prop.description ?? '', display_name: prop.displayName,
    ...(prop.defaultValue !== undefined ? { default: prop.defaultValue } : {}),
    ...(['STATIC_DROPDOWN', 'STATIC_MULTI_SELECT_DROPDOWN'].includes(prop.type) ? { options: prop.options.options.map(({ label, value }) => ({ label, value })) } : {}),
    ...(['DROPDOWN', 'MULTI_SELECT_DROPDOWN', 'DYNAMIC'].includes(prop.type) ? { refreshers: prop.refreshers ?? [] } : {}),
    ...(['DROPDOWN', 'MULTI_SELECT_DROPDOWN'].includes(prop.type) ? { refresh_on_search: prop.refreshOnSearch ?? false } : {}),
    ...(prop.properties ? { properties: propsMetadata(prop.properties) } : {}),
  }]));
}
test('exports installed action props, required flags, auth kinds and deterministic action ids', async () => {
  const exported = pieceCatalog.exportActions({});
  assert.deepEqual(JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8')), exported);
  assert.deepEqual(exported.map((item) => item.id), ['send_channel_message', 'send_message_with_bot', 'get-many-rows', 'find_rows', 'find_row_by_num', 'insert_row', 'google-sheets-insert-multiple-rows', 'update_row', 'google_calendar_find_busy_free_periods', 'google_calendar_get_events', 'google_calendar_get_event_by_id', 'create_google_calendar_event', 'update_event', 'search-folder', 'create_new_gdrive_folder',
    'outlook_send_email', 'outlook_reply_to_message', 'outlook_forward_message', 'outlook_search_messages', 'outlook_list_messages', 'outlook_get_message',
    'list_events', 'create_event',
    'microsoft_teams_send_channel_message', 'microsoft_teams_reply_to_channel_message', 'microsoft_teams_send_chat_message', 'microsoft_teams_find_channel', 'microsoft_teams_get_channel_message',
    'get_workbooks', 'get_worksheets', 'get_worksheet_rows', 'append_row', 'append_multiple_rows', 'update_row',
    'onedrive_search_items', 'onedrive_list_folder_children', 'onedrive_get_item', 'onedrive_create_folder', 'onedrive_create_text_file', 'onedrive_move_item',
    'microsoft_sharepoint_find_site', 'microsoft_sharepoint_get_folder_contents', 'microsoft_sharepoint_find_file', 'microsoft_sharepoint_search_list_item', 'microsoft_sharepoint_create_folder', 'microsoft_sharepoint_create_list_item',
    'create_record', 'get_record', 'find_record', 'update_record', 'add_comment', 'resolve_incident', 'count_records', 'search_knowledge_articles',
    'get_envelope', 'list_envelopes', 'list_templates', 'find_envelope_recipients', 'create_order', 'find_order', 'find_shipping_label']);
  for (const entry of pieceCatalog.entries) {
    const piece = require(entry.piece)[entry.exportName], action = piece.getAction(entry.action);
    const metadata = exported.find((item) => item.piece === entry.piece && item.action === entry.action);
    assert.deepEqual([metadata.version, metadata.description], [require(`${entry.piece}/package.json`).version, action.description]);
    assert.deepEqual(metadata.props, propsMetadata(action.props));
    const declarations = Array.isArray(piece.auth) ? piece.auth : [piece.auth];
    assert.deepEqual(metadata.auth_kinds, declarations.map((auth) => auth.type));
    assert.deepEqual(metadata.auth, { kind: declarations[0].type, props: declarations[0].type === 'CUSTOM_AUTH' ? propsMetadata(declarations[0].props) : {} });
  }
  const calendar = exported.find((item) => item.piece === '@activepieces/piece-google-calendar' && item.action === 'update_event');
  assert.deepEqual(calendar.props.guests_can_modify.options, [{ label: 'Yes', value: true }, { label: 'No', value: false }]);
  const teams = exported.find((item) => item.piece === '@activepieces/piece-microsoft-teams' && item.action === 'microsoft_teams_send_channel_message');
  assert.deepEqual(teams.props.contentType.options, [{ label: 'Text', value: 'text' }, { label: 'HTML', value: 'html' }]);
  assert.equal(teams.props.contentType.default, 'text');
  assert.deepEqual(teams.props.channelId.refreshers, ['teamId']);
  assert.equal(teams.props.channelId.refresh_on_search, false);
  const excel = exported.find((item) => item.piece === '@activepieces/piece-microsoft-excel-365' && item.action === 'append_row');
  assert.deepEqual(excel.props.values, { type: 'DYNAMIC', required: true, description: 'The values to insert', display_name: 'Values', refreshers: ['storageSource', 'siteId', 'documentId', 'workbookId', 'worksheetId', 'isFirstRowHeaders'] });
  const drive = exported.find((item) => item.piece === '@activepieces/piece-google-drive' && item.action === 'create_new_gdrive_folder');
  assert.equal(drive.props.parentFolder.refresh_on_search, true);
  const directory = await mkdtemp(join(tmpdir(), 'piece-runner-export-'));
  try {
    const output = join(directory, 'actions.json');
    await promisify(execFile)(process.execPath, [join(packageRoot, 'export-actions.mjs'), output], { env: {} });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), exported);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('exports typed auth declarations and generated credential fields without inferring secrets', async () => {
  const exported = JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8'));
  assert.equal(exported.length, 61);
  for (const item of exported) {
    assert.ok(['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'].includes(item.auth.kind));
    assert.equal(item.auth.kind, item.auth_kinds[0]);
  }
  const serviceNow = exported.find((item) => item.piece === '@activepieces/piece-service-now').auth;
  assert.deepEqual(Object.keys(serviceNow.props), ['instanceUrl', 'username', 'password']);
  assert.ok(Object.values(serviceNow.props).every((prop) => prop.required && prop.type === 'SHORT_TEXT'));
  const docusign = exported.find((item) => item.piece === '@activepieces/piece-docusign').auth;
  assert.equal(docusign.props.privateKey.type, 'SECRET_TEXT');
  assert.deepEqual(docusign.props.environment.options.map((option) => option.value), ['demo', 'www', 'eu']);
  assert.equal(exported.find((item) => item.piece === '@activepieces/piece-shippo').auth.kind, 'SECRET_TEXT');
  const props = { password: { type: 'SHORT_TEXT', displayName: 'Secret API password', description: 'Secret credential', required: true }, privateKey: { type: 'SECRET_TEXT', displayName: 'Key', required: true } };
  assert.deepEqual(pieceCatalog.exportAuth({ piece: { auth: { type: 'CUSTOM_AUTH', props } } }), { kind: 'CUSTOM_AUTH', props: propsMetadata(props) });
  assert.notEqual(pieceCatalog.exportAuth({ piece: { auth: { type: 'CUSTOM_AUTH', props } } }).props.password.type, 'SECRET_TEXT');
  for (const kind of ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH']) assert.deepEqual(pieceCatalog.exportAuth({ piece: { auth: { type: kind } } }), { kind, props: {} });
  assert.deepEqual(pieceCatalog.exportAuth({ piece: { auth: [{ type: 'OAUTH2' }, { type: 'CUSTOM_AUTH', props }] } }), { kind: 'OAUTH2', props: {} });
});
test('preserves JSON defaults including false, zero, empty strings and null', () => {
  const values = [false, 0, '', null, undefined, () => true, NaN, Infinity, { omitted: undefined }];
  const props = pieceCatalog.exportProps({ declarations: Object.fromEntries(values.map((defaultValue, name) => [name, { type: 'SHORT_TEXT', displayName: 'Value', required: false, defaultValue }])) });
  assert.deepEqual(Object.values(props).map((prop) => Object.hasOwn(prop, 'default') ? prop.default : 'omitted'), [false, 0, '', null, 'omitted', 'omitted', 'omitted', 'omitted', 'omitted']);
});
test('fails closed when a pinned piece version differs from the fork', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'piece-runner-version-'));
  try {
    for (const path of [...new Set(pieceCatalog.entries.map((entry) => `packages/pieces/community/${entry.forkDirectory}/package.json`))]) {
      const target = join(repositoryRoot, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readFile(resolve(packageRoot, '../..', path), 'utf8'));
    }
    for (const forkDirectory of ['slack', 'google-sheets', 'google-calendar', 'google-drive', 'microsoft-outlook', 'microsoft-outlook-calendar', 'microsoft-teams', 'microsoft-excel-365', 'microsoft-onedrive', 'microsoft-sharepoint', 'service-now', 'docusign', 'shippo']) {
      const target = join(repositoryRoot, `packages/pieces/community/${forkDirectory}/package.json`), original = await readFile(target, 'utf8');
      await writeFile(target, JSON.stringify({ version: '0.0.0' }));
      assert.throws(() => pieceCatalog.verifyVersions({ repositoryRoot }), { name: 'RunnerRefusal', code: 'VERSION_MISMATCH' });
      await writeFile(target, original);
    }
  } finally { await rm(repositoryRoot, { recursive: true, force: true }); }
});
