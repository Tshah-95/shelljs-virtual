# Tight-pin edge fidelity v1

## Orient

### Repo brain
- `AGENTS.md` at repo root: missing
- Using the closest available repo guidance instead:
  - `SPEC.md`
  - `README.md`
  - `artifacts/specs/agent-grade-virtual-shell-substrate-v1.md`
  - existing focused tests in `tests/`

### Breadcrumbs
📖 `AGENTS.md` (missing) → `SPEC.md` → `README.md` → `artifacts/specs/agent-grade-virtual-shell-substrate-v1.md` → `tests/patch.test.ts` → `tests/show.test.ts` → `tests/edit-primitives.test.ts` → `tests/diff-review.test.ts` → `tests/integration.test.ts` → `src/common.ts` → `src/shell.ts`

## What is not tightly pinned today

These are the remaining weak spots after the failure-semantics sweep:

1. **CRLF semantics are not intentional enough yet**
   - `show()`, `sed()`, `splice()`, `head()`, `tail()`, `sort()`, and `uniq()` normalize to `\n`
   - `replace()` and `insert()` currently operate on raw source text, so LF anchors/search strings will not reliably match CRLF files
   - `diff()` renders CRLF hunks, but that behavior is not pinned

2. **No-final-newline behavior is still mostly inferred, not asserted**
   - patch apply/reverse on files without trailing newline
   - diff rendering with `\ No newline at end of file`
   - exact edits on files without trailing newline
   - show behavior on newline-poor or empty files

3. **Unicode is only lightly covered where it matters most**
   - current integration coverage proves grep/find/cat survive unicode
   - it does not pin edit + diff workflows on unicode content and unicode paths

4. **Patch coverage is strong on failure, weaker on successful composition**
   - multi-file patch failure is pinned
   - multi-file patch success is not pinned separately
   - relative-cwd patch path behavior is not pinned

5. **A few agent-facing review behaviors are still implicit**
   - binary `diff()` rendering is not pinned
   - empty-file behavior across patch/diff/show is not pinned end to end

## Scope options

### Option A, test-only pinning of current behavior
Add the missing tests, keep current semantics unless a hidden bug appears.

Pros:
- fastest
- smallest code delta
- likely one short slice

Cons:
- bakes in today’s newline inconsistencies
- leaves `replace()` / `insert()` less agent-friendly on CRLF files

### Option B, pinning plus newline-behavior hardening
Add the missing tests first, then fix any inconsistencies those tests expose, especially around CRLF handling for exact-edit commands.

Pros:
- gives us intentional semantics instead of accidental ones
- better for real coding-agent use on mixed-line-ending repos
- closes the main remaining trust gap, not just the documentation gap

Cons:
- medium-sized slice
- likely touches both tests and shared text helpers

## Recommendation

**Option B.**

If we are going to spend the energy to tighten the contract, we should not freeze obviously awkward CRLF behavior into place. The right outcome is: agents can reason in normalized `\n` text, but file writes still behave predictably and diffs/patches preserve standard unified-diff semantics.

## Proposed behavior contract

### Newline policy
- Commands that present text for reading or stream processing may normalize to `\n` in stdout.
- Exact-edit commands (`replace()`, `insert()`) should accept LF-authored search/anchor strings against CRLF files.
- When exact-edit commands rewrite an existing file, they should preserve that file’s newline style when practical.
- `diff()` and `patch()` must preserve standard unified-diff semantics, including explicit no-final-newline markers.
- Empty files should be handled explicitly, not by accidental fallthrough.

This is the one design decision to settle before implementation. Everything else follows from it.

## Build plan

### Step 1, author the missing test matrix before code changes
**Files:**
- `tests/patch.test.ts`
- `tests/show.test.ts`
- `tests/edit-primitives.test.ts`
- `tests/diff-review.test.ts`
- `tests/integration.test.ts`

**What changes:**
Add focused tests for the currently loose behaviors.

**Test additions by file:**

#### `tests/patch.test.ts`
Add cases for:
- patch apply on file with no trailing newline
- patch reverse on file with no trailing newline
- patch against empty file
- successful multi-file patch apply
- relative-cwd patch apply (for example shell cwd inside `/project/src` with patch labels relative to that cwd)
- CRLF-target patch apply if current parser/writer is expected to support it

#### `tests/show.test.ts`
Add cases for:
- explicit empty-file behavior
- CRLF file read normalizes to LF in stdout, if that is the chosen policy
- no-final-newline line-range read

#### `tests/edit-primitives.test.ts`
Add cases for:
- `replace()` against CRLF content using LF-authored search text
- `insert()` against CRLF content using LF-authored anchor text
- file-without-trailing-newline edits
- unicode path and unicode content edit round-trip
- dry-run/live parity on the same ambiguous and newline-sensitive inputs

#### `tests/diff-review.test.ts`
Add cases for:
- `\ No newline at end of file` markers
- binary diff review output
- unicode path/content diff output
- empty-file add/delete rendering
- CRLF diff behavior, whatever contract we choose

#### `tests/integration.test.ts`
Add one realistic workflow that proves composition, not just primitives:
- nested cwd + relative patch or exact edit + diff review on unicode/no-newline content

