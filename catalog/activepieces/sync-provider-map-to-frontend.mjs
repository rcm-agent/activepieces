#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const EXTRACTOR_PATH = path.join(SCRIPT_DIR, 'extract-pilot-metadata.mjs');
const SOURCE_ROOT = path.join(SCRIPT_DIR, 'generated', 'pilot');
const SOURCE_INDEX_PATH = path.join(SOURCE_ROOT, 'index.json');
const PROVIDER_MAP_OUTPUT_PATH = path.join(
  SCRIPT_DIR,
  'generated',
  'provider-map',
  'nango_provider_config_map.json',
);
const DEFAULT_FRONTEND_ROOT = path.resolve(REPO_ROOT, '..', 'basekey-frontend');
const FRONTEND_TARGET_RELATIVE_PATH = path.join(
  'src',
  'generated',
  'activepieces-nango-provider-map',
  'index.ts',
);
const SCHEMA_VERSION = 'activepieces-nango-provider-map.v1';
const CATALOG_SCHEMA_VERSION = 'activepieces-catalog-candidate.v1';
const RUNTIME_STATUS = 'candidate_only';
const CANONICAL_PACKAGE_PATTERN = /^@activepieces\/piece-[a-z0-9][a-z0-9-]*$/;
const PROVIDER_CONFIG_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const FRONTEND_MARKERS = [
  path.join('src', 'routes', 'api', 'activepieces', 'nango', 'connect-session.tsx'),
  path.join('src', 'generated', 'activepieces-nango-oauth-client', 'index.ts'),
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const frontendRoot = path.resolve(
    options.frontendRoot ?? process.env.BASEKEY_FRONTEND_ROOT ?? DEFAULT_FRONTEND_ROOT,
  );
  const frontendTargetPath = path.join(frontendRoot, FRONTEND_TARGET_RELATIVE_PATH);

  await assertFrontendRoot(frontendRoot);
  if (options.check || options.skipGenerate) {
    runExtractor('check');
  } else {
    runExtractor('generate');
    runExtractor('check');
  }

  const providerMap = await buildProviderMap();
  validateProviderMap(providerMap);
  const providerMapJson = stableJson(providerMap);
  const frontendModule = renderFrontendModule(providerMap);

  if (options.check) {
    await assertCurrent(PROVIDER_MAP_OUTPUT_PATH, providerMapJson);
    await assertCurrent(frontendTargetPath, frontendModule);
    console.log(
      `Generated Nango provider map is current for ${providerMap.provider_config_count} Activepieces pieces.`,
    );
    return;
  }

  await fs.mkdir(path.dirname(PROVIDER_MAP_OUTPUT_PATH), { recursive: true });
  await fs.writeFile(PROVIDER_MAP_OUTPUT_PATH, providerMapJson);

  await fs.rm(path.dirname(frontendTargetPath), { recursive: true, force: true });
  await fs.mkdir(path.dirname(frontendTargetPath), { recursive: true });
  await fs.writeFile(frontendTargetPath, frontendModule);

  console.log(
    JSON.stringify(
      {
        status: 'synced',
        source_artifact_path: toRepoPath(PROVIDER_MAP_OUTPUT_PATH),
        frontend_root: frontendRoot,
        frontend_target_path: path.relative(frontendRoot, frontendTargetPath).split(path.sep).join('/'),
        provider_config_count: providerMap.provider_config_count,
      },
      null,
      2,
    ),
  );
}

function parseArgs(args) {
  const options = {
    check: false,
    frontendRoot: undefined,
    help: false,
    skipGenerate: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--skip-generate') {
      options.skipGenerate = true;
      continue;
    }
    if (arg === '--frontend-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--frontend-root requires a path value.');
      }
      options.frontendRoot = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--frontend-root=')) {
      options.frontendRoot = arg.slice('--frontend-root='.length);
      if (!options.frontendRoot) {
        throw new Error('--frontend-root requires a path value.');
      }
      continue;
    }
    throw new Error(`Unknown argument "${arg}". Use --help for usage.`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node catalog/activepieces/sync-provider-map-to-frontend.mjs [options]

Generate the source-only Activepieces-to-Nango provider map and copy the
generated TypeScript read model into the sibling basekey-frontend checkout.

Options:
  --frontend-root <path>  Target basekey-frontend checkout.
                          Defaults to ../basekey-frontend or BASEKEY_FRONTEND_ROOT.
  --check                 Fail if generated source/frontend artifacts are stale.
  --skip-generate         Use existing extractor artifacts instead of regenerating.
  -h, --help              Show this help.
`);
}

function runExtractor(command) {
  const result = spawnSync(process.execPath, [EXTRACTOR_PATH, command], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Extractor command failed: ${command}`);
  }
}

