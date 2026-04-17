# DEV.md - shelljs-virtual development notes

## Stack

- Runtime and package manager: `bun`
- Language: TypeScript
- Test runner: `bun test`
- Build output: `dist/`

## Repo layout

- `src/index.ts` - package entrypoint exports
- `src/shell.ts` - core command implementation
- `src/common.ts` - shared text/fs helpers
- `src/utils/*` - path, glob, and pipe utilities
- `src/commands/*` - thin wrappers around `Shell` methods
- `tests/*` - focused behavior and integration coverage
- `scripts/build.ts` - Bun build + declaration copy
- `scripts/lint.ts` - repo-specific guardrails
- `artifacts/specs/*` - implementation specs and check contracts

## Commands

- `bun run lint`
- `bun run check`
- `bun test`
- `bun run build`
- `bun run verify`

## Development standards

### Filesystem boundary

Production code must stay virtual-FS-only.
If a change needs host filesystem access, it belongs in tooling or tests, not in `src/**`.

### Behavior changes

If command behavior changes:
- add or update focused tests
- update README when the change is user-visible
- prefer deterministic output and explicit failure semantics

### Newline and text behavior

The repo now intentionally distinguishes between:
- read/stream outputs, which can normalize to LF
- exact edits, which should preserve file newline style when rewriting an existing file

If you change that behavior, update tests first.

### Specs

`SPEC.md` is useful background, but active execution should usually key off the current artifact specs in `artifacts/specs/`.
