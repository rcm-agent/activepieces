#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const PIECES_ROOT = path.join(REPO_ROOT, 'packages', 'pieces', 'community');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'generated', 'pilot');
const PIECE_OUTPUT_DIR = path.join(OUTPUT_DIR, 'pieces');
const TRIGGER_CANDIDATES_OUTPUT_PATH = path.join(OUTPUT_DIR, 'trigger_candidates.json');
const SCHEMA_VERSION = 'activepieces-catalog-candidate.v1';
const RUNTIME_STATUS = 'candidate_only';
const UPSTREAM_REPO = 'activepieces/activepieces';
const UPSTREAM_COMMIT = '59c94f454ef3afed9974b41650e3d78067918328';
const PILOT_PIECES = ['slack', 'discord', 'gmail', 'google-sheets', 'google-calendar', 'google-drive', 'hubspot', 'github', 'notion'];
const WEBHOOK_TRIGGER_STRATEGIES = new Set(['WEBHOOK', 'APP_WEBHOOK']);
const POLLING_TRIGGER_STRATEGIES = new Set(['POLLING']);

const DEFAULT_CUSTOM_API_ACTION = {
  name: 'custom_api_call',
  display_name: 'Custom API Call',
  description: 'Make a custom API call to a specific endpoint',
};

const NANGO_PROVIDER_HINTS = {
  slack: ['slack', 'slack-dev'],
  discord: ['discord-dev', 'discord'],
  gmail: ['google', 'gmail', 'google-mail', 'google-mail-dev'],
  'google-sheets': ['google', 'google-sheets', 'google-sheet', 'google-sheet-dev'],
  'google-calendar': ['google-calendar', 'google-calendar-dev'],
  'google-drive': ['google-drive', 'google-drive-dev'],
  hubspot: ['hubspot'],
  github: ['github'],
  notion: ['notion-dev', 'notion'],
};

function main() {
  const command = process.argv[2] ?? 'generate';
  if (!['generate', 'check', 'validate'].includes(command)) {
    throw new Error(`Unknown command "${command}". Use generate, check, or validate.`);
  }

  if (command === 'validate') {
    validateExistingArtifacts();
    console.log(`Validated ${PILOT_PIECES.length} pilot artifacts in ${toRepoPath(OUTPUT_DIR)}.`);
    return;
  }

  const catalog = buildCatalog();
  if (command === 'check') {
    checkGeneratedArtifacts(catalog);
    console.log(`Generated artifacts are current for ${PILOT_PIECES.length} pilot pieces.`);
    return;
  }

  writeCatalog(catalog);
  console.log(`Wrote ${PILOT_PIECES.length} pilot artifacts to ${toRepoPath(OUTPUT_DIR)}.`);
}

function buildCatalog() {
  const upstreamCommit = UPSTREAM_COMMIT;
  const artifacts = PILOT_PIECES.map((slug) => buildPieceArtifact({ slug, upstreamCommit }));
  const triggerCandidates = buildTriggerCandidates({ artifacts, upstreamCommit });
  const index = buildIndex({ artifacts, triggerCandidates, upstreamCommit });
  validateCatalog({ artifacts, index, triggerCandidates });
  return { artifacts, index, triggerCandidates };
}

function buildPieceArtifact({ slug, upstreamCommit }) {
  const pieceDir = path.join(PIECES_ROOT, slug);
  assertDirectory(pieceDir, `pilot piece directory for ${slug}`);

  const packagePath = path.join(pieceDir, 'package.json');
  const indexPath = path.join(pieceDir, 'src', 'index.ts');
  const packageJson = readJson(packagePath);
  const indexCode = readText(indexPath);
  const indexImports = parseImports({ code: indexCode, fromFile: indexPath });
  const pieceObject = extractSingleCallObject({
    code: indexCode,
    callName: 'createPiece',
    sourceFile: indexPath,
  });
  const pieceMetadata = parsePieceMetadata({ slug, object: pieceObject.objectCode });
  const auth = extractAuth({
    authSymbol: pieceMetadata.auth_symbol,
    indexImports,
    indexPath,
  });
  const actions = extractOperations({
    kind: 'action',
    pieceSlug: slug,
    pieceObjectCode: pieceObject.objectCode,
    indexCode,
    indexPath,
    indexImports,
  });
  const triggers = extractOperations({
    kind: 'trigger',
    pieceSlug: slug,
    pieceObjectCode: pieceObject.objectCode,
    indexCode,
    indexPath,
    indexImports,
  });

  return sortObjectKeys({
    schema_version: SCHEMA_VERSION,
    runtime_status: RUNTIME_STATUS,
    runtime_execution: {
      supported: false,
      status: RUNTIME_STATUS,
      note: 'Generated catalog candidate only; Activepieces runtime execution is out of scope.',
    },
    provenance: {
      upstream_repo: UPSTREAM_REPO,
      upstream_commit: upstreamCommit,
      piece_path: toRepoPath(pieceDir),
      index_path: toRepoPath(indexPath),
      extractor_path: toRepoPath(SCRIPT_PATH),
    },
    package: {
      name: requiredString(packageJson.name, `${slug} package name`),
      version: requiredString(packageJson.version, `${slug} package version`),
    },
    piece: pieceMetadata,
    auth,
    nango_provider_key_candidates: inferNangoCandidates({ slug, packageName: packageJson.name, auth }),
    actions,
    triggers,
  });
}

