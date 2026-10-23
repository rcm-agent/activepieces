import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pieceCatalog } from '../catalog.mjs';
import { pieceRunner } from '../index.mjs';
import { runnerExecution } from '../execution.mjs';
import { runnerContext } from '../context.mjs';
import { runnerStore } from '../store.mjs';
import { runnerTriggerCatalog } from '../trigger-catalog.mjs';
import { handler } from '../lambda.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url)), require = createRequire(join(packageRoot, 'package.json'));
const installedOptions = { skip: pieceCatalog.entries.some((entry) => !existsSync(join(packageRoot, 'node_modules', entry.piece, 'package.json'))) ? 'Pinned packages are unavailable; run installed-piece checks in the runner image.' : false };

test('TIMEBASED and LAST_ITEM hooks round-trip caller cursors without replay', async () => {
  for (const [strategy, key, baseline, newer] of [['TIMEBASED', 'lastPoll', 100, 200], ['LAST_ITEM', 'lastItem', 'old', 'new']]) {
    const trigger = {
      onEnable: async ({ store }) => { await store.put(key, baseline); return ['ignored']; },
      // Reads what pollingHelper.poll and test read from the whole context.
      run: async ({ store, auth, propsValue, maxItemsToPoll, files, server }) => { const previous = await store.get(key); if (strategy === 'TIMEBASED' && previous === null) throw Error('Missing lastPoll'); await store.put(key, newer); return previous === newer ? [] : [{ strategy, id: newer }]; },
      test: async ({ store, auth, propsValue, files, server }) => [{ strategy, id: newer }],
    };
    const catalog = { prepareTrigger: () => ({ trigger, auth: {}, props: {} }) }, input = { caller: { preserved: true } };
    const run = ({ hook, store }) => runnerExecution.execute({ request: { mode: 'trigger', hook, store }, pieceCatalog: catalog });
    const enabled = await run({ hook: 'enable', store: input });
    assert.deepEqual(enabled, { items: [], store: { ...input, [key]: baseline } });
    const polled = await run({ hook: 'poll', store: enabled.store });
    assert.deepEqual(polled, { items: [{ strategy, id: newer }], store: { ...input, [key]: newer } });
    assert.deepEqual(await run({ hook: 'poll', store: polled.store }), { items: [], store: polled.store });
    assert.deepEqual(await run({ hook: 'test' }), { items: [{ strategy, id: newer }], store: {} });
    assert.deepEqual(input, { caller: { preserved: true } });
  }
});

test('trigger stores reject invalid JSON and oversized maps and isolate caller values', async () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [null, [], 'cursor', { bad: undefined }, { bad: NaN }, { bad: Infinity }, { bad: 1n }, cycle]) {
    assert.throws(() => runnerStore.validate({ value }), { code: 'INVALID_STORE' });
    const result = await pieceRunner.invoke({ mode: 'trigger', hook: 'poll', store: value });
    assert.deepEqual([result.status, result.refusal?.code], ['refused', 'INVALID_STORE']);
  }
  const oversized = { cursor: 'é'.repeat(1024) };
  assert.throws(() => runnerStore.validate({ value: oversized }), { code: 'STORE_LIMIT_EXCEEDED' });
  const boundary = { cursor: 'x'.repeat(2048 - Buffer.byteLength(JSON.stringify({ cursor: '' }))) };
  assert.deepEqual(runnerStore.validate({ value: boundary }), boundary);
  const value = { nested: { id: 1 } }, store = runnerStore.create({ value }); value.nested.id = 2;
  assert.deepEqual(await store.service.get('nested'), { id: 1 });
  const nested = await store.service.get('nested', 'project'); nested.id = 9;
  assert.equal(store.snapshot().nested.id, 1);
  await store.service.put('new', { id: 3 }, 'flow'); await store.service.delete('nested', 'project');
  assert.deepEqual(store.snapshot(), { new: { id: 3 } });
  await assert.rejects(store.service.put('large', oversized), { code: 'STORE_LIMIT_EXCEEDED' });
  assert.deepEqual(store.snapshot(), { new: { id: 3 } });
  const context = runnerContext.createTrigger({ auth: {}, props: {}, store: store.service });
  assert.equal(context.store, store.service);
  assert.equal(typeof context.files.write, 'function');
  for (const method of ['write', 'read']) await assert.rejects(context.files[method]({}), { code: 'CONTEXT_SERVICE_UNAVAILABLE' });
  assert.throws(() => context.server.apiUrl, { code: 'CONTEXT_SERVICE_UNAVAILABLE' });
  for (const service of ['project', 'connections']) assert.throws(() => context[service], { code: 'CONTEXT_SERVICE_UNAVAILABLE' });
});

