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
    throw refusal({ code: 'ACTION_NOT_ALLOWLISTED', message: `The allowlisted action ${entry.piece}/${entry.action} is missing from the installed piece.` });
  }
  return { entry, piece: installedPiece, action: installedAction };
}

function prepare({ request, packageRoot = runnerRoot }) {
  const loaded = loadAction({ ...request, packageRoot });
  const auth = buildAuth({ authType: request.auth_type, auth: request.auth, piece: loaded.piece });
  const props = request.props ?? {};
  validateProps({ declarations: loaded.action.props, props });
  return { ...loaded, auth, props: withDefaults({ declarations: loaded.action.props, props }) };
}

function withDefaults({ declarations, props }) {
  const filled = { ...props };
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!Object.hasOwn(filled, name) && declaration.type !== 'FILE' && declaration.defaultValue !== undefined) filled[name] = declaration.defaultValue;
  }
  return filled;
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
  const pins = entries.map((entry) => ({ name: entry.piece, version: entry.version, source: `packages/pieces/community/${entry.forkDirectory}/package.json` }));
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

function dependencyVersion({ manifest, name }) {
  const version = manifest.dependencies?.[name];
  if (!nonemptyString(version)) throw versionMismatch();
  return version;
}

const runnerRoot = dirname(fileURLToPath(import.meta.url));
const runnerManifest = readJson({ path: join(runnerRoot, 'package.json') });
const entries = Object.freeze([
  { piece: '@activepieces/piece-slack', action: 'send_channel_message', exportName: 'slack', forkDirectory: 'slack' },
  { piece: '@activepieces/piece-discord', action: 'sendMessageWithBot', exportName: 'discord', forkDirectory: 'discord' },
  { piece: '@activepieces/piece-google-sheets', action: 'get-many-rows', exportName: 'googleSheets', forkDirectory: 'google-sheets' },
  { piece: '@activepieces/piece-google-sheets', action: 'find_rows', exportName: 'googleSheets', forkDirectory: 'google-sheets' },
  { piece: '@activepieces/piece-google-sheets', action: 'find_row_by_num', exportName: 'googleSheets', forkDirectory: 'google-sheets' },
  { piece: '@activepieces/piece-google-sheets', action: 'insert_row', exportName: 'googleSheets', forkDirectory: 'google-sheets' },
  { piece: '@activepieces/piece-google-sheets', action: 'google-sheets-insert-multiple-rows', exportName: 'googleSheets', forkDirectory: 'google-sheets' },
  { piece: '@activepieces/piece-google-sheets', action: 'update_row', exportName: 'googleSheets', forkDirectory: 'google-sheets' },
  { piece: '@activepieces/piece-google-calendar', action: 'google_calendar_find_busy_free_periods', exportName: 'googleCalendar', forkDirectory: 'google-calendar' },
  { piece: '@activepieces/piece-google-calendar', action: 'google_calendar_get_events', exportName: 'googleCalendar', forkDirectory: 'google-calendar' },
  { piece: '@activepieces/piece-google-calendar', action: 'google_calendar_get_event_by_id', exportName: 'googleCalendar', forkDirectory: 'google-calendar' },
  { piece: '@activepieces/piece-google-calendar', action: 'create_google_calendar_event', exportName: 'googleCalendar', forkDirectory: 'google-calendar' },
  { piece: '@activepieces/piece-google-calendar', action: 'update_event', exportName: 'googleCalendar', forkDirectory: 'google-calendar' },
  { piece: '@activepieces/piece-google-drive', action: 'search-folder', exportName: 'googleDrive', forkDirectory: 'google-drive' },
  { piece: '@activepieces/piece-google-drive', action: 'create_new_gdrive_folder', exportName: 'googleDrive', forkDirectory: 'google-drive' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_send_email', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_reply_to_message', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_forward_message', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_search_messages', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_list_messages', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_get_message', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook-calendar', action: 'list_events', exportName: 'microsoftOutlookCalendar', forkDirectory: 'microsoft-outlook-calendar' },
  { piece: '@activepieces/piece-microsoft-outlook-calendar', action: 'create_event', exportName: 'microsoftOutlookCalendar', forkDirectory: 'microsoft-outlook-calendar' },
  { piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_send_channel_message', exportName: 'microsoftTeams', forkDirectory: 'microsoft-teams' },
  { piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_reply_to_channel_message', exportName: 'microsoftTeams', forkDirectory: 'microsoft-teams' },
  { piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_send_chat_message', exportName: 'microsoftTeams', forkDirectory: 'microsoft-teams' },
  { piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_find_channel', exportName: 'microsoftTeams', forkDirectory: 'microsoft-teams' },
  { piece: '@activepieces/piece-microsoft-teams', action: 'microsoft_teams_get_channel_message', exportName: 'microsoftTeams', forkDirectory: 'microsoft-teams' },
  { piece: '@activepieces/piece-microsoft-excel-365', action: 'get_workbooks', exportName: 'microsoftExcel', forkDirectory: 'microsoft-excel-365' },
  { piece: '@activepieces/piece-microsoft-excel-365', action: 'get_worksheets', exportName: 'microsoftExcel', forkDirectory: 'microsoft-excel-365' },
  { piece: '@activepieces/piece-microsoft-excel-365', action: 'get_worksheet_rows', exportName: 'microsoftExcel', forkDirectory: 'microsoft-excel-365' },
  { piece: '@activepieces/piece-microsoft-excel-365', action: 'append_row', exportName: 'microsoftExcel', forkDirectory: 'microsoft-excel-365' },
  { piece: '@activepieces/piece-microsoft-excel-365', action: 'append_multiple_rows', exportName: 'microsoftExcel', forkDirectory: 'microsoft-excel-365' },
  { piece: '@activepieces/piece-microsoft-excel-365', action: 'update_row', exportName: 'microsoftExcel', forkDirectory: 'microsoft-excel-365' },
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_search_items', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_list_folder_children', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_get_item', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_create_folder', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_create_text_file', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'onedrive_move_item', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_find_site', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_get_folder_contents', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_find_file', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_search_list_item', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_create_folder', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_create_list_item', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
].map((entry) => Object.freeze({ ...entry, version: dependencyVersion({ manifest: runnerManifest, name: entry.piece }) })));

export const pieceCatalog = { entries, validateTuple, loadAction, prepare, exportActions, verifyVersions, camelToSnake };
