#!/usr/bin/env node
// Builds a lightweight directory of every forked Activepieces community piece:
// display name, description, logo, categories and auth kinds. The Data Hub
// connector catalog shows it so people can find apps. Directory entries are
// display metadata only. A piece is connectable only through the provider map
// and executable only after an RCM catalog promotion (see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIECES_ROOT = path.join(REPO_ROOT, 'packages', 'pieces', 'community');
const OUTPUT_PATH = path.join(REPO_ROOT, 'catalog', 'activepieces', 'generated', 'directory', 'pieces.json');
const FRONTEND_MODULE_PATH = path.join('src', 'generated', 'activepieces-piece-directory', 'index.ts');
const SCHEMA_VERSION = 'activepieces-piece-directory.v1';
const PACKAGE_NAME_PATTERN = /^@activepieces\/piece-[a-z0-9-]+$/;
const DESCRIPTION_LIMIT = 200;
const AUTH_KIND_BY_FACTORY = {
  BasicAuth: 'basic_auth',
  CustomAuth: 'custom_auth',
  OAuth2: 'oauth2',
  SecretText: 'secret_text',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Returns the index just past the string, template or comment that starts at
// `start`, or `start` when none starts there.
function skipLiteral(code, start) {
  const char = code[start];
  if (char === '/' && code[start + 1] === '/') {
    const end = code.indexOf('\n', start);
    return end === -1 ? code.length : end;
  }
  if (char === '/' && code[start + 1] === '*') {
    const end = code.indexOf('*/', start + 2);
    return end === -1 ? code.length : end + 2;
  }
  if (char !== "'" && char !== '"' && char !== '`') return start;
  for (let index = start + 1; index < code.length; index += 1) {
    if (code[index] === '\\') {
      index += 1;
    } else if (code[index] === char) {
      return index + 1;
    }
  }
  return code.length;
}

// Splits the object literal opened at `openIndex` into its top-level
// `key: value` source segments.
export function readTopLevelProperties(code, openIndex) {
  const properties = new Map();
  let depth = 0;
  let segmentStart = openIndex + 1;
  const flush = (end) => {
    const segment = code.slice(segmentStart, end).trim();
    const match = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(segment);
    if (match && !properties.has(match[1])) properties.set(match[1], match[2].trim());
  };
  for (let index = openIndex; index < code.length; index += 1) {
    const skipped = skipLiteral(code, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const char = code[index];
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      if (depth === 0) {
        flush(index);
        return properties;
      }
    } else if (char === ',' && depth === 1) {
      flush(index);
      segmentStart = index + 1;
    }
  }
  throw new Error('Unterminated createPiece object.');
}

export function readStringValue(source) {
  if (!source) return null;
  const unwrapped = /^t\(\s*([\s\S]*?)\s*\)$/.exec(source)?.[1] ?? source;
  const match = /^(['"`])([\s\S]*)\1$/.exec(unwrapped.trim());
  if (!match || (match[1] === '`' && match[2].includes('${'))) return null;
  const text = match[2].replace(/\\(['"`\\])/g, '$1').replace(/\s+/g, ' ').trim();
  return text || null;
}

function readCategories(source) {
  if (!source) return [];
  return [...new Set([...source.matchAll(/PieceCategory\.([A-Z_]+)/g)].map((match) => match[1]))].sort();
}

function listSourceFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'test' && entry.name !== '__tests__') walk(full);
      } else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(directory);
  return files.sort();
}

function readAuthKinds(sourceDirectory) {
  const kinds = new Set();
  for (const file of listSourceFiles(sourceDirectory)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(/PieceAuth\.(OAuth2|SecretText|BasicAuth|CustomAuth)\s*\(/g)) {
      kinds.add(AUTH_KIND_BY_FACTORY[match[1]]);
    }
  }
  return [...kinds].sort();
}

export function buildPieceEntry({ slug, packageJson, indexCode, authKinds }) {
  const packageName = packageJson?.name;
  if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) return null;
  const call = /createPiece\s*\(\s*\{/.exec(indexCode);
  if (!call) return null;
  const properties = readTopLevelProperties(indexCode, call.index + call[0].length - 1);
  const displayName = readStringValue(properties.get('displayName'));
  if (!displayName) return null;
  const description = readStringValue(properties.get('description'));
  const logoUrl = readStringValue(properties.get('logoUrl'));
  return {
    auth_kinds: authKinds,
    categories: readCategories(properties.get('categories')),
    description: description ? description.slice(0, DESCRIPTION_LIMIT) : null,
    display_name: displayName,
    logo_url: logoUrl?.startsWith('https://') ? logoUrl : null,
    package_name: packageName,
    slug,
  };
}

export function buildPieceDirectory(piecesRoot = PIECES_ROOT) {
  const pieces = [];
  const skipped = [];
  for (const slug of fs.readdirSync(piecesRoot).sort()) {
    const pieceRoot = path.join(piecesRoot, slug);
    const packagePath = path.join(pieceRoot, 'package.json');
    const indexPath = path.join(pieceRoot, 'src', 'index.ts');
    if (!fs.existsSync(packagePath) || !fs.existsSync(indexPath)) continue;
    const entry = buildPieceEntry({
      authKinds: readAuthKinds(path.join(pieceRoot, 'src')),
      indexCode: fs.readFileSync(indexPath, 'utf8'),
      packageJson: readJson(packagePath),
      slug,
    });
    if (entry) pieces.push(entry);
    else skipped.push(slug);
  }
  pieces.sort((left, right) =>
    left.display_name.localeCompare(right.display_name, 'en', { sensitivity: 'base' }) ||
    left.slug.localeCompare(right.slug),
  );
  return {
    directory: {
      piece_count: pieces.length,
      pieces,
      runtime_status: 'catalog_only',
      schema_version: SCHEMA_VERSION,
      source_root: 'packages/pieces/community',
    },
    skipped,
  };
}

function renderJson(directory) {
  return `${JSON.stringify(directory, null, 2)}\n`;
}

export function renderFrontendModule(directory) {
  const lines = directory.pieces.map((piece) =>
    `  ${JSON.stringify({
      authKinds: piece.auth_kinds,
      categories: piece.categories,
      description: piece.description,
      displayName: piece.display_name,
      logoUrl: piece.logo_url,
      packageName: piece.package_name,
      slug: piece.slug,
    })},`,
  );
  return [
    '// Generated by activepieces-catalog/catalog/activepieces/generate-piece-directory.mjs.',
    '// Do not edit manually. Display metadata only: a listed piece is connectable',
    '// only through the Nango provider map and runs only after RCM promotion.',
    '',
    `export const ACTIVEPIECES_PIECE_DIRECTORY_SCHEMA_VERSION = ${JSON.stringify(SCHEMA_VERSION)} as const;`,
    '',
    'export type ActivepiecesPieceDirectoryEntry = {',
    '  readonly authKinds: readonly string[];',
    '  readonly categories: readonly string[];',
    '  readonly description: string | null;',
    '  readonly displayName: string;',
    '  readonly logoUrl: string | null;',
    '  readonly packageName: string;',
    '  readonly slug: string;',
    '};',
    '',
    'export const ACTIVEPIECES_PIECE_DIRECTORY: readonly ActivepiecesPieceDirectoryEntry[] = [',
    ...lines,
    '];',
    '',
  ].join('\n');
}

function resolveFrontendRoot(argv) {
  const flag = argv.indexOf('--frontend-root');
  const root = flag >= 0 ? argv[flag + 1] : process.env.BASEKEY_FRONTEND_ROOT || path.join(REPO_ROOT, '..', 'basekey-frontend');
  const resolved = path.resolve(root);
  const packagePath = path.join(resolved, 'package.json');
  if (!fs.existsSync(packagePath) || readJson(packagePath).name !== 'basekey-frontend' || !fs.existsSync(path.join(resolved, 'src', 'routes'))) {
    throw new Error(`Frontend root is not a basekey-frontend checkout: ${resolved}`);
  }
  return resolved;
}

function main(argv) {
  const command = argv[0] ?? 'generate';
  if (!['generate', 'check', 'sync-frontend', 'frontend', 'check-frontend'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  // frontend and check-frontend (basekey-frontend's tree-landing row) render the frontend read model from the
  // committed directory and touch nothing here.
  const consumer = command === 'frontend' || command === 'check-frontend';
  const { directory, skipped } = consumer ? { directory: readJson(OUTPUT_PATH), skipped: [] } : buildPieceDirectory();
  const [target, expected] = command === 'check' || command === 'generate' ? [OUTPUT_PATH, renderJson(directory)]
    : [path.join(resolveFrontendRoot(argv), FRONTEND_MODULE_PATH), renderFrontendModule(directory)];
  if (command === 'check' || command === 'check-frontend') {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== expected) {
      throw new Error(`${target} is stale. Run ${command === 'check' ? 'generate' : 'frontend'}.`);
    }
    console.log(`Piece directory is current for ${directory.piece_count} pieces.`);
    return;
  }
  if (!consumer) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, renderJson(directory));
    console.log(`Wrote ${directory.piece_count} pieces to ${path.relative(REPO_ROOT, OUTPUT_PATH)} (skipped ${skipped.length}).`);
  }
  if (consumer || command === 'sync-frontend') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
    console.log(`Wrote ${path.join('basekey-frontend', FRONTEND_MODULE_PATH)}.`);
  }
}

// Node runs a symlinked script under its real path (a consumer's tree landing reaches this repo through a symlink).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
