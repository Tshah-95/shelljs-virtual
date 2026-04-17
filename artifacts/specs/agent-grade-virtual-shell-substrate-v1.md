# Agent-Grade Shell Primitives V1

Status: Proposed
Date: 2026-04-16
Repo: `/Users/tejas/Github/shelljs-virtual`

## Brain / survey breadcrumbs

📖 No repo-local `AGENTS.md` found in this repo.

Using workspace brain plus:
- `README.md`
- `SPEC.md`
- `package.json`
- `src/shell.ts`
- `src/types.ts`
- `src/utils/pipe.ts`
- `src/common.ts`
- `tests/helpers.ts`
- `tests/phase1.test.ts`
- `tests/phase2.test.ts`
- `tests/phase3.test.ts`
- `tests/phase45.test.ts`
- `tests/integration.test.ts`

## Orientation

`shelljs-virtual` already has a good base shell:
- injected `VirtualFS`
- virtual `cwd`
- sync ShellJS-style command surface
- piping via `ShellString` and `ShellArrayResult`
- existing commands for search, read, edit, file ops, and simple review

The problem is not “we need a higher-level agent framework.”

The problem is that the shell itself is still missing the primitives that make coding agents trustworthy and efficient:
- precise patch application
- exact-match editing that fails loudly on ambiguity
- better diff and changed-file review
- line-precise reading
- stronger search/path filtering
- clearer failure semantics across all mutating operations

That is the actual scope of V1.

## Non-goals

Out of scope for this spec:
- feedback loops
- diagnostics systems
- plan UIs
- policy/session/orchestration layers
- LLM/provider coupling
- AST-aware language tooling
- real process execution / `exec()`

Those can come later. This spec is about building the best shell.

## Current shell gaps

Based on the current implementation:

### 1. No patch-apply primitive
There is no way to apply unified diff text back onto the virtual fs.

### 2. Edit primitives are too brittle
- `sed` is flexible but too loose for safe agent edits
- `splice` is line-number based, which is useful, but fragile after unrelated edits

### 3. `diff()` is too shallow
Current `diff()`:
- takes exactly two file paths
- emits one coarse unified block from the top of the file
- does not support tree diff, name-only diff, diff stat, or context control

### 4. Read primitives are too coarse
There is no first-class way to ask for exact line ranges or match-centered excerpts.

### 5. Search primitives are not quite agent-grade yet
`grep` and `find` are already useful, but they still lack stronger ignore/hidden/path-selection behavior.

### 6. Failure semantics need tightening
For agent use, ambiguity and partial application must fail loudly and predictably.

## Design principles

1. **Shell-first, not framework-first**
   - New value should land as commands or command-adjacent helpers, not a parallel abstraction stack.

2. **Precise edits beat clever edits**
   - Mutating commands should default to exact-match behavior and explicit failure on ambiguity.

3. **Dry-run wherever mutation is non-trivial**
   - Patch apply and exact-edit commands should preview without mutation.

4. **Text output remains the product**
   - Internal helpers can be structured, but the public surface should remain command-oriented and shell-usable.

5. **Failure must be informative**
   - Exit codes and stderr must tell the agent exactly what failed: not found, ambiguous match, hunk mismatch, invalid range, binary file, etc.

6. **Backward compatibility where reasonable**
   - Do not break working `Shell` patterns just to make the API cleaner.

## Recommended command roadmap

### Priority 1: `patch()` / `applyPatch()`

This is the biggest missing primitive.

#### Goal
Apply unified diff text against one or many files in the virtual filesystem.

#### Required capabilities
- accept patch text as string input and piped stdin
- support multi-file unified diffs
- dry-run mode
- check-only mode
- reverse apply mode
- strict hunk matching by default
- exact reporting of which files and hunks applied
- clean failure when a hunk cannot be applied

#### Suggested command shape

```ts
sh.patch(patchText)
sh.patch('--dry-run', patchText)
sh.patch('--check', patchText)
sh.patch('--reverse', patchText)
sh.cat('/tmp/change.patch').patch('--dry-run')
```

The exact flag names can still be tuned, but the semantics matter more than the spelling.

#### Edge cases
- new file creation from `/dev/null`
- file deletion to `/dev/null`
- file with no trailing newline
- multiple hunks in one file
- multiple files in one patch
- repeated context lines that make naive matching ambiguous
- patch against empty file
- patch against large file
- CRLF vs LF content
- patch touching binary-looking file

#### Common failure modes
- hunk context mismatch after file drift
- target file missing
- patch references wrong path
- malformed hunk header
- reverse patch applied in forward mode
- same hunk applies twice because idempotence was not checked
- partial multi-file apply with one later failure

