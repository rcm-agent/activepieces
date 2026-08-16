#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const EXTRACTOR_PATH = path.join(SCRIPT_DIR, 'extract-pilot-metadata.mjs');
const SOURCE_ROOT = path.join(SCRIPT_DIR, 'generated', 'pilot');
const DEFAULT_ORCHESTRATOR_ROOT = path.resolve(REPO_ROOT, '..', 'rcm-orchestrator');
const TARGET_RELATIVE_ROOT = path.join(
  'rcm_orchestrator',
  'connectors',
  'catalog',
  'generated',
  'activepieces',
  'pilot',
);
const ORCHESTRATOR_MARKERS = [
  path.join('services', 'connector_catalog_service.py'),
  path.join('rcm_orchestrator', 'connectors', 'catalog', 'generated_activepieces.py'),
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const orchestratorRoot = path.resolve(
    options.orchestratorRoot ?? process.env.RCM_ORCHESTRATOR_ROOT ?? DEFAULT_ORCHESTRATOR_ROOT,
  );
  const targetRoot = path.join(orchestratorRoot, TARGET_RELATIVE_ROOT);

  await assertOrchestratorRoot(orchestratorRoot);
  if (options.skipGenerate) {
    runExtractor('check');
  } else {
    runExtractor('generate');
    runExtractor('check');
  }

  const files = await listJsonFiles(SOURCE_ROOT);
  if (files.length === 0) {
    throw new Error(`No generated JSON artifacts found under ${toRepoPath(SOURCE_ROOT)}.`);
  }

  await fs.rm(targetRoot, { force: true, recursive: true });
  await fs.mkdir(targetRoot, { recursive: true });

  const copied = [];
  for (const sourceFile of files) {
    const relativeFile = path.relative(SOURCE_ROOT, sourceFile);
    const targetFile = path.join(targetRoot, relativeFile);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.copyFile(sourceFile, targetFile);

    const sourceSha256 = await sha256(sourceFile);
    const targetSha256 = await sha256(targetFile);
    if (sourceSha256 !== targetSha256) {
      throw new Error(`Checksum mismatch after copying ${relativeFile}.`);
    }

    copied.push({
      path: normalizePath(relativeFile),
      sha256: sourceSha256,
    });
  }

  console.log(
    JSON.stringify(
      {
        status: 'synced',
        source_root: toRepoPath(SOURCE_ROOT),
        target_root: path.relative(orchestratorRoot, targetRoot),
        orchestrator_root: orchestratorRoot,
        file_count: copied.length,
        files: copied,
      },
      null,
      2,
    ),
  );
}

function parseArgs(args) {
  const options = {
    help: false,
    orchestratorRoot: undefined,
    skipGenerate: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--skip-generate') {
      options.skipGenerate = true;
      continue;
    }
    if (arg === '--orchestrator-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--orchestrator-root requires a path value.');
      }
      options.orchestratorRoot = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--orchestrator-root=')) {
      options.orchestratorRoot = arg.slice('--orchestrator-root='.length);
      if (!options.orchestratorRoot) {
        throw new Error('--orchestrator-root requires a path value.');
      }
      continue;
    }
    throw new Error(`Unknown argument "${arg}". Use --help for usage.`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node catalog/activepieces/sync-to-orchestrator.mjs [options]

Generate the catalog-only Activepieces pilot artifacts and copy them into the
orchestrator generated catalog package. This does not run or require an
Activepieces runtime.

Options:
  --orchestrator-root <path>  Target rcm-orchestrator checkout.
                             Defaults to ../rcm-orchestrator or RCM_ORCHESTRATOR_ROOT.
  --skip-generate            Only check existing generated artifacts before copying.
  -h, --help                 Show this help.
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

async function assertOrchestratorRoot(orchestratorRoot) {
  for (const marker of ORCHESTRATOR_MARKERS) {
    const markerPath = path.join(orchestratorRoot, marker);
    try {
      const stats = await fs.stat(markerPath);
      if (!stats.isFile()) {
        throw new Error(`${markerPath} is not a file.`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Orchestrator root is missing required marker ${marker}: ${orchestratorRoot}`);
      }
      throw error;
    }
  }
}

async function listJsonFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function sha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

function toRepoPath(filePath) {
  return normalizePath(path.relative(REPO_ROOT, filePath));
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