function buildIndex({ artifacts, triggerCandidates, upstreamCommit }) {
  return sortObjectKeys({
    schema_version: SCHEMA_VERSION,
    runtime_status: RUNTIME_STATUS,
    upstream_commit: upstreamCommit,
    extractor_path: toRepoPath(SCRIPT_PATH),
    artifact_root: toRepoPath(OUTPUT_DIR),
    trigger_candidates_artifact_path: toRepoPath(triggerCandidatesArtifactPath()),
    trigger_candidate_count: triggerCandidates.triggers.length,
    pieces: artifacts.map((artifact) => ({
      slug: artifact.piece.slug,
      artifact_path: toRepoPath(pieceArtifactPath(artifact.piece.slug)),
      package_name: artifact.package.name,
      package_version: artifact.package.version,
      display_name: artifact.piece.display_name,
      auth_types: artifact.auth.types,
      nango_provider_key_candidates: artifact.nango_provider_key_candidates.map(
        (candidate) => candidate.provider_key,
      ),
      action_count: artifact.actions.length,
      trigger_count: artifact.triggers.length,
      runtime_status: artifact.runtime_status,
    })),
  });
}

function buildTriggerCandidates({ artifacts, upstreamCommit }) {
  const triggers = sortTriggerCandidates(artifacts.flatMap((artifact) => (
    artifact.triggers.map((trigger) => buildTriggerCandidateRecord({ artifact, trigger }))
  )));

  return sortObjectKeys({
    schema_version: SCHEMA_VERSION,
    runtime_status: RUNTIME_STATUS,
    upstream_commit: upstreamCommit,
    extractor_path: toRepoPath(SCRIPT_PATH),
    artifact_root: toRepoPath(OUTPUT_DIR),
    trigger_count: triggers.length,
    triggers,
  });
}

function buildTriggerCandidateRecord({ artifact, trigger }) {
  const pieceSlug = artifact.piece.slug;
  const triggerName = trigger.name;
  const triggerStrategy = requiredString(
    trigger.trigger_strategy,
    `${pieceSlug} trigger ${triggerName} trigger_strategy`,
  );
  return sortObjectKeys({
    candidate_id: triggerCandidateId({ pieceSlug, triggerName }),
    runtime_status: RUNTIME_STATUS,
    runtime_execution: {
      supported: false,
      status: RUNTIME_STATUS,
      note: 'Generated trigger candidate only; RCM-owned trigger catalog promotion is required before execution.',
    },
    piece_slug: pieceSlug,
    piece_display_name: artifact.piece.display_name,
    package_name: artifact.package.name,
    package_version: artifact.package.version,
    auth_types: artifact.auth.types,
    nango_provider_key_candidates: artifact.nango_provider_key_candidates,
    trigger_name: triggerName,
    display_name: trigger.display_name,
    description: trigger.description,
    trigger_strategy: triggerStrategy,
    trigger_strategy_family: triggerStrategyFamily(triggerStrategy),
    source_path: trigger.source_path,
    source_line: trigger.source_line,
  });
}

function parsePieceMetadata({ slug, object }) {
  const displayName = readStringField({ object, fieldName: 'displayName' });
  const description = readStringField({ object, fieldName: 'description' });
  const logoUrl = readStringField({ object, fieldName: 'logoUrl' });
  const minimumSupportedRelease = readStringField({
    object,
    fieldName: 'minimumSupportedRelease',
    required: false,
  });
  const authSymbol = readIdentifierField({ object, fieldName: 'auth' });
  return sortObjectKeys({
    slug,
    export_name: readPieceExportName({ slug }),
    display_name: displayName,
    description,
    minimum_supported_release: minimumSupportedRelease,
    logo_url: logoUrl,
    categories: readEnumArrayField({ object, fieldName: 'categories', enumPrefix: 'PieceCategory' }),
    authors: readStringArrayField({ object, fieldName: 'authors' }),
    auth_symbol: authSymbol,
  });
}