#### Required failure behavior
- no silent fuzzy success
- no partial apply unless explicitly allowed, and V1 should default to all-or-fail behavior
- return clear stderr naming file + hunk that failed

---

### Priority 2: exact edit primitives

Agents need safer edit tools than raw `sed` and raw line-number `splice`.

#### New command: `replace()`

#### Goal
Replace exact text or regex matches in a way that is self-checking.

#### Required capabilities
- exact string replacement
- optional regex replacement
- expected match count control
- default behavior: fail unless exactly one match is found
- explicit `--all` mode if replacing many matches is intended
- dry-run mode
- file and piped-input modes

#### Suggested command shape

```ts
sh.replace('/project/src/index.ts', 'hello', 'greet')
sh.replace('--all', '/project/src/index.ts', 'foo', 'bar')
sh.replace('--regex', '/project/src/index.ts', 'from "./old"', 'from "./new"')
sh.replace('--dry-run', '/project/src/index.ts', 'hello', 'greet')
```

#### New command: `insert()`

#### Goal
Insert text relative to stable anchors rather than line numbers.

#### Required capabilities
- insert before exact anchor
- insert after exact anchor
- insert at start or end of file
- default behavior: fail unless exactly one anchor match is found
- dry-run mode

#### Suggested command shape

```ts
sh.insert('--after', '/project/src/index.ts', 'import { foo } from "./foo";', 'import { bar } from "./bar";')
sh.insert('--before', '/project/src/index.ts', 'export default app;', 'const ready = true;')
sh.insert('--at-start', '/project/src/index.ts', '// generated\n')
sh.insert('--at-end', '/project/src/index.ts', '\nexport { ready };\n')
```

#### Existing command to keep: `splice()`
`splice()` is still useful, but it should be positioned as the right tool when the agent really does know line numbers and wants exact line-based surgery.

#### Edge cases
- zero matches
- multiple matches
- overlapping replacements
- replacement introduces same anchor again
- insert into empty file
- insert before first line / after last line
- unicode text
- CRLF input normalization
- very large file with repeated anchors

#### Common failure modes
- agent thinks a snippet is unique but it appears twice
- replace-all used accidentally instead of one exact replacement
- anchor exists in comments and code, causing ambiguity
- regex replacement matches too broadly
- dry-run output differs from actual write behavior

#### Required failure behavior
- exact-match mode should fail on 0 or >1 matches
- stderr must report match count and target file
- dry-run and live apply must share the same matching logic

---

### Priority 3: real diff and changed-file review

Current `diff()` is not enough.

#### Goal
Make review strong enough that an agent can understand what changed without reading entire files.

#### Required capabilities
- file-to-file diff
- directory-to-directory diff
- name-only mode
- stat mode
- configurable unified context like `-U 3`
- multiple hunks per file
- clear exit codes: identical / different / error
- stable ordering for multi-file diff output

#### Suggested command shape

```ts
sh.diff('left.ts', 'right.ts')
sh.diff('-U', '5', 'left.ts', 'right.ts')
sh.diff('--name-only', '/before', '/after')
sh.diff('--stat', '/before', '/after')
```

#### Edge cases
- added file
- deleted file
- renamed-but-not-detected file pair (V1 can treat as delete+add)
- binary-looking files
- empty files
- very small files with zero context lines
- files with repeated identical blocks producing multiple hunks
- no trailing newline markers

#### Common failure modes
- entire file emitted as one hunk when only one small region changed
- path ordering unstable across runs
- diff stat inconsistent with actual hunks
- tree diff quietly skips files
- file vs directory mismatch not reported clearly

#### Required failure behavior
- diff over missing paths should error explicitly
- tree diff modes should name skipped/binary files instead of silently misrendering them

---

### Priority 4: line-precise read primitives

Agents need a better “show me exactly this part” command.

#### New command: `show()`

#### Goal
Read exact line ranges and match-centered excerpts from files.

#### Required capabilities
- line range selection: start/end inclusive
- numbered output
- optional context around a given line or pattern
- multiple non-contiguous ranges in one output if needed later, but V1 can start with one range
- preserve raw file text as much as possible

#### Suggested command shape

```ts
sh.show('/project/src/index.ts', 20, 60)
sh.show('--numbers', '/project/src/index.ts', 20, 60)
sh.show('--around-line', '120', '--context', '5', '/project/src/index.ts')
sh.show('--around-match', 'export function hello', '--context', '3', '/project/src/index.ts')
```

#### Edge cases
- start before line 1
- end past EOF
- empty file
- one-line file
- file with long lines
- unicode content
- file without trailing newline
- match occurs more than once

