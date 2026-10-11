import https from 'node:https';
import { createRequire } from 'node:module';
import { runnerErrors } from './errors.mjs';
import { runnerExecution } from './execution.mjs';

const writeResult = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
// The published HTTP client changes the TLS environment flag during requests.
https.globalAgent.options.rejectUnauthorized = true;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1048576) process.exit(1);
});
process.stdin.on('end', async () => {
  let request;
  let result;
  try {
    request = JSON.parse(input);
    const { pieceCatalog } = await import('./catalog.mjs');
    pieceCatalog.verifyVersions({});
    const { tryCatch } = createRequire(import.meta.url)('@activepieces/shared');
    const execution = await tryCatch(async () => ({ output: await runnerExecution.execute({ request, pieceCatalog }) }));
    result = execution.data === null
      ? runnerErrors.failure({ error: execution.error, auth: request.auth })
      : { status: 'completed', output: execution.data.output ?? null };
  } catch (error) {
    result = runnerErrors.failure({ error, auth: request?.auth });
  }
  try {
    const encoded = JSON.stringify(result);
    const cap = request?.max_output_bytes ?? 262144;
    const response = Buffer.byteLength(encoded) > cap
      ? JSON.stringify(runnerErrors.refusal({ code: 'OUTPUT_LIMIT_EXCEEDED' })) : encoded;
    writeResult(response, () => process.exit(0));
  } catch (error) {
    writeResult(JSON.stringify(runnerErrors.failure({ error, auth: request?.auth })), () => process.exit(0));
  }
});