function readPieceExportName({ slug }) {
  const indexPath = path.join(PIECES_ROOT, slug, 'src', 'index.ts');
  const code = readText(indexPath);
  const match = code.match(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*createPiece\s*\(/);
  if (!match) {
    throw new Error(`Unable to find exported createPiece symbol for ${slug}.`);
  }
  return match[1];
}

function extractAuth({ authSymbol, indexImports, indexPath }) {
  const importedFile = indexImports.get(authSymbol);
  if (!importedFile) {
    throw new Error(`Unable to resolve auth symbol "${authSymbol}" from ${toRepoPath(indexPath)}.`);
  }
  const sourceFile = followReExport({ symbol: authSymbol, sourceFile: importedFile });
  const code = readText(sourceFile);
  const types = [];
  if (code.includes('PieceAuth.OAuth2(')) {
    types.push('oauth2');
  }
  if (code.includes('PieceAuth.CustomAuth(')) {
    types.push('custom_auth');
  }
  if (code.includes('PieceAuth.SecretText(') && types.length === 0) {
    types.push('secret_text');
  }
  if (types.length === 0) {
    throw new Error(`Unable to infer auth type for ${authSymbol} in ${toRepoPath(sourceFile)}.`);
  }
  return sortObjectKeys({
    declared_symbol: authSymbol,
    source_path: toRepoPath(sourceFile),
    types: unique(types),
    auth_url_candidates: unique(readStringFieldValues({ code, fieldName: 'authUrl' })),
    token_url_candidates: unique(readStringFieldValues({ code, fieldName: 'tokenUrl' })),
  });
}

function extractOperations({ kind, pieceSlug, pieceObjectCode, indexCode, indexPath, indexImports }) {
  const fieldName = kind === 'action' ? 'actions' : 'triggers';
  const callName = kind === 'action' ? 'createAction' : 'createTrigger';
  const elements = readOperationFieldElements({
    object: pieceObjectCode,
    fieldName,
    contextLabel: `${pieceSlug} createPiece`,
  });
  const operations = [];

  for (const element of elements) {
    // Upstream groups array entries under whole-line and block comments (e.g. `// audience:'ai' agent atomics`).
    const trimmed = element.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim();
    if (!trimmed) {
      continue;
    }
    if (kind === 'action' && trimmed.startsWith('createCustomApiCallAction(')) {
      const customApiCallIndex = indexCode.indexOf(
        'createCustomApiCallAction(',
        indexCode.indexOf('actions:'),
      );
      if (customApiCallIndex === -1) {
        throw new Error(`Unable to locate custom API call action in ${toRepoPath(indexPath)}.`);
      }
      operations.push({
        ...DEFAULT_CUSTOM_API_ACTION,
        source_path: toRepoPath(indexPath),
        source_line: lineNumberAt(indexCode, customApiCallIndex),
      });
      continue;
    }
    const identifier = readLeadingIdentifier(trimmed);
    if (!identifier) {
      throw new Error(`Unsupported ${kind} array element in ${pieceSlug}: ${trimmed.slice(0, 80)}`);
    }
    const sourceFile = indexImports.get(identifier);
    if (!sourceFile) {
      throw new Error(`Unable to resolve ${kind} symbol "${identifier}" in ${toRepoPath(indexPath)}.`);
    }
    if (kind === 'trigger' && identifier === 'githubTriggers') {
      operations.push(...extractGithubTriggers(sourceFile));
      continue;
    }
    const parsed = extractOperationsFromSource({ sourceFile, callName, symbol: identifier, kind });
    operations.push(...parsed);
  }

  return sortOperations(dedupeOperations({ operations, kind, pieceSlug }));
}

function extractGithubTriggers(sourceFile) {
  const code = readText(sourceFile);
  const imports = parseImports({ code, fromFile: sourceFile });
  const triggers = [];
  const githubEventTypes = readEnumStringValues({ code, enumName: 'GithubEventType' });
  const registeredArray = readTopLevelArrayLiteral({
    code,
    fieldPattern: /export\s+const\s+registered\s*=/,
    sourceFile,
  });
  for (const objectInfo of splitTopLevelObjectLiterals(registeredArray.code)) {
    const eventName = readStringOrEnumField({
      object: objectInfo.objectCode,
      fieldName: 'name',
      enumValues: githubEventTypes,
      contextLabel: `registered GitHub trigger in ${toRepoPath(sourceFile)}`,
    });
    triggers.push({
      name: `trigger_${eventName}`,
      display_name: readStringField({
        object: objectInfo.objectCode,
        fieldName: 'displayName',
        contextLabel: `registered GitHub trigger ${eventName}`,
      }),
      description: readStringField({
        object: objectInfo.objectCode,
        fieldName: 'description',
        contextLabel: `registered GitHub trigger ${eventName}`,
      }),
      source_path: toRepoPath(sourceFile),
      source_line: lineNumberAt(code, registeredArray.start + objectInfo.start),
      trigger_strategy: 'WEBHOOK',
    });
  }

  const githubTriggersArray = readTopLevelArrayLiteral({
    code,
    fieldPattern: /export\s+const\s+githubTriggers\s*=/,
    sourceFile,
  });
  const elements = splitTopLevel(githubTriggersArray.code).map((item) => item.trim()).filter(Boolean);
  for (const element of elements) {
    if (element.startsWith('...registered.map(')) {
      continue;
    }
    const identifier = readLeadingIdentifier(element);
    const imported = imports.get(identifier);
    if (!imported) {
      throw new Error(`Unable to resolve GitHub trigger symbol "${identifier}" in ${toRepoPath(sourceFile)}.`);
    }
    triggers.push(...extractOperationsFromSource({
      sourceFile: imported,
      callName: 'createTrigger',
      symbol: identifier,
      kind: 'trigger',
    }));
  }
  return triggers;
}

function extractOperationsFromSource({ sourceFile, callName, symbol, kind }) {
  const code = readText(sourceFile);
  const calls = extractCallObjects({ code, callName, sourceFile });
  if (calls.length === 0) {
    throw new Error(`No ${callName} call found for ${symbol} in ${toRepoPath(sourceFile)}.`);
  }
  return calls.map((call) => {
    const contextLabel = `${kind} ${symbol} in ${toRepoPath(sourceFile)}:${call.sourceLine}`;
    const base = {
      name: readStringField({ object: call.objectCode, fieldName: 'name', contextLabel }),
      display_name: readStringField({ object: call.objectCode, fieldName: 'displayName', contextLabel }),
      description: readStringField({
        object: call.objectCode,
        fieldName: 'description',
        required: false,
        contextLabel,
      }),
      source_path: toRepoPath(sourceFile),
      source_line: call.sourceLine,
    };
    if (kind === 'trigger') {
      return {
        ...base,
        trigger_strategy: readTriggerStrategy(call.objectCode),
      };
    }
    return base;
  });
}

function readTriggerStrategy(object) {
  const match = object.match(/\btype\s*:\s*TriggerStrategy\.([A-Z_]+)/);
  return match ? match[1] : null;
}

function inferNangoCandidates({ slug, packageName, auth }) {
  const hints = new Set(NANGO_PROVIDER_HINTS[slug] ?? []);
  const evidence = [
    packageName,
    ...auth.auth_url_candidates,
    ...auth.token_url_candidates,
  ].join(' ');

  const lower = evidence.toLowerCase();
  if (lower.includes('slack.com')) {
    hints.add('slack');
  }
  if (lower.includes('google.com') || lower.includes('googleapis.com')) {
    hints.add('google');
  }
  if (lower.includes('hubspot.com') || lower.includes('hubapi.com')) {
    hints.add('hubspot');
  }
  if (lower.includes('github.com')) {
    hints.add('github');
  }

  return [...hints].map((providerKey) => ({
    provider_key: providerKey,
    confidence: providerKey === 'google-sheets' || providerKey === 'gmail' ? 'possible' : 'high',
    evidence: `inferred from package/auth metadata for ${slug}`,
    candidate_only: true,
  }));
}

function validateCatalog({ artifacts, index, triggerCandidates }) {
  if (artifacts.length !== PILOT_PIECES.length) {
    throw new Error(`Expected ${PILOT_PIECES.length} artifacts, got ${artifacts.length}.`);
  }
  const slugs = artifacts.map((artifact) => artifact.piece.slug);
  assertEqualArrays(slugs, PILOT_PIECES, 'pilot artifact order');
  validateIndex(index, artifacts, triggerCandidates);
  for (const artifact of artifacts) {
    validateArtifact(artifact);
  }
  validateTriggerCandidates({ triggerCandidates, artifacts });
  validateLegacyTriggerCandidateRejection(triggerCandidates);
}

function validateExistingArtifacts() {
  const artifacts = PILOT_PIECES.map((slug) => readJson(pieceArtifactPath(slug)));
  const index = readJson(indexArtifactPath());
  const triggerCandidates = readJson(triggerCandidatesArtifactPath());
  validateCatalog({ artifacts, index, triggerCandidates });
}

function validateIndex(index, artifacts, triggerCandidates) {
  if (index.schema_version !== SCHEMA_VERSION) {
    throw new Error('Index schema_version mismatch.');
  }
  if (index.runtime_status !== RUNTIME_STATUS) {
    throw new Error('Index runtime_status must be candidate_only.');
  }
  if (index.trigger_candidates_artifact_path !== toRepoPath(triggerCandidatesArtifactPath())) {
    throw new Error('Index trigger_candidates_artifact_path mismatch.');
  }
  if (index.trigger_candidate_count !== triggerCandidates.triggers.length) {
    throw new Error('Index trigger_candidate_count mismatch.');
  }
  if (!Array.isArray(index.pieces) || index.pieces.length !== artifacts.length) {
    throw new Error('Index pieces list does not match artifact count.');
  }
  assertEqualArrays(index.pieces.map((piece) => piece.slug), artifacts.map((artifact) => artifact.piece.slug), 'index slugs');
}

function validateArtifact(artifact) {
  if (artifact.schema_version !== SCHEMA_VERSION) {
    throw new Error(`${artifact?.piece?.slug ?? 'unknown'} schema_version mismatch.`);
  }
  if (artifact.runtime_status !== RUNTIME_STATUS) {
    throw new Error(`${artifact.piece.slug} runtime_status must be candidate_only.`);
  }
  if (artifact.runtime_execution?.supported !== false) {
    throw new Error(`${artifact.piece.slug} runtime_execution.supported must be false.`);
  }
  if (!/^[0-9a-f]{40}$/.test(artifact.provenance?.upstream_commit ?? '')) {
    throw new Error(`${artifact.piece.slug} upstream_commit must be a 40-character git SHA.`);
  }
  requiredString(artifact.package?.name, `${artifact.piece.slug} package.name`);
  requiredString(artifact.package?.version, `${artifact.piece.slug} package.version`);
  requiredString(artifact.piece?.display_name, `${artifact.piece.slug} piece.display_name`);
  requiredString(artifact.piece?.description, `${artifact.piece.slug} piece.description`);
  requiredString(artifact.piece?.logo_url, `${artifact.piece.slug} piece.logo_url`);
  if (!Array.isArray(artifact.auth?.types) || artifact.auth.types.length === 0) {
    throw new Error(`${artifact.piece.slug} must include at least one auth type.`);
  }
  if (!Array.isArray(artifact.nango_provider_key_candidates) || artifact.nango_provider_key_candidates.length === 0) {
    throw new Error(`${artifact.piece.slug} must include Nango provider key candidates.`);
  }
  validateOperations({ operations: artifact.actions, kind: 'action', slug: artifact.piece.slug });
  validateOperations({ operations: artifact.triggers, kind: 'trigger', slug: artifact.piece.slug });
}

function validateOperations({ operations, kind, slug }) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(`${slug} must include at least one ${kind}.`);
  }
  const names = new Set();
  for (const operation of operations) {
    requiredString(operation.name, `${slug} ${kind}.name`);
    requiredString(operation.display_name, `${slug} ${kind}.display_name`);
    requiredString(operation.source_path, `${slug} ${kind}.source_path`);
    if (!Number.isInteger(operation.source_line) || operation.source_line < 1) {
      throw new Error(`${slug} ${kind} ${operation.name} source_line must be a positive integer.`);
    }
    if (names.has(operation.name)) {
      throw new Error(`${slug} has duplicate ${kind} name ${operation.name}.`);
    }
    names.add(operation.name);
    if (kind === 'trigger') {
      requiredString(operation.trigger_strategy, `${slug} trigger ${operation.name} trigger_strategy`);
    }
  }
}

