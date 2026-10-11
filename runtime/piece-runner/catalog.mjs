import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function validateTuple({ piece, version, action }) {
  const entry = entries.find((candidate) => candidate.piece === piece
    && candidate.version === version && candidate.action === action);
  if (!entry) throw refusal({ code: 'ACTION_NOT_ALLOWLISTED', message: 'The piece, version and action must be allowlisted.' });
  return entry;
}

function loadAction({ piece, version, action, packageRoot = runnerRoot }) {
  const entry = validateTuple({ piece, version, action });
  const installed = readJson({ path: join(packageRoot, 'node_modules', entry.piece, 'package.json') });
  if (installed.version !== entry.version) throw versionMismatch();
  const require = createRequire(join(packageRoot, 'package.json'));
  const imported = require(entry.piece);
  const installedPiece = imported[entry.exportName];
  const installedAction = installedPiece?.getAction(entry.action);
  if (!installedAction || typeof installedAction.run !== 'function') {
    throw refusal({ code: 'ACTION_NOT_ALLOWLISTED', message: 'The allowlisted action is missing from the installed piece.' });
  }
  return { entry, piece: installedPiece, action: installedAction };
}

function prepare({ request, packageRoot = runnerRoot }) {
  const loaded = loadAction({ ...request, packageRoot });
  const auth = buildAuth({ authType: request.auth_type, auth: request.auth, piece: loaded.piece });
  const props = request.props ?? {};
  validateProps({ declarations: loaded.action.props, props });
  return { ...loaded, auth, props };
}

function exportActions({ packageRoot = runnerRoot, repositoryRoot = resolve(runnerRoot, '../..') } = {}) {
  verifyVersions({ packageRoot, repositoryRoot });
  return entries.map((entry) => {
    const loaded = loadAction({ ...entry, packageRoot });
    return {
      piece: entry.piece,
      version: entry.version,
      action: entry.action,
      id: camelToSnake({ name: entry.action }),
      display_name: loaded.action.displayName,
      description: loaded.action.description,
      auth_kinds: authKinds({ piece: loaded.piece }),
      props: exportProps({ declarations: loaded.action.props }),
    };
  });
}

function verifyVersions({ packageRoot = runnerRoot, repositoryRoot = resolve(runnerRoot, '../..') } = {}) {
  const manifest = readJson({ path: join(packageRoot, 'package.json') });
  const lock = readJson({ path: join(packageRoot, 'package-lock.json') });
  const pins = [
    ...entries.map((entry) => ({ name: entry.piece, version: entry.version, source: `packages/pieces/community/${entry.forkDirectory}/package.json` })),
    { name: '@activepieces/pieces-framework', version: '0.28.1', source: 'packages/pieces/framework/package.json' },
  ];
  for (const pin of pins) {
    const fork = readJson({ path: join(repositoryRoot, pin.source) });
    if (fork.version !== pin.version || manifest.dependencies?.[pin.name] !== pin.version
      || lock.packages?.[`node_modules/${pin.name}`]?.version !== pin.version
      || lock.packages?.['']?.dependencies?.[pin.name] !== pin.version) {
      throw versionMismatch();
    }
  }
  for (const pin of pins) {
    const installed = readJson({ path: join(packageRoot, 'node_modules', pin.name, 'package.json') });
    if (installed.version !== pin.version) throw versionMismatch();
  }
}

function camelToSnake({ name }) {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function buildAuth({ authType, auth, piece }) {
  const type = { API_KEY: 'SECRET_TEXT', BASIC: 'BASIC_AUTH', OAUTH2: 'OAUTH2' }[authType];
  if (!type || !authKinds({ piece }).includes(type)) {
    throw refusal({ code: 'AUTH_TYPE_MISMATCH', message: 'The auth type does not match a kind declared by the piece.' });
  }
  if (!isRecord(auth)) throw invalidAuth();
  if (type === 'SECRET_TEXT') {
    const secretText = auth.apiKey ?? auth.secret_text;
    if (!nonemptyString(secretText)) throw invalidAuth();
    return { type, secret_text: secretText };
  }
  if (type === 'BASIC_AUTH') {
    if (typeof auth.username !== 'string' || typeof auth.password !== 'string') throw invalidAuth();
    return { type, username: auth.username, password: auth.password };
  }
  const data = auth.raw ?? auth.data ?? {};
  if (!nonemptyString(auth.access_token) || !isRecord(data)) throw invalidAuth();
  return { type, access_token: auth.access_token, data };
}

function authKinds({ piece }) {
  const declarations = Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  return declarations.filter(Boolean).map((declaration) => declaration.type);
}

function validateProps({ declarations, props }) {
  if (!isRecord(props)) throw refusal({ code: 'INVALID_PROPS', message: 'Props must be an object.' });
  for (const name of Object.keys(props)) {
    if (!Object.hasOwn(declarations, name)) {
      throw refusal({ code: 'UNDECLARED_PROP', message: 'The action received an undeclared prop.' });
    }
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    const supplied = Object.hasOwn(props, name);
    if (supplied && declaration.type === 'FILE') {
      throw refusal({ code: 'FILE_PROP_REFUSED', message: 'File props are unavailable in this runner.' });
    }
    const value = props[name];
    if (declaration.required && (!supplied || value === null || value === undefined || value === '')) {
      throw refusal({ code: 'MISSING_REQUIRED_PROP', message: 'A required action prop is missing.' });
    }
    if (supplied && declaration.type === 'ARRAY' && value !== null && value !== undefined) {
      if (!Array.isArray(value)) throw refusal({ code: 'INVALID_PROPS', message: 'Array props must be arrays.' });
      if (declaration.properties) {
        for (const item of value) validateProps({ declarations: declaration.properties, props: item });
      }
    }
  }
}

function exportProps({ declarations }) {
  return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => [name, {
    type: declaration.type,
    required: declaration.required,
    description: declaration.description ?? '',
    ...(declaration.properties ? { properties: exportProps({ declarations: declaration.properties }) } : {}),
  }]));
}

