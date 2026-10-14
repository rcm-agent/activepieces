import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pieceCatalog } from '../catalog.mjs';
import { pieceRunner } from '../index.mjs';
import { runnerContext } from '../context.mjs';

test('loader admission requires an own property, matching type and callable loader before spawn', async () => {
  const entry = pieceCatalog.entries.find((item) => item.piece === '@activepieces/piece-microsoft-teams');
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-admission-'));
  const originalLoader = pieceCatalog.validateLoader, originalSpawn = childProcess.spawn;
  let spawned = false;
  try {
    const target = join(packageRoot, 'node_modules', entry.piece);
    await mkdir(target, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{}');
    await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
    await writeFile(join(target, 'index.cjs'), `module.exports = { microsoftTeams: { auth: { type: 'OAUTH2' }, getAction: () => ({ run: () => { throw Error('run invoked'); }, props: Object.assign(Object.create({ inherited: { type: 'DROPDOWN', options: () => ({ options: [] }) } }), { channelId: { type: 'DROPDOWN', required: true, options: () => ({ options: [] }) }, multi: { type: 'MULTI_SELECT_DROPDOWN', options: () => ({ options: [] }) }, fields: { type: 'DYNAMIC', props: () => ({}) }, broken: { type: 'DROPDOWN', options: [] }, teamId: { type: 'SHORT_TEXT', required: true }, file: { type: 'FILE' }, contentType: { type: 'STATIC_DROPDOWN', defaultValue: 'text' }, rows: { type: 'ARRAY', properties: { required: { type: 'SHORT_TEXT', required: true }, file: { type: 'FILE' } } } }) }) } };`);
    const request = { piece: entry.piece, action: entry.action, version: entry.version, mode: 'options', property: 'channelId', auth_type: 'OAUTH2', auth: { access_token: 'fixture', raw: {} }, props: {} };
    pieceCatalog.validateLoader = (input) => originalLoader({ ...input, packageRoot });
    childProcess.spawn = () => { spawned = true; throw new Error('Unexpected spawn'); };
    syncBuiltinESMExports();
    for (const property of ['inherited', 'toString', 'broken', 'contentType', 'teamId', 'fields', 'missing']) {
      const result = await pieceRunner.invoke({ ...request, property });
      assert.deepEqual([result.status, result.refusal?.code, spawned], ['refused', 'PROPERTY_NOT_LOADABLE', false]);
    }
    assert.equal(originalLoader({ request: { ...request, property: 'multi' }, packageRoot }).declaration.type, 'MULTI_SELECT_DROPDOWN');
    assert.equal(originalLoader({ request: { ...request, mode: 'props', property: 'fields' }, packageRoot }).declaration.type, 'DYNAMIC');
    const prepared = pieceCatalog.prepareLoader({ request: { ...request, props: { rows: [{}] } }, packageRoot });
    assert.deepEqual(prepared.auth, { type: 'OAUTH2', access_token: 'fixture', data: {} });
    assert.deepEqual(prepared.props, { rows: [{}], contentType: 'text' });
    assert.throws(() => pieceCatalog.prepare({ request, packageRoot }), { code: 'MISSING_REQUIRED_PROP' });
    for (const [props, code] of [[{ unknown: true }, 'UNDECLARED_PROP'], [{ file: null }, 'FILE_PROP_REFUSED'], [{ rows: [{ file: {} }] }, 'FILE_PROP_REFUSED'], [{ rows: {} }, 'INVALID_PROPS']]) {
      assert.throws(() => pieceCatalog.prepareLoader({ request: { ...request, props }, packageRoot }), { code });
    }
  } finally {
    pieceCatalog.validateLoader = originalLoader;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('property context refuses all unavailable services while preserving search text', () => {
  const context = runnerContext.createPropertyContext({ searchValue: 'contract' });
  assert.equal(context.searchValue, 'contract');
  for (const service of ['server', 'project', 'flows', 'connections']) assert.throws(() => context[service], { name: 'RunnerRefusal', code: 'CONTEXT_SERVICE_UNAVAILABLE' });
});

test('loading actions and property loaders refuses ambiguous, missing and duplicate admitted auth declarations', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-auth-admission-'));
  const cases = [
    ['@activepieces/piece-discord', ['CUSTOM_AUTH', 'OAUTH2']],
    ['@activepieces/piece-shopify', ['CUSTOM_AUTH']],
    ['@activepieces/piece-shopify', ['OAUTH2', 'OAUTH2']],
  ];
  try {
    for (const [index, [piece, types]] of cases.entries()) {
      const entry = pieceCatalog.entries.find((item) => item.piece === piece);
      const root = join(packageRoot, String(index)), target = join(root, 'node_modules', piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(root, 'package.json'), '{}');
      await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `module.exports = { ${entry.exportName}: { auth: ${JSON.stringify(types.map((type) => ({ type })))}, getAction: () => ({ run: () => { throw Error('Action must not run'); }, props: { channel: { type: 'DROPDOWN', options: () => { throw Error('Loader must not run'); } } } }) } };`);
      assert.throws(() => pieceCatalog.loadAction({ ...entry, packageRoot: root }), { name: 'RunnerRefusal', code: 'AUTH_TYPE_MISMATCH' });
      assert.throws(() => pieceCatalog.validateLoader({ request: { ...entry, mode: 'options', property: 'channel' }, packageRoot: root }), { name: 'RunnerRefusal', code: 'AUTH_TYPE_MISMATCH' });
    }
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

for (const [piece, version, exportName, authType, admittedAuthType, actions] of [
  ['@activepieces/piece-slack', '0.21.1', 'slack', 'OAUTH2', 'OAUTH2', ['getChannelHistory', 'slack_list_channels', 'searchMessages']],
  ['@activepieces/piece-discord', '0.7.2', 'discord', 'SECRET_TEXT', undefined, ['discord_list_messages', 'discord_find_member', 'list_guild_members']],
  ['@activepieces/piece-google-sheets', '0.17.2', 'googleSheets', 'OAUTH2', 'OAUTH2', ['find_spreadsheets']],
  ['@activepieces/piece-microsoft-outlook', '0.7.2', 'microsoftOutlook', 'OAUTH2', undefined, ['findEmail']],
  ['@activepieces/piece-microsoft-onedrive', '0.6.1', 'microsoftOneDrive', 'OAUTH2', undefined, ['list_folders']],
]) {
  for (const action of actions) test(`admits pinned read action ${piece}/${action} with its allowed auth`, async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-read-admission-'));
    try {
      const target = join(packageRoot, 'node_modules', piece), tuple = { piece, version, action };
      await mkdir(target, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), '{}');
      await writeFile(join(target, 'package.json'), JSON.stringify({ version, main: 'index.cjs' }));
      const declarations = admittedAuthType === 'OAUTH2' ? [{ type: 'CUSTOM_AUTH', props: {} }, { type: authType }] : { type: authType };
      await writeFile(join(target, 'index.cjs'), `module.exports = { ${exportName}: { auth: ${JSON.stringify(declarations)}, getAction: (name) => name === ${JSON.stringify(action)} ? { props: {}, run: () => { throw Error('Action must not run'); } } : undefined } };`);
      const loaded = pieceCatalog.loadAction({ ...tuple, packageRoot });
      assert.deepEqual([loaded.entry.exportName, loaded.entry.authType], [exportName, admittedAuthType]);
      const auth = authType === 'OAUTH2' ? { access_token: 'read-contract-token' } : { secret_text: 'read-contract-token' };
      const request = { ...tuple, auth_type: authType, auth, props: {} };
      assert.deepEqual(pieceCatalog.prepare({ request, packageRoot }).auth, { type: authType, ...auth, ...(authType === 'OAUTH2' ? { data: {} } : {}) });
      if (authType === 'OAUTH2') assert.throws(() => pieceCatalog.prepare({ request: { ...request, auth_type: 'CUSTOM_AUTH', auth: { props: {} } }, packageRoot }), { name: 'RunnerRefusal', code: 'AUTH_TYPE_MISMATCH' });
    } finally { await rm(packageRoot, { recursive: true, force: true }); }
  });
}

for (const [directory, version, action, exportName, property, authType, refreshers] of [
  ['microsoft-outlook', '0.7.2', 'findEmail', 'microsoftOutlook', 'folderId', 'OAUTH2', []],
  ['microsoft-onedrive', '0.6.1', 'list_folders', 'microsoftOneDrive', 'parentFolder', 'OAUTH2', ['auth']],
  ['discord', '0.7.2', 'list_guild_members', 'discord', 'guild_id', 'SECRET_TEXT', []],
]) {
  test(`admits borrowed dropdown ${action}.${property} only in options mode`, async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-borrowed-loader-'));
    try {
      const piece = `@activepieces/piece-${directory}`, target = join(packageRoot, 'node_modules', piece);
      await mkdir(target, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), '{}');
      await writeFile(join(target, 'package.json'), JSON.stringify({ version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `module.exports = { ${exportName}: { auth: { type: ${JSON.stringify(authType)} }, getAction: (name) => name === ${JSON.stringify(action)} ? { run: () => { throw Error('Action must not run'); }, props: { ${property}: { type: 'DROPDOWN', refreshers: ${JSON.stringify(refreshers)}, options: () => { throw Error('Loader must not run during admission'); } } } } : undefined } };`);
      const auth = authType === 'OAUTH2' ? { access_token: 'borrowed-contract-token' } : { secret_text: 'borrowed-contract-token' };
      const request = { piece, version, action, property, mode: 'options', auth_type: authType, auth, props: {} };
      const loaded = pieceCatalog.validateLoader({ request, packageRoot });
      assert.deepEqual([loaded.declaration.type, loaded.declaration.refreshers], ['DROPDOWN', refreshers]);
      assert.deepEqual(pieceCatalog.prepareLoader({ request, packageRoot }).auth, { type: authType, ...auth, ...(authType === 'OAUTH2' ? { data: {} } : {}) });
      assert.throws(() => pieceCatalog.validateLoader({ request: { ...request, mode: 'props' }, packageRoot }), { name: 'RunnerRefusal', code: 'PROPERTY_NOT_LOADABLE' });
    } finally { await rm(packageRoot, { recursive: true, force: true }); }
  });
}
