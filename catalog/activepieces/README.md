# Activepieces Catalog Pilot

This directory contains catalog-only extraction for a pilot set of Activepieces
pieces. The generated files are candidate source data for downstream connector
mapping; they do not enable or imply Activepieces runtime execution.

Upstream refresh: [piece runner](../../runtime/piece-runner/README.md#build-and-check).

## Commands

```bash
node catalog/activepieces/extract-pilot-metadata.mjs generate
node catalog/activepieces/extract-pilot-metadata.mjs check
node catalog/activepieces/extract-pilot-metadata.mjs validate
node catalog/activepieces/sync-provider-map-to-frontend.mjs
node catalog/activepieces/generate-piece-directory.mjs generate
node catalog/activepieces/generate-piece-directory.mjs check
node catalog/activepieces/generate-piece-directory.mjs sync-frontend
```

`generate` reads the fork's `packages/pieces/community` and writes deterministic JSON
under `catalog/activepieces/generated` (pilot pieces, trigger candidates, piece
directory); `check` fails on stale artifacts; `validate` checks them without runtime
code. The sync commands also write basekey-frontend's generated read models
(`src/generated/activepieces-nango-provider-map/`, `src/generated/activepieces-piece-directory/`);
pass `--frontend-root` or `BASEKEY_FRONTEND_ROOT` for a non-sibling checkout.

Tree landing regenerates each of these outputs with its sources, here and in
basekey-frontend, through the rows in swarm-engine-private
`bin/regen_generated.json`.

## Runtime Placement

RCM runs allowlisted piece actions in the piece runner (`runtime/piece-runner`),
invoked only by the orchestrator's connector runtime with a Nango credential.
There is still no Activepieces API, worker, queue or server. Nango remains the
connection owner.

For triggers, the generated `trigger_candidates.json` file is provenance only.
Executable triggers must be promoted into the orchestrator-owned
`rcm_orchestrator/contracts/connector_trigger_catalog.py` with an RCM trigger ID
such as `slack.channels.created`. Nango then forwards provider webhooks to the
orchestrator Nango webhook endpoint; the Activepieces fork is not called during
runtime delivery.

## Ownership

Each script is the only writer of its outputs: `extract-pilot-metadata.mjs` writes
`generated/pilot` and pins the upstream commit; `sync-provider-map-to-frontend.mjs`
writes `generated/provider-map` and the frontend provider map;
`generate-piece-directory.mjs` writes `generated/directory` and the frontend piece
directory. Generated records stay `candidate_only` and never execute; only RCM
catalogs promote an action or trigger to runtime.