#### Common failure modes
- off-by-one line numbering
- context window clips wrong side of range
- numbered output misaligns on long files
- match-centered read chooses wrong occurrence

#### Required failure behavior
- invalid range should error clearly
- ambiguous `around-match` should fail unless an occurrence selector exists

---

### Priority 5: better search/path selection

`grep` and `find` are close, but need hardening for agent use.

#### Goal
Move search behavior closer to the ergonomics agents expect from `rg` + `fd`.

#### Required capabilities
- explicit include-hidden behavior
- explicit ignore/exclude behavior
- path-only output modes where useful
- max-results / stop-early controls
- consistent recursive handling
- better interaction between path globs and recursive search

#### Suggested extensions
- `grep --hidden`
- `grep --max-count-total=N` or similar stop-early support
- `find --hidden`
- `find --exclude=GLOB`

#### Edge cases
- hidden files and directories
- nested exclude patterns
- deep trees
- many thousands of files
- symlink loops if supported later
- binary-looking content in recursive search

#### Common failure modes
- hidden directories unexpectedly skipped or included
- exclude pattern only applied to filenames, not paths
- stop-early returns inconsistent exit status
- recursive search duplicates matches

#### Required failure behavior
- output and exit code should stay deterministic when limits are hit
- recursive traversal should not loop forever if symlink handling expands later

---

### Priority 6: failure semantics sweep across the shell

This is cross-cutting and should land as hardening, not as a new command.

#### Goal
Make command behavior predictable enough for agent automation.

#### Required behaviors
- mutating commands should clearly distinguish success, no-op, and failure
- ambiguous match operations should fail by default
- missing-path behavior should be consistent across commands
- binary file handling should be explicit
- stderr should be short but actionable
- pipe chains should preserve failure status when downstream commands receive empty or failed input

#### Edge cases
- chained commands after failure
- dry-run vs live mutation parity
- commands receiving piped stdin plus file args
- empty stdout with success vs empty stdout with failure

#### Common failure modes
- code `0` with silent no-op mutation
- command writes partially before discovering later ambiguity
- piped failure becomes success because stdout is empty
- inconsistent error strings across commands for the same class of problem

## Implementation plan

### Step 1: add patch apply with strict semantics

Files likely touched:
- `src/shell.ts`
- `src/common.ts`
- `src/types.ts`
- new helper module if needed, likely `src/utils/patch.ts`
- new tests, likely `tests/patch.test.ts`

What changes:
- implement unified diff parsing
- implement strict hunk matching and application
- support dry-run, check-only, reverse
- make all-or-fail the default for multi-file patches

How to verify:
- `bun test tests/patch.test.ts`
- `bun run build`
- `bun run lint`

### Step 2: add `replace()` and `insert()` exact edit commands

Files likely touched:
- `src/shell.ts`
- `src/types.ts`
- maybe `src/common.ts`
- new tests, likely `tests/edit-primitives.test.ts`

What changes:
- implement exact-match replace command
- implement anchor-based insert command
- share matching logic between dry-run and live apply
- preserve `splice()` as line-based surgery, not as the only precise edit tool

How to verify:
- `bun test tests/edit-primitives.test.ts`
- `bun run build`
- `bun run lint`

### Step 3: upgrade `diff()` for real review workflows

Files likely touched:
- `src/shell.ts`
- possibly new diff helper module
- new tests, likely `tests/diff-review.test.ts`
- existing `tests/phase45.test.ts`

What changes:
- add tree diff modes
- add `--name-only`, `--stat`, `-U`
- emit multiple hunks correctly
- keep simple file diff usage backward compatible

How to verify:
- `bun test tests/diff-review.test.ts tests/phase45.test.ts`
- `bun run build`

### Step 4: add `show()` line-range read command

Files likely touched:
- `src/shell.ts`
- `src/types.ts` if option shapes are needed
- new tests, likely `tests/show.test.ts`

What changes:
- implement line-range reads
- implement numbered output
- implement match-centered excerpt mode if it fits cleanly in V1, otherwise land line ranges first and leave pattern-centered excerpts for the next slice

How to verify:
- `bun test tests/show.test.ts`
- `bun run build`

### Step 5: harden search and path filtering

Files likely touched:
- `src/shell.ts`
- maybe `src/utils/glob.ts`
- existing grep/find tests plus new search-hardening tests

What changes:
- add hidden/exclude/limit behavior
- tighten recursive traversal behavior
- improve deterministic search results under limits and excludes

How to verify:
- `bun test tests/phase3.test.ts tests/search-hardening.test.ts`
- `bun run build`