**How to verify this step:**
- `bun test tests/patch.test.ts tests/show.test.ts tests/edit-primitives.test.ts tests/diff-review.test.ts tests/integration.test.ts`
- Expect new failures before implementation changes. That is correct.

### Step 2, add shared newline helpers only if the tests expose real inconsistency
**Files:**
- `src/common.ts`
- possibly `src/types.ts` if a helper type is worth naming

**What changes:**
Add the minimum shared helpers needed to make newline semantics intentional. Likely helpers:
- detect dominant newline style (`\n` vs `\r\n`)
- normalize text for logical matching
- reapply newline style on write
- if needed, map normalized match offsets back to raw source offsets

**Why here:**
This is the composition seam. If we need newline fidelity, it should live in one place rather than being reimplemented per command.

**How to verify this step:**
- targeted unit tests added in Step 1 now pass for helper-driven behavior
- no unrelated command regressions

### Step 3, harden command implementations where the new tests actually fail
**Files:**
- `src/shell.ts`

**Expected touchpoints:**
- `replace()` / `insert()` matching and writeback
- patch mutation/build flow, if no-final-newline or relative-cwd cases fail
- diff rendering, if binary/no-newline rendering is off
- show range handling, if empty-file or CRLF semantics are unclear

**Important constraint:**
Do not widen command surface area. This slice is about behavior clarity and correctness, not new flags.

**How to verify this step:**
- targeted test subset passes
- prior green suites stay green

### Step 4, document the now-intentional semantics
**Files:**
- `README.md`

**What changes:**
Document the newline policy and the specific edge-case guarantees we now rely on:
- CRLF handling
- no-final-newline diff/patch behavior
- empty-file behavior where non-obvious
- any exact-edit newline preservation promise

**How to verify this step:**
- README statements match actual tests
- no stale promises or hand-wavy language

### Step 5, run the full verification pass
**How to verify this step:**
- `bun test`
- `bun run build`
- `bun run lint`
- repeat one deterministic subset twice if needed to confirm no order-sensitive output

## Decomposition for verifiability

### Isolated units
- newline helper behavior in `src/common.ts`
- exact-edit matching/writeback behavior
- patch parser/apply behavior
- diff formatter behavior
- show range semantics

### Composition points
- exact edit → diff review
- patch apply → diff clean state
- nested cwd + relative paths → patch or show behavior

### Why this decomposition works
The risky part is not the presence of features, it is cross-command consistency. This plan isolates the newline/edge helpers first, then verifies each command against them, then verifies a realistic agent workflow that composes them.

## Testing strategy

- Add tests before implementation changes.
- Prefer literal patch text for no-final-newline cases when helper generators hide important markers.
- Keep tests command-local where possible, then add one integration proof.
- If a subagent writes the tests, give it only this spec plus the current command contracts, not the implementation.

## Risk flags

1. **CRLF-preserving exact edits may require offset mapping**, which is easy to get subtly wrong.
2. **Diff-library helpers may hide newline markers**, so some tests should use hand-authored patch text.
3. **Empty-file behavior can turn into command-specific drift** unless we decide it explicitly up front.
4. **Relative-cwd patch paths may expose ambiguous assumptions** in path resolution.
5. **Trying to make every command preserve original newline style may bloat scope.** Keep that promise narrow unless the tests prove it is cheap.

## Check Contract

### Functional verification
- [ ] `replace()` and `insert()` behave intentionally on CRLF-backed files
- [ ] patch apply/reverse works on files without trailing newline
- [ ] successful multi-file patch apply is pinned
- [ ] `diff()` renders no-final-newline markers correctly
- [ ] `show()` empty-file and CRLF behavior is explicit and tested
- [ ] unicode edit + diff workflow passes on both unicode paths and unicode content
- [ ] relative-cwd path-sensitive workflow passes for at least one agent-facing command

### Edge cases
- [ ] empty-file behavior is explicit across patch, diff, and show
- [ ] no-trailing-newline behavior is explicit across patch, replace, diff, and show
- [ ] binary diff output is explicit, not accidental
- [ ] CRLF behavior is documented and matches tests
- [ ] dry-run and live exact-edit behavior match on newline-sensitive inputs

### Failure modes
- [ ] ambiguous exact-edit behavior still reports exact match counts and target files
- [ ] patch failure still remains all-or-fail after new edge coverage is added
- [ ] path resolution failures still surface clear command-local errors

### Integration points
- [ ] existing phase tests remain green
- [ ] realistic agent workflow test remains green after newline hardening
- [ ] `README.md` reflects the edge-behavior contract accurately

### Quality gates
- [ ] `bun test` passes
- [ ] `bun run build` passes
- [ ] `bun run lint` passes
- [ ] command output remains deterministic across repeated runs on the same virtual tree

## Definition of done

This follow-on slice is done when the remaining edge behaviors are no longer “probably fine” or “implicitly inherited from the diff library,” but are instead:
- chosen intentionally
- pinned by focused tests
- documented in README
- verified in one realistic agent workflow

At that point `/check` should be able to say the substrate is tightly pinned, including the newline/empty/unicode corners that still feel a little soft today.
