import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { pieceCatalog } from '../catalog.mjs';
import { outdated, refresh } from '../update-pieces.mjs';
function write({ path, data }) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }
function indexFile({ records }) {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(records.length, 8);
  const entries = records.sort((left, right) => left.path.localeCompare(right.path)).map(({ path, hash, stage = 0 }) => {
    const entry = Buffer.alloc(Math.ceil((63 + Buffer.byteLength(path)) / 8) * 8); entry.writeUInt32BE(0o100644, 24);
    Buffer.from(hash, 'hex').copy(entry, 40); entry.writeUInt16BE((stage << 12) | Buffer.byteLength(path), 60); entry.write(path, 62); return entry;
  });
  const content = Buffer.concat([header, ...entries]); return Buffer.concat([content, createHash('sha1').update(content).digest()]); }
function fixture({ context, staged = false, unmerged = false, conflict = false, lockFailure = false, missing = false }) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'piece-update-contract-')), bare = join(repositoryRoot, 'upstream.git');
  context.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  // Fixture objects keep every git invocation read-only in the isolated worker.
  function object({ type, content }) {
    const data = Buffer.concat([Buffer.from(`${type} ${Buffer.byteLength(content)}\0`), Buffer.from(content)]), hash = createHash('sha1').update(data).digest('hex');
    for (const directory of [join(repositoryRoot, '.git'), bare]) write({ path: join(directory, 'objects', hash.slice(0, 2), hash.slice(2)), data: deflateSync(data) });
    return hash; }
  const actions = JSON.parse(readFileSync(new URL('../../../catalog/activepieces/generated/runner/actions.json', import.meta.url), 'utf8'));
  const actionPath = 'catalog/activepieces/generated/runner/actions.json', actionText = `${JSON.stringify(actions, null, 2)}\n`;
  const actionHash = object({ type: 'blob', content: actionText }); let tree = actionHash;
  for (const [index, name] of actionPath.split('/').reverse().entries()) tree = object({ type: 'tree', content: Buffer.concat([Buffer.from(`${index ? '40000' : '100644'} ${name}\0`), Buffer.from(tree, 'hex')]) });
  function commit({ parent, message }) { return object({ type: 'commit', content: `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Contract <contract@example.test> 1 +0000\ncommitter Contract <contract@example.test> 1 +0000\n\n${message}\n` }); }
  const head = commit({ message: 'fork' }), upstream = commit({ parent: head, message: 'upstream' }), foreign = commit({ message: 'foreign' });
  for (const directory of [join(repositoryRoot, '.git'), bare]) {
    write({ path: join(directory, 'HEAD'), data: 'ref: refs/heads/main\n' }); write({ path: join(directory, 'refs/heads/main'), data: `${directory === bare ? upstream : head}\n` });
    write({ path: join(directory, 'config'), data: `[core]\nrepositoryformatversion = 0\nbare = ${directory === bare}\n` });
  }
  write({ path: join(repositoryRoot, '.git/config'), data: `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "upstream"]\nurl = ${bare}\nfetch = +refs/heads/*:refs/remotes/upstream/*\n` });
  const records = [{ path: actionPath, hash: actionHash }]; if (staged) records.push({ path: 'staged.txt', hash: actionHash });
  if (unmerged) records.push(...[1, 2, 3].map((stage) => ({ path: 'conflicted.txt', hash: actionHash, stage })));
  write({ path: join(repositoryRoot, '.git/index'), data: indexFile({ records }) }); write({ path: join(repositoryRoot, actionPath), data: actionText });
  const [manifestPath, lockPath, pilotPath] = ['runtime/piece-runner/package.json', 'runtime/piece-runner/package-lock.json', 'catalog/activepieces/extract-pilot-metadata.mjs'];
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')); write({ path: join(repositoryRoot, manifestPath), data: `${JSON.stringify(manifest)}\n` });
  for (const [path, data] of [[lockPath, '{"lockfileVersion":3,"packages":{}}\n'], [pilotPath, `const UPSTREAM_COMMIT = '${head}';\n`]]) write({ path: join(repositoryRoot, path), data });
  const sources = [...new Set(pieceCatalog.entries.map((entry) => `packages/pieces/community/${entry.forkDirectory}/package.json`)), 'packages/pieces/framework/package.json', 'packages/pieces/common/package.json', 'packages/shared/package.json'];
  const forks = {}; for (const source of sources) { const data = readFileSync(new URL(`../../../${source}`, import.meta.url), 'utf8'), fork = JSON.parse(data); forks[fork.name] = fork.version; write({ path: join(repositoryRoot, source), data }); }
  const calls = [], logs = [], containers = [];
  async function exec({ command, args, cwd }) {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'fetch') write({ path: join(repositoryRoot, '.git/refs/remotes/upstream/main'), data: readFileSync(join(bare, 'refs/heads/main')) });
    else if (command === 'git' && args[0] === 'merge') {
      if (conflict) {
        write({ path: join(repositoryRoot, '.git/index'), data: indexFile({ records: [...records, ...[1, 2, 3].map((stage) => ({ path: 'conflicted.txt', hash: actionHash, stage }))] }) });
        throw Object.assign(new Error('Merge conflict: conflicted.txt'), { code: 1, stderr: 'merge diagnostic\n'.repeat(80) });
      }
    } else if (command === 'git') return promisify(execFile)(command, args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    else if (command === 'npm' && lockFailure) throw Object.assign(new Error('Unpublished @activepieces/piece-slack'), { code: 1, stderr: 'npm diagnostic\n'.repeat(80) });
    return { stdout: '', stderr: '' };
  }
  const containerCheck = async () => { containers.push(true); return (missing ? actions.slice(1) : actions).map((action) => ({ ...action, version: forks[action.piece] })); };
  return { repositoryRoot, head, upstream, foreign, exec, containerCheck, log: (value) => logs.push(value), calls, logs, containers, pins: manifest.dependencies, forks, snapshot: () => [manifestPath, lockPath, pilotPath].map((path) => readFileSync(join(repositoryRoot, path), 'utf8')) }; }
