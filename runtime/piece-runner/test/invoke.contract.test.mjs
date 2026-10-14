import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pieceRunner } from '../index.mjs';
import { runnerErrors } from '../errors.mjs';
import { pieceCatalog } from '../catalog.mjs';
import { runnerExecution } from '../execution.mjs';
function requestTuple({ piece, action }) {
  const entry = pieceCatalog.entries.find((candidate) => candidate.piece === piece && candidate.action === action);
  assert.ok(entry, `Missing allowlisted action ${piece}/${action}`);
  return { piece, version: entry.version, action };
}
const discord = { ...requestTuple({ piece: '@activepieces/piece-discord', action: 'sendMessageWithBot' }), auth_type: 'API_KEY', auth: { type: 'API_KEY', apiKey: 'discord-contract-token' }, allowed_hosts: ['discord.com'], props: { channel_id: 'C123', message: 'contract message' }, timeout_ms: 15000 };
const slack = { ...requestTuple({ piece: '@activepieces/piece-slack', action: 'send_channel_message' }), auth_type: 'OAUTH2', auth: { type: 'OAUTH2', access_token: 'slack-contract-token', raw: { team: { id: 'contract-team' } } }, props: { channel: 'C123', sendAsBot: true, text: 'contract message' }, timeout_ms: 15000 };
const teams = { ...requestTuple({ piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_send_channel_message' }), auth_type: 'OAUTH2', auth: { access_token: 'teams-contract-token', raw: {} }, props: { teamId: 'contract-team' }, timeout_ms: 15000 };
const output = { id: 'message-123', content: 'contract message', nested: { untouched: true } };
const installedOptions = { skip: pieceCatalog.entries.some((entry) => !existsSync(new URL(`../node_modules/${entry.piece}/package.json`, import.meta.url))) ? 'Pinned packages are unavailable; run installed-piece checks in the runner image.' : false };
const originalSpawn = childProcess.spawn;
let fixture;
let spawnCount = 0;
childProcess.spawn = (command, args, options) => {
  spawnCount += 1;
  assert.deepEqual(options.env, {}); assert.equal(args[0], `--max-old-space-size=${fixture.memoryMb}`);
  return originalSpawn(command, ['--require', fileURLToPath(new URL('./http-intercept.cjs', import.meta.url)), ...args, JSON.stringify(fixture)], options);
};
syncBuiltinESMExports(); after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
function run({ request = discord, body = output, status = 200, mode, url, method = 'POST', requests, memoryMb = request.memory_mb ?? 256 } = {}) {
  const authorization = request.piece === slack.piece ? `Bearer ${request.props.sendAsBot ?? true ? request.auth.access_token : (request.auth.raw ?? request.auth.data)?.authed_user?.access_token}` : request.piece === discord.piece ? `Bot ${request.auth.apiKey ?? request.auth.secret_text}` : `Bearer ${request.auth.access_token}`;
  fixture = { body, status, mode, method, requests, memoryMb, url: url ?? (request.piece === slack.piece ? 'https://slack.com/api/chat.postMessage' : 'https://discord.com/api/v10/channels/C123/messages'), authorization };
  return pieceRunner.invoke(request);
}
test('runs installed Discord and Slack actions in an empty child environment and preserves output', installedOptions, async () => {
  assert.deepEqual(await run(), { status: 'completed', output });
  assert.deepEqual(await run({ request: { ...discord, mode: 'run' } }), { status: 'completed', output });
  assert.deepEqual(await run({ request: { ...discord, auth: { secret_text: discord.auth.apiKey } } }), { status: 'completed', output });
  const slackOutput = { ok: true, channel: 'C123', ts: '123.456', message: { text: 'contract message' }, response_metadata: {} };
  assert.deepEqual(await run({ request: slack, body: slackOutput }), { status: 'completed', output: slackOutput });
  const { sendAsBot, ...withoutSender } = slack.props;
  assert.deepEqual(await run({ request: { ...slack, auth: { ...slack.auth, raw: { authed_user: { access_token: 'slack-user-contract-token' } } }, props: withoutSender }, body: slackOutput }), { status: 'completed', output: slackOutput });
  assert.deepEqual(await run({ request: { ...slack, auth: { access_token: slack.auth.access_token, data: slack.auth.raw } }, body: slackOutput }), { status: 'completed', output: slackOutput });
  const userAuth = { ...slack.auth, raw: { authed_user: { access_token: 'slack-user-contract-token' } } };
  assert.deepEqual(await run({ request: { ...slack, auth: userAuth, props: { ...slack.props, sendAsBot: false } }, body: slackOutput }), { status: 'completed', output: slackOutput });
});
test('Google Sheets passes the OAuth token through its nested HTTP client', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-google-sheets', action: 'get-many-rows' }), auth_type: 'OAUTH2', auth: { access_token: 'sheets-contract-token', data: {} }, props: { spreadsheetId: 'contract-sheet', sheetId: 0, first_row_headers: false }, timeout_ms: 15000 };
  const baseUrl = 'https://sheets.googleapis.com/v4/spreadsheets/contract-sheet';
  const requests = [{ url: baseUrl, method: 'GET', body: { sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] } }, { url: `${baseUrl}/values/Sheet1`, method: 'GET', body: {} }];
  assert.deepEqual(await run({ request, requests }), { status: 'completed', output: [] });
});
test('Slack history uses the OAuth token and refuses CustomAuth', installedOptions, async () => {
  const request = { ...requestTuple({ piece: slack.piece, action: 'getChannelHistory' }), auth_type: 'OAUTH2', auth: { access_token: 'slack-history-contract-token' }, props: { channel: 'C123' }, timeout_ms: 15000 };
  const messages = [{ ts: '123.456', text: 'Contract history' }];
  assert.deepEqual(await run({ request, body: { ok: true, messages, has_more: false, response_metadata: { next_cursor: '' } }, url: 'https://slack.com/api/conversations.history' }), { status: 'completed', output: messages });
  const result = await run({ request: { ...request, auth_type: 'CUSTOM_AUTH', auth: { props: { botToken: 'custom-contract-token' } }, allowed_hosts: ['slack.com'] } });
  assert.deepEqual([result.status, result.refusal?.code], ['refused', 'AUTH_TYPE_MISMATCH']);
});
test('Sheets spreadsheet search uses the OAuth token at the Drive host', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-google-sheets', action: 'find_spreadsheets' }), auth_type: 'OAUTH2', auth: { access_token: 'sheets-search-contract-token' }, props: { spreadsheet_name: 'Contract' }, timeout_ms: 15000 };
  const files = [{ id: 'contract-sheet', name: 'Contract sheet' }];
  const url = 'https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27+and+trashed%3Dfalse+and+name+contains+%27Contract%27&includeItemsFromAllDrives=false&supportsAllDrives=true&corpora=user&fields=files%28id%2Cname%2CwebViewLink%2CcreatedTime%2CmodifiedTime%29%2CnextPageToken';
  assert.deepEqual(await run({ request, body: { files }, method: 'GET', url }), { status: 'completed', output: { found: true, spreadsheets: files } });
});
test('Google Calendar passes the OAuth token through its nested HTTP client', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-google-calendar', action: 'google_calendar_get_event_by_id' }), auth_type: 'OAUTH2', auth: { access_token: 'calendar-contract-token', raw: {} }, props: { calendar_id: 'primary', event_id: 'contract-event' }, timeout_ms: 15000 };
  const body = { id: 'contract-event', summary: 'Contract event' };
  assert.deepEqual(await run({ request, body, method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/contract-event' }), { status: 'completed', output: body });
});
test('Google Drive passes the OAuth token, defaults to 256 MiB, honors a request limit and refuses requests above 512 MiB', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-google-drive', action: 'create_new_gdrive_folder' }), auth_type: 'OAUTH2', auth: { access_token: 'drive-contract-token', data: {} }, props: { folderName: 'Contract folder' }, timeout_ms: 15000 };
  const body = { id: 'contract-folder', name: 'Contract folder' };
  assert.deepEqual(await run({ request, body, url: 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=false', memoryMb: 256 }), { status: 'completed', output: body });
  assert.deepEqual(await run({ request: { ...request, memory_mb: 384 }, body, url: 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=false' }), { status: 'completed', output: body });
  const result = await run({ request: { ...request, memory_mb: 513 } });
  assert.deepEqual([result.status, result.refusal?.code], ['refused', 'INVALID_LIMIT']);
});
test('Microsoft Outlook passes the OAuth token to the default Graph mailbox', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_get_message' }), auth_type: 'OAUTH2', auth: { access_token: 'outlook-contract-token', raw: {} }, props: { messageId: 'contract-message' }, timeout_ms: 15000 };
  const body = { id: 'contract-message', subject: 'Contract message' };
  assert.deepEqual(await run({ request, body, method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/messages/contract-message' }), { status: 'completed', output: body });
});
test('Microsoft Outlook Calendar passes the OAuth token to the default Graph calendar', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-outlook-calendar', action: 'list_events' }), auth_type: 'OAUTH2', auth: { access_token: 'outlook-calendar-contract-token', data: {} }, props: { calendarId: 'contract-calendar' }, timeout_ms: 15000 };
  const body = { value: [{ id: 'contract-event', subject: 'Contract event' }] };
  assert.deepEqual(await run({ request, body, method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/calendars/contract-calendar/events' }), { status: 'completed', output: body });
});
test('Microsoft Teams passes the OAuth token through its Graph client', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_get_channel_message' }), auth_type: 'OAUTH2', auth: { access_token: 'teams-contract-token', raw: {} }, props: { teamId: 'contract-team', channelId: 'contract-channel', messageId: 'contract-message' }, timeout_ms: 15000 };
  const body = { id: 'contract-message', body: { content: 'Contract message' } };
  assert.deepEqual(await run({ request, body, method: 'GET', url: 'https://graph.microsoft.com/v1.0/teams/contract-team/channels/contract-channel/messages/contract-message' }), { status: 'completed', output: body });
});
test('loads Teams channel options without running the send action or requiring its other props', installedOptions, async () => {
  const channels = [{ id: 'contract-channel', displayName: 'Contract channel' }, { id: 'second-channel', displayName: 'Second channel' }];
  const request = { ...teams, mode: 'options', property: 'channelId' };
  const requests = [{ method: 'GET', url: 'https://graph.microsoft.com/v1.0/teams/contract-team/channels', body: { value: channels } }];
  assert.deepEqual(await run({ request, requests }), { status: 'completed', output: { disabled: false, placeholder: null, options: channels.map((channel) => ({ label: channel.displayName, value: channel.id })) } });
});
test('passes search_value to the Google Drive folder loader', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-google-drive', action: 'create_new_gdrive_folder' }), mode: 'options', property: 'parentFolder', search_value: '  Contract  ', auth_type: 'OAUTH2', auth: { access_token: 'drive-contract-token', data: {} }, props: {}, timeout_ms: 15000 };
  const requests = [{ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.folder%27+and+trashed+%3D+false+and+name+contains+%27Contract%27&includeItemsFromAllDrives=false&supportsAllDrives=true&corpora=user&pageSize=1000&fields=nextPageToken%2C+files%28id%2C+name%29', body: { files: [{ id: 'contract-folder', name: 'Contract folder' }] } }];
  assert.deepEqual(await run({ request, requests }), { status: 'completed', output: { disabled: false, placeholder: null, options: [{ label: 'Contract folder', value: 'contract-folder' }] } });
});
test('exports Excel dynamic header props with defaults and without running append_row', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-excel-365', action: 'append_row' }), mode: 'props', property: 'values', auth_type: 'OAUTH2', auth: { access_token: 'excel-contract-token', data: {} }, props: { workbookId: 'contract-workbook', worksheetId: 'contract-worksheet', isFirstRowHeaders: true }, timeout_ms: 15000 };
  const requests = [{ method: 'GET', url: "https://graph.microsoft.com/v1.0/me/drive/items/contract-workbook/workbook/worksheets/contract-worksheet/range(address='A1:ZZ1')/usedRange", body: { values: [['Name', 'Count']] } }];
  const props = { 0: { type: 'SHORT_TEXT', required: false, description: 'Name', display_name: 'Name', default: '' }, 1: { type: 'SHORT_TEXT', required: false, description: 'Count', display_name: 'Count', default: '' } };
  assert.deepEqual(await run({ request, requests }), { status: 'completed', output: { props } });
});
test('refuses invalid loader requests before spawning a worker', installedOptions, async () => {
  for (const [request, code] of [
    [{ ...teams, mode: 'unknown' }, 'INVALID_MODE'],
    [{ ...teams, mode: 'options' }, 'PROPERTY_NOT_LOADABLE'],
    [{ ...teams, mode: 'run', property: 'channelId' }, 'PROPERTY_NOT_LOADABLE'],
    [{ ...discord, mode: 'options', property: 'message' }, 'PROPERTY_NOT_LOADABLE'],
    [{ ...teams, mode: 'options', property: 'contentType' }, 'PROPERTY_NOT_LOADABLE'],
    [{ ...teams, mode: 'options', property: 'undeclared' }, 'PROPERTY_NOT_LOADABLE'],
    [{ ...teams, mode: 'props', property: 'channelId' }, 'PROPERTY_NOT_LOADABLE'],
    [{ ...teams, mode: 'options', property: 'channelId', search_value: 'x'.repeat(201) }, 'INVALID_SEARCH_VALUE'],
    [{ ...teams, mode: 'options', property: 'channelId', search_value: 1 }, 'INVALID_SEARCH_VALUE'],
    [{ ...discord, search_value: 'contract' }, 'INVALID_SEARCH_VALUE'],
  ]) {
    const before = spawnCount;
    const result = await run({ request });
    assert.deepEqual([result.status, result.refusal?.code], ['refused', code]);
    assert.equal(spawnCount, before);
  }
});
test('refuses supplied FILE props in an options worker', installedOptions, async () => {
  const before = spawnCount;
  const result = await run({ request: { ...slack, mode: 'options', property: 'channel', props: { file: { filename: 'file.txt' } } }, requests: [] });
  assert.deepEqual([result.status, result.refusal?.code], ['refused', 'FILE_PROP_REFUSED']);
  assert.equal(spawnCount, before + 1);
});
test('Microsoft Excel passes the OAuth token through its Graph client', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-excel-365', action: 'get_worksheets' }), auth_type: 'OAUTH2', auth: { access_token: 'excel-contract-token', data: {} }, props: { storageSource: 'onedrive', workbookId: 'contract-workbook', returnAll: true }, timeout_ms: 15000 };
  const worksheets = [{ id: 'contract-worksheet', name: 'Sheet1', position: 0 }];
  assert.deepEqual(await run({ request, body: { value: worksheets }, method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/items/contract-workbook/workbook/worksheets' }), { status: 'completed', output: worksheets });
});
test('Microsoft OneDrive passes the OAuth token to the default Graph drive', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_get_item' }), auth_type: 'OAUTH2', auth: { access_token: 'onedrive-contract-token', raw: {} }, props: { itemId: 'contract-item' }, timeout_ms: 15000 };
  const body = { id: 'contract-item', name: 'Contract file' };
  const output = { ...body, type: 'file', mimeType: null, size: null, webUrl: null, createdDateTime: null, lastModifiedDateTime: null, childCount: null, parentId: null, parentPath: null, driveId: null, driveType: null, createdByName: null, createdByEmail: null, lastModifiedByName: null, lastModifiedByEmail: null, description: null, deleted: false, remoteItemId: null, remoteDriveId: null };
  assert.deepEqual(await run({ request, body, method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/items/contract-item' }), { status: 'completed', output });
});
test('Microsoft SharePoint passes the OAuth token through its Graph client', installedOptions, async () => {
  const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_get_folder_contents' }), auth_type: 'OAUTH2', auth: { access_token: 'sharepoint-contract-token', data: {} }, props: { siteId: 'contract-site', driveId: 'contract-drive', folderId: 'root' }, timeout_ms: 15000 };
  const items = [{ id: 'contract-item', name: 'Contract folder', folder: { childCount: 0 } }];
  assert.deepEqual(await run({ request, body: { value: items }, method: 'GET', url: 'https://graph.microsoft.com/v1.0/sites/contract-site/drive/root/children' }), { status: 'completed', output: items });
});
test('refuses invalid calls, unavailable store/server services, hung actions and excessive output or limits', installedOptions, async () => {
  for (const [request, response, code] of [
    [{ ...discord, auth_type: 'BASIC' }, {}, 'AUTH_TYPE_MISMATCH'],
    [{ ...slack, auth_type: 'API_KEY', allowed_hosts: ['slack.com'] }, {}, 'AUTH_TYPE_MISMATCH'],
    [{ ...discord, action: 'discordSendMessageWebhook' }, {}, 'ACTION_NOT_ALLOWLISTED'],
    [{ ...slack, props: { ...slack.props, file: { filename: 'file.txt' } } }, {}, 'FILE_PROP_REFUSED'],
    [{ ...discord, props: { ...discord.props, files: [{ file: { filename: 'file.txt' } }] } }, {}, 'FILE_PROP_REFUSED'],
    [{ ...discord, props: { ...discord.props, undeclared: true } }, {}, 'UNDECLARED_PROP'],
    [{ ...discord, props: {} }, {}, 'MISSING_REQUIRED_PROP'],
    [discord, { mode: 'store' }, 'CONTEXT_SERVICE_UNAVAILABLE'],
    [{ ...slack, props: { ...slack.props, mentionOriginFlow: true } }, {}, 'CONTEXT_SERVICE_UNAVAILABLE'],
    [{ ...discord, timeout_ms: 2500 }, { mode: 'hang' }, 'TIMEOUT'],
    [{ ...discord, max_output_bytes: 128 }, { body: { message: 'x'.repeat(2048) } }, 'OUTPUT_LIMIT_EXCEEDED'],
    [{ ...discord, memory_mb: 513 }, {}, 'INVALID_LIMIT'],
    [{ ...discord, timeout_ms: 60001 }, {}, 'INVALID_LIMIT'],
    [{ ...discord, max_output_bytes: 1048577 }, {}, 'INVALID_LIMIT'],
  ]) {
    const result = await run({ request, ...response });
    assert.deepEqual([result.status, result.refusal?.code], ['refused', code]);
  }
});
test('provider errors expose only class, HTTP status and a message with every auth string scrubbed', installedOptions, async () => {
  const auth = { apiKey: discord.auth.apiKey, raw: { other: 'raw-provider-contract-secret' } };
  const result = await run({ request: { ...discord, auth }, status: 400, body: { message: `${auth.apiKey} ${auth.raw.other}` } });
  assert.deepEqual([result.status, result.error.class, result.error.http_status], ['failed', 'HttpError', 400]);
  assert.deepEqual(Object.keys(result.error).sort(), ['class', 'http_status', 'message']);
  for (const secret of [auth.apiKey, auth.raw.other]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(result.error.message.includes('[REDACTED]'));
  const special = { secret_text: 'quoted"\\token\n', other: '\ud800' };
  const echo = Object.values(special).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]).join(' ');
  assert.equal(runnerErrors.failure({ error: new Error(echo), auth: special }).error.message, '[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
});

test('stub typed auth requires a valid host list before loading pieces or spawning', async () => {
  const before = spawnCount;
  for (const auth_type of ['API_KEY', 'SECRET_TEXT', 'BASIC', 'CUSTOM_AUTH']) {
    for (const allowed_hosts of [undefined, null, [], Array(1), [null], [''], 'api.example.com', ['127.0.0.1'], ['::1'], ['*.example.com'], ['API.example.com'], ['https://api.example.com'], ['api.example.com:443'], Array(11).fill('api.example.com')]) {
      const result = await pieceRunner.invoke({ ...discord, auth_type, allowed_hosts });
      assert.deepEqual([result.status, result.refusal?.code, spawnCount], ['refused', 'ALLOWED_HOSTS_REQUIRED', before]);
    }
    const result = await pieceRunner.invoke({ ...discord, auth_type, allowed_hosts: undefined, mode: 'options', property: 'message' });
    assert.deepEqual([result.refusal?.code, spawnCount], ['ALLOWED_HOSTS_REQUIRED', before]);
  }
});

test('stub CustomAuth validates declared credentials and reaches context.auth.props; OAuth needs no list', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-auth-'));
  try {
    const metadata = JSON.parse(await readFile(new URL('../../../catalog/activepieces/generated/runner/actions.json', import.meta.url), 'utf8'));
    const entry = pieceCatalog.entries.find((item) => item.piece === '@activepieces/piece-docusign');
    const fields = metadata.find((item) => item.piece === entry.piece).auth.props;
    const declarations = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, { ...field, ...(field.options ? { options: { options: field.options } } : {}) }]));
    const longTextEntry = pieceCatalog.entries.find((item) => item.piece === '@activepieces/piece-service-now');
    const longTextAuth = { type: 'CUSTOM_AUTH', props: { serviceAccount: { type: 'LONG_TEXT', required: true }, userEmail: { type: 'SHORT_TEXT', required: false } } };
    await writeFile(join(packageRoot, 'package.json'), '{}');
    for (const [item, auth] of [[entry, { type: 'CUSTOM_AUTH', props: declarations }], [pieceCatalog.entries[0], { type: 'OAUTH2' }], [longTextEntry, longTextAuth]]) {
      const target = join(packageRoot, 'node_modules', item.piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ version: item.version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `module.exports = { ${item.exportName}: { auth: ${JSON.stringify(auth)}, getAction: () => ({ props: {}, run: (context) => context.auth }) } };`);
    }
    const props = { clientId: 'contract-client', privateKey: 'contract-private-key', environment: 'demo', impersonatedUserId: 'contract-user', scopes: 'signature' };
    const request = { piece: entry.piece, version: entry.version, action: entry.action, auth_type: 'CUSTOM_AUTH', auth: { props }, allowed_hosts: ['demo.docusign.net'] };
    const catalog = { prepare: ({ request }) => pieceCatalog.prepare({ request, packageRoot }) };
    assert.deepEqual(await runnerExecution.execute({ request, pieceCatalog: catalog }), { type: 'CUSTOM_AUTH', props });
    const { privateKey, ...missing } = props;
    for (const invalid of [undefined, [], missing, { ...props, unknown: 'value' }, { ...props, environment: 'other' }, { ...props, privateKey: '' }, { ...props, privateKey: 'x'.repeat(4097) }, { ...props, clientId: 1 }]) {
      await assert.rejects(runnerExecution.execute({ request: { ...request, auth: { props: invalid } }, pieceCatalog: catalog }), { name: 'RunnerRefusal', code: 'INVALID_AUTH' });
    }
    assert.throws(() => pieceCatalog.prepare({ request: { ...request, auth_type: 'BASIC' }, packageRoot }), { code: 'AUTH_TYPE_MISMATCH' });
    assert.deepEqual(await runnerExecution.execute({ request: { ...slack, props: {} }, pieceCatalog: catalog }), { type: 'OAUTH2', access_token: slack.auth.access_token, data: slack.auth.raw });
    const longTextRequest = { ...request, piece: longTextEntry.piece, version: longTextEntry.version, action: longTextEntry.action, auth: { props: { serviceAccount: JSON.stringify({ private_key: 'contract-key', padding: ' '.repeat(4096) }) } } };
    assert.deepEqual(await runnerExecution.execute({ request: longTextRequest, pieceCatalog: catalog }), { type: 'CUSTOM_AUTH', props: longTextRequest.auth.props });
    await assert.rejects(runnerExecution.execute({ request: { ...longTextRequest, auth: { props: { serviceAccount: 1 } } }, pieceCatalog: catalog }), { code: 'INVALID_AUTH' });
    const result = runnerErrors.failure({ error: new Error(`Credential ${privateKey} failed`), auth: request.auth });
    assert.equal(result.error.message, 'Credential [REDACTED] failed');
    const basic = { props: { username: 'contract-username', password: 'contract-password' } };
    const encoded = Buffer.from(`${basic.props.username}:${basic.props.password}`).toString('base64');
    assert.equal(runnerErrors.failure({ error: new Error(`Basic ${encoded}`), auth: basic }).error.message, 'Basic [REDACTED]');
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('stub Slack history and Sheets spreadsheet reads pass the OAuth2 token and refuse CustomAuth before running', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-read-auth-'));
  try {
    await writeFile(join(packageRoot, 'package.json'), '{}');
    const catalog = { prepare: ({ request }) => pieceCatalog.prepare({ request, packageRoot }) };
    for (const [piece, version, action, exportName] of [
      ['@activepieces/piece-slack', '0.21.1', 'getChannelHistory', 'slack'],
      ['@activepieces/piece-google-sheets', '0.17.2', 'find_spreadsheets', 'googleSheets'],
    ]) {
      const target = join(packageRoot, 'node_modules', piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `const piece = { runs: 0, auth: [{ type: 'CUSTOM_AUTH', props: {} }, { type: 'OAUTH2' }], getAction: (name) => name === ${JSON.stringify(action)} ? { props: {}, run: ({ auth }) => { piece.runs += 1; return { action: name, access_token: auth.access_token }; } } : undefined }; module.exports = { ${exportName}: piece };`);
      const request = { piece, version, action, auth_type: 'OAUTH2', auth: { access_token: `${exportName}-read-contract-token` }, props: {} };
      const loaded = pieceCatalog.loadAction({ ...request, packageRoot });
      await assert.rejects(runnerExecution.execute({ request: { ...request, auth_type: 'CUSTOM_AUTH', auth: { props: {} } }, pieceCatalog: catalog }), { name: 'RunnerRefusal', code: 'AUTH_TYPE_MISMATCH' });
      assert.equal(loaded.piece.runs, 0);
      assert.deepEqual(await runnerExecution.execute({ request, pieceCatalog: catalog }), { action, access_token: request.auth.access_token });
    }
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('stub OAuth2 declared props refuse invalid credentials before running, fill declared defaults and preserve no-props auth', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-oauth-props-'));
  try {
    await writeFile(join(packageRoot, 'package.json'), '{}');
    const finance = pieceCatalog.entries.filter((entry) => ['@activepieces/piece-quickbooks', '@activepieces/piece-quickbooks-sandbox', '@activepieces/piece-xero'].includes(entry.piece));
    const pieces = [...new Map([...finance, ...pieceCatalog.entries.filter((entry) => [slack.piece, '@activepieces/piece-google-sheets', '@activepieces/piece-microsoft-teams'].includes(entry.piece))].map((entry) => [entry.piece, entry])).values()];
    const declarations = { companyId: { type: 'SHORT_TEXT', displayName: 'Company ID', required: true }, environment: { type: 'STATIC_DROPDOWN', required: false, options: { options: [{ label: 'Production', value: 'production' }, { label: 'Sandbox', value: 'sandbox' }] } } };
    const microsoftDeclarations = { cloud: { type: 'STATIC_DROPDOWN', required: true, defaultValue: 'login.microsoftonline.com', options: { options: [{ label: 'Commercial', value: 'login.microsoftonline.com' }, { label: 'US Government', value: 'login.microsoftonline.us' }] } }, tenant: { type: 'SHORT_TEXT', required: true, defaultValue: 'common' }, mailbox: { type: 'SHORT_TEXT', required: false } };
    for (const entry of pieces) {
      const auth = { type: 'OAUTH2', ...(entry.forkDirectory.startsWith('quickbooks') ? { props: declarations } : entry.forkDirectory === 'microsoft-teams' ? { props: microsoftDeclarations } : {}) };
      const target = join(packageRoot, 'node_modules', entry.piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `const piece = { runs: 0, auth: ${JSON.stringify(auth)}, getAction: () => ({ props: { fail: { type: 'CHECKBOX', required: false }, tenant_id: { type: 'DROPDOWN', required: true, options: async ({ auth }) => ({ options: [{ label: auth.props?.companyId ?? auth.access_token, value: 'contract-tenant' }] }) } }, run: ({ auth, propsValue }) => { piece.runs += 1; if (propsValue.fail) throw new Error('Company ' + auth.props.companyId + ' failed'); return auth; } }) }; module.exports = { ${entry.exportName}: piece };`);
    }
    const catalog = { prepare: ({ request }) => pieceCatalog.prepare({ request, packageRoot }), prepareLoader: ({ request }) => pieceCatalog.prepareLoader({ request, packageRoot }) };
    for (const entry of pieces) {
      const request = { ...requestTuple({ piece: entry.piece, action: entry.action }), auth_type: 'OAUTH2', auth: { access_token: 'oauth-contract-token', raw: { provider: 'contract-provider' } }, props: { tenant_id: 'contract-tenant' } };
      const loaded = pieceCatalog.loadAction({ ...request, packageRoot });
      if (entry.forkDirectory.startsWith('quickbooks')) {
        const props = { companyId: '123456789012345', environment: 'production' };
        for (const invalid of [undefined, null, [], {}, { environment: 'production' }, { ...props, unknown: 'value' }, { ...props, companyId: '' }, { ...props, companyId: 123456789012345 }, { ...props, companyId: 'x'.repeat(4097) }, { ...props, environment: 'Production' }]) {
          await assert.rejects(runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props: invalid } }, pieceCatalog: catalog }), { name: 'RunnerRefusal', code: 'INVALID_AUTH' });
          assert.equal(loaded.piece.runs, 0);
        }
        request.auth.props = props;
        assert.deepEqual(await runnerExecution.execute({ request, pieceCatalog: catalog }), { type: 'OAUTH2', access_token: request.auth.access_token, data: request.auth.raw, props });
        assert.notEqual(pieceCatalog.prepare({ request, packageRoot }).auth.props, props);
        assert.deepEqual(await runnerExecution.execute({ request: { ...request, mode: 'options', property: 'tenant_id', props: {} }, pieceCatalog: catalog }), { options: [{ label: props.companyId, value: 'contract-tenant' }], disabled: false, placeholder: null });
        const failure = await runnerExecution.execute({ request: { ...request, props: { ...request.props, fail: true } }, pieceCatalog: catalog }).catch((error) => runnerErrors.failure({ error, auth: request.auth }));
        assert.deepEqual(failure, { status: 'failed', error: { class: 'Error', http_status: null, message: 'Company [REDACTED] failed' } });
      } else {
        const defaults = entry.forkDirectory === 'microsoft-teams' ? { props: { cloud: 'login.microsoftonline.com', tenant: 'common' } } : {};
        for (const invalid of [{ x: '1' }, null, [], 'value', ...(defaults.props ? [{ cloud: 'login.example.com' }, { tenant: '' }, { tenant: null }] : [])]) {
          await assert.rejects(runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props: invalid } }, pieceCatalog: catalog }), { code: 'INVALID_AUTH' });
          assert.equal(loaded.piece.runs, 0);
        }
        for (const props of [undefined, {}]) {
          assert.deepEqual(await runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props } }, pieceCatalog: catalog }), { type: 'OAUTH2', access_token: request.auth.access_token, data: request.auth.raw, ...defaults });
        }
        if (defaults.props) {
          const props = { cloud: 'login.microsoftonline.us', mailbox: 'shared@contract.example' };
          assert.deepEqual(await runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props } }, pieceCatalog: catalog }), { type: 'OAUTH2', access_token: request.auth.access_token, data: request.auth.raw, props: { ...props, tenant: 'common' } });
        }
        if (entry.forkDirectory === 'xero') assert.deepEqual(await runnerExecution.execute({ request: { ...request, mode: 'options', property: 'tenant_id', props: {} }, pieceCatalog: catalog }), { options: [{ label: request.auth.access_token, value: 'contract-tenant' }], disabled: false, placeholder: null });
      }
    }
    for (const entry of pieces.filter((entry) => ['quickbooks', 'quickbooks-sandbox', 'xero'].includes(entry.forkDirectory))) {
      const result = await pieceRunner.invoke({ ...requestTuple({ piece: entry.piece, action: entry.action }), action: 'custom_api_call', auth_type: 'OAUTH2', auth: { access_token: 'oauth-contract-token' } });
      assert.deepEqual([result.status, result.refusal?.code], ['refused', 'ACTION_NOT_ALLOWLISTED']);
    }
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('stub Business Central preserves OAuth2 defaults and tenant-qualified environments, loads fields and refuses deletion', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-business-central-'));
  try {
    const request = { ...requestTuple({ piece: '@activepieces/piece-microsoft-dynamics-365-business-central', action: 'search-records' }), auth_type: 'OAUTH2', auth: { access_token: 'business-central-contract-token' }, props: { company_id: 'contract-company', record_type: 'customers', record_filter_fields: {} } };
    const declarations = { cloud: { type: 'STATIC_DROPDOWN', required: true, defaultValue: 'login.microsoftonline.com', options: { options: [{ label: 'Commercial (Global)', value: 'login.microsoftonline.com' }, { label: 'US Government (GCC High)', value: 'login.microsoftonline.us' }] } }, environment: { type: 'SHORT_TEXT', required: true, defaultValue: 'Production' } };
    const target = join(packageRoot, 'node_modules', request.piece);
    await mkdir(target, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{}');
    await writeFile(join(target, 'package.json'), JSON.stringify({ version: request.version, main: 'index.cjs' }));
    await writeFile(join(target, 'index.cjs'), `const fields = { type: 'DYNAMIC', required: true, refreshers: ['company_id', 'record_type'], props: async ({ auth, company_id, record_type }) => { if (!auth || !company_id || !record_type) return {}; return { displayName: { type: 'SHORT_TEXT', required: false, displayName: 'Display Name' } }; } }; const piece = { runs: 0, auth: { type: 'OAUTH2', props: ${JSON.stringify(declarations)} }, getAction: (name) => ({ props: { company_id: { type: 'DROPDOWN', required: true, refreshers: [], options: async ({ auth }) => ({ options: [{ label: auth.props.environment, value: 'contract-company' }] }) }, record_type: { type: 'STATIC_DROPDOWN', required: true, options: { options: [{ label: 'Customers', value: 'customers' }] } }, [name === 'search-records' ? 'record_filter_fields' : 'record_fields']: fields }, run: ({ auth }) => { piece.runs += 1; return auth; } }) }; module.exports = { microsoftDynamics365BusinessCentral: piece };`);
    const catalog = { prepare: ({ request }) => pieceCatalog.prepare({ request, packageRoot }), prepareLoader: ({ request }) => pieceCatalog.prepareLoader({ request, packageRoot }), exportProps: pieceCatalog.exportProps };
    const loaded = pieceCatalog.loadAction({ ...request, packageRoot });
    const defaults = { cloud: 'login.microsoftonline.com', environment: 'Production' };
    for (const props of [undefined, {}]) {
      assert.deepEqual(await runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props } }, pieceCatalog: catalog }), { type: 'OAUTH2', access_token: request.auth.access_token, data: {}, props: defaults });
    }
    const environment = '271592a8-9286-4526-9f93-0d02aeeae857/Production';
    for (const cloud of ['login.microsoftonline.com', 'login.microsoftonline.us']) {
      assert.deepEqual(await runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props: { cloud, environment } } }, pieceCatalog: catalog }), { type: 'OAUTH2', access_token: request.auth.access_token, data: {}, props: { cloud, environment } });
    }
    const before = loaded.piece.runs;
    await assert.rejects(runnerExecution.execute({ request: { ...request, auth: { ...request.auth, props: { cloud: 'login.example.com' } } }, pieceCatalog: catalog }), { name: 'RunnerRefusal', code: 'INVALID_AUTH' });
    assert.equal(loaded.piece.runs, before);
    assert.deepEqual(await runnerExecution.execute({ request: { ...request, mode: 'options', property: 'company_id', props: {} }, pieceCatalog: catalog }), { options: [{ label: 'Production', value: 'contract-company' }], disabled: false, placeholder: null });
    for (const [action, property] of [['search-records', 'record_filter_fields'], ['create-record', 'record_fields'], ['update-record', 'record_fields']]) {
      assert.deepEqual(await runnerExecution.execute({ request: { ...request, action, mode: 'props', property, props: { company_id: 'contract-company', record_type: 'customers' } }, pieceCatalog: catalog }), { props: { displayName: { type: 'SHORT_TEXT', required: false, description: '', display_name: 'Display Name' } } });
    }
    assert.equal(loaded.piece.runs, before);
    for (const action of ['delete-record', 'custom_api_call']) {
      const spawns = spawnCount;
      const result = await pieceRunner.invoke({ ...request, action });
      assert.deepEqual([result.status, result.refusal?.code, spawnCount], ['refused', 'ACTION_NOT_ALLOWLISTED', spawns]);
    }
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('stub Shopify admits only OAuth2 shop credentials and Onfleet admits secret text before running', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-fulfillment-auth-'));
  try {
    await writeFile(join(packageRoot, 'package.json'), '{}');
    const shopName = { type: 'SHORT_TEXT', required: true };
    const shopifyAuth = [{ type: 'CUSTOM_AUTH', props: { shopName, adminToken: { type: 'SECRET_TEXT', required: true } } }, { type: 'OAUTH2', props: { shopName } }];
    const shopify = { ...requestTuple({ piece: '@activepieces/piece-shopify', action: 'get_order' }), auth_type: 'OAUTH2', auth: { access_token: 'shopify-contract-token', props: { shopName: 'basekey-dev' } }, allowed_hosts: ['basekey-dev.myshopify.com'], props: { order_id: 'contract-order' } };
    const onfleet = { ...requestTuple({ piece: '@activepieces/piece-onfleet', action: 'get_task' }), auth_type: 'SECRET_TEXT', auth: { secret_text: 'onfleet-contract-token' }, allowed_hosts: ['onfleet.com'], props: { task: 'contract-task' } };
    const catalog = { prepare: ({ request }) => pieceCatalog.prepare({ request, packageRoot }) };
    for (const [request, auth] of [[shopify, shopifyAuth], [onfleet, { type: 'SECRET_TEXT' }]]) {
      const entry = pieceCatalog.entries.find((item) => item.piece === request.piece && item.action === request.action);
      const target = join(packageRoot, 'node_modules', entry.piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
      const props = Object.fromEntries(Object.keys(request.props).map((name) => [name, { type: 'SHORT_TEXT', required: true }]));
      await writeFile(join(target, 'index.cjs'), `const piece = { runs: 0, auth: ${JSON.stringify(auth)}, getAction: () => ({ props: ${JSON.stringify(props)}, run: ({ auth, propsValue }) => { piece.runs += 1; return { auth, props: propsValue }; } }) }; module.exports = { ${entry.exportName}: piece };`);
    }
    const invalid = [
      [{ ...shopify, auth_type: 'CUSTOM_AUTH', auth: { props: { shopName: 'basekey-dev', adminToken: 'legacy-contract-token' } } }, 'AUTH_TYPE_MISMATCH'],
      [{ ...shopify, auth: { type: 'CUSTOM_AUTH', props: { shopName: 'basekey-dev', adminToken: 'legacy-contract-token' } } }, 'INVALID_AUTH'],
      [{ ...shopify, auth: { access_token: shopify.auth.access_token } }, 'INVALID_AUTH'],
      [{ ...shopify, auth: { ...shopify.auth, props: {} } }, 'INVALID_AUTH'],
      [{ ...shopify, auth: { ...shopify.auth, props: { ...shopify.auth.props, unknown: 'value' } } }, 'INVALID_AUTH'],
      [{ ...onfleet, auth: {} }, 'INVALID_AUTH'],
      [{ ...onfleet, auth: { secret_text: '' } }, 'INVALID_AUTH'],
    ];
    for (const [request, code] of invalid) {
      const loaded = pieceCatalog.loadAction({ ...request, packageRoot });
      await assert.rejects(runnerExecution.execute({ request, pieceCatalog: catalog }), { name: 'RunnerRefusal', code });
      assert.equal(loaded.piece.runs, 0);
    }
    assert.deepEqual(await runnerExecution.execute({ request: shopify, pieceCatalog: catalog }), { auth: { type: 'OAUTH2', access_token: shopify.auth.access_token, data: {}, props: { shopName: 'basekey-dev' } }, props: shopify.props });
    for (const auth_type of ['SECRET_TEXT', 'API_KEY']) assert.deepEqual(await runnerExecution.execute({ request: { ...onfleet, auth_type }, pieceCatalog: catalog }), { auth: { type: 'SECRET_TEXT', secret_text: onfleet.auth.secret_text }, props: onfleet.props });
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('stub egress guards DNS and sockets with public-address controls and no real DNS', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import dns, { lookup as namedLookup } from 'node:dns';
    import { lookup as namedPromiseLookup } from 'node:dns/promises';
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    import { promisify } from 'node:util';
    import { runnerEgress } from ${JSON.stringify(new URL('../egress.mjs', import.meta.url).href)};
    let addresses = ['93.184.216.34'], sockets = 0, forwarded;
    const records = () => addresses.map((address) => ({ address, family: net.isIP(address) }));
    const nativeLookup = dns.lookup;
    dns.lookup = (...args) => queueMicrotask(() => args.at(-1)(null, args[1]?.all ? records() : addresses[0], net.isIP(addresses[0] ?? '')));
    for (const symbol of Object.getOwnPropertySymbols(nativeLookup)) Object.defineProperty(dns.lookup, symbol, Object.getOwnPropertyDescriptor(nativeLookup, symbol));
    dns.promises.lookup = async (...args) => args[1]?.all ? records() : records()[0];
    net.Socket.prototype.connect = function (options) { sockets += 1; forwarded = options; return this; };
    tls.connect = () => { sockets += 1; return {}; };
    const original = [dns.lookup, dns.promises.lookup, net.Socket.prototype.connect, tls.connect];
    const oauth = runnerEgress.install({ request: { auth_type: 'OAUTH2' } });
    assert.deepEqual([dns.lookup, dns.promises.lookup, net.Socket.prototype.connect, tls.connect], original);
    assert.equal(oauth.refusal(), undefined);
    const guard = runnerEgress.install({ request: { auth_type: 'CUSTOM_AUTH', allowed_hosts: ['api.example.com'] } });
    assert.deepEqual(await promisify(dns.lookup)('api.example.com'), { address: addresses[0], family: 4 });
    const callbackLookup = ({ host, all = false }) => new Promise((resolve, reject) => namedLookup(host, { all }, (...args) => args[0] ? reject(args[0]) : resolve(args[1])));
    for (const lookup of [dns.promises.lookup, namedPromiseLookup, promisify(dns.lookup), (host) => callbackLookup({ host })]) {
      assert.ok(await lookup('api.example.com'));
      await assert.rejects(lookup('outside.example.com'), { code: 'EGRESS_HOST_REFUSED' });
      for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '0.0.0.0', '100.64.0.1', '172.16.0.1', '192.168.1.1', '224.0.0.1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:5::1', '2001:db8::1']) {
        addresses = [address]; await assert.rejects(lookup('api.example.com'), { code: 'EGRESS_HOST_REFUSED' });
      }
      addresses = ['93.184.216.34'];
    }
    for (const values of [['93.184.216.34', '10.0.0.1'], Array(1)]) {
      addresses = values;
      await assert.rejects(callbackLookup({ host: 'api.example.com', all: true }), { code: 'EGRESS_HOST_REFUSED' });
      await assert.rejects(dns.promises.lookup('api.example.com', { all: true }), { code: 'EGRESS_HOST_REFUSED' });
    }
    for (const address of ['2606:4700:4700::1111', '::ffff:93.184.216.34', '64:ff9b::5db8:d822', '2001:1::1', '2001:3::1', '2001:200::1']) { addresses = [address]; assert.ok(await dns.promises.lookup('api.example.com')); }
    for (const connect of [() => net.connect('127.0.0.1'), () => net.connect(443, '127.0.0.1'), () => net.createConnection({ port: 443, host: '93.184.216.34' }), () => new net.Socket().connect({ port: 443, host: '::1' }), () => tls.connect({ port: 443, host: '127.0.0.1' }), () => tls.connect(443, 'outside.example.com')]) assert.throws(connect, { code: 'EGRESS_HOST_REFUSED' });
    for (const client of [http, https]) await assert.rejects(new Promise((resolve, reject) => client.get((client === https ? 'https' : 'http') + '://127.0.0.1', resolve).on('error', reject)), { code: 'EGRESS_HOST_REFUSED' });
    await assert.rejects(fetch('http://127.0.0.1'), (error) => error.cause?.code === 'EGRESS_HOST_REFUSED');
    assert.equal(sockets, 0);
    net.connect({ port: 443, host: 'api.example.com', lookup: () => assert.fail('Custom DNS bypass') });
    assert.equal(sockets, 1); assert.equal(forwarded.lookup, dns.lookup);
    assert.equal(guard.refusal().code, 'EGRESS_HOST_REFUSED');
    console.log('guard contracts passed');
  `;
  const { stdout } = await promisify(childProcess.execFile)(process.execPath, ['--input-type=module', '-e', script], { env: {}, timeout: 10000 });
  assert.equal(stdout.trim(), 'guard contracts passed');
  const workerScript = `
    import dns from 'node:dns';
    import nodeModule from 'node:module';
    import { pieceCatalog } from ${JSON.stringify(new URL('../catalog.mjs', import.meta.url).href)};
    nodeModule.createRequire = () => () => ({ tryCatch: async (callback) => { try { return { data: await callback() }; } catch (error) { return { data: null, error }; } } });
    nodeModule.syncBuiltinESMExports();
    dns.promises.lookup = async () => ({ address: '127.0.0.1', family: 4 });
    pieceCatalog.verifyVersions = () => {};
    pieceCatalog.prepare = () => ({ auth: {}, props: {}, action: { run: async () => {
      try { await dns.promises.lookup('api.example.com'); } catch {}
      return 'provider swallowed lookup';
    } } });
    await import(${JSON.stringify(new URL('../worker.mjs', import.meta.url).href)});
    process.stdin.emit('data', process.argv[1]); process.stdin.emit('end');
  `;
  for (const auth_type of ['API_KEY', 'SECRET_TEXT', 'OAUTH2']) {
    const request = { auth_type, ...(auth_type !== 'OAUTH2' ? { allowed_hosts: ['api.example.com'] } : {}) };
    const { stdout } = await promisify(childProcess.execFile)(process.execPath, ['--input-type=module', '-e', workerScript, JSON.stringify(request)], { env: {}, timeout: 10000 });
    const result = JSON.parse(stdout);
    assert.deepEqual(auth_type !== 'OAUTH2' ? [result.status, result.refusal?.code] : result, auth_type !== 'OAUTH2' ? ['refused', 'EGRESS_HOST_REFUSED'] : { status: 'completed', output: 'provider swallowed lookup' });
  }
});
