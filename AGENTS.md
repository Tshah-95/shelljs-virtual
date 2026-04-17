# AGENTS.md - shelljs-virtual

This repo is a Bun-first virtual shell for coding agents.

## Mission

Keep `shelljs-virtual` in the sweet spot between:
- ShellJS familiarity
- deterministic agent-oriented behavior
- clean virtual-filesystem boundaries

The public bar is not just shell parity. The repo should optimize for trustworthy agent workflows: inspect, search, edit, diff, patch, and verify without guessing.

## Canonical docs

Read in this order:

1. `README.md` - public API and current behavior contract
2. `DEV.md` - local development workflow and repo layout
3. `artifacts/specs/*.md` - active implementation specs and check contracts
4. `SPEC.md` - historical origin doc, useful for context but not the final source of truth

If docs disagree:
- current code + tests win over old planning text
- `README.md` wins over `SPEC.md` for user-facing behavior
- newer artifact specs win over older ones when they explicitly supersede behavior

## Repo rules

- **Use bun. Always.** Do not introduce npm, yarn, or pnpm flows.
- **Do not import the real filesystem in production code.** `src/**` must stay on the injected `VirtualFS` boundary.
- **Keep command behavior deterministic.** Stable ordering matters for agent trust.
- **Prefer explicit failures over guessing.** Ambiguity should fail loudly.
- **Keep the API sync-only unless explicitly directed otherwise.**
- **When behavior changes, update tests and README together.**
- **Treat `dist/` as generated output.** Do not hand-edit it.

## Working guidance

- Most behavior lives in `src/shell.ts` with shared helpers in `src/common.ts` and `src/utils/*`.
- `src/commands/*` are thin command wrappers around the `Shell` methods.
- Focused tests belong in `tests/*` next to the behavior slice they pin.
- New agent-facing behavior should usually ship with:
  - a focused test
  - an integration or workflow proof when composition matters
  - a README contract update if the behavior is user-visible

## Before finishing a change

Run the relevant subset first, then the full health pass when the slice is done:

- `bun run lint`
- `bun run check`
- `bun test`
- `bun run build`
- `bun run verify`
