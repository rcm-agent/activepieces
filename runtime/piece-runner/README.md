# Piece runner

Standalone Node 20 package outside the repository's Bun workspaces. It executes the Slack, Discord and Google actions listed below. RCM's orchestrator connector runtime supplies a Nango credential; Nango remains the connection owner.

| Piece | Version | Allowed actions |
| --- | --- | --- |
| Slack | 0.17.0 | `send_channel_message` |
| Discord | 0.5.0 | `sendMessageWithBot` |
| Google Sheets | 0.14.6 | `get-many-rows`, `find_rows`, `find_row_by_num`, `insert_row`, `google-sheets-insert-multiple-rows`, `update_row` |
| Google Calendar | 0.9.1 | `google_calendar_find_busy_free_periods`, `google_calendar_get_events`, `google_calendar_get_event_by_id`, `create_google_calendar_event`, `update_event` |
| Google Drive | 0.7.5 | `search-folder`, `create_new_gdrive_folder` |

```js
import { pieceRunner } from './index.mjs';

const result = await pieceRunner.invoke({
  piece: '@activepieces/piece-discord',
  version: '0.5.0',
  action: 'sendMessageWithBot',
  auth_type: 'API_KEY',
  auth: { apiKey: 'NANGO_CREDENTIAL' },
  props: { channel_id: 'CHANNEL_ID', message: 'Hello' },
  timeout_ms: 30_000,
  memory_mb: 256,
  max_output_bytes: 262_144,
});
```

The result is `{ status: 'completed', output }`, `{ status: 'refused', refusal }` or `{ status: 'failed', error }`. Successful action output is unchanged. Error responses contain only the class, optional HTTP status and message, with every string in `auth` scrubbed. The runner never logs the request or credentials.

Auth input is selected exclusively by `auth_type`: Nango's `API_KEY` credential `{ apiKey }` becomes `{ type: 'SECRET_TEXT', secret_text }`, `BASIC` accepts `{ username, password }`, and `OAUTH2` accepts `{ access_token, raw }`, mapping the provider's raw OAuth response to AP's `data`. Normalized `{ secret_text }` and OAuth `{ access_token, data }` inputs also work; Nango fields take precedence when both are supplied. Discord declares `SECRET_TEXT`, so it accepts `API_KEY`. Slack declares `OAUTH2` and `CUSTOM_AUTH`; this runner accepts only `OAUTH2` for Slack. An undeclared auth kind is refused. Props must match the installed action's declarations: unknown names, missing required values and supplied File props are refused.

Each allowed invocation starts a fresh child with an empty environment. Defaults and hard ceilings are:

| Field | Default | Hard ceiling |
| --- | ---: | ---: |
| `timeout_ms` | 30,000 | 60,000 |
| `memory_mb` | 256 | 512 |
| `max_output_bytes` | 262,144 | 1,048,576 |

Google Calendar and Google Drive entries set `memoryMb: 512` as a per-call floor. The effective memory limit is the larger of the requested value (256 MiB by default) and the entry's floor. Requested limits are validated before applying the floor, so requests above 512 MiB are still refused.

Limits must be integers; timeout and output limits must be positive, and memory must be at least 64 MiB. Memory enforcement combines a V8 heap limit with a Linux RSS monitor. The serialized request is capped at 1 MiB; the output limit counts serialized response bytes. Expiry kills the child and returns `TIMEOUT`. Invalid limits, excessive memory and excessive output return named refusals. Store, files, server, pause, connections, agent and flows services throw `CONTEXT_SERVICE_UNAVAILABLE` when used.

Install exact locked npm packages during a build, with scripts disabled. No runtime installation occurs. From this directory:

```sh
npm ci --ignore-scripts
node check-versions.mjs
node --test test/invoke.contract.test.mjs
node --test test/export-actions.contract.test.mjs
node export-actions.mjs actions.json
```

The version check compares the lock and installed pieces with the fork's piece manifests using each entry's explicit `forkDirectory`, and checks the pinned root framework. Pieces retain their own nested framework, common and shared dependencies. Export reads metadata from installed piece code, including props, required flags, descriptions, declared auth kinds and versions. Exported action IDs use deterministic snake case (`sendMessageWithBot` → `send_message_with_bot`).

Build the Lambda container from the repository root:

```sh
docker build -f runtime/piece-runner/Dockerfile -t rcm-piece-runner .
```

The AWS Node 20 base invokes `runtime/piece-runner/lambda.handler`. The image contains installed production dependencies and fork manifests for the version check. `Dockerfile.dockerignore` limits the repository build context to runner source, its lock and those manifests. AWS deployment, IAM and non-VPC Lambda configuration are owner steps. There is no Activepieces API, worker, queue or server.
