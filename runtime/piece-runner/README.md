# Piece runner

Standalone Node 22 package (outside the Bun workspaces) that runs allowlisted
Activepieces actions, property loaders and the polling triggers of those pieces,
each in a fresh child with an empty environment. Credentials arrive with each
invocation; the orchestrator supplies them. The Lambda image's entry is
`lambda.handler`.

| Fact | Owner |
| --- | --- |
| Bundled pieces and actions mirror the orchestrator allowlist; versions and `authType` | `rcm-orchestrator/contracts/activepieces-piece-allowlist.json`; runner mirror `catalog.mjs` (versions from `package.json`) |
| Request modes (`run`, `options`, `props`, `trigger`) and result shape | `index.mjs`, `worker.mjs`, `execution.mjs` |
| Refusal codes | `errors.mjs` |
| Timeout, memory and output defaults and ceilings | `index.mjs`, `worker.mjs` |
| Credential `allowed_hosts` egress | `egress.mjs` |
| Trigger store limits | `store.mjs`; trigger admission `trigger-catalog.mjs` |
| Exported action and trigger metadata | `export-actions.mjs`, `export-triggers.mjs` |

```js
import { pieceRunner } from './index.mjs';
const result = await pieceRunner.invoke({ piece, version, action, auth_type: 'API_KEY',
  auth: { apiKey }, allowed_hosts: ['discord.com'], props: { channel_id, message } });
// { status: 'completed', output } | { status: 'refused', refusal } | { status: 'failed', error }
```

## Build and check

From this directory (exact locked packages, scripts disabled, no runtime install):

```sh
npm ci --ignore-scripts
node check-versions.mjs
node --test test/<name>.contract.test.mjs
node export-actions.mjs actions.json
node export-triggers.mjs ../../catalog/activepieces/generated/runner/triggers.json
```

From the repository root:

```sh
node runtime/piece-runner/update-pieces.mjs outdated [--json]
node runtime/piece-runner/update-pieces.mjs refresh --upstream <commit>
docker build -f runtime/piece-runner/Dockerfile -t rcm-piece-runner .
```

`refresh` needs an empty Git index, and in a sparse checkout `runtime` and
`catalog` on the sparse list; review the printed prop and auth changes before
committing.