test('trigger admission rejects webhook strategies and resolves only selected trigger loaders', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'piece-runner-trigger-'));
  try {
    await writeFile(join(packageRoot, 'package.json'), '{}');
    for (const [directory, name, type] of [['discord', 'poll', 'POLLING'], ['docusign', 'envelopeCreated', 'WEBHOOK'], ['slack', 'new-message-in-channel', 'APP_WEBHOOK'], ['onfleet', 'manual', 'MANUAL']]) {
      const entry = pieceCatalog.entries.find((item) => item.piece === `@activepieces/piece-${directory}`), target = join(packageRoot, 'node_modules', entry.piece);
      await mkdir(target, { recursive: true }); await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), `const trigger = { name: ${JSON.stringify(name)}, type: ${JSON.stringify(type)}, onEnable() {}, run() { throw Error('poll invoked'); }, test() { throw Error('test invoked'); }, props: { required: { type: 'SHORT_TEXT', required: true }, choice: { type: 'DROPDOWN', options: () => ({ options: [{ label: 'First', value: 1 }] }) }, fields: { type: 'DYNAMIC', props: () => ({ field: { type: 'SHORT_TEXT', required: false, displayName: 'Field' } }) } } }; const triggers = { [trigger.name]: trigger, unknown: { ...trigger, name: 'unknown', type: 'UNKNOWN' } }; module.exports = { ${entry.exportName}: { auth: { type: ${JSON.stringify(entry.authType ?? (directory === 'discord' ? 'SECRET_TEXT' : 'OAUTH2'))} }, metadata: () => ({ triggers }), getTrigger: (name) => triggers[name] } };`);
      const tuple = { piece: entry.piece, version: entry.version, trigger: name };
      if (type !== 'POLLING') { assert.throws(() => pieceCatalog.loadTrigger({ ...tuple, packageRoot }), { code: 'TRIGGER_NOT_ADMITTED' }); continue; }
      for (const trigger of ['missing', 'toString', 'unknown']) assert.throws(() => pieceCatalog.loadTrigger({ ...tuple, trigger, packageRoot }), { code: 'TRIGGER_NOT_ADMITTED' });
      assert.throws(() => pieceCatalog.loadTrigger({ ...tuple, action: entry.action, packageRoot }), { code: 'TRIGGER_NOT_ADMITTED' });
      const loaded = pieceCatalog.loadTrigger({ ...tuple, packageRoot }), metadata = loaded.piece.metadata;
      loaded.piece.metadata = () => ({ triggers: { [name]: { ...loaded.trigger, type: 'WEBHOOK' } } });
      assert.throws(() => pieceCatalog.loadTrigger({ ...tuple, packageRoot }), { code: 'TRIGGER_NOT_ADMITTED' }); loaded.piece.metadata = metadata;
      const request = { ...tuple, auth_type: 'SECRET_TEXT', auth: { secret_text: 'trigger-contract-token' }, props: {} };
      assert.throws(() => pieceCatalog.prepareTrigger({ request, packageRoot }), { code: 'MISSING_REQUIRED_PROP' });
      for (const [mode, property] of [['options', 'choice'], ['props', 'fields']]) {
        const loaderRequest = { ...request, mode, property }, prepared = pieceCatalog.prepareLoader({ request: loaderRequest, packageRoot });
        assert.equal(typeof prepared.declaration[mode], 'function');
        const catalog = { prepareLoader: ({ request }) => pieceCatalog.prepareLoader({ request, packageRoot }), exportProps: pieceCatalog.exportProps };
        const output = await runnerExecution.execute({ request: loaderRequest, pieceCatalog: catalog });
        assert.deepEqual(output, mode === 'options' ? { options: [{ label: 'First', value: 1 }], disabled: false, placeholder: null } : { props: { field: { type: 'SHORT_TEXT', required: false, description: '', display_name: 'Field' } } });
      }
    }
    const entry = pieceCatalog.entries.find((item) => item.piece === '@activepieces/piece-discord'), callerRoot = join(packageRoot, 'caller-root'), target = join(callerRoot, 'node_modules', entry.piece), maliciousFile = join(target, 'index.cjs');
    await mkdir(target, { recursive: true }); await writeFile(join(callerRoot, 'package.json'), '{}'); await writeFile(join(target, 'package.json'), JSON.stringify({ version: entry.version, main: 'index.cjs' }));
    await writeFile(maliciousFile, "throw Error('CALLER_ROOT_MODULE_MUST_NOT_EXECUTE_3323');");
    const result = await pieceRunner.invoke({ piece: entry.piece, version: entry.version, trigger: 'caller_root_only_3323', mode: 'trigger', hook: 'enable', packageRoot: callerRoot, auth_type: 'SECRET_TEXT', auth: { secret_text: 'trigger-contract-token' }, allowed_hosts: ['discord.com'], props: {} });
    assert.equal(require.cache[maliciousFile], undefined); assert.notEqual(result.status, 'completed'); assert.doesNotMatch(JSON.stringify(result), /CALLER_ROOT_MODULE_MUST_NOT_EXECUTE_3323/);
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('invalid trigger hooks and typed credentials refuse before a worker starts', async () => {
  for (const [request, code] of [[{ hook: 'disable' }, 'INVALID_TRIGGER_HOOK'], [{}, 'INVALID_TRIGGER_HOOK'], [{ hook: 'poll', store: { cursor: 'x'.repeat(2048) } }, 'STORE_LIMIT_EXCEEDED'], [{ hook: 'poll', auth_type: 'SECRET_TEXT', auth: { secret_text: 'secret' } }, 'ALLOWED_HOSTS_REQUIRED']]) {
    const result = await pieceRunner.invoke({ mode: 'trigger', ...request });
    assert.deepEqual([result.status, result.refusal?.code], ['refused', code]);
  }
});