async function assertFrontendRoot(frontendRoot) {
  for (const marker of FRONTEND_MARKERS) {
    const markerPath = path.join(frontendRoot, marker);
    try {
      const stats = await fs.stat(markerPath);
      if (!stats.isFile()) {
        throw new Error(`${markerPath} is not a file.`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Frontend root is missing required marker ${marker}: ${frontendRoot}`);
      }
      throw error;
    }
  }
}

async function buildProviderMap() {
  const index = await readJson(SOURCE_INDEX_PATH);
  assertCatalogIndex(index);

  const providerConfigs = [];
  for (const piece of index.pieces) {
    const artifactPath = path.join(REPO_ROOT, piece.artifact_path);
    const artifact = await readJson(artifactPath);
    const providerConfig = buildProviderConfig({ indexPiece: piece, artifact });
    providerConfigs.push(providerConfig);
  }

  return sortObjectKeys({
    artifact_root: toRepoPath(SOURCE_ROOT),
    extractor_path: toRepoPath(EXTRACTOR_PATH),
    frontend_generated_path: FRONTEND_TARGET_RELATIVE_PATH.split(path.sep).join('/'),
    provider_config_count: providerConfigs.length,
    provider_configs: providerConfigs,
    runtime_status: RUNTIME_STATUS,
    schema_version: SCHEMA_VERSION,
    source_index_path: toRepoPath(SOURCE_INDEX_PATH),
    upstream_commit: index.upstream_commit,
  });
}

function assertCatalogIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error('Generated Activepieces index must be an object.');
  }
  if (index.schema_version !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`Generated Activepieces index schema_version mismatch: ${index.schema_version}`);
  }
  if (index.runtime_status !== RUNTIME_STATUS) {
    throw new Error('Generated Activepieces index must be candidate_only.');
  }
  if (!Array.isArray(index.pieces) || index.pieces.length === 0) {
    throw new Error('Generated Activepieces index must include a non-empty pieces array.');
  }
}

function buildProviderConfig({ indexPiece, artifact }) {
  const packageName = requiredString(indexPiece.package_name, 'index package_name');
  const artifactPackageName = requiredString(artifact.package?.name, `${packageName} artifact package.name`);
  if (artifactPackageName !== packageName) {
    throw new Error(`Package mismatch between index and artifact for ${packageName}.`);
  }
  if (!CANONICAL_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(`Provider map package_name must be an exact Activepieces package name: ${packageName}`);
  }
  if (artifact.runtime_status !== RUNTIME_STATUS || indexPiece.runtime_status !== RUNTIME_STATUS) {
    throw new Error(`${packageName} must be candidate_only in index and artifact.`);
  }

  const candidateRecords = requiredCandidateRecords(
    artifact.nango_provider_key_candidates,
    packageName,
  );
  const selected = selectProviderConfigKey(candidateRecords, packageName);
  const candidateKeys = candidateRecords.map((candidate) => candidate.provider_key);
  const artifactPath = requiredString(indexPiece.artifact_path, `${packageName} artifact_path`);

  return sortObjectKeys({
    auth_types: requiredStringArray(indexPiece.auth_types, `${packageName} auth_types`),
    display_name: requiredString(indexPiece.display_name, `${packageName} display_name`),
    logo_url: requiredLogoUrl(artifact.piece?.logo_url, packageName),
    package_name: packageName,
    package_version: requiredString(indexPiece.package_version, `${packageName} package_version`),
    piece_slug: requiredString(indexPiece.slug, `${packageName} slug`),
    provider_config_key: selected.provider_key,
    provider_config_key_candidate_records: candidateRecords,
    provider_config_key_candidates: candidateKeys,
    provider_config_key_selection: {
      confidence: selected.confidence,
      policy: 'first_high_confidence_else_first_candidate',
    },
    runtime_status: RUNTIME_STATUS,
    source_artifact_path: artifactPath,
  });
}

function requiredLogoUrl(value, packageName) {
  const logoUrl = requiredString(value, `${packageName} logo_url`);
  if (!logoUrl.startsWith('https://')) {
    throw new Error(`${packageName} logo_url must be an https URL.`);
  }
  return logoUrl;
}

function requiredCandidateRecords(value, contextLabel) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${contextLabel} must include provider candidate records.`);
  }

  const seen = new Set();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${contextLabel} provider candidate must be an object.`);
    }
    const providerKey = requiredString(candidate.provider_key, `${contextLabel} provider_key`);
    if (!PROVIDER_CONFIG_KEY_PATTERN.test(providerKey)) {
      throw new Error(`${contextLabel} provider_key is invalid: ${providerKey}`);
    }
    if (seen.has(providerKey)) {
      throw new Error(`${contextLabel} has duplicate provider_key ${providerKey}.`);
    }
    seen.add(providerKey);
    if (candidate.candidate_only !== true) {
      throw new Error(`${contextLabel} provider candidate ${providerKey} must be candidate_only.`);
    }
    return sortObjectKeys({
      candidate_only: true,
      confidence: requiredString(candidate.confidence, `${contextLabel} ${providerKey} confidence`),
      evidence: requiredString(candidate.evidence, `${contextLabel} ${providerKey} evidence`),
      provider_key: providerKey,
    });
  });
}

function selectProviderConfigKey(candidates, contextLabel) {
  const selected = candidates.find((candidate) => candidate.confidence === 'high') ?? candidates[0];
  if (!selected) {
    throw new Error(`${contextLabel} has no provider config key candidates.`);
  }
  return selected;
}

function validateProviderMap(providerMap) {
  if (providerMap.schema_version !== SCHEMA_VERSION) {
    throw new Error('Provider map schema_version mismatch.');
  }
  if (providerMap.runtime_status !== RUNTIME_STATUS) {
    throw new Error('Provider map must be candidate_only.');
  }
  if (!Array.isArray(providerMap.provider_configs) || providerMap.provider_configs.length === 0) {
    throw new Error('Provider map must include provider_configs.');
  }
  if (providerMap.provider_config_count !== providerMap.provider_configs.length) {
    throw new Error('Provider map count mismatch.');
  }

  const seenPackages = new Set();
  for (const config of providerMap.provider_configs) {
    validateProviderConfig(config);
    if (seenPackages.has(config.package_name)) {
      throw new Error(`Provider map has duplicate package_name ${config.package_name}.`);
    }
    seenPackages.add(config.package_name);
  }
}

function validateProviderConfig(config) {
  const packageName = requiredString(config.package_name, 'provider config package_name');
  if (!CANONICAL_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(`Provider config package_name is not canonical: ${packageName}`);
  }
  const providerConfigKey = requiredString(config.provider_config_key, `${packageName} provider_config_key`);
  if (!PROVIDER_CONFIG_KEY_PATTERN.test(providerConfigKey)) {
    throw new Error(`${packageName} provider_config_key is invalid: ${providerConfigKey}`);
  }
  const candidates = requiredStringArray(
    config.provider_config_key_candidates,
    `${packageName} provider_config_key_candidates`,
  );
  if (!candidates.includes(providerConfigKey)) {
    throw new Error(`${packageName} selected provider_config_key must appear in candidates.`);
  }
  requiredString(config.source_artifact_path, `${packageName} source_artifact_path`);
  requiredString(config.display_name, `${packageName} display_name`);
  requiredString(config.piece_slug, `${packageName} piece_slug`);
  if (config.runtime_status !== RUNTIME_STATUS) {
    throw new Error(`${packageName} runtime_status must be candidate_only.`);
  }
}

function renderFrontendModule(providerMap) {
  const records = providerMap.provider_configs.map((config) => sortObjectKeys({
    authTypes: config.auth_types,
    displayName: config.display_name,
    logoUrl: config.logo_url,
    packageName: config.package_name,
    packageVersion: config.package_version,
    pieceSlug: config.piece_slug,
    providerConfigKey: config.provider_config_key,
    providerConfigKeyCandidateRecords: config.provider_config_key_candidate_records.map((candidate) => sortObjectKeys({
      candidateOnly: candidate.candidate_only,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      providerKey: candidate.provider_key,
    })),
    providerConfigKeyCandidates: config.provider_config_key_candidates,
    runtimeStatus: config.runtime_status,
    sourceArtifactPath: config.source_artifact_path,
  }));

  return [
    '// Generated by activepieces-catalog/catalog/activepieces/sync-provider-map-to-frontend.mjs.',
    '// Do not edit manually.',
    '',
    `export const ACTIVEPIECES_NANGO_PROVIDER_MAP_SCHEMA_VERSION = ${JSON.stringify(SCHEMA_VERSION)} as const;`,
    '',
    `export const ACTIVEPIECES_NANGO_PROVIDER_CONFIGS = ${JSON.stringify(records, null, 2)} as const;`,
    '',
    'export type ActivepiecesNangoProviderConfig =',
    '  (typeof ACTIVEPIECES_NANGO_PROVIDER_CONFIGS)[number];',
    '',
  ].join('\n');
}

async function assertCurrent(filePath, expectedText) {
  let actualText;
  try {
    actualText = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Generated artifact is missing: ${filePath}`);
    }
    throw error;
  }
  if (actualText !== expectedText) {
    throw new Error(`Generated artifact is stale: ${filePath}`);
  }
}

async function readJson(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Required generated artifact is missing: ${toRepoPath(filePath)}`);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Generated artifact is not valid JSON: ${toRepoPath(filePath)}`, { cause: error });
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  return value.map((item) => requiredString(item, label));
}

function stableJson(value) {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObjectKeys(entry)]),
  );
}

function toRepoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
