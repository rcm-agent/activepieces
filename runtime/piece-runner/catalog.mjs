import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runnerErrors } from './errors.mjs';
import { runnerTriggerCatalog } from './trigger-catalog.mjs';

function validateTuple({ piece, version, action }) {
  const entry = entries.find((candidate) => candidate.piece === piece
    && candidate.version === version && candidate.action === action);
  if (!entry) throw refusal({ code: 'ACTION_NOT_ALLOWLISTED', message: 'The piece, version and action must be allowlisted.' });
  return entry;
}

function loadAction({ piece, version, action, packageRoot = runnerRoot }) {
  const entry = validateTuple({ piece, version, action });
  const loaded = loadPiece({ entry, packageRoot });
  const installedAction = loaded.piece?.getAction(entry.action);
  if (!installedAction || typeof installedAction.run !== 'function') {
    throw refusal({ code: 'ACTION_NOT_ALLOWLISTED', message: `The allowlisted action ${entry.piece}/${entry.action} is missing from the installed piece.` });
  }
  authDeclarations({ piece: loaded.piece, authType: entry.authType });
  return { ...loaded, action: installedAction };
}

function loadPiece({ entry, packageRoot }) {
  const installed = readJson({ path: join(packageRoot, 'node_modules', entry.piece, 'package.json') });
  if (installed.version !== entry.version) throw versionMismatch();
  const require = createRequire(join(packageRoot, 'package.json'));
  const imported = require(entry.piece);
  const installedPiece = imported[entry.exportName];
  return { entry, piece: installedPiece };
}

function prepare({ request, packageRoot = runnerRoot }) {
  const loaded = loadAction({ ...request, packageRoot });
  return { ...loaded, ...prepareInputs({ request, loaded, declarations: loaded.action.props }) };
}

function loadTrigger({ packageRoot = runnerRoot, ...request }) {
  const loaded = runnerTriggerCatalog.load({ request, entries, loadPiece, packageRoot });
  authDeclarations({ piece: loaded.piece, authType: loaded.entry.authType });
  return loaded;
}

function validateTriggerTuple(request) {
  return loadTrigger({ ...request, packageRoot: runnerRoot }).entry;
}

function prepareTrigger({ request, packageRoot = runnerRoot }) {
  const loaded = loadTrigger({ ...request, packageRoot });
  return { ...loaded, ...prepareInputs({ request, loaded, declarations: loaded.trigger.props }) };
}

function prepareInputs({ request, loaded, declarations, requireRequired = true }) {
  const auth = buildAuth({ authType: request.auth_type, auth: request.auth, piece: loaded.piece, admittedAuthType: loaded.entry.authType });
  const props = request.props ?? {};
  validateProps({ declarations, props, requireRequired });
  return { auth, props: withDefaults({ declarations, props }) };
}

function validateLoader({ request, packageRoot = runnerRoot }) {
  const loaded = Object.hasOwn(request, 'trigger') ? loadTrigger({ ...request, packageRoot }) : loadAction({ ...request, packageRoot });
  const operation = loaded.trigger ?? loaded.action;
  const name = request.property;
  const declaration = typeof name === 'string' && Object.hasOwn(operation.props, name) ? operation.props[name] : undefined;
  const callback = request.mode === 'options' ? 'options' : 'props';
  const types = request.mode === 'options' ? ['DROPDOWN', 'MULTI_SELECT_DROPDOWN'] : request.mode === 'props' ? ['DYNAMIC'] : [];
  const excluded = loaded.entry.loaderRefused?.some((item) => item.piece === request.piece && item.action === request.action && item.property === name);
  if (!declaration || !types.includes(declaration.type) || typeof declaration[callback] !== 'function' || excluded) {
    throw runnerErrors.refusalError({ code: runnerErrors.codes.propertyNotLoadable, message: 'The property must have an admitted loader for the requested mode.' });
  }
  return { ...loaded, declaration };
}

function prepareLoader({ request, packageRoot = runnerRoot }) {
  const loaded = validateLoader({ request, packageRoot });
  return { ...loaded, ...prepareInputs({ request, loaded, declarations: (loaded.trigger ?? loaded.action).props, requireRequired: false }) };
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
      auth: exportAuth({ piece: loaded.piece, authType: entry.authType }),
      props: exportProps({ declarations: loaded.action.props }),
    };
  });
}