test('bundled TIMEBASED enable, poll and test preserve the caller cursor and suppress replay', installedOptions, async () => {
  const request = triggerRequest({ directory: 'discord', trigger: 'new_member', auth_type: 'SECRET_TEXT', auth: { secret_text: 'trigger-contract-token' }, props: { guildId: 'G123' }, allowed_hosts: ['discord.com'] });
  const enabled = await runInstalled({ request: { ...request, hook: 'enable' } }); assert.equal(enabled.status, 'completed'); assert.deepEqual(enabled.output.items, []);
  assert.ok(enabled.output.store.lastPoll > 0);
  const items = [{ user: { id: 'old' }, joined_at: new Date(enabled.output.store.lastPoll - 1000).toISOString() }, { user: { id: 'new' }, joined_at: new Date(enabled.output.store.lastPoll + 1000).toISOString() }];
  const requests = [{ url: 'https://discord.com/api/v9/guilds/G123/members?limit=50', method: 'GET', body: items }];
  const polled = await runInstalled({ request: { ...request, hook: 'poll', store: enabled.output.store }, requests });
  assert.deepEqual(polled, { status: 'completed', output: { items: [items[1]], store: { lastPoll: Date.parse(items[1].joined_at) } } });
  assert.deepEqual(await runInstalled({ request: { ...request, hook: 'poll', store: polled.output.store }, requests }), { status: 'completed', output: { items: [], store: polled.output.store } });
  assert.deepEqual(await runInstalled({ request: { ...request, hook: 'test' }, requests }), { status: 'completed', output: { items, store: {} } });
  const refused = await runInstalled({ request: { ...request, hook: 'poll', store: enabled.output.store }, mode: 'trigger-egress' });
  assert.deepEqual([refused.status, refused.refusal?.code], ['refused', 'EGRESS_HOST_REFUSED']);
});

