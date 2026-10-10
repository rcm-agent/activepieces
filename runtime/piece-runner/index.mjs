import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pieceCatalog } from './catalog.mjs';
import { runnerErrors } from './errors.mjs';

// Readings are 20 ms apart, so a broken monitor still stops the action within 200 ms.
const MISSING_READING_LIMIT = 10;

async function invoke(request) {
  try {
    pieceCatalog.validateTuple(request ?? {});
    const limits = getLimits({ request });
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 1048576) return runnerErrors.refusal({ code: 'INPUT_LIMIT_EXCEEDED' });
    return await execute({ payload, limits, auth: request.auth });
  } catch (error) {
    return runnerErrors.failure({ error, auth: request?.auth });
  }
}

function getLimits({ request }) {
  const limits = {
    timeout_ms: request.timeout_ms ?? 30000,
    memory_mb: request.memory_mb ?? 256,
    max_output_bytes: request.max_output_bytes ?? 262144,
  };
  for (const [name, minimum, maximum] of [['timeout_ms', 1, 60000], ['memory_mb', 64, 512], ['max_output_bytes', 1, 1048576]]) {
    if (!Number.isInteger(limits[name]) || limits[name] < minimum || limits[name] > maximum) {
      const error = new Error(`Invalid ${name} limit`);
      error.name = 'RunnerRefusal';
      error.code = 'INVALID_LIMIT';
      throw error;
    }
  }
  return limits;
}

function execute({ payload, limits, auth }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${limits.memory_mb}`, fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0;
    let terminal;
    let closed = false;
    const stop = (code) => {
      if (closed) return;
      terminal ??= runnerErrors.refusal({ code });
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('TIMEOUT'), limits.timeout_ms);
    let missingReadings = 0;
    const memory = setInterval(async () => {
      try {
        if (!child.pid || terminal || closed) return;
        const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
        if (terminal || closed) return;
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        if (rss) missingReadings = 0;
        if (rss && Number(rss[1]) > limits.memory_mb * 1024) stop('MEMORY_LIMIT_EXCEEDED');
        // An exiting process drops VmRSS before its state turns zombie; only a lasting gap is a broken monitor.
        else if (!rss && !/^State:\s+[ZX]/m.test(status) && ++missingReadings >= MISSING_READING_LIMIT) {
          stop('MEMORY_MONITOR_UNAVAILABLE');
        }
      } catch (error) {
        if (terminal || closed || child.exitCode !== null || child.signalCode !== null) return;
        if (error.code === 'ENOENT') {
          try {
            process.kill(child.pid, 0);
          } catch (probeError) {
            if (probeError.code === 'ESRCH') return;
          }
        }
        stop('MEMORY_MONITOR_UNAVAILABLE');
      }
    }, 20);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limits.max_output_bytes) stop('OUTPUT_LIMIT_EXCEEDED');
      else if (!terminal) chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { terminal ??= runnerErrors.failure({ error, auth }); });
    child.on('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      clearInterval(memory);
      if (terminal) return resolve(terminal);
      if (code !== 0 || signal) {
        return resolve(runnerErrors.failure({ error: new Error('Action process exited without a result'), auth }));
      }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result?.status === 'completed' && Object.hasOwn(result, 'output')) {
          return resolve({ status: 'completed', output: result.output });
        }
        const scrub = runnerErrors.redactor({ auth });
        if (result?.status === 'refused' && typeof result.refusal?.code === 'string') {
          return resolve(runnerErrors.refusal({ code: scrub(result.refusal.code), message: scrub(result.refusal.message) }));
        }
        if (result?.status === 'failed' && typeof result.error?.message === 'string') {
          return resolve({ status: 'failed', error: {
            class: scrub(result.error.class),
            http_status: Number.isInteger(result.error.http_status) && result.error.http_status >= 100 && result.error.http_status <= 599 ? result.error.http_status : null,
            message: scrub(result.error.message),
          } });
        }
        throw new Error('Invalid action process result');
      } catch {
        resolve(runnerErrors.failure({ error: new Error('Invalid action process result'), auth }));
      }
    });
    child.stdin.end(payload);
  });
}

export const pieceRunner = { invoke };