function refusal({ code, message }) {
  const error = new Error(message);
  error.name = 'RunnerRefusal';
  error.code = code;
  return error;
}

function invalidAuth() {
  return refusal({ code: 'INVALID_AUTH', message: 'The auth value does not have the required credential fields.' });
}

function versionMismatch() {
  return refusal({ code: 'VERSION_MISMATCH', message: 'Runner, lockfile, installed package and fork versions must match.' });
}

function readJson({ path }) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

const runnerRoot = dirname(fileURLToPath(import.meta.url));
const entries = Object.freeze([
  Object.freeze({ piece: '@activepieces/piece-slack', version: '0.17.0', action: 'send_channel_message', exportName: 'slack', forkDirectory: 'slack', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-discord', version: '0.5.0', action: 'sendMessageWithBot', exportName: 'discord', forkDirectory: 'discord' }),
  Object.freeze({ piece: '@activepieces/piece-google-sheets', version: '0.14.6', action: 'get-many-rows', exportName: 'googleSheets', forkDirectory: 'google-sheets' }),
  Object.freeze({ piece: '@activepieces/piece-google-sheets', version: '0.14.6', action: 'find_rows', exportName: 'googleSheets', forkDirectory: 'google-sheets' }),
  Object.freeze({ piece: '@activepieces/piece-google-sheets', version: '0.14.6', action: 'find_row_by_num', exportName: 'googleSheets', forkDirectory: 'google-sheets' }),
  Object.freeze({ piece: '@activepieces/piece-google-sheets', version: '0.14.6', action: 'insert_row', exportName: 'googleSheets', forkDirectory: 'google-sheets' }),
  Object.freeze({ piece: '@activepieces/piece-google-sheets', version: '0.14.6', action: 'google-sheets-insert-multiple-rows', exportName: 'googleSheets', forkDirectory: 'google-sheets' }),
  Object.freeze({ piece: '@activepieces/piece-google-sheets', version: '0.14.6', action: 'update_row', exportName: 'googleSheets', forkDirectory: 'google-sheets' }),
  Object.freeze({ piece: '@activepieces/piece-google-calendar', version: '0.9.1', action: 'google_calendar_find_busy_free_periods', exportName: 'googleCalendar', forkDirectory: 'google-calendar', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-google-calendar', version: '0.9.1', action: 'google_calendar_get_events', exportName: 'googleCalendar', forkDirectory: 'google-calendar', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-google-calendar', version: '0.9.1', action: 'google_calendar_get_event_by_id', exportName: 'googleCalendar', forkDirectory: 'google-calendar', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-google-calendar', version: '0.9.1', action: 'create_google_calendar_event', exportName: 'googleCalendar', forkDirectory: 'google-calendar', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-google-calendar', version: '0.9.1', action: 'update_event', exportName: 'googleCalendar', forkDirectory: 'google-calendar', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-google-drive', version: '0.7.5', action: 'search-folder', exportName: 'googleDrive', forkDirectory: 'google-drive', memoryMb: 512 }),
  Object.freeze({ piece: '@activepieces/piece-google-drive', version: '0.7.5', action: 'create_new_gdrive_folder', exportName: 'googleDrive', forkDirectory: 'google-drive', memoryMb: 512 }),
]);

export const pieceCatalog = { entries, validateTuple, loadAction, prepare, exportActions, verifyVersions, camelToSnake };