function validateTriggerCandidates({ triggerCandidates, artifacts }) {
  if (triggerCandidates.schema_version !== SCHEMA_VERSION) {
    throw new Error('Trigger candidates schema_version mismatch.');
  }
  if (triggerCandidates.runtime_status !== RUNTIME_STATUS) {
    throw new Error('Trigger candidates runtime_status must be candidate_only.');
  }
  if (!Array.isArray(triggerCandidates.triggers)) {
    throw new Error('Trigger candidates artifact must include a triggers array.');
  }
  if (triggerCandidates.trigger_count !== triggerCandidates.triggers.length) {
    throw new Error('Trigger candidates trigger_count mismatch.');
  }

  const expectedIds = sortTriggerCandidates(artifacts.flatMap((artifact) => (
    artifact.triggers.map((trigger) => buildTriggerCandidateRecord({ artifact, trigger }))
  ))).map((candidate) => candidate.candidate_id);
  const actualIds = triggerCandidates.triggers.map((candidate) => candidate.candidate_id);
  assertEqualArrays(actualIds, expectedIds, 'trigger candidate order');

  const seen = new Set();
  for (const candidate of triggerCandidates.triggers) {
    validateTriggerCandidateRecord(candidate);
    if (seen.has(candidate.candidate_id)) {
      throw new Error(`Duplicate trigger candidate_id ${candidate.candidate_id}.`);
    }
    seen.add(candidate.candidate_id);
  }
}

