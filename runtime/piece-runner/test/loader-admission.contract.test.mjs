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
