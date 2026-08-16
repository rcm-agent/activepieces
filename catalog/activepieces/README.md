# Activepieces Catalog Pilot

This directory contains catalog-only extraction for a pilot set of Activepieces
pieces. The generated files are candidate source data for downstream connector
mapping; they do not enable or imply Activepieces runtime execution.

## Commands

```bash
node catalog/activepieces/extract-pilot-metadata.mjs generate
node catalog/activepieces/extract-pilot-metadata.mjs check
node catalog/activepieces/extract-pilot-metadata.mjs validate
node catalog/activepieces/sync-to-orchestrator.mjs
node catalog/activepieces/sync-provider-map-to-frontend.mjs
```

`generate` reads the forked Activepieces source under `packages/pieces/community`
and writes deterministic JSON artifacts under `catalog/activepieces/generated`.
`check` regenerates in memory and fails if the checked-in artifacts are stale.
`validate` verifies the checked-in artifacts without reading runtime code.
Trigger candidates are emitted as first-class source-only records in
`catalog/activepieces/generated/pilot/trigger_candidates.json`, with stable
candidate IDs, piece slug, trigger name, display name, source path, trigger
strategy/family, provider candidates, and `candidate_only` runtime status.
`sync-to-orchestrator` runs `generate` + `check`, then copies the generated
pilot JSON directory into the sibling `rcm-orchestrator` checkout. Use
`--orchestrator-root /path/to/rcm-orchestrator` or `RCM_ORCHESTRATOR_ROOT` when
the checkout is not a sibling directory.
`sync-provider-map-to-frontend` reads the generated pilot artifacts, writes
`catalog/activepieces/generated/provider-map/nango_provider_config_map.json`, and
replaces the frontend generated TypeScript read model at
`basekey-frontend/src/generated/activepieces-nango-provider-map/index.ts`. Use
`--frontend-root /path/to/basekey-frontend` or `BASEKEY_FRONTEND_ROOT` when the checkout
is not a sibling directory.

## Runtime Placement

The fork is source-only. The orchestrator consumes copied JSON artifacts from
`rcm_orchestrator/connectors/catalog/generated/activepieces/pilot`; it does not
run Activepieces workers, queues, APIs, or containers. Nango remains the
connection owner, and RCM-owned connector services decide which generated
catalog candidates are promoted to executable functions.

For triggers, the generated `trigger_candidates.json` file is provenance only.
Executable triggers must be promoted into the orchestrator-owned
`rcm_orchestrator/contracts/connector_trigger_catalog.py` with an RCM trigger ID
such as `slack.channels.created`. Nango then forwards provider webhooks to the
orchestrator Nango webhook endpoint; the Activepieces fork is not called during
runtime delivery.

## Ownership

- Canonical path and owner: `catalog/activepieces/extract-pilot-metadata.mjs`.
- Authoritative writer: the extractor is the only writer for
  `catalog/activepieces/generated/pilot`.
- Upstream provenance owner: the extractor pins the upstream repository and
  commit represented by the pilot source. The pin changes only when that source
  snapshot is deliberately refreshed, after which the extractor regenerates
  every artifact; catalog-only commits do not change it.
- Distribution writer: `catalog/activepieces/sync-to-orchestrator.mjs` is the
  only writer for the generated Activepieces pilot directory copied into
  `rcm-orchestrator`.
- Provider-map distribution writer:
  `catalog/activepieces/sync-provider-map-to-frontend.mjs` is the only writer
  for `catalog/activepieces/generated/provider-map` and the frontend generated
  read model.
- Current input hops: local filesystem reads of piece `package.json`,
  `src/index.ts`, auth modules, and referenced action/trigger source files.
- Runtime status: every generated piece artifact must carry
  `runtime_status: "candidate_only"` and `runtime_execution.supported: false`.
- Trigger candidate status: every generated trigger candidate must carry
  `runtime_status: "candidate_only"`, `runtime_execution.supported: false`, and
  a non-package candidate ID. Raw `@activepieces/piece-*` package IDs are source
  provenance only and are rejected as trigger candidate IDs.
- Runtime promotion boundary: RCM catalogs are the only executable catalog
  writers. Generated Activepieces records can justify a promotion, but they do
  not execute actions/triggers by themselves.