test('bundled LAST_ITEM initializes a baseline and emits a new calendar exactly once', installedOptions, async () => {
  const request = triggerRequest({ directory: 'google-calendar', trigger: 'new_calendar', auth_type: 'OAUTH2', auth: { access_token: 'trigger-contract-token' }, props: {} });
  const old = { id: 'old', summary: 'Old', accessRole: 'owner' }, added = { id: 'new', summary: 'New', accessRole: 'owner' };
  const response = (items) => ({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?showDeleted=false', method: 'GET', body: { items } });
  const enabled = await runInstalled({ request: { ...request, hook: 'enable' }, requests: [response([old]), response([old])] });
  assert.deepEqual(enabled, { status: 'completed', output: { items: [], store: { calendars: ['old'] } } });
  const polled = await runInstalled({ request: { ...request, hook: 'poll', store: enabled.output.store }, requests: [response([old, added])] });
  assert.deepEqual(polled, { status: 'completed', output: { items: [{ ...added, isOwned: true, isShared: false, calendarType: 'owned' }], store: { calendars: ['old', 'new'], lastItem: 'new' } } });
  assert.deepEqual(await runInstalled({ request: { ...request, hook: 'poll', store: polled.output.store }, requests: [response([old, added])] }), { status: 'completed', output: { items: [], store: polled.output.store } });
});

test('trigger export contains exactly installed POLLING metadata and deterministic artifact bytes', installedOptions, async () => {
  const exported = pieceCatalog.exportTriggers({}), expected = [...new Map(pieceCatalog.entries.map((entry) => [entry.piece, entry])).values()].flatMap((entry) => {
    const piece = require(entry.piece)[entry.exportName];
    return Object.values(piece.metadata().triggers).filter((trigger) => trigger.type === 'POLLING').map((trigger) => ({ piece: entry.piece, version: entry.version, trigger: trigger.name, display_name: trigger.displayName, description: trigger.description, strategy: trigger.type, auth_kinds: (Array.isArray(piece.auth) ? piece.auth : [piece.auth]).map((auth) => auth.type), auth: pieceCatalog.exportAuth({ piece, authType: entry.authType }), props: pieceCatalog.exportProps({ declarations: trigger.props }), sampleData: runnerTriggerCatalog.sampleWithoutUrlQueries(trigger.sampleData ?? null), outputSchema: runnerTriggerCatalog.outputSchemaWithoutUrlQueries(trigger.outputSchema) }));
  }).sort((left, right) => `${left.piece}\0${left.trigger}` < `${right.piece}\0${right.trigger}` ? -1 : 1);
  assert.deepEqual(exported, expected);
  const bytes = `${JSON.stringify(exported, null, 2)}\n`;
  assert.equal(await readFile(new URL('../../../catalog/activepieces/generated/runner/triggers.json', import.meta.url), 'utf8'), bytes);
  const directory = await mkdtemp(join(tmpdir(), 'piece-runner-trigger-export-'));
  try { const output = join(directory, 'triggers.json'); await promisify(childProcess.execFile)(process.execPath, [join(packageRoot, 'export-triggers.mjs'), output], { env: {} }); assert.equal(await readFile(output, 'utf8'), bytes); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('metadata export excludes every non-polling strategy and sorts admitted triggers', () => {
  const entries = [{ piece: 'z', version: '1', authType: 'OAUTH2' }, { piece: 'a', version: '2', authType: 'OAUTH2' }];
  const triggers = Object.fromEntries(['MANUAL', 'WEBHOOK', 'APP_WEBHOOK', 'POLLING'].map((type) => [type, { name: type.toLowerCase(), type, displayName: type, description: 'Contract', props: { limit: { type: 'NUMBER', required: false, displayName: 'Limit', defaultValue: 0 } }, sampleData: { id: 1 }, run: () => assert.fail('Export must not run hooks') }]));
  let verified = 0;
  const input = { entries: [...entries, entries[0]], loadPiece: ({ entry }) => ({ entry, piece: { auth: [{ type: 'CUSTOM_AUTH', props: {} }, { type: 'OAUTH2' }], metadata: () => ({ triggers }) } }), verifyVersions: () => { verified += 1; }, exportProps: pieceCatalog.exportProps, exportAuth: pieceCatalog.exportAuth };
  const exported = runnerTriggerCatalog.exportTriggers(input);
  assert.deepEqual(exported.map(({ piece, trigger, strategy, auth }) => ({ piece, trigger, strategy, auth })), ['a', 'z'].map((piece) => ({ piece, trigger: 'polling', strategy: 'POLLING', auth: { kind: 'OAUTH2', props: {} } })));
  assert.deepEqual(exported[0].props.limit, { type: 'NUMBER', required: false, description: '', display_name: 'Limit', default: 0 });
  assert.deepEqual(exported[0].sampleData, { id: 1 }); assert.equal(verified, 1);
  assert.deepEqual(runnerTriggerCatalog.sampleWithoutUrlQueries({ links: ['https://bucket.s3.amazonaws.com/a.pdf?AWSAccessKeyId=key&Signature=s#top', 'note?'], n: 2 }), { links: ['https://bucket.s3.amazonaws.com/a.pdf', 'note?'], n: 2 });
  assert.equal(JSON.stringify(runnerTriggerCatalog.exportTriggers(input)), JSON.stringify(exported));
});

test('Lambda forwards the complete trigger request unchanged', async () => {
  const original = pieceRunner.invoke, request = { mode: 'trigger', hook: 'poll', trigger: 'new_member', store: { lastPoll: 123 }, auth: { secret_text: 'secret' }, props: {} }, output = { status: 'completed', output: { items: [], store: request.store } };
  try { pieceRunner.invoke = async (received) => { assert.equal(received, request); return output; }; assert.equal(await handler(request), output); }
  finally { pieceRunner.invoke = original; }
});

function triggerRequest({ directory, trigger, ...input }) { const entry = pieceCatalog.entries.find((entry) => entry.piece === `@activepieces/piece-${directory}`); return { piece: entry.piece, version: entry.version, trigger, mode: 'trigger', timeout_ms: 15000, ...input }; }
async function runInstalled({ request, requests = [], mode }) {
  const original = childProcess.spawn, fixture = { requests, mode, authorization: request.auth_type === 'OAUTH2' ? `Bearer ${request.auth.access_token}` : `Bot ${request.auth.secret_text}` };
  childProcess.spawn = (command, args, options) => { assert.deepEqual(options.env, {}); return original(command, ['--require', fileURLToPath(new URL('./http-intercept.cjs', import.meta.url)), ...args, JSON.stringify(fixture)], options); };
  syncBuiltinESMExports();
  try { return await pieceRunner.invoke(request); } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}
