import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { providerMapPaths } from './sync-provider-map-to-frontend.mjs';

test('source and frontend provider maps expose exactly the committed pilot display metadata', async (context) => {
  const frontendRoot = await mkdtemp(path.join(tmpdir(), 'activepieces-display-contract-'));
  context.after(() => rm(frontendRoot, { recursive: true, force: true }));
  await Promise.all(providerMapPaths.frontendMarkers.map(async (marker) => {
    const target = path.join(frontendRoot, marker);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '');
  }));
  const sourceText = await readFile(providerMapPaths.providerMapOutput, 'utf8');
  const index = JSON.parse(await readFile(providerMapPaths.sourceIndex, 'utf8'));
  const expected = await Promise.all(index.pieces.map(async (piece) => {
    const artifactPath = path.join(providerMapPaths.sourceRoot, path.relative(index.artifact_root, piece.artifact_path));
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    return {
      auth_types: piece.auth_types,
      display_name: piece.display_name,
      logo_url: artifact.piece.logo_url,
      package_name: piece.package_name,
      package_version: piece.package_version,
      piece_slug: piece.slug,
      runtime_status: piece.runtime_status,
      source_artifact_path: piece.artifact_path,
    };
  }));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('sync-provider-map-to-frontend.mjs', import.meta.url)),
    '--only', 'frontend', '--frontend-root', frontendRoot,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const frontendText = await readFile(path.join(frontendRoot, providerMapPaths.frontendTarget), 'utf8');
  const match = frontendText.match(/export const ACTIVEPIECES_NANGO_PROVIDER_CONFIGS = (\[[\s\S]*?\]) as const;/);
  assert.ok(match, 'frontend module must export the provider records');
  const frontendRecords = JSON.parse(match[1]);
  const source = JSON.parse(sourceText);
  assert.ok(expected.length > 0);
  assert.equal(source.provider_config_count, expected.length);
  for (const record of source.provider_configs) {
    assert.deepEqual(Object.keys(record).sort(), displayFields.map(([key]) => key).sort());
  }
  for (const record of frontendRecords) {
    assert.deepEqual(Object.keys(record).sort(), displayFields.map(([, key]) => key).sort());
  }
  assert.deepEqual(source.provider_configs, expected);
  assert.deepEqual(frontendRecords, expected.map((record) => Object.fromEntries(
    displayFields.map(([sourceKey, frontendKey]) => [frontendKey, record[sourceKey]]),
  )));
  const forbiddenFields = /(?:provider_config_key\w*|providerConfigKey\w*|provider_key|providerKey|nango_provider_key_candidates|candidateOnly|"[^"]*candidate[^"]*"\s*:)/i;
  assert.doesNotMatch(sourceText, forbiddenFields);
  assert.doesNotMatch(frontendText, forbiddenFields);
  assert.equal(await readFile(providerMapPaths.providerMapOutput, 'utf8'), sourceText);
});

const displayFields = [
  ['auth_types', 'authTypes'],
  ['display_name', 'displayName'],
  ['logo_url', 'logoUrl'],
  ['package_name', 'packageName'],
  ['package_version', 'packageVersion'],
  ['piece_slug', 'pieceSlug'],
  ['runtime_status', 'runtimeStatus'],
  ['source_artifact_path', 'sourceArtifactPath'],
];