function exportTriggers({ packageRoot = runnerRoot, repositoryRoot = resolve(runnerRoot, '../..') } = {}) {
  return runnerTriggerCatalog.exportTriggers({ entries, loadPiece, exportProps, exportAuth, verifyVersions, packageRoot, repositoryRoot });
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

function buildAuth({ authType, auth, piece, admittedAuthType }) {
  const type = { API_KEY: 'SECRET_TEXT', SECRET_TEXT: 'SECRET_TEXT', BASIC: 'BASIC_AUTH', OAUTH2: 'OAUTH2', CUSTOM_AUTH: 'CUSTOM_AUTH' }[authType];
  const declaration = authDeclarations({ piece, authType: admittedAuthType }).find((candidate) => candidate.type === type);
  if (!type || !declaration) {
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
  if (type === 'CUSTOM_AUTH') {
    validateAuthProps({ declarations: declaration.props, props: auth.props });
    return { type, props: { ...auth.props } };
  }
  const data = auth.raw ?? auth.data ?? {};
  if (!nonemptyString(auth.access_token) || !isRecord(data)) throw invalidAuth();
  if (declaration.props !== undefined) {
    if (auth.props !== undefined && !isRecord(auth.props)) throw invalidAuth();
    const props = withDefaults({ declarations: declaration.props, props: auth.props ?? {} });
    validateAuthProps({ declarations: declaration.props, props });
    return { type, access_token: auth.access_token, data, props };
  }
  if (auth.props !== undefined) validateAuthProps({ declarations: {}, props: auth.props });
  return { type, access_token: auth.access_token, data };
}

function authKinds({ piece }) {
  return (Array.isArray(piece.auth) ? piece.auth : [piece.auth]).filter(Boolean).map((declaration) => declaration.type);
}

function authDeclarations({ piece, authType }) {
  const declarations = (Array.isArray(piece.auth) ? piece.auth : [piece.auth]).filter(Boolean);
  const admitted = authType === undefined ? declarations : declarations.filter((declaration) => declaration.type === authType);
  if (admitted.length !== 1) {
    throw refusal({ code: 'AUTH_TYPE_MISMATCH', message: 'The allowlist must admit exactly one declared auth type.' });
  }
  return admitted;
}

function exportAuth({ piece, authType }) {
  const [declaration] = authDeclarations({ piece, authType });
  return { kind: declaration.type, props: declaration.type === 'CUSTOM_AUTH' || (declaration.type === 'OAUTH2' && declaration.props !== undefined) ? exportProps({ declarations: declaration.props }) : {} };
}

function validateAuthProps({ declarations, props }) {
  if (!isRecord(declarations) || !isRecord(props)) throw invalidAuth();
  if (Object.keys(props).some((name) => !Object.hasOwn(declarations, name))) throw invalidAuth();
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!Object.hasOwn(props, name)) {
      if (declaration.required) throw invalidAuth();
      continue;
    }
    const value = props[name];
    if (['SHORT_TEXT', 'SECRET_TEXT'].includes(declaration.type)) {
      if (!nonemptyString(value) || value.length > 4096) throw invalidAuth();
    } else if (declaration.type === 'LONG_TEXT') {
      if (!nonemptyString(value)) throw invalidAuth();
    } else if (declaration.type === 'NUMBER') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidAuth();
    } else if (declaration.type === 'CHECKBOX') {
      if (typeof value !== 'boolean') throw invalidAuth();
    } else if (declaration.type === 'STATIC_DROPDOWN') {
      if (!declaration.options?.options?.some((option) => isDeepStrictEqual(option.value, value))) throw invalidAuth();
    } else if (declaration.type === 'STATIC_MULTI_SELECT_DROPDOWN') {
      if (!Array.isArray(value) || ![...value].every((selected) => declaration.options?.options?.some((option) => isDeepStrictEqual(option.value, selected)))) throw invalidAuth();
    } else {
      throw invalidAuth();
    }
  }
}

function validateProps({ declarations, props, requireRequired = true }) {
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
    if (requireRequired && declaration.required && (!supplied || value === null || value === undefined || value === '')) {
      throw refusal({ code: 'MISSING_REQUIRED_PROP', message: 'A required action prop is missing.' });
    }
    if (supplied && declaration.type === 'ARRAY' && value !== null && value !== undefined) {
      if (!Array.isArray(value)) throw refusal({ code: 'INVALID_PROPS', message: 'Array props must be arrays.' });
      if (declaration.properties) {
        for (const item of value) validateProps({ declarations: declaration.properties, props: item, requireRequired });
      }
    }
  }
}

