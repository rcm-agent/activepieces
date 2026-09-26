import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'sync-provider-map-to-frontend.mjs');
const GENERATED_TARGET = path.join(
  'src',
  'generated',
  'activepieces-nango-provider-map',
  'index.ts',
);
const GENERATED_CLIENT_MARKER = path.join(
  'src',
  'generated',
  'activepieces-nango-oauth-client',
  'index.ts',
);
const TANSTACK_MARKER = path.join(
  'src',
  'routes',
  'api',
  'activepieces',
  'nango',
  'connect-session.tsx',
);
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
  for (const relativePath of [marker, GENERATED_CLIENT_MARKER]) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// test marker\n');
  }
  return root;
}

function runSync(frontendRoot) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--skip-generate', '--frontend-root', frontendRoot],
    { encoding: 'utf8' },
  );
}

test('admits the canonical TanStack Start route and generates the Discord provider read model', async () => {
  const frontendRoot = await createFrontendRoot(TANSTACK_MARKER);
  try {
    const result = runSync(frontendRoot);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generated = await readFile(path.join(frontendRoot, GENERATED_TARGET), 'utf8');
    assert.match(generated, /"packageName": "@activepieces\/piece-discord"/);
    assert.match(generated, /"providerConfigKey": "discord-dev"/);
    assert.match(generated, /"logoUrl": "https:\/\/cdn\.activepieces\.com\/pieces\/discord\.png"/);
  } finally {
    await rm(frontendRoot, { recursive: true, force: true });
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
