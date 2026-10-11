import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pieceCatalog } from './catalog.mjs';

async function outdated({ repositoryRoot = defaultRoot, npmView = viewVersion } = {}) {
  const manifest = await readJson(join(repositoryRoot, 'runtime/piece-runner/package.json'));
  const rows = [];
  for (const { name, source } of packageSources()) {
    const runnerPin = manifest.dependencies[name];
    const fork = await readJson(join(repositoryRoot, source));
    const latest = await step({ name: `npm latest ${name}`, run: () => npmView({ name }) });
    rows.push({ name, runner_pin: runnerPin, fork_version: fork.version, npm_latest: latest,
      behind: compareVersions({ left: latest, right: runnerPin }) > 0 });
  }
  return rows;
}

async function refresh({ repositoryRoot = defaultRoot, upstream, exec = execute, containerCheck = checkContainer, log = console.log } = {}) {
  if (!upstream || upstream.startsWith('-')) throw new Error('refresh requires --upstream <commit>');
  const git = (args) => exec({ command: 'git', args, cwd: repositoryRoot });
  const before = await step({ name: 'preflight', run: async () => {
    await git(['diff', '--cached', '--quiet']);
    const { stdout } = await git(['diff', '--name-only', '--diff-filter=U']);
    if (stdout.trim()) throw new Error(`Unmerged paths:\n${stdout.trim()}`);
    return JSON.parse((await git(['show', 'HEAD:catalog/activepieces/generated/runner/actions.json'])).stdout);
  } });
  const commit = await step({ name: 'upstream', run: async () => {
    await git(['fetch', '--filter=blob:none', 'upstream', 'main']);
    const { stdout } = await git(['rev-parse', '--verify', '--end-of-options', `${upstream}^{commit}`]);
    const fullCommit = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(fullCommit)) throw new Error('Upstream must resolve to a full commit hash');
    if (!await ancestor({ git, commit: fullCommit, target: 'upstream/main' })) throw new Error(`${fullCommit} is not on upstream/main`);
    if (await ancestor({ git, commit: fullCommit, target: 'HEAD' })) throw new Error(`${fullCommit} is already an ancestor of HEAD`);
    return fullCommit;
  } });
  await step({ name: 'merge', run: async () => {
    try { await git(['merge', '--no-ff', '--no-edit', commit]); }
    catch (error) {
      const { stdout } = await git(['diff', '--name-only', '--diff-filter=U']);
      if (stdout.trim()) throw new Error(`${diagnostic(error)}\nConflicted paths (resolve before continuing):\n${stdout.trim()}`);
      throw error;
    }
  } });
  const sources = packageSources();
  const runnerRoot = join(repositoryRoot, 'runtime/piece-runner');
  const manifest = await step({ name: 're-pin', run: async () => {
    const updated = await readJson(join(runnerRoot, 'package.json'));
    for (const { name, source } of sources) {
      const fork = await readJson(join(repositoryRoot, source));
      compareVersions({ left: fork.version, right: fork.version });
      updated.dependencies[name] = fork.version;
    }
    await writeFile(join(runnerRoot, 'package.json'), `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  } });
  await step({ name: 'lock', run: async () => {
    try { await exec({ command: 'npm', args: ['install', '--package-lock-only', '--save-exact', '--ignore-scripts'], cwd: runnerRoot }); }
    catch (error) {
      const pins = sources.map(({ name }) => `${name}@${manifest.dependencies[name]}`).join(', ');
      throw new Error(`${diagnostic(error)}\nCould not lock runner packages: ${pins}`);
    }
  } });
  await step({ name: 'provenance', run: async () => {
    const path = join(repositoryRoot, 'catalog/activepieces/extract-pilot-metadata.mjs');
    const source = await readFile(path, 'utf8');
    const matches = source.match(/const UPSTREAM_COMMIT = '[a-f0-9]+';/g);
    if (matches?.length !== 1) throw new Error('Expected one UPSTREAM_COMMIT pin in pilot extractor');
    await writeFile(path, source.replace(matches[0], `const UPSTREAM_COMMIT = '${commit}';`));
  } });
  for (const mode of ['generate', 'check']) {
    for (const script of ['extract-pilot-metadata', 'generate-piece-directory']) {
      await step({ name: `${script} ${mode}`, run: () => exec({ command: process.execPath,
        args: [`catalog/activepieces/${script}.mjs`, mode], cwd: repositoryRoot }) });
    }
  }
  const after = await step({ name: 'container', run: () => containerCheck({ repositoryRoot, exec, sources }) });
  const output = join(repositoryRoot, 'catalog/activepieces/generated/runner/actions.json');
  await step({ name: 'runner export', run: () => writeFile(output, `${JSON.stringify(after, null, 2)}\n`) });
  const diff = await step({ name: 'review', run: () => reviewActions({ before, after }) });
  log(`Action review:\n${JSON.stringify(diff, null, 2)}`);
  log('Downstream sync commands (run after reviewing and committing):\nnode catalog/activepieces/sync-to-orchestrator.mjs\nnode catalog/activepieces/sync-provider-map-to-frontend.mjs\nnode catalog/activepieces/generate-piece-directory.mjs sync-frontend');
  const status = await step({ name: 'status', run: () => git(['status', '--short']) });
  log(status.stdout);
  return diff;
}

function reviewActions({ before, after, entries = pieceCatalog.entries }) {
  for (const entry of entries) {
    if (!after.some((action) => action.piece === entry.piece && action.action === entry.action)) {
      throw new Error(`Allowlisted action missing: ${entry.piece} ${entry.action}`);
    }
  }
  const previous = new Map(before.map((action) => [`${action.piece}:${action.id}`, action]));
  return after.flatMap((action) => {
    const old = previous.get(`${action.piece}:${action.id}`);
    const props = compareProps({ before: old?.props ?? {}, after: action.props });
    const version = old?.version === action.version ? undefined : { before: old?.version ?? null, after: action.version };
    const auth = sameKinds({ before: old?.auth_kinds ?? [], after: action.auth_kinds }) ? undefined
      : { before: old?.auth_kinds ?? [], after: action.auth_kinds };
    if (!version && !auth && !props.added.length && !props.removed.length && !props.changed.length) return [];
    return [{ piece: action.piece, id: action.id, ...(version ? { version } : {}), props, ...(auth ? { auth_kinds: auth } : {}) }];
  });
}

async function main({ argv = process.argv.slice(2) } = {}) {
  if (argv[0] === 'outdated' && (argv.length === 1 || (argv.length === 2 && argv[1] === '--json'))) {
    const rows = await outdated();
    if (argv[1] === '--json') console.log(JSON.stringify(rows, null, 2));
    else console.table(rows);
    return;
  }
  if (argv.length === 3 && argv[0] === 'refresh' && argv[1] === '--upstream') {
    await refresh({ upstream: argv[2] });
    return;
  }
  throw new Error('Usage: node runtime/piece-runner/update-pieces.mjs outdated [--json] | refresh --upstream <commit>');
}

// Pieces only: published pieces bundle their own framework, so the fork's framework, common and shared versions say
// nothing about what runs (upstream's are unpublished since mid-2026), and the runner's own pins stay where they are.
function packageSources() {
  const pieces = new Map(pieceCatalog.entries.map((entry) => [entry.piece,
    { name: entry.piece, source: `packages/pieces/community/${entry.forkDirectory}/package.json` }]));
  return [...pieces.values()];
}

async function viewVersion({ name }) {
  const { stdout } = await execute({ command: 'npm', args: ['view', name, 'version'], cwd: defaultRoot });
  return stdout.trim();
}

async function checkContainer({ repositoryRoot, exec, sources }) {
  const tar = await exec({ command: 'tar', args: ['-cf', '-', '--exclude=node_modules', '--exclude=.npmrc',
    'runtime/piece-runner', 'catalog/activepieces/generated', ...sources.map(({ source }) => source)], cwd: repositoryRoot, encoding: null });
  const script = [
    'set -e',
    'run_check() { check="$1"; shift; "$@" >&2 || { code=$?; printf "%s failed (exit %s)\\n" "$check" "$code" >&2; exit "$code"; }; }',
    'mkdir -p /work',
    'tar -xf - -C /work',
    'cd /work/runtime/piece-runner',
    'run_check "npm ci" npm ci --ignore-scripts',
    'run_check "check-versions" npm run check-versions',
    'run_check "action export for contract tests" node export-actions.mjs /work/catalog/activepieces/generated/runner/actions.json',
    'run_check "contract tests" npm test',
    'run_check "action export" node export-actions.mjs /work/catalog/activepieces/generated/runner/actions.json',
    'cat /work/catalog/activepieces/generated/runner/actions.json',
  ].join('\n');
  const { stdout } = await exec({ command: 'docker', args: ['run', '--rm', '-i', 'node:20-bookworm', 'sh', '-c', script],
    cwd: repositoryRoot, input: tar.stdout });
  return JSON.parse(stdout);
}

function execute({ command, args, cwd, input, encoding = 'utf8' }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (code) => {
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const error = new Error(`${command} exited with ${code}`);
        Object.assign(error, { code, stdout: out.toString('utf8'), stderr: err });
        reject(error);
      } else resolveResult({ stdout: encoding === null ? out : out.toString(encoding), stderr: err });
    });
    child.stdin.end(input);
  });
}

async function ancestor({ git, commit, target }) {
  try { await git(['merge-base', '--is-ancestor', commit, target]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}

async function step({ name, run }) {
  try { return await run(); }
  catch (error) { throw new Error(`[${name}] ${diagnostic(error)}`, { cause: error }); }
}

function diagnostic(error) {
  return [error.message, error.stdout, error.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-40).join('\n');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function sameKinds({ before, after }) {
  return JSON.stringify([...before].sort()) === JSON.stringify([...after].sort());
}

function compareProps({ before, after, prefix = '' }) {
  const added = [], removed = [], changed = [];
  for (const name of Object.keys(before)) if (!Object.hasOwn(after, name)) removed.push(`${prefix}${name}`);
  for (const [name, prop] of Object.entries(after)) {
    const path = `${prefix}${name}`, old = before[name];
    if (!old) { added.push(path); continue; }
    for (const field of ['type', 'required']) {
      if (old[field] !== prop[field]) changed.push({ prop: path, field, before: old[field], after: prop[field] });
    }
    const nested = compareProps({ before: old.properties ?? {}, after: prop.properties ?? {}, prefix: `${path}.` });
    added.push(...nested.added); removed.push(...nested.removed); changed.push(...nested.changed);
  }
  return { added, removed, changed };
}

function compareVersions({ left, right }) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error(`Expected an exact semver version: ${version}`);
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) throw new Error(`Invalid semver prerelease: ${version}`);
  return { core: match.slice(1, 4).map((part) => BigInt(part)), pre };
}

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

export { outdated, refresh, reviewActions };
