# Piece runner

Standalone Node 22 package outside the repository's Bun workspaces. It executes the actions listed below. Credentials arrive with each invocation; the orchestrator supplies OAuth credentials from Nango and typed credentials from the tenant's vault.

| Piece | Allowed actions |
| --- | --- |
| Slack | `send_channel_message`, `getChannelHistory`, `slack_list_channels`, `searchMessages` |
| Discord | `sendMessageWithBot`, `discord_list_messages`, `discord_find_member`, `list_guild_members` |
| Google Sheets | `get-many-rows`, `find_rows`, `find_row_by_num`, `insert_row`, `google-sheets-insert-multiple-rows`, `update_row`, `find_spreadsheets` |
| Google Calendar | `google_calendar_find_busy_free_periods`, `google_calendar_get_events`, `google_calendar_get_event_by_id`, `create_google_calendar_event`, `update_event` |
| Google Drive | `search-folder`, `create_new_gdrive_folder` |
| Microsoft Outlook | `outlook_send_email`, `outlook_reply_to_message`, `outlook_forward_message`, `outlook_search_messages`, `outlook_list_messages`, `outlook_get_message`, `findEmail` |
| Microsoft Outlook Calendar | `list_events`, `create_event` |
| Microsoft Teams | `microsoft_teams_send_channel_message`, `microsoft_teams_reply_to_channel_message`, `microsoft_teams_send_chat_message`, `microsoft_teams_find_channel`, `microsoft_teams_get_channel_message` |
| Microsoft Excel 365 | `get_workbooks`, `get_worksheets`, `get_worksheet_rows`, `append_row`, `append_multiple_rows`, `update_row` |
| Microsoft OneDrive | `onedrive_search_items`, `onedrive_list_folder_children`, `onedrive_get_item`, `onedrive_create_folder`, `onedrive_create_text_file`, `onedrive_move_item`, `list_folders` |
| Microsoft SharePoint | `microsoft_sharepoint_find_site`, `microsoft_sharepoint_get_folder_contents`, `microsoft_sharepoint_find_file`, `microsoft_sharepoint_search_list_item`, `microsoft_sharepoint_create_folder`, `microsoft_sharepoint_create_list_item` |
| ServiceNow | `create_record`, `get_record`, `find_record`, `update_record`, `add_comment`, `resolve_incident`, `count_records`, `search_knowledge_articles` |
| DocuSign | `getEnvelope`, `listEnvelopes`, `listTemplates`, `findEnvelopeRecipients` |
| Shippo | `create_order`, `find_order`, `find_shipping_label` |
| Shopify | `get_order`, `search_orders`, `list_order_fulfillment_orders`, `get_fulfillment_order`, `create_fulfillment`, `update_fulfillment_tracking`, `list_locations`, `list_inventory_levels`, `get_inventory_item`, `adjust_inventory_quantities`, `get_product`, `search_products` |
| Onfleet | `create_task`, `get_task`, `get_tasks`, `update_task`, `complete_task`, `get_worker`, `get_teams`, `get_hubs` |

Runner versions come from `package.json` dependencies; allowlist entries derive their versions from that manifest.

```js
import { pieceRunner } from './index.mjs';
import { pieceCatalog } from './catalog.mjs';

const entry = pieceCatalog.entries.find(({ action }) => action === 'sendMessageWithBot');
if (!entry) throw new Error('Action is not allowlisted');

const result = await pieceRunner.invoke({
  piece: entry.piece,
  version: entry.version,
  action: entry.action,
  auth_type: 'API_KEY',
  auth: { apiKey: 'NANGO_CREDENTIAL' },
  allowed_hosts: ['discord.com'],
  props: { channel_id: 'CHANNEL_ID', message: 'Hello' },
  timeout_ms: 30_000,
  memory_mb: 256,
  max_output_bytes: 262_144,
});
```

The result is `{ status: 'completed', output }`, `{ status: 'refused', refusal }` or `{ status: 'failed', error }`. Successful action output is unchanged. Error responses contain only the class, optional HTTP status and message, with every string in `auth` scrubbed. The runner never logs the request or credentials.

`mode` is optional and defaults to `"run"`. Use `"options"` to load a `DROPDOWN` or `MULTI_SELECT_DROPDOWN`, or `"props"` to load a `DYNAMIC` field set. Both loader modes require `property`, the key in the action's own props, and use the same `auth_type`, `auth` and sibling `props` as a run. Missing required props are allowed while loading; supplied File props and undeclared props remain refused. Defaults still apply. Loader modes call only the selected property's loader.

`search_value` is an optional string of at most 200 characters, accepted only in options mode. It reaches the loader as `ctx.searchValue`. Static dropdown choices come from the exported catalog and cannot be loaded. Property admission happens before spawning a worker.

