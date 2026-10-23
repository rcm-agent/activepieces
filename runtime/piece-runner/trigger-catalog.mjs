import { runnerErrors } from './errors.mjs';

function load({ request, entries, loadPiece, packageRoot }) {
  const entry = entries.find((candidate) => candidate.piece === request.piece && candidate.version === request.version);
  if (!entry || typeof request.trigger !== 'string' || Object.hasOwn(request, 'action')) throw notAdmitted();
  const loaded = loadPiece({ entry, packageRoot });
  const declarations = loaded.piece.metadata().triggers;
  if (!Object.hasOwn(declarations, request.trigger) || !isPolling(declarations[request.trigger])) throw notAdmitted();
  const trigger = loaded.piece.getTrigger(request.trigger);
  if (!isPolling(trigger)) throw notAdmitted();
  return { ...loaded, trigger };
}

function exportTriggers({ entries, loadPiece, exportProps, exportAuth, verifyVersions, packageRoot, repositoryRoot }) {
  verifyVersions({ packageRoot, repositoryRoot });
  const pieces = [...new Map(entries.map((entry) => [entry.piece, entry])).values()];
  return pieces.flatMap((entry) => {
    const { piece } = loadPiece({ entry, packageRoot });
    return Object.values(piece.metadata().triggers).filter(isPolling).map((trigger) => ({
      piece: entry.piece,
      version: entry.version,
      trigger: trigger.name,
      display_name: trigger.displayName,
      description: trigger.description,
      strategy: trigger.type,
      auth_kinds: (Array.isArray(piece.auth) ? piece.auth : [piece.auth]).filter(Boolean).map((auth) => auth.type),
      auth: exportAuth({ piece, authType: entry.authType }),
      props: exportProps({ declarations: trigger.props }),
      sampleData: sampleWithoutUrlQueries(trigger.sampleData ?? null),
      outputSchema: outputSchemaWithoutUrlQueries(trigger.outputSchema),
    }));
  }).sort((left, right) => compareTriggers({ left, right }));
}

// Upstream samples include presigned links whose query strings carry access key ids; fields need only the shape.
function sampleWithoutUrlQueries(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value.split(/[?#]/, 1)[0] : value;
  if (Array.isArray(value)) return value.map(sampleWithoutUrlQueries);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sampleWithoutUrlQueries(item)]));
  return value;
}

function outputSchemaWithoutUrlQueries(schema) {
  if (schema == null) return null;
  return { ...schema, fields: schema.fields.map(outputSchemaFieldWithoutUrlQueries) };
}

function outputSchemaFieldWithoutUrlQueries(field) {
  return {
    ...field,
    ...(field.value === undefined ? {} : { value: sampleWithoutUrlQueries(field.value) }),
    ...(field.children ? { children: field.children.map(outputSchemaFieldWithoutUrlQueries) } : {}),
    ...(field.listItems ? { listItems: field.listItems.map(outputSchemaFieldWithoutUrlQueries) } : {}),
  };
}

function validateHook({ hook }) {
  if (!['enable', 'poll', 'test'].includes(hook)) {
    throw runnerErrors.refusalError({ code: 'INVALID_TRIGGER_HOOK', message: 'A trigger hook must be enable, poll or test.' });
  }
}

function isPolling(trigger) {
  return trigger?.type === 'POLLING';
}

function compareTriggers({ left, right }) {
  const leftKey = `${left.piece}\0${left.trigger}`;
  const rightKey = `${right.piece}\0${right.trigger}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function notAdmitted() {
  return runnerErrors.refusalError({ code: 'TRIGGER_NOT_ADMITTED', message: 'The piece, version and trigger must identify an admitted polling trigger.' });
}

export const runnerTriggerCatalog = { load, exportTriggers, validateHook, sampleWithoutUrlQueries, outputSchemaWithoutUrlQueries };
