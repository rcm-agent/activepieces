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
function propsMetadata(declarations) { return Object.fromEntries(Object.entries(declarations).map(([name, prop]) => [name, { type: prop.type, required: prop.required, description: prop.description ?? '', ...(prop.properties ? { properties: propsMetadata(prop.properties) } : {}) }])); }
test('exports installed action props, required flags, auth kinds and deterministic action ids', async () => {
  const exported = pieceCatalog.exportActions({});
  assert.deepEqual(JSON.parse(await readFile(resolve(packageRoot, '../../catalog/activepieces/generated/runner/actions.json'), 'utf8')), exported);
  assert.deepEqual(exported.map((item) => item.id), ['send_channel_message', 'send_message_with_bot', 'get-many-rows', 'find_rows', 'find_row_by_num', 'insert_row', 'google-sheets-insert-multiple-rows', 'update_row', 'google_calendar_find_busy_free_periods', 'google_calendar_get_events', 'google_calendar_get_event_by_id', 'create_google_calendar_event', 'update_event', 'search-folder', 'create_new_gdrive_folder']);
  for (const entry of pieceCatalog.entries) {
    const piece = require(entry.piece)[entry.exportName], action = piece.getAction(entry.action);
    const metadata = exported.find((item) => item.piece === entry.piece && item.action === entry.action);
    assert.deepEqual([metadata.version, metadata.description], [require(`${entry.piece}/package.json`).version, action.description]);
    assert.deepEqual(metadata.props, propsMetadata(action.props));
    assert.deepEqual(metadata.auth_kinds, (Array.isArray(piece.auth) ? piece.auth : [piece.auth]).map((auth) => auth.type));
  }
  const directory = await mkdtemp(join(tmpdir(), 'piece-runner-export-'));
  try {
    const output = join(directory, 'actions.json');
    await promisify(execFile)(process.execPath, [join(packageRoot, 'export-actions.mjs'), output], { env: {} });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), exported);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('fails closed when a pinned piece version differs from the fork', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'piece-runner-version-'));
  try {
    for (const path of [...new Set(pieceCatalog.entries.map((entry) => `packages/pieces/community/${entry.forkDirectory}/package.json`))]) {
      const target = join(repositoryRoot, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readFile(resolve(packageRoot, '../..', path), 'utf8'));
    }
    for (const forkDirectory of ['slack', 'google-sheets', 'google-calendar', 'google-drive']) {
      const target = join(repositoryRoot, `packages/pieces/community/${forkDirectory}/package.json`), original = await readFile(target, 'utf8');
      await writeFile(target, JSON.stringify({ version: '0.0.0' }));
      assert.throws(() => pieceCatalog.verifyVersions({ repositoryRoot }), { name: 'RunnerRefusal', code: 'VERSION_MISMATCH' });
      await writeFile(target, original);
    }
  } finally { await rm(repositoryRoot, { recursive: true, force: true }); }
});
