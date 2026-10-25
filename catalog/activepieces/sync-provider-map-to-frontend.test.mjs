import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { providerMapPaths } from './sync-provider-map-to-frontend.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'sync-provider-map-to-frontend.mjs');
const RETIRED_NEXT_MARKER = path.join(
  'src',
  'app',
  'api',
  'activepieces',
  'nango',
  'connect-session',
  'route.ts',
);

async function createFrontendRoot(marker) {
  const root = await mkdtemp(path.join(tmpdir(), 'activepieces-provider-map-'));
  for (const relativePath of [marker, providerMapPaths.frontendMarkers[1]]) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// test marker\n');
  }
  return root;
}

function runSync(frontendRoot) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--only', 'frontend', '--frontend-root', frontendRoot],
    { encoding: 'utf8' },
  );
}

test('admits the canonical TanStack Start route and generates the Discord provider read model', async () => {
  const frontendRoot = await createFrontendRoot(providerMapPaths.frontendMarkers[0]);
  try {
    const result = runSync(frontendRoot);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generated = await readFile(path.join(frontendRoot, providerMapPaths.frontendTarget), 'utf8');
    assert.match(generated, /"packageName": "@activepieces\/piece-discord"/);
    assert.match(generated, /"displayName": "Discord"/);
    assert.match(generated, /"logoUrl": "https:\/\/cdn\.activepieces\.com\/pieces\/discord\.png"/);
  } finally {
    await rm(frontendRoot, { recursive: true, force: true });
  }
});

test('a consumer landing that reaches the catalog through a symlink still refuses a stale frontend map', async () => {
  const frontendRoot = await createFrontendRoot(providerMapPaths.frontendMarkers[0]);
  const linkDir = await mkdtemp(path.join(tmpdir(), 'activepieces-catalog-link-'));
  try {
    const target = path.join(frontendRoot, providerMapPaths.frontendTarget);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// stale\n');
    await symlink(path.resolve(SCRIPT_DIR, '..', '..'), path.join(linkDir, 'activepieces-catalog'));
    const linked = path.join(linkDir, 'activepieces-catalog', path.relative(path.resolve(SCRIPT_DIR, '..', '..'), SCRIPT_PATH));
    const result = spawnSync(process.execPath, [linked, '--only', 'frontend', '--frontend-root', frontendRoot, '--check'],
      { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout);
  } finally {
    await rm(frontendRoot, { recursive: true, force: true });
    await rm(linkDir, { recursive: true, force: true });
  }
});

test('rejects a frontend root that exposes only the retired Next route marker', async () => {
  const frontendRoot = await createFrontendRoot(RETIRED_NEXT_MARKER);
  try {
    const result = runSync(frontendRoot);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /missing required marker src\/routes\/api\/activepieces\/nango\/connect-session\.tsx/,
    );
  } finally {
    await rm(frontendRoot, { recursive: true, force: true });
  }
});
