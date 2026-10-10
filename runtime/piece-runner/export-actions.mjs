import { writeFile } from 'node:fs/promises';
import { pieceCatalog } from './catalog.mjs';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node export-actions.mjs <output.json>');
await writeFile(outputPath, `${JSON.stringify(pieceCatalog.exportActions({}), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