function exportProps({ declarations }) {
  return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => [name, {
    type: declaration.type,
    required: declaration.required,
    description: declaration.description ?? '',
    display_name: declaration.displayName,
    ...exportDefault({ value: declaration.defaultValue }),
    ...(['STATIC_DROPDOWN', 'STATIC_MULTI_SELECT_DROPDOWN'].includes(declaration.type)
      ? { options: declaration.options.options.map(({ label, value }) => ({ label, value })) } : {}),
    ...(['DROPDOWN', 'MULTI_SELECT_DROPDOWN', 'DYNAMIC'].includes(declaration.type)
      ? { refreshers: [...(declaration.refreshers ?? [])] } : {}),
    ...(['DROPDOWN', 'MULTI_SELECT_DROPDOWN'].includes(declaration.type)
      ? { refresh_on_search: declaration.refreshOnSearch ?? false } : {}),
    ...(declaration.properties ? { properties: exportProps({ declarations: declaration.properties }) } : {}),
  }]));
}

function exportDefault({ value }) {
  if (value === undefined) return {};
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return {};
    const decoded = JSON.parse(encoded);
    return isDeepStrictEqual(value, decoded) ? { default: decoded } : {};
  } catch {
    return {};
  }
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
  { piece: '@activepieces/piece-slack', action: 'send_channel_message', exportName: 'slack', forkDirectory: 'slack', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-slack', action: 'getChannelHistory', exportName: 'slack', forkDirectory: 'slack', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-slack', action: 'slack_list_channels', exportName: 'slack', forkDirectory: 'slack', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-slack', action: 'searchMessages', exportName: 'slack', forkDirectory: 'slack', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-discord', action: 'sendMessageWithBot', exportName: 'discord', forkDirectory: 'discord' },
  { piece: '@activepieces/piece-discord', action: 'discord_list_messages', exportName: 'discord', forkDirectory: 'discord' },
  { piece: '@activepieces/piece-discord', action: 'discord_find_member', exportName: 'discord', forkDirectory: 'discord' },
  { piece: '@activepieces/piece-discord', action: 'list_guild_members', exportName: 'discord', forkDirectory: 'discord' },
  { piece: '@activepieces/piece-google-sheets', action: 'get-many-rows', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-sheets', action: 'find_rows', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-sheets', action: 'find_row_by_num', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-sheets', action: 'insert_row', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-sheets', action: 'google-sheets-insert-multiple-rows', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-sheets', action: 'update_row', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-sheets', action: 'find_spreadsheets', exportName: 'googleSheets', forkDirectory: 'google-sheets', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-calendar', action: 'google_calendar_find_busy_free_periods', exportName: 'googleCalendar', forkDirectory: 'google-calendar', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-calendar', action: 'google_calendar_get_events', exportName: 'googleCalendar', forkDirectory: 'google-calendar', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-calendar', action: 'google_calendar_get_event_by_id', exportName: 'googleCalendar', forkDirectory: 'google-calendar', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-calendar', action: 'create_google_calendar_event', exportName: 'googleCalendar', forkDirectory: 'google-calendar', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-calendar', action: 'update_event', exportName: 'googleCalendar', forkDirectory: 'google-calendar', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-drive', action: 'search-folder', exportName: 'googleDrive', forkDirectory: 'google-drive', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-google-drive', action: 'create_new_gdrive_folder', exportName: 'googleDrive', forkDirectory: 'google-drive', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_send_email', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_reply_to_message', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_forward_message', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_search_messages', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_list_messages', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'outlook_get_message', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
  { piece: '@activepieces/piece-microsoft-outlook', action: 'findEmail', exportName: 'microsoftOutlook', forkDirectory: 'microsoft-outlook' },
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
  { piece: '@activepieces/piece-microsoft-onedrive', action: 'list_folders', exportName: 'microsoftOneDrive', forkDirectory: 'microsoft-onedrive' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_find_site', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_get_folder_contents', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_find_file', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_search_list_item', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_create_folder', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-microsoft-sharepoint', action: 'microsoft_sharepoint_create_list_item', exportName: 'microsoftSharePoint', forkDirectory: 'microsoft-sharepoint' },
  { piece: '@activepieces/piece-service-now', action: 'create_record', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'get_record', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'find_record', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'update_record', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'add_comment', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'resolve_incident', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'count_records', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-service-now', action: 'search_knowledge_articles', exportName: 'serviceNow', forkDirectory: 'service-now' },
  { piece: '@activepieces/piece-docusign', action: 'getEnvelope', exportName: 'docusign', forkDirectory: 'docusign' },
  { piece: '@activepieces/piece-docusign', action: 'listEnvelopes', exportName: 'docusign', forkDirectory: 'docusign' },
  { piece: '@activepieces/piece-docusign', action: 'listTemplates', exportName: 'docusign', forkDirectory: 'docusign' },
  { piece: '@activepieces/piece-docusign', action: 'findEnvelopeRecipients', exportName: 'docusign', forkDirectory: 'docusign' },
  { piece: '@activepieces/piece-shippo', action: 'create_order', exportName: 'shippo', forkDirectory: 'shippo' },
  { piece: '@activepieces/piece-shippo', action: 'find_order', exportName: 'shippo', forkDirectory: 'shippo' },
  { piece: '@activepieces/piece-shippo', action: 'find_shipping_label', exportName: 'shippo', forkDirectory: 'shippo' },
  { piece: '@activepieces/piece-quickbooks', action: 'find_invoice', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'find_customer', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'find_payment', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'find_vendor', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'find_account', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'read_aging_report', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'create_invoice', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'create_bill', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'create_vendor', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'record_payment', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks', action: 'record_bill_payment', exportName: 'quickbooks', forkDirectory: 'quickbooks' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'find_invoice', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'find_customer', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'find_payment', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'find_vendor', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'find_account', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'read_aging_report', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'create_invoice', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'create_bill', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'create_vendor', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'record_payment', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-quickbooks-sandbox', action: 'record_bill_payment', exportName: 'quickbooksSandbox', forkDirectory: 'quickbooks-sandbox' },
  { piece: '@activepieces/piece-xero', action: 'xero_find_contact', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_find_invoice', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_get_invoice', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_search_invoices', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_search_payments', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_get_aged_receivables', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_get_aged_payables', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_list_accounts', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_list_organisations', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_create_contact', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_create_invoice', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_create_bill', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-xero', action: 'xero_create_payment', exportName: 'xero', forkDirectory: 'xero' },
  { piece: '@activepieces/piece-microsoft-dynamics-365-business-central', action: 'get-record', exportName: 'microsoftDynamics365BusinessCentral', forkDirectory: 'microsoft-dynamics-365-business-central' },
  { piece: '@activepieces/piece-microsoft-dynamics-365-business-central', action: 'search-records', exportName: 'microsoftDynamics365BusinessCentral', forkDirectory: 'microsoft-dynamics-365-business-central' },
  { piece: '@activepieces/piece-microsoft-dynamics-365-business-central', action: 'create-record', exportName: 'microsoftDynamics365BusinessCentral', forkDirectory: 'microsoft-dynamics-365-business-central' },
  { piece: '@activepieces/piece-microsoft-dynamics-365-business-central', action: 'update-record', exportName: 'microsoftDynamics365BusinessCentral', forkDirectory: 'microsoft-dynamics-365-business-central' },
  { piece: '@activepieces/piece-shopify', action: 'get_order', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'search_orders', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'list_order_fulfillment_orders', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'get_fulfillment_order', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'create_fulfillment', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'update_fulfillment_tracking', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'list_locations', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'list_inventory_levels', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'get_inventory_item', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'adjust_inventory_quantities', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'get_product', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-shopify', action: 'search_products', exportName: 'shopify', forkDirectory: 'shopify', authType: 'OAUTH2' },
  { piece: '@activepieces/piece-onfleet', action: 'create_task', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'get_task', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'get_tasks', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'update_task', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'complete_task', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'get_worker', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'get_teams', exportName: 'onfleet', forkDirectory: 'onfleet' },
  { piece: '@activepieces/piece-onfleet', action: 'get_hubs', exportName: 'onfleet', forkDirectory: 'onfleet' },
].map((entry) => Object.freeze({ ...entry, version: dependencyVersion({ manifest: runnerManifest, name: entry.piece }) })));

export const pieceCatalog = { entries, validateTuple, loadAction, prepare, validateTriggerTuple, loadTrigger, prepareTrigger, validateLoader, prepareLoader, exportProps, exportAuth, exportActions, exportTriggers, verifyVersions, camelToSnake };
