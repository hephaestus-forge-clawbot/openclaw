# Config Builder (WIP)

This workspace package will host the standalone OpenClaw config builder app.

## Stack

Use the same front-end stack as the existing OpenClaw web UI (`ui/`):

- Vite
- Lit
- Plain CSS (no Next.js/Tailwind)

## Current status

Phase 0, Phase 1, and Phase 2 are in place:

- app boots with Vite + Lit
- `OpenClawSchema.toJSONSchema()` runs in browser bundle
- `buildConfigSchema()` UI hints load in browser bundle
- Explorer scaffold renders grouped sections + field metadata
- Primitive field editing writes sparse config state by dot-path
- Draft state persists to localStorage
- Live JSON5 preview supports copy/download/reset

To run locally:

```bash
pnpm --filter @openclaw/config-builder dev
```

## Notes

Implementation details are tracked in `.local/config-builder-spec.md`.

For the spike, Vite aliases lightweight browser shims for:

- `src/version.ts`
- `src/channels/registry.ts`

This keeps schema imports browser-safe while preserving the existing Node runtime modules.