function validateTriggerCandidateRecord(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Trigger candidate must be an object.');
  }
  const candidateId = requiredString(candidate.candidate_id, 'trigger candidate_id');
  const pieceSlug = requiredString(candidate.piece_slug, `${candidateId} piece_slug`);
  const triggerName = requiredString(candidate.trigger_name, `${candidateId} trigger_name`);
  const expectedCandidateId = triggerCandidateId({ pieceSlug, triggerName });
  if (candidateId !== expectedCandidateId) {
    throw new Error(`Trigger candidate_id mismatch. Expected ${expectedCandidateId}, got ${candidateId}.`);
  }
  if (candidateId.startsWith('@activepieces/piece-') || candidateId.includes('@activepieces/piece-')) {
    throw new Error(`Trigger candidate_id must not be a raw Activepieces package ID: ${candidateId}.`);
  }
  if (candidate.runtime_status !== RUNTIME_STATUS) {
    throw new Error(`${candidateId} runtime_status must be candidate_only.`);
  }
  if (candidate.runtime_execution?.supported !== false) {
    throw new Error(`${candidateId} runtime_execution.supported must be false.`);
  }
  requiredString(candidate.piece_display_name, `${candidateId} piece_display_name`);
  const packageName = requiredString(candidate.package_name, `${candidateId} package_name`);
  if (!packageName.startsWith('@activepieces/piece-')) {
    throw new Error(`${candidateId} package_name must be an Activepieces piece package.`);
  }
  requiredString(candidate.package_version, `${candidateId} package_version`);
  requiredString(candidate.display_name, `${candidateId} display_name`);
  requiredString(candidate.source_path, `${candidateId} source_path`);
  if (!Number.isInteger(candidate.source_line) || candidate.source_line < 1) {
    throw new Error(`${candidateId} source_line must be a positive integer.`);
  }
  const triggerStrategy = requiredString(candidate.trigger_strategy, `${candidateId} trigger_strategy`);
  const expectedFamily = triggerStrategyFamily(triggerStrategy);
  if (candidate.trigger_strategy_family !== expectedFamily) {
    throw new Error(`${candidateId} trigger_strategy_family must be ${expectedFamily}.`);
  }
  validateStringArray(candidate.auth_types, `${candidateId} auth_types`);
  validateProviderCandidates(candidate.nango_provider_key_candidates, candidateId);
}

function validateLegacyTriggerCandidateRejection(triggerCandidates) {
  const firstCandidate = triggerCandidates.triggers[0];
  if (!firstCandidate) {
    throw new Error('Cannot run legacy trigger candidate rejection check without candidates.');
  }
  const legacyCandidate = {
    ...firstCandidate,
    candidate_id: firstCandidate.package_name,
  };
  try {
    validateTriggerCandidateRecord(legacyCandidate);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Trigger candidate_id mismatch')) {
      return;
    }
    throw error;
  }
  throw new Error('Legacy Activepieces package ID was accepted as a trigger candidate_id.');
}