### Step 6: do a shell-wide failure-semantics pass

Files likely touched:
- `src/shell.ts`
- tests across all phases
- `README.md`

What changes:
- normalize stderr and exit code behavior
- ensure dry-run/live parity on all complex mutators
- document exact semantics for ambiguous matches, patch failures, binary handling, and no-op cases

How to verify:
- `bun test`
- `bun run build`
- `bun run lint`

## Decomposition and composition points

This spec is deliberately decomposed into shell primitives that can be tested in isolation.

### Isolated units
- patch parser + patch applier
- exact replace matcher
- anchor-based insert matcher
- diff hunk generator
- line-range reader
- search/filter behavior
- shared error/exit-code helpers

### Composition points
- `patch()` composes parser + matcher + writer
- `replace()` composes exact matcher + writer
- `insert()` composes anchor matcher + writer
- `diff()` composes file walker + hunk formatter
- integration workflows compose `grep` + `show` + `replace`/`insert` + `diff`

## Testing strategy

### Unit tests first
Each new primitive should get its own focused test file.

### Integration tests second
Add realistic agent workflows only after the primitives are trusted.

Suggested integration scenarios:
- find symbol → show context → replace exact snippet → diff review
- generate patch → dry-run patch → apply patch → diff shows no remaining change
- grep for importers → insert import after anchor → replace symbol → diff tree review

### Edge-case matrix
At minimum, test all new primitives against:
- empty files
- empty directories
- no trailing newline
- CRLF input
- unicode and emoji
- long lines
- repeated identical snippets
- hidden files
- large directory trees
- binary-looking content
- nonexistent paths
- file/directory type mismatches

### Common failure-mode matrix
At minimum, assert robust behavior for:
- ambiguous exact match
- zero exact matches
- malformed patch
- hunk drift after unrelated edits
- multi-file patch with one failing target
- invalid line ranges
- dry-run/live mismatch
- path resolution surprises from relative cwd
- pipe chains preserving failure status

## Risk flags

1. Patch application is easy to get subtly wrong, especially around repeated context lines and no-trailing-newline cases.
2. Exact-edit commands can drift into “mini templating language” territory if flags multiply too fast.
3. Tree diff can become noisy unless output modes stay disciplined.
4. Search hardening can accidentally break current grep ergonomics if hidden/exclude defaults change carelessly.
5. Error normalization can cause regressions if old tests do not pin behavior tightly enough.

## Check Contract

### Functional verification
- [ ] `patch()` can dry-run and apply unified diffs against one or many files in virtual fs
- [ ] `patch()` fails cleanly on malformed patches and hunk mismatch
- [ ] `replace()` defaults to exact single-match semantics and can optionally replace all matches
- [ ] `insert()` can insert before/after anchors and at file boundaries
- [ ] `diff()` supports both file and directory comparisons with usable multi-hunk output
- [ ] `diff --name-only` and `diff --stat` work for tree comparisons
- [ ] `show()` can print exact line ranges with stable numbering
- [ ] search primitives support hidden/exclude/limit behavior without unstable output

### Edge cases
- [ ] empty files and no-trailing-newline files behave correctly across patch, replace, diff, and show
- [ ] CRLF content is handled intentionally rather than accidentally
- [ ] unicode paths and unicode content survive edits and diffs
- [ ] binary-looking files fail or skip explicitly, not silently corrupt
- [ ] repeated anchors/snippets trigger ambiguity failures in exact-edit commands
- [ ] multi-file patch apply is all-or-fail by default

### Failure modes
- [ ] patch hunk mismatch identifies file and failed hunk clearly
- [ ] ambiguous replace/insert reports match count and target file
- [ ] invalid line ranges report clear errors
- [ ] dry-run and live apply share the same matching behavior
- [ ] pipe chains preserve non-zero exit status after upstream failure

### Integration points
- [ ] existing phase tests still pass unless intentionally updated for improved semantics
- [ ] realistic agent workflow tests pass using only shell commands and piping
- [ ] `README.md` documents the new commands and exact failure semantics

### Quality gates
- [ ] `bun test` passes
- [ ] `bun run build` passes
- [ ] `bun run lint` passes
- [ ] command behavior is deterministic across repeated runs on the same virtual tree

## Definition of done

This slice is done when `shelljs-virtual` can credibly serve as a strong coding-agent shell by providing:
- strict patch application
- exact-match text replacement
- anchor-based insertion
- strong diff and changed-file review
- line-precise reading
- hardened search/path filtering
- failure semantics that are safe enough to automate against

No fake framework needed.
This should feel like a better shell, not a new product layer.