For example, a Teams channel picker uses `mode: "options"`, `property: "channelId"` and `props: { teamId: "TEAM_ID" }` on `microsoft_teams_send_channel_message`. The completed loader responses are:

```js
{ status: 'completed', output: { disabled: false, placeholder: null, options: [{ label: 'General', value: 'CHANNEL_ID' }] } }
{ status: 'completed', output: { props: { column_1: { type: 'SHORT_TEXT', required: false, description: '', display_name: 'Name' } } } }
```

Options retain only `label` and `value`; missing `disabled` and `placeholder` become `false` and `null`. Dynamic fields use the same metadata export as action props. The property context exposes search text; its server, project, flows and connections services refuse access.

| Refusal code | Cause |
| --- | --- |
| `INVALID_MODE` | Mode is not `run`, `options` or `props`. |
| `PROPERTY_NOT_LOADABLE` | Property is missing for a loader, supplied in run mode, undeclared, excluded, or lacks the requested loader type and function. |
| `INVALID_SEARCH_VALUE` | Search text is not a string, exceeds 200 characters, or is supplied outside options mode. |
| `AUTH_TYPE_MISMATCH` | The allowlist does not select exactly one declaration, or the invocation auth kind differs from it. |
| `INVALID_AUTH` | Credential fields do not match the piece's auth declaration. |
| `ALLOWED_HOSTS_REQUIRED` | A typed credential lacks a valid `allowed_hosts` list. |
| `EGRESS_HOST_REFUSED` | A typed credential attempts an unlisted host, a non-public address, or an IP-literal connection. |

Auth input is selected exclusively by `auth_type`: `API_KEY` or `SECRET_TEXT` accepts `{ apiKey }` or `{ secret_text }` and builds `SECRET_TEXT`; `BASIC` accepts `{ username, password }` and builds `BASIC_AUTH`; `CUSTOM_AUTH` accepts `{ props: { ... } }` using the piece's declared auth fields. Every required CustomAuth field must be present, unknown keys are refused, ShortText and SecretText values must be non-empty strings of at most 4096 characters, and StaticDropdown values must match a declared option. An unadmitted auth kind returns `AUTH_TYPE_MISMATCH`; malformed credentials return `INVALID_AUTH`. Slack and the Google pieces admit OAuth2. Action props still refuse unknown names, missing required values and supplied File props.

Every `API_KEY`, `SECRET_TEXT`, `BASIC` and `CUSTOM_AUTH` invocation, including property loaders, requires `allowed_hosts`: 1-10 lowercase DNS names saved with the credential, without IP literals or wildcards. Missing or invalid lists return `ALLOWED_HOSTS_REQUIRED` before piece code loads. The fresh worker guards outbound hostname lookups and socket connections for its lifetime, refuses hosts outside that list and resolved non-public addresses, and refuses IP-literal connections with `EGRESS_HOST_REFUSED`. ServiceNow needs its instance hostname; DocuSign needs its OAuth and API hostnames; Shippo needs `api.goshippo.com`.

`OAUTH2` retains `{ access_token, raw }` or `{ access_token, data }`, with `raw` taking precedence and becoming AP's `data`. When the piece declares OAuth2 auth props, supply `auth.props`; the runner validates them with the same required-field, unknown-key, type and static-choice checks as CustomAuth and passes a copy to the piece. QuickBooks Online and QuickBooks Online Sandbox require `auth.props.companyId`. Pieces without OAuth2 auth props accept an absent or empty `auth.props` and retain `{ type, access_token, data }`. Auth prop strings are redacted from failures. OAuth calls require no host list and retain their existing egress behavior. `apiKey` takes precedence over `secret_text` when both are supplied.

An allowlist entry's `authType` selects exactly one declared auth kind. Multi-auth pieces require that selection; missing, unknown or duplicate declarations refuse at load. The export's `auth_kinds` retains all declared kinds for compatibility, while `auth` and invocations use only the admitted declaration.

Shopify admits its Dev Dashboard app `OAUTH2` auth and requires `auth.props.shopName`, the shop name before `.myshopify.com`, with the supplied `access_token`. Onfleet declares `SECRET_TEXT`; invoke it with `auth_type: "SECRET_TEXT"` or the existing `"API_KEY"` alias, `auth: { apiKey }` or `auth: { secret_text }`, and `allowed_hosts: ["onfleet.com"]`.

The finance catalog admits 11 actions each for QuickBooks Online and QuickBooks Online Sandbox and 13 for Xero. Xero takes its organization through the action's loadable `tenant_id` prop.

Microsoft 365 actions accept `OAUTH2` and use `https://graph.microsoft.com`; Outlook defaults to the connected user's `/me` mailbox. Outlook email attachments remain unavailable because supplied File props are refused.

