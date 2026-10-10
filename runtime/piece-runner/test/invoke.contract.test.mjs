import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pieceRunner } from '../index.mjs';
import { runnerErrors } from '../errors.mjs';
const discord = { piece: '@activepieces/piece-discord', version: '0.5.0', action: 'sendMessageWithBot', auth_type: 'API_KEY', auth: { type: 'API_KEY', apiKey: 'discord-contract-token' }, props: { channel_id: 'C123', message: 'contract message' }, timeout_ms: 15000 };
const slack = { piece: '@activepieces/piece-slack', version: '0.17.0', action: 'send_channel_message', auth_type: 'OAUTH2', auth: { type: 'OAUTH2', access_token: 'slack-contract-token', raw: { team: { id: 'contract-team' } } }, props: { channel: 'C123', sendAsBot: true, text: 'contract message' }, timeout_ms: 15000 };
const output = { id: 'message-123', content: 'contract message', nested: { untouched: true } };
const originalSpawn = childProcess.spawn;
let fixture;
childProcess.spawn = (command, args, options) => {
  assert.deepEqual(options.env, {}); assert.equal(args[0], '--max-old-space-size=256');
  return originalSpawn(command, ['--require', fileURLToPath(new URL('./http-intercept.cjs', import.meta.url)), ...args, JSON.stringify(fixture)], options);
};
syncBuiltinESMExports(); after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
function run({ request = discord, body = output, status = 200, mode } = {}) {
  fixture = { body, status, mode, url: request.piece === slack.piece ? 'https://slack.com/api/chat.postMessage' : 'https://discord.com/api/v10/channels/C123/messages', authorization: request.piece === slack.piece ? `Bearer ${request.props.sendAsBot ? request.auth.access_token : (request.auth.raw ?? request.auth.data)?.authed_user?.access_token}` : `Bot ${request.auth.apiKey ?? request.auth.secret_text}` };
  return pieceRunner.invoke(request);
}
test('runs installed Discord and Slack actions in an empty child environment and preserves output', async () => {
  assert.deepEqual(await run(), { status: 'completed', output });
  assert.deepEqual(await run({ request: { ...discord, auth: { secret_text: discord.auth.apiKey } } }), { status: 'completed', output });
  const slackOutput = { ok: true, channel: 'C123', ts: '123.456', message: { text: 'contract message' }, response_metadata: {} };
  assert.deepEqual(await run({ request: slack, body: slackOutput }), { status: 'completed', output: slackOutput });
  assert.deepEqual(await run({ request: { ...slack, auth: { access_token: slack.auth.access_token, data: slack.auth.raw } }, body: slackOutput }), { status: 'completed', output: slackOutput });
  const userAuth = { ...slack.auth, raw: { authed_user: { access_token: 'slack-user-contract-token' } } };
  assert.deepEqual(await run({ request: { ...slack, auth: userAuth, props: { ...slack.props, sendAsBot: false } }, body: slackOutput }), { status: 'completed', output: slackOutput });
});
test('refuses invalid calls, unavailable store/server services, hung actions and excessive output or limits', async () => {
  for (const [request, response, code] of [
    [{ ...discord, auth_type: 'BASIC' }, {}, 'AUTH_TYPE_MISMATCH'],
    [{ ...slack, auth_type: 'API_KEY' }, {}, 'AUTH_TYPE_MISMATCH'],
    [{ ...discord, action: 'discordSendMessageWebhook' }, {}, 'ACTION_NOT_ALLOWLISTED'],
    [{ ...slack, props: { ...slack.props, file: { filename: 'file.txt' } } }, {}, 'FILE_PROP_REFUSED'],
    [{ ...discord, props: { ...discord.props, files: [{ file: { filename: 'file.txt' } }] } }, {}, 'FILE_PROP_REFUSED'],
    [{ ...discord, props: { ...discord.props, undeclared: true } }, {}, 'UNDECLARED_PROP'],
    [{ ...discord, props: {} }, {}, 'MISSING_REQUIRED_PROP'],
    [discord, { mode: 'store' }, 'CONTEXT_SERVICE_UNAVAILABLE'],
    [{ ...slack, props: { ...slack.props, mentionOriginFlow: true } }, {}, 'CONTEXT_SERVICE_UNAVAILABLE'],
    [{ ...discord, timeout_ms: 2500 }, { mode: 'hang' }, 'TIMEOUT'],
    [{ ...discord, max_output_bytes: 128 }, { body: { message: 'x'.repeat(2048) } }, 'OUTPUT_LIMIT_EXCEEDED'],
    [{ ...discord, memory_mb: 513 }, {}, 'INVALID_LIMIT'],
    [{ ...discord, timeout_ms: 60001 }, {}, 'INVALID_LIMIT'],
    [{ ...discord, max_output_bytes: 1048577 }, {}, 'INVALID_LIMIT'],
  ]) {
    const result = await run({ request, ...response });
    assert.deepEqual([result.status, result.refusal?.code], ['refused', code]);
  }
});
test('provider errors expose only class, HTTP status and a message with every auth string scrubbed', async () => {
  const auth = { apiKey: discord.auth.apiKey, raw: { other: 'raw-provider-contract-secret' } };
  const result = await run({ request: { ...discord, auth }, status: 400, body: { message: `${auth.apiKey} ${auth.raw.other}` } });
  assert.deepEqual([result.status, result.error.class, result.error.http_status], ['failed', 'HttpError', 400]);
  assert.deepEqual(Object.keys(result.error).sort(), ['class', 'http_status', 'message']);
  for (const secret of [auth.apiKey, auth.raw.other]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(result.error.message.includes('[REDACTED]'));
  const special = { secret_text: 'quoted"\\token\n', other: '\ud800' };
  const echo = Object.values(special).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]).join(' ');
  assert.equal(runnerErrors.failure({ error: new Error(echo), auth: special }).error.message, '[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
});