function validateProviderCandidates(candidates, contextLabel) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`${contextLabel} must include Nango provider key candidates.`);
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${contextLabel} provider candidate must be an object.`);
    }
    const providerKey = requiredString(candidate.provider_key, `${contextLabel} provider_key`);
    requiredString(candidate.confidence, `${contextLabel} provider candidate confidence`);
    requiredString(candidate.evidence, `${contextLabel} provider candidate evidence`);
    if (candidate.candidate_only !== true) {
      throw new Error(`${contextLabel} provider candidate ${providerKey} must be candidate_only.`);
    }
    if (seen.has(providerKey)) {
      throw new Error(`${contextLabel} has duplicate provider candidate ${providerKey}.`);
    }
    seen.add(providerKey);
  }
}

function validateStringArray(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  for (const value of values) {
    requiredString(value, label);
  }
}

function writeCatalog({ artifacts, index, triggerCandidates }) {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(PIECE_OUTPUT_DIR, { recursive: true });
  for (const artifact of artifacts) {
    fs.writeFileSync(pieceArtifactPath(artifact.piece.slug), stableJson(artifact));
  }
  fs.writeFileSync(triggerCandidatesArtifactPath(), stableJson(triggerCandidates));
  fs.writeFileSync(indexArtifactPath(), stableJson(index));
}

function checkGeneratedArtifacts({ artifacts, index, triggerCandidates }) {
  const expected = new Map([
    [indexArtifactPath(), stableJson(index)],
    [triggerCandidatesArtifactPath(), stableJson(triggerCandidates)],
    ...artifacts.map((artifact) => [pieceArtifactPath(artifact.piece.slug), stableJson(artifact)]),
  ]);
  for (const [filePath, expectedText] of expected) {
    const actualText = readText(filePath);
    if (actualText !== expectedText) {
      throw new Error(`Generated artifact is stale: ${toRepoPath(filePath)}`);
    }
  }
}

function parseImports({ code, fromFile }) {
  const imports = new Map();
  const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(importPattern)) {
    const specifier = match[2];
    const sourceFile = resolveImport({ fromFile, specifier });
    for (const imported of splitTopLevel(match[1])) {
      const part = imported.trim();
      if (!part || part.startsWith('type ')) {
        continue;
      }
      const cleaned = part.replace(/^type\s+/, '').trim();
      const aliasMatch = cleaned.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        imports.set(aliasMatch[2], sourceFile);
        continue;
      }
      const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*)$/);
      if (nameMatch) {
        imports.set(nameMatch[1], sourceFile);
      }
    }
  }
  return imports;
}

function followReExport({ symbol, sourceFile }) {
  const reExport = parseReExports({ code: readText(sourceFile), fromFile: sourceFile }).get(symbol);
  return reExport ? followReExport({ symbol, sourceFile: reExport }) : sourceFile;
}

function parseReExports({ code, fromFile }) {
  const statements = [...code.matchAll(/\bexport(\s*\{[^}]*\}\s*from\s*['"][^'"]+['"])/g)].map((match) => `import${match[1]}`);
  return parseImports({ code: statements.join('\n'), fromFile });
}

function resolveImport({ fromFile, specifier }) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) {
    throw new Error(`Unable to resolve import "${specifier}" from ${toRepoPath(fromFile)}.`);
  }
  return resolved;
}

function extractSingleCallObject({ code, callName, sourceFile }) {
  const calls = extractCallObjects({ code, callName, sourceFile });
  if (calls.length !== 1) {
    throw new Error(`Expected one ${callName} call in ${toRepoPath(sourceFile)}, got ${calls.length}.`);
  }
  return calls[0];
}

function extractCallObjects({ code, callName, sourceFile }) {
  const calls = [];
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const callIndex = code.indexOf(callName, searchFrom);
    if (callIndex === -1) {
      break;
    }
    const before = code[callIndex - 1];
    const after = code[callIndex + callName.length];
    if (isIdentifierChar(before) || isIdentifierChar(after)) {
      searchFrom = callIndex + callName.length;
      continue;
    }
    let parenStart = callIndex + callName.length;
    while (/\s/.test(code[parenStart] ?? '')) {
      parenStart += 1;
    }
    if (code[parenStart] !== '(') {
      searchFrom = callIndex + callName.length;
      continue;
    }
    let objectStart = parenStart + 1;
    while (/\s/.test(code[objectStart] ?? '')) {
      objectStart += 1;
    }
    if (code[objectStart] !== '{') {
      searchFrom = parenStart + 1;
      continue;
    }
    const objectEnd = findMatchingPair({ code, start: objectStart, open: '{', close: '}' });
    calls.push({
      objectCode: code.slice(objectStart, objectEnd + 1),
      sourceLine: lineNumberAt(code, objectStart),
    });
    searchFrom = objectEnd + 1;
  }
  return calls;
}

function readTopLevelArrayElements({ object, fieldName, contextLabel = 'object' }) {
  const fieldIndex = findFieldIndex({ object, fieldName, contextLabel });
  const bracketStart = object.indexOf('[', fieldIndex);
  if (bracketStart === -1) {
    throw new Error(`Missing array field "${fieldName}" in ${contextLabel}.`);
  }
  const bracketEnd = findMatchingPair({ code: object, start: bracketStart, open: '[', close: ']' });
  return splitTopLevel(object.slice(bracketStart + 1, bracketEnd));
}

function readOperationFieldElements({ object, fieldName, contextLabel }) {
  const fieldIndex = findFieldIndex({ object, fieldName, contextLabel });
  const colonIndex = object.indexOf(':', fieldIndex);
  let valueIndex = colonIndex + 1;
  while (/\s/.test(object[valueIndex] ?? '')) {
    valueIndex += 1;
  }
  if (object[valueIndex] === '[') {
    const bracketEnd = findMatchingPair({ code: object, start: valueIndex, open: '[', close: ']' });
    return splitTopLevel(object.slice(valueIndex + 1, bracketEnd));
  }
  const identifier = readLeadingIdentifier(object.slice(valueIndex));
  if (!identifier) {
    throw new Error(`Missing array or identifier field "${fieldName}" in ${contextLabel}.`);
  }
  return [identifier];
}

function readTopLevelArrayLiteral({ code, fieldPattern, sourceFile }) {
  const match = code.match(fieldPattern);
  if (!match || match.index === undefined) {
    throw new Error(`Unable to find array literal in ${toRepoPath(sourceFile)}.`);
  }
  const bracketStart = code.indexOf('[', match.index + match[0].length);
  if (bracketStart === -1) {
    throw new Error(`Missing array literal bracket in ${toRepoPath(sourceFile)}.`);
  }
  const bracketEnd = findMatchingPair({ code, start: bracketStart, open: '[', close: ']' });
  return {
    code: code.slice(bracketStart + 1, bracketEnd),
    start: bracketStart + 1,
  };
}

function splitTopLevelObjectLiterals(code) {
  const objects = [];
  let index = 0;
  while (index < code.length) {
    while (index < code.length && /[\s,]/.test(code[index])) {
      index += 1;
    }
    if (index >= code.length) {
      break;
    }
    if (code[index] !== '{') {
      index += 1;
      continue;
    }
    const end = findMatchingPair({ code, start: index, open: '{', close: '}' });
    objects.push({
      objectCode: code.slice(index, end + 1),
      start: index,
    });
    index = end + 1;
  }
  return objects;
}

function splitTopLevel(code) {
  const values = [];
  let start = 0;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      values.push(code.slice(start, index));
      start = index + 1;
    }
  }
  values.push(code.slice(start));
  return values;
}

function findMatchingPair({ code, start, open, close }) {
  if (code[start] !== open) {
    throw new Error(`Expected "${open}" at index ${start}.`);
  }
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(`Unable to find matching "${close}" for "${open}" at index ${start}.`);
}

function readStringField({ object, fieldName, required = true, contextLabel = 'object' }) {
  const fieldIndex = findFieldIndex({ object, fieldName, required, contextLabel });
  if (fieldIndex === -1) {
    return null;
  }
  const colonIndex = object.indexOf(':', fieldIndex);
  let valueIndex = colonIndex + 1;
  while (/\s/.test(object[valueIndex] ?? '')) {
    valueIndex += 1;
  }
  const quote = object[valueIndex];
  if (!['\'', '"', '`'].includes(quote)) {
    if (required) {
      throw new Error(`Field "${fieldName}" must be a string literal in ${contextLabel}.`);
    }
    return null;
  }
  return readQuotedString({ code: object, start: valueIndex });
}