test('refresh refuses staged or unmerged paths before fetch or merge', async (context) => { for (const state of [{ staged: true }, { unmerged: true }]) {
    const value = fixture({ context, ...state }); await assert.rejects(refresh(value), /preflight/i);
    assert.equal(value.calls.some(({ args }) => ['fetch', 'merge'].includes(args[0])), false);
} });
test('refresh refuses off-upstream or already-merged commits', async (context) => { const value = fixture({ context }); for (const upstream of [value.foreign, value.head]) await assert.rejects(refresh({ ...value, upstream }), /upstream/i);
  assert.equal(value.calls.some(({ args }) => args[0] === 'merge'), false);
});
test('a merge conflict preserves manifest, lock and provenance', async (context) => { const value = fixture({ context, conflict: true }), before = value.snapshot(); await assert.rejects(refresh(value), /merge.*conflicted.txt/is);
  assert.deepEqual(value.snapshot(), before); assert.equal(value.calls.some(({ command }) => command === 'npm'), false); assert.equal(value.containers.length, 0);
});
test('lock failure names its package and stops before container or review', async (context) => { const value = fixture({ context, lockFailure: true }); await assert.rejects(refresh(value), /lock.*piece-slack/is);
  assert.equal(value.containers.length, 0); assert.equal(value.calls.some(({ args }) => args[0].startsWith('catalog/')), false); assert.equal(value.logs.some((line) => String(line).startsWith('Action review:')), false);
});
test('a missing exported action stops with its piece and action names', async (context) => { const value = fixture({ context, missing: true }); await assert.rejects(refresh(value), /review.*@activepieces\/piece-slack.*send_channel_message/i);
});
test('outdated marks only newer versions behind, once per piece plus framework', async (context) => { const value = fixture({ context }), rows = await outdated({ ...value, npmView: async ({ name }) => name.endsWith('slack') ? `${BigInt(value.pins[name].split('.')[0]) + 1n}.0.0` : name.endsWith('discord') ? '0.0.0' : name.endsWith('calendar') ? `${value.pins[name]}-rc.1` : value.pins[name] });
  assert.equal(rows.length, new Set(pieceCatalog.entries.map((entry) => entry.piece)).size + 1); assert.deepEqual(rows.filter((row) => row.behind).map((row) => row.name), ['@activepieces/piece-slack']);
  assert.ok(rows.every((row) => row.fork_version === value.forks[row.name] && row.runner_pin === value.pins[row.name]));
});
