#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
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

  // --only source writes this repository's map; --only frontend (a consumer's tree-landing row) writes only the
  // frontend read model, from the committed pilot artifacts.
  const writesSource = options.only !== 'frontend';
  const writesFrontend = options.only !== 'source';
  if (writesFrontend) {
    await assertFrontendRoot(frontendRoot);
  }
  if (writesSource && (options.check || options.skipGenerate)) {
    runExtractor('check');
  } else if (writesSource) {
    runExtractor('generate');
    runExtractor('check');
  }

  const providerMap = await buildProviderMap();
  validateProviderMap(providerMap);
  const providerMapJson = stableJson(providerMap);
  const frontendModule = renderFrontendModule(providerMap);

  if (options.check) {
    if (writesSource) await assertCurrent(PROVIDER_MAP_OUTPUT_PATH, providerMapJson);
    if (writesFrontend) await assertCurrent(frontendTargetPath, frontendModule);
    console.log(
      `Generated Nango provider map is current for ${providerMap.provider_config_count} Activepieces pieces.`,
    );
    return;
  }

  if (writesSource) {
    await fs.mkdir(path.dirname(PROVIDER_MAP_OUTPUT_PATH), { recursive: true });
    await fs.writeFile(PROVIDER_MAP_OUTPUT_PATH, providerMapJson);
  }
  if (writesFrontend) {
    await fs.rm(path.dirname(frontendTargetPath), { recursive: true, force: true });
    await fs.mkdir(path.dirname(frontendTargetPath), { recursive: true });
    await fs.writeFile(frontendTargetPath, frontendModule);
  }

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
    only: undefined,
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
    if (arg === '--only') {
      const value = args[index + 1];
      if (value !== 'source' && value !== 'frontend') {
        throw new Error('--only takes source or frontend.');
      }
      options.only = value;
      index += 1;
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
  --only source|frontend  Write or check only this repository's map, or only the frontend read model.
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

  const artifactPath = requiredString(indexPiece.artifact_path, `${packageName} artifact_path`);

  return sortObjectKeys({
    auth_types: requiredStringArray(indexPiece.auth_types, `${packageName} auth_types`),
    display_name: requiredString(indexPiece.display_name, `${packageName} display_name`),
    logo_url: requiredLogoUrl(artifact.piece?.logo_url, packageName),
    package_name: packageName,
    package_version: requiredString(indexPiece.package_version, `${packageName} package_version`),
    piece_slug: requiredString(indexPiece.slug, `${packageName} slug`),
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

// Node runs a symlinked script under its real path (a consumer's tree landing reaches this repo through a symlink).
if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export const providerMapPaths = {
  frontendMarkers: FRONTEND_MARKERS,
  frontendTarget: FRONTEND_TARGET_RELATIVE_PATH,
  sourceIndex: SOURCE_INDEX_PATH,
  sourceRoot: SOURCE_ROOT,
  providerMapOutput: PROVIDER_MAP_OUTPUT_PATH,
};