function readStringFieldValues({ code, fieldName }) {
  const values = [];
  const pattern = new RegExp(`\\b${escapeRegExp(fieldName)}\\s*:`, 'g');
  for (const match of code.matchAll(pattern)) {
    let valueIndex = match.index + match[0].length;
    while (/\s/.test(code[valueIndex] ?? '')) {
      valueIndex += 1;
    }
    if (['\'', '"', '`'].includes(code[valueIndex])) {
      values.push(readQuotedString({ code, start: valueIndex }));
    }
  }
  return values;
}

function readStringArrayField({ object, fieldName }) {
  const fieldIndex = findFieldIndex({ object, fieldName, required: false });
  if (fieldIndex === -1) {
    return [];
  }
  const bracketStart = object.indexOf('[', fieldIndex);
  if (bracketStart === -1) {
    return [];
  }
  const bracketEnd = findMatchingPair({ code: object, start: bracketStart, open: '[', close: ']' });
  return splitTopLevel(object.slice(bracketStart + 1, bracketEnd))
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const quote = item[0];
      return ['\'', '"', '`'].includes(quote) ? readQuotedString({ code: item, start: 0 }) : null;
    })
    .filter((item) => item !== null);
}

function readEnumArrayField({ object, fieldName, enumPrefix }) {
  const fieldIndex = findFieldIndex({ object, fieldName, required: false });
  if (fieldIndex === -1) {
    return [];
  }
  const bracketStart = object.indexOf('[', fieldIndex);
  if (bracketStart === -1) {
    return [];
  }
  const bracketEnd = findMatchingPair({ code: object, start: bracketStart, open: '[', close: ']' });
  const arrayCode = object.slice(bracketStart + 1, bracketEnd);
  const pattern = new RegExp(`${escapeRegExp(enumPrefix)}\\.([A-Z0-9_]+)`, 'g');
  return unique([...arrayCode.matchAll(pattern)].map((match) => match[1])).sort();
}

function readIdentifierField({ object, fieldName }) {
  const fieldIndex = findFieldIndex({ object, fieldName });
  const colonIndex = object.indexOf(':', fieldIndex);
  const match = object.slice(colonIndex + 1).match(/\s*([A-Za-z_$][\w$]*)/);
  if (!match) {
    throw new Error(`Unable to read identifier field "${fieldName}".`);
  }
  return match[1];
}