Each allowed invocation starts a fresh child with an empty environment. Defaults and hard ceilings are:

| Field | Default | Hard ceiling |
| --- | ---: | ---: |
| `timeout_ms` | 30,000 for run; 15,000 for options/props | 60,000 |
| `memory_mb` | 256 | 512 |
| `max_output_bytes` | 262,144 | 1,048,576 |

An entry may set `memoryMb` (64-512) as the default memory limit for its calls; others default to 256 MiB. Give an entry 512 when its piece holds more than 200 MB resident right after `require`; no entry sets it today. Earlier bundled piece measurements held 60-67 MB; the Microsoft pieces still need resident-memory measurements. A request's own `memory_mb` replaces the default and is validated the same way, so requests above 512 MiB are still refused.

Limits must be integers; timeout and output limits must be positive, and memory must be at least 64 MiB. Memory enforcement combines a V8 heap limit with a Linux RSS monitor. The serialized request is capped at 1 MiB; the output limit counts serialized response bytes. Expiry kills the child and returns `TIMEOUT`. Invalid limits, excessive memory and excessive output return named refusals. Store, files, server, pause, connections, agent and flows services throw `CONTEXT_SERVICE_UNAVAILABLE` when used.

Install exact locked npm packages during a build, with scripts disabled. No runtime installation occurs. From this directory:

```sh
npm ci --ignore-scripts
node check-versions.mjs
node --test test/update-pieces.contract.test.mjs
node --test test/invoke.contract.test.mjs
node --test test/export-actions.contract.test.mjs
node export-actions.mjs actions.json
```

The version check compares the lock and installed pieces with the fork's piece manifests using each entry's explicit `forkDirectory`. Pieces retain their own nested (older versions) or bundled (newer versions) framework, common and shared code, so the runner's root framework, common and shared pins are not compared with the fork. Export reads metadata from installed piece code, including props, required flags, descriptions, declared auth kinds and versions. Exported action IDs use deterministic snake case (`sendMessageWithBot` → `send_message_with_bot`). Each prop includes `display_name` and a `default` when its value survives JSON serialization unchanged. Static dropdowns include ordered `options` with their original value types. Loaded dropdowns and dynamic fields include `refreshers` (default `[]`); loaded dropdowns also include `refresh_on_search` (default `false`). Nested `properties` use the same export. Placeholders, disabled states and loader code are not exported.

Each exported action retains `auth_kinds` and adds `auth: { kind, props }` describing its admitted auth declaration. CustomAuth and declared OAuth2 fields use the same metadata export as action props; auth kinds without declared fields have empty `props`. Types are the declared types: ServiceNow's `password` remains `SHORT_TEXT`, while DocuSign's `privateKey` is `SECRET_TEXT`.

## Updating pieces

From the repository root:

```sh
node runtime/piece-runner/update-pieces.mjs outdated
node runtime/piece-runner/update-pieces.mjs refresh --upstream <commit>
```

`outdated` reports each runner piece's runner pin, fork version, npm latest and whether npm is newer. Add `--json` for machine-readable output. It changes no files.

In a sparse checkout, `runtime` and `catalog` must be on the sparse list (`git sparse-checkout add runtime catalog`); otherwise the merge removes them from disk and re-pinning stops. `refresh` requires an empty Git index and no unmerged paths, fetches `upstream/main`, and accepts only a commit on that branch that HEAD does not already contain. It merges with `--no-ff`; conflicts stop immediately and remain for the owner to resolve. It then re-pins each runner piece to its fork version, rewrites the lock, updates pilot provenance, and regenerates and checks pilot and directory artifacts. A Linux Node 22 Docker check installs locked packages, verifies versions, runs contract tests and replaces the runner action export. Docker honors `DOCKER_HOST`.

Review the printed per-action version, added or removed props, prop type/required flags and auth-kind changes before committing the generated updates. A missing allowlisted action stops the refresh and names the piece and action to resolve. Only Git's merge creates a commit; the remaining updates stay uncommitted. The command prints Git status and downstream sync commands for the owner to run after review; it does not run those cross-repository syncs.

Build the Lambda container from the repository root:

```sh
docker build -f runtime/piece-runner/Dockerfile -t rcm-piece-runner .
```

The AWS Node 22 base invokes `runtime/piece-runner/lambda.handler`. The image contains installed production dependencies and fork manifests for the version check. After that check the image drops npm, corepack and the base image's bundled AWS SDK, which the runner never loads, so their dependency trees do not ship. `Dockerfile.dockerignore` limits the repository build context to runner source, its lock and those manifests. AWS deployment, IAM and non-VPC Lambda configuration are owner steps. There is no Activepieces API, worker, queue or server.
