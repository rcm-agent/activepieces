import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPieceEntry,
  readStringValue,
  readTopLevelProperties,
  renderFrontendModule,
} from './generate-piece-directory.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate-piece-directory.mjs');

const PIECE_SOURCE = `
import { createPiece, PieceAuth, PieceCategory } from '@activepieces/pieces-framework';
// displayName: 'Not this comment'
export const gmail = createPiece({
  minimumSupportedRelease: '0.30.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/gmail.png',
  categories: [PieceCategory.COMMUNICATION, PieceCategory.BUSINESS_INTELLIGENCE],
  actions: [
    createCustomApiCallAction({ displayName: 'Nested action', baseUrl: () => \`https://\${host}\` }),
  ],
  description: t('Email service by \\'Google\\''),
  displayName: "Gmail",
  auth: gmailAuth,
});
`;

test('reads only the top-level createPiece properties', () => {
  const open = PIECE_SOURCE.indexOf('createPiece({') + 'createPiece('.length;
  const properties = readTopLevelProperties(PIECE_SOURCE, open);
  assert.equal(readStringValue(properties.get('displayName')), 'Gmail');
  assert.equal(readStringValue(properties.get('description')), "Email service by 'Google'");
  assert.equal(readStringValue('`https://${host}`'), null);
  assert.equal(properties.get('auth'), 'gmailAuth');
});

test('builds a display-only directory entry', () => {
  const entry = buildPieceEntry({
    authKinds: ['oauth2'],
    indexCode: PIECE_SOURCE,
    packageJson: { name: '@activepieces/piece-gmail', version: '0.9.0' },
    slug: 'gmail',
  });
  assert.deepEqual(entry, {
    auth_kinds: ['oauth2'],
    categories: ['BUSINESS_INTELLIGENCE', 'COMMUNICATION'],
    description: "Email service by 'Google'",
    display_name: 'Gmail',
    logo_url: 'https://cdn.activepieces.com/pieces/gmail.png',
    package_name: '@activepieces/piece-gmail',
    slug: 'gmail',
  });
  assert.equal(
    buildPieceEntry({ authKinds: [], indexCode: PIECE_SOURCE, packageJson: { name: 'not-a-piece' }, slug: 'x' }),
    null,
  );
  const module = renderFrontendModule({ pieces: [entry] });
  assert.match(module, /"displayName":"Gmail"/);
  assert.match(module, /Display metadata only/);
});

test('checked-in directory matches the forked piece sources', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
