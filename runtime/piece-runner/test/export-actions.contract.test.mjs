import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pieceCatalog } from '../catalog.mjs';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(packageRoot, 'package.json'));
const installedOptions = { skip: pieceCatalog.entries.some((entry) => !existsSync(join(packageRoot, 'node_modules', entry.piece, 'package.json'))) ? 'Pinned packages are unavailable; run installed-piece checks in the runner image.' : false };
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
test('exports installed action props, required flags, auth kinds and deterministic action ids', installedOptions, async () => {
  const exported = pieceCatalog.exportActions({});
  assert.deepEqual(JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8')), exported);
  assert.deepEqual(exported.map((item) => item.id), ['send_channel_message', 'get_channel_history', 'slack_list_channels', 'search_messages', 'send_message_with_bot', 'discord_list_messages', 'discord_find_member', 'list_guild_members', 'get-many-rows', 'find_rows', 'find_row_by_num', 'insert_row', 'google-sheets-insert-multiple-rows', 'update_row', 'find_spreadsheets', 'google_calendar_find_busy_free_periods', 'google_calendar_get_events', 'google_calendar_get_event_by_id', 'create_google_calendar_event', 'update_event', 'search-folder', 'create_new_gdrive_folder',
    'outlook_send_email', 'outlook_reply_to_message', 'outlook_forward_message', 'outlook_search_messages', 'outlook_list_messages', 'outlook_get_message', 'find_email',
    'list_events', 'create_event',
    'microsoft_teams_send_channel_message', 'microsoft_teams_reply_to_channel_message', 'microsoft_teams_send_chat_message', 'microsoft_teams_find_channel', 'microsoft_teams_get_channel_message',
    'get_workbooks', 'get_worksheets', 'get_worksheet_rows', 'append_row', 'append_multiple_rows', 'update_row',
    'onedrive_search_items', 'onedrive_list_folder_children', 'onedrive_get_item', 'onedrive_create_folder', 'onedrive_create_text_file', 'onedrive_move_item', 'list_folders',
    'microsoft_sharepoint_find_site', 'microsoft_sharepoint_get_folder_contents', 'microsoft_sharepoint_find_file', 'microsoft_sharepoint_search_list_item', 'microsoft_sharepoint_create_folder', 'microsoft_sharepoint_create_list_item',
    'create_record', 'get_record', 'find_record', 'update_record', 'add_comment', 'resolve_incident', 'count_records', 'search_knowledge_articles',
    'get_envelope', 'list_envelopes', 'list_templates', 'find_envelope_recipients', 'create_order', 'find_order', 'find_shipping_label',
    ...Array(2).fill(['find_invoice', 'find_customer', 'find_payment', 'find_vendor', 'find_account', 'read_aging_report', 'create_invoice', 'create_bill', 'create_vendor', 'record_payment', 'record_bill_payment']).flat(),
    'xero_find_contact', 'xero_find_invoice', 'xero_get_invoice', 'xero_search_invoices', 'xero_search_payments', 'xero_get_aged_receivables', 'xero_get_aged_payables', 'xero_list_accounts', 'xero_list_organisations', 'xero_create_contact', 'xero_create_invoice', 'xero_create_bill', 'xero_create_payment',
    'get-record', 'search-records', 'create-record', 'update-record',
    'get_order', 'search_orders', 'list_order_fulfillment_orders', 'get_fulfillment_order', 'create_fulfillment', 'update_fulfillment_tracking', 'list_locations', 'list_inventory_levels', 'get_inventory_item', 'adjust_inventory_quantities', 'get_product', 'search_products',
    'create_task', 'get_task', 'get_tasks', 'update_task', 'complete_task', 'get_worker', 'get_teams', 'get_hubs']);
  for (const entry of pieceCatalog.entries) {
    const piece = require(entry.piece)[entry.exportName], action = piece.getAction(entry.action);
    const metadata = exported.find((item) => item.piece === entry.piece && item.action === entry.action);
    assert.deepEqual([metadata.version, metadata.description], [require(`${entry.piece}/package.json`).version, action.description]);
    assert.deepEqual(metadata.props, propsMetadata(action.props));
    const declarations = Array.isArray(piece.auth) ? piece.auth : [piece.auth];
    const declaration = declarations.find((auth) => auth.type === (entry.authType ?? declarations[0].type));
    assert.deepEqual(metadata.auth_kinds, declarations.map((auth) => auth.type));
    assert.deepEqual(metadata.auth, { kind: declaration.type, props: ['CUSTOM_AUTH', 'OAUTH2'].includes(declaration.type) && declaration.props !== undefined ? propsMetadata(declaration.props) : {} });
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
  assert.equal(exported.length, 129);
  for (const item of exported) {
    assert.ok(['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'].includes(item.auth.kind));
    const entry = pieceCatalog.entries.find((entry) => entry.piece === item.piece && entry.action === item.action);
    assert.equal(item.auth.kind, entry.authType ?? item.auth_kinds[0]);
  }
  const serviceNow = exported.find((item) => item.piece === '@activepieces/piece-service-now').auth;
  assert.deepEqual(Object.keys(serviceNow.props), ['instanceUrl', 'username', 'password']);
  assert.ok(Object.values(serviceNow.props).every((prop) => prop.required && prop.type === 'SHORT_TEXT'));
  const docusign = exported.find((item) => item.piece === '@activepieces/piece-docusign').auth;
  assert.equal(docusign.props.privateKey.type, 'SECRET_TEXT');
  assert.deepEqual(docusign.props.environment.options.map((option) => option.value), ['demo', 'www', 'eu']);
  assert.equal(exported.find((item) => item.piece === '@activepieces/piece-shippo').auth.kind, 'SECRET_TEXT');
  for (const [piece, version, count, kind, kinds] of [['@activepieces/piece-shopify', '0.9.1', 12, 'OAUTH2', ['CUSTOM_AUTH', 'OAUTH2']], ['@activepieces/piece-onfleet', '0.2.0', 8, 'SECRET_TEXT', ['SECRET_TEXT']]]) {
    const records = exported.filter((record) => record.piece === piece);
    assert.equal(records.length, count);
    for (const record of records) {
      assert.deepEqual([record.version, record.auth_kinds, record.auth.kind], [version, kinds, kind]);
      assert.deepEqual(Object.keys(record.auth.props), kind === 'OAUTH2' ? ['shopName'] : []);
      if (kind === 'OAUTH2') assert.deepEqual([record.auth.props.shopName.type, record.auth.props.shopName.required], ['SHORT_TEXT', true]);
    }
  }
  const props = { password: { type: 'SHORT_TEXT', displayName: 'Secret API password', description: 'Secret credential', required: true }, privateKey: { type: 'SECRET_TEXT', displayName: 'Key', required: true } };
  assert.deepEqual(pieceCatalog.exportAuth({ piece: { auth: { type: 'CUSTOM_AUTH', props } } }), { kind: 'CUSTOM_AUTH', props: propsMetadata(props) });
  assert.notEqual(pieceCatalog.exportAuth({ piece: { auth: { type: 'CUSTOM_AUTH', props } } }).props.password.type, 'SECRET_TEXT');
  for (const kind of ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH']) assert.deepEqual(pieceCatalog.exportAuth({ piece: { auth: { type: kind } } }), { kind, props: {} });
  const oauthProps = { shopName: { type: 'SHORT_TEXT', displayName: 'Shop Name', required: true } };
  const multi = { auth: [{ type: 'CUSTOM_AUTH', props }, { type: 'OAUTH2', props: oauthProps }] };
  assert.deepEqual(pieceCatalog.exportAuth({ piece: multi, authType: 'OAUTH2' }), { kind: 'OAUTH2', props: propsMetadata(oauthProps) });
  assert.deepEqual(pieceCatalog.exportAuth({ piece: multi, authType: 'CUSTOM_AUTH' }), { kind: 'CUSTOM_AUTH', props: propsMetadata(props) });
  for (const authType of [undefined, 'BASIC_AUTH']) assert.throws(() => pieceCatalog.exportAuth({ piece: multi, authType }), { name: 'RunnerRefusal', code: 'AUTH_TYPE_MISMATCH' });
  assert.throws(() => pieceCatalog.exportAuth({ piece: { auth: [...multi.auth, multi.auth[1]] }, authType: 'OAUTH2' }), { name: 'RunnerRefusal', code: 'AUTH_TYPE_MISMATCH' });
});
test('exports 39 admitted finance actions and OAuth2 auth props through stubbed pieces', async () => {
  const exported = JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8'));
  const companyId = { type: 'SHORT_TEXT', displayName: 'Company ID', required: true };
  const quickbooksAuth = { kind: 'OAUTH2', props: { companyId: { type: 'SHORT_TEXT', required: true, description: '', display_name: 'Company ID' } } };
  const businessCentralPiece = '@activepieces/piece-microsoft-dynamics-365-business-central';
  const businessCentralAuth = { type: 'OAUTH2', props: {
    cloud: { type: 'STATIC_DROPDOWN', displayName: 'Cloud Environment', description: 'Select your Microsoft cloud environment.', required: true, defaultValue: 'login.microsoftonline.com', options: { options: [{ label: 'Commercial (Global)', value: 'login.microsoftonline.com' }, { label: 'US Government (GCC High)', value: 'login.microsoftonline.us' }] } },
    environment: { type: 'SHORT_TEXT', displayName: 'Environment', description: "Name of the environment to connect to, e.g. 'Production' or 'Sandbox'. Environment names can be found in the Business Central Admin Center.", required: true, defaultValue: 'Production' },
  } };
  const businessCentralLoaders = {
    company_id: { type: 'DROPDOWN', displayName: 'Company', required: true, refreshers: [] },
    record_filter_fields: { type: 'DYNAMIC', displayName: 'Filter Fields', required: true, refreshers: ['company_id', 'record_type'] },
    record_fields: { type: 'DYNAMIC', displayName: 'Record Fields', required: true, refreshers: ['company_id', 'record_type'] },
  };
  assert.deepEqual(pieceCatalog.exportAuth({ piece: { auth: { type: 'OAUTH2', props: { companyId } } } }), quickbooksAuth);
  for (const [piece, version, count] of [['@activepieces/piece-quickbooks', '0.3.3', 11], ['@activepieces/piece-quickbooks-sandbox', '0.2.2', 11], ['@activepieces/piece-xero', '0.8.1', 13], [businessCentralPiece, '0.3.0', 4]]) {
    const records = exported.filter((item) => item.piece === piece);
    assert.equal(records.length, count);
    assert.deepEqual(records.map(({ action }) => action), pieceCatalog.entries.filter((entry) => entry.piece === piece).map(({ action }) => action));
    for (const record of records) {
      assert.equal(record.version, version);
      assert.deepEqual(record.auth_kinds, ['OAUTH2']);
      assert.deepEqual(record.auth, piece === businessCentralPiece ? { kind: 'OAUTH2', props: propsMetadata(businessCentralAuth.props) } : piece === '@activepieces/piece-xero' ? { kind: 'OAUTH2', props: {} } : quickbooksAuth);
      if (record.props.tenant_id) assert.deepEqual(record.props.tenant_id, { type: 'DROPDOWN', required: true, description: '', display_name: 'Organization', refreshers: [], refresh_on_search: false });
    }
  }
  const businessCentralRecords = exported.filter((record) => record.piece === businessCentralPiece);
  assert.deepEqual(businessCentralRecords.map(({ action }) => action), ['get-record', 'search-records', 'create-record', 'update-record']);
  for (const record of businessCentralRecords) {
    assert.deepEqual(record.props.company_id, propsMetadata(businessCentralLoaders).company_id);
    const fields = { 'get-record': ['company_id', 'record_type', 'record_id'], 'search-records': ['company_id', 'record_type', 'markdown', 'record_filter_fields'], 'create-record': ['company_id', 'record_type', 'record_fields'], 'update-record': ['company_id', 'record_type', 'record_id', 'record_fields'] }[record.action];
    assert.deepEqual(Object.keys(record.props), fields);
    for (const name of fields.filter((name) => name.startsWith('record_') && name.endsWith('fields'))) assert.deepEqual(record.props[name], propsMetadata(businessCentralLoaders)[name]);
  }
  const stubRepository = await mkdtemp(join(tmpdir(), 'piece-runner-export-stub-'));
  const stubRoot = join(stubRepository, 'runtime/piece-runner');
  try {
    await mkdir(stubRoot, { recursive: true });
    for (const filename of ['package.json', 'package-lock.json', 'catalog.mjs', 'errors.mjs', 'export-actions.mjs']) await writeFile(join(stubRoot, filename), await readFile(join(packageRoot, filename), 'utf8'));
    const declarations = (props) => Object.fromEntries(Object.entries(props).map(([name, prop]) => [name, { type: prop.type, required: prop.required, description: prop.description, displayName: prop.display_name, ...(Object.hasOwn(prop, 'default') ? { defaultValue: prop.default } : {}), ...(prop.options ? { options: { options: prop.options } } : {}), ...(prop.refreshers ? { refreshers: prop.refreshers, refreshOnSearch: prop.refresh_on_search } : {}), ...(prop.properties ? { properties: declarations(prop.properties) } : {}) }]));
    for (const entry of [...new Map(pieceCatalog.entries.map((entry) => [entry.piece, entry])).values()]) {
      const records = exported.filter((record) => record.piece === entry.piece);
      const [record] = records;
      const pieceAuth = record.auth_kinds.map((type) => ({ type, ...(type === record.auth.kind && ['CUSTOM_AUTH', 'OAUTH2'].includes(type) && Object.keys(record.auth.props).length ? { props: declarations(record.auth.props) } : {}), ...(entry.forkDirectory === 'shopify' && type === 'CUSTOM_AUTH' ? { props: { shopName: { type: 'SHORT_TEXT', required: true }, adminToken: { type: 'SECRET_TEXT', required: true } } } : {}) }));
      const auth = entry.piece === businessCentralPiece ? [businessCentralAuth] : pieceAuth;
      const actions = Object.fromEntries(records.map((record) => [record.action, { displayName: record.display_name, description: record.description, props: { ...declarations(record.props), ...(entry.piece === businessCentralPiece ? Object.fromEntries(Object.keys(record.props).filter((name) => businessCentralLoaders[name]).map((name) => [name, businessCentralLoaders[name]])) : {}) } }]));
      const target = join(stubRoot, 'node_modules', entry.piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `const actions = ${JSON.stringify(actions)}; module.exports = { ${entry.exportName}: { auth: ${JSON.stringify(auth)}, getAction: (name) => ({ ...actions[name], run: () => { throw new Error('Export must not run an action'); } }) } };`);
      const forkManifest = join(stubRepository, `packages/pieces/community/${entry.forkDirectory}/package.json`);
      await mkdir(dirname(forkManifest), { recursive: true });
      await writeFile(forkManifest, await readFile(resolve(packageRoot, '../..', `packages/pieces/community/${entry.forkDirectory}/package.json`), 'utf8'));
    }
    assert.deepEqual(pieceCatalog.exportActions({ packageRoot: stubRoot, repositoryRoot: stubRepository }), exported);
    await promisify(execFile)(process.execPath, ['export-actions.mjs', 'actions.json'], { cwd: stubRoot, env: {} });
    assert.equal(await readFile(join(stubRoot, 'actions.json'), 'utf8'), await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8'));
    const stub = createRequire(join(stubRoot, 'package.json'))(businessCentralPiece).microsoftDynamics365BusinessCentral;
    stub.auth[0].props = {};
    assert.throws(() => assert.deepEqual(pieceCatalog.exportActions({ packageRoot: stubRoot, repositoryRoot: stubRepository }), exported), { code: 'ERR_ASSERTION' });
  } finally { await rm(stubRepository, { recursive: true, force: true }); }
});
test('exports six trigger read actions with admitted auth and declared props', async () => {
  const exported = JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8'));
  for (const [directory, action, id, version, kind, props] of [
    ['slack', 'getChannelHistory', 'get_channel_history', '0.21.1', 'OAUTH2', ['info', 'onlyBotChannels', 'channel', 'oldest', 'latest', 'inclusive', 'includeAllMetadata']],
    ['slack', 'slack_list_channels', 'slack_list_channels', '0.21.1', 'OAUTH2', ['types', 'excludeArchived']],
    ['slack', 'searchMessages', 'search_messages', '0.21.1', 'OAUTH2', ['query']],
    ['discord', 'discord_list_messages', 'discord_list_messages', '0.7.2', 'SECRET_TEXT', ['channel_id', 'limit', 'before', 'after', 'around']],
    ['discord', 'discord_find_member', 'discord_find_member', '0.7.2', 'SECRET_TEXT', ['guild_id', 'query', 'limit']],
    ['google-sheets', 'find_spreadsheets', 'find_spreadsheets', '0.17.2', 'OAUTH2', ['includeTeamDrives', 'spreadsheet_name', 'exact_match']],
  ]) {
    const piece = `@activepieces/piece-${directory}`, entry = pieceCatalog.validateTuple({ piece, action, version }), record = exported.find((item) => item.piece === piece && item.action === action);
    assert.ok(record, `Missing exported read action ${piece}/${action}`);
    assert.deepEqual([record.id, record.version, record.auth, record.auth_kinds, entry.authType], [id, version, { kind, props: {} }, kind === 'OAUTH2' ? ['OAUTH2', 'CUSTOM_AUTH'] : ['SECRET_TEXT'], kind === 'OAUTH2' ? kind : undefined]);
    assert.deepEqual([Object.keys(record.props), Object.values(record.props).some((prop) => prop.type === 'FILE')], [props, false]);
  }
});
test('exports three borrowed-loader read actions with admitted auth and dropdown metadata', async () => {
  const exported = JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8'));
  for (const [directory, action, id, version, property, refreshers, kind] of [
    ['microsoft-outlook', 'findEmail', 'find_email', '0.7.2', 'folderId', [], 'OAUTH2'],
    ['microsoft-onedrive', 'list_folders', 'list_folders', '0.6.1', 'parentFolder', ['auth'], 'OAUTH2'],
    ['discord', 'list_guild_members', 'list_guild_members', '0.7.2', 'guild_id', [], 'SECRET_TEXT'],
  ]) {
    const piece = `@activepieces/piece-${directory}`, record = exported.find((item) => item.piece === piece && item.action === action);
    assert.ok(record, `Missing borrowed-loader read action ${piece}/${action}`);
    const sibling = exported.find((item) => item.piece === piece && item.action !== action);
    assert.deepEqual([record.id, record.version, record.auth.kind, record.auth, record.auth_kinds], [id, version, kind, sibling.auth, sibling.auth_kinds]);
    assert.deepEqual([record.props[property].type, record.props[property].refreshers, record.props[property].refresh_on_search], ['DROPDOWN', refreshers, false]);
    if (!installedOptions.skip) {
      assert.equal(typeof pieceCatalog.validateLoader({ request: { piece, action, version, property, mode: 'options' } }).declaration.options, 'function');
      assert.throws(() => pieceCatalog.validateLoader({ request: { piece, action, version, property, mode: 'props' } }), { name: 'RunnerRefusal', code: 'PROPERTY_NOT_LOADABLE' });
    }
  }
});
test('adds admitted exports without changing any pre-existing record bytes', async () => {
  const source = await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8');
  assertExistingRecordBytes({ source });
  const changed = source.replace('"version": "0.21.1"', '"version": "0.0.0"');
  assert.notEqual(changed, source);
  assert.throws(() => assertExistingRecordBytes({ source: changed }), { code: 'ERR_ASSERTION' });
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
    for (const forkDirectory of ['slack', 'google-sheets', 'google-calendar', 'google-drive', 'microsoft-outlook', 'microsoft-outlook-calendar', 'microsoft-teams', 'microsoft-excel-365', 'microsoft-onedrive', 'microsoft-sharepoint', 'service-now', 'docusign', 'shippo', 'quickbooks', 'quickbooks-sandbox', 'xero', 'microsoft-dynamics-365-business-central', 'shopify', 'onfleet']) {
      const target = join(repositoryRoot, `packages/pieces/community/${forkDirectory}/package.json`), original = await readFile(target, 'utf8');
      await writeFile(target, JSON.stringify({ version: '0.0.0' }));
      assert.throws(() => pieceCatalog.verifyVersions({ repositoryRoot }), { name: 'RunnerRefusal', code: 'VERSION_MISMATCH' });
      await writeFile(target, original);
    }
  } finally { await rm(repositoryRoot, { recursive: true, force: true }); }
});

function assertExistingRecordBytes({ source }) {
  const borrowedActions = new Set(['@activepieces/piece-microsoft-outlook/findEmail', '@activepieces/piece-microsoft-onedrive/list_folders', '@activepieces/piece-discord/list_guild_members']);
  const allRecords = source.slice(2, -3).split(/,\n(?=  {\n    "piece": )/), baseline = allRecords.filter((record) => {
    const { piece, action } = JSON.parse(record);
    return !borrowedActions.has(`${piece}/${action}`);
  });
  assert.equal(allRecords.length - baseline.length, 3);
  assert.equal(baseline.length, 126);
  source = `[\n${baseline.join(',\n')}\n]\n`;
  assert.equal(createHash('sha256').update(source).digest('hex'), 'a49a934c93d266884d912615e693d514b09f30e711c59e4ee72d2d0d1e9e0d75');
  const triggerReadActions = new Set(['getChannelHistory', 'slack_list_channels', 'searchMessages', 'discord_list_messages', 'discord_find_member', 'find_spreadsheets']);
  const records = source.slice(2, -3).split(/,\n(?=  {\n    "piece": )/), existing = records.filter((record) => !triggerReadActions.has(JSON.parse(record).action));
  assert.equal(records.length - existing.length, 6);
  source = `[\n${existing.join(',\n')}\n]\n`;
  assert.equal(createHash('sha256').update(source).digest('hex'), '8f7e2ab822521ca382ea5ef188ae8c6d6f1d15f8b84efedb98af798ecf648bdc');
  const boundary = source.indexOf(',\n  {\n    "piece": "@activepieces/piece-microsoft-dynamics-365-business-central"');
  assert.ok(boundary > 0);
  assert.equal(createHash('sha256').update(`${source.slice(0, boundary)}\n]\n`).digest('hex'), '343d46e23d66886ac72166c0750ec78a64875929ea4107b5b5110b1bbdb39670');
  const fulfillmentBoundary = source.indexOf(',\n  {\n    "piece": "@activepieces/piece-shopify"');
  assert.ok(fulfillmentBoundary > boundary);
  assert.equal(createHash('sha256').update(`${source.slice(0, fulfillmentBoundary)}\n]\n`).digest('hex'), 'f0a2481a3abf3c1aab295c36f41bf15d875d3e1a7be70550bfbe56a4089e44c6');
}