function readStringOrEnumField({ object, fieldName, enumValues, contextLabel }) {
  const fieldIndex = findFieldIndex({ object, fieldName, contextLabel });
  const colonIndex = object.indexOf(':', fieldIndex);
  let valueIndex = colonIndex + 1;
  while (/\s/.test(object[valueIndex] ?? '')) {
    valueIndex += 1;
  }
  const quote = object[valueIndex];
  if (['\'', '"', '`'].includes(quote)) {
    return readQuotedString({ code: object, start: valueIndex });
  }
  const enumMatch = object.slice(valueIndex).match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/);
  if (enumMatch) {
    const enumKey = `${enumMatch[1]}.${enumMatch[2]}`;
    const enumValue = enumValues.get(enumKey);
    if (enumValue) {
      return enumValue;
    }
  }
  throw new Error(`Field "${fieldName}" must be a string literal or known enum in ${contextLabel}.`);
}

function readEnumStringValues({ code, enumName }) {
  const enumIndex = code.indexOf(`enum ${enumName}`);
  if (enumIndex === -1) {
    return new Map();
  }
  const braceStart = code.indexOf('{', enumIndex);
  const braceEnd = findMatchingPair({ code, start: braceStart, open: '{', close: '}' });
  const enumCode = code.slice(braceStart + 1, braceEnd);
  const values = new Map();
  const pattern = /([A-Za-z_$][\w$]*)\s*=\s*(['"`])/g;
  for (const match of enumCode.matchAll(pattern)) {
    const member = match[1];
    const valueStart = match.index + match[0].lastIndexOf(match[2]);
    values.set(`${enumName}.${member}`, readQuotedString({ code: enumCode, start: valueStart }));
  }
  return values;
}

function findFieldIndex({ object, fieldName, required = true, contextLabel = 'object' }) {
  const pattern = new RegExp(`\\b${escapeRegExp(fieldName)}\\s*:`, 'g');
  const match = pattern.exec(object);
  if (!match) {
    if (required) {
      throw new Error(`Missing required field "${fieldName}" in ${contextLabel}.`);
    }
    return -1;
  }
  return match.index;
}

function readQuotedString({ code, start }) {
  const quote = code[start];
  let value = '';
  let escaped = false;
  for (let index = start + 1; index < code.length; index += 1) {
    const char = code[index];
    if (escaped) {
      value += decodeEscapedChar(char);
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return value;
    }
    value += char;
  }
  throw new Error(`Unterminated string literal starting at ${start}.`);
}

function decodeEscapedChar(char) {
  if (char === 'n') return '\n';
  if (char === 'r') return '\r';
  if (char === 't') return '\t';
  return char;
}

function readLeadingIdentifier(value) {
  const match = value.match(/^([A-Za-z_$][\w$]*)/);
  return match ? match[1] : null;
}

function dedupeOperations({ operations, kind, pieceSlug }) {
  const seen = new Set();
  const deduped = [];
  for (const operation of operations) {
    if (seen.has(operation.name)) {
      throw new Error(`${pieceSlug} has duplicate ${kind} "${operation.name}".`);
    }
    seen.add(operation.name);
    deduped.push(sortObjectKeys(operation));
  }
  return deduped;
}

function sortOperations(operations) {
  return operations.slice().sort((left, right) => left.name.localeCompare(right.name));
}

function sortTriggerCandidates(candidates) {
  return candidates.slice().sort((left, right) => {
    const leftPieceIndex = PILOT_PIECES.indexOf(left.piece_slug);
    const rightPieceIndex = PILOT_PIECES.indexOf(right.piece_slug);
    if (leftPieceIndex !== rightPieceIndex) {
      return leftPieceIndex - rightPieceIndex;
    }
    return left.trigger_name.localeCompare(right.trigger_name);
  });
}

function triggerCandidateId({ pieceSlug, triggerName }) {
  return `activepieces_candidate.${pieceSlug}.${triggerName}`;
}

function triggerStrategyFamily(strategy) {
  if (POLLING_TRIGGER_STRATEGIES.has(strategy)) {
    return 'POLLING';
  }
  if (WEBHOOK_TRIGGER_STRATEGIES.has(strategy)) {
    return 'WEBHOOK';
  }
  throw new Error(`Unsupported trigger strategy for generated candidate: ${strategy}.`);
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.keys(value).sort().reduce((accumulator, key) => {
    accumulator[key] = sortObjectKeys(value[key]);
    return accumulator;
  }, {});
}

function stableJson(value) {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function assertDirectory(dirPath, description) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Missing ${description}: ${toRepoPath(dirPath)}`);
  }
}

function assertEqualArrays(actual, expected, description) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${description} mismatch. Expected ${expected.join(', ')}, got ${actual.join(', ')}.`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function pieceArtifactPath(slug) {
  return path.join(PIECE_OUTPUT_DIR, `${slug}.json`);
}

function indexArtifactPath() {
  return path.join(OUTPUT_DIR, 'index.json');
}

function triggerCandidatesArtifactPath() {
  return TRIGGER_CANDIDATES_OUTPUT_PATH;
}

function toRepoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function lineNumberAt(code, index) {
  if (index < 0) {
    return 1;
  }
  return code.slice(0, index).split('\n').length;
}

function isIdentifierChar(char) {
  return typeof char === 'string' && /[A-Za-z0-9_$]/.test(char);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
