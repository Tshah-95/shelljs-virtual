# shelljs-virtual: A memfs-compatible fork of ShellJS for coding agents

## Project Overview

Fork ShellJS into a new package called `shelljs-virtual` that accepts an injected `fs` parameter instead of hardcoding `require('fs')`. This makes all ShellJS commands work against any Node.js `fs`-compatible filesystem — including `memfs` for fully in-memory operation.

Additionally, extend the command set with missing flags and commands that coding agents rely on heavily.

**Source repo to fork:** https://github.com/shelljs/shelljs (MIT licensed)

**End state:** A standalone npm package where you can do:

```typescript
import { Volume, createFsFromVolume } from 'memfs';
import { Shell } from 'shelljs-virtual';

const vol = Volume.fromJSON({
  '/project/src/index.ts': 'export function hello() { return "world"; }',
  '/project/src/utils.ts': 'export const add = (a: number, b: number) => a + b;',
  '/project/README.md': '# My Project',
});
const fs = createFsFromVolume(vol);
const sh = new Shell({ fs, cwd: '/project' });

sh.grep('-rn', 'export', 'src/');
// => "src/index.ts:1:export function hello() ...\nsrc/utils.ts:1:export const add ..."

sh.find('src/').filter(f => f.endsWith('.ts'));
// => ['src/index.ts', 'src/utils.ts']

sh.sed('-i', /hello/, 'goodbye', 'src/index.ts');
// file is now modified in the memfs volume

// Serialize entire filesystem state to JSON for DB persistence
const snapshot = vol.toJSON();
// Restore later with Volume.fromJSON(snapshot)
```

---

## Architecture Decisions

### Core Principle: `fs` as a constructor parameter

Every command currently does `require('fs')` at the top of its file. The refactor replaces this with an `fs` instance stored on the `Shell` object and passed through to every command function.

```typescript
// BEFORE (ShellJS today):
var fs = require('fs');
function _grep(options, regex, files) {
  // uses global fs
}

// AFTER (shelljs-virtual):
function _grep(fs, options, regex, files) {
  // uses injected fs
}
```

### Virtual cwd

ShellJS uses `process.cwd()` and `process.chdir()` for cd/pwd. Replace with a virtual `cwd` string managed on the Shell instance. All path resolution uses this virtual cwd instead of the process cwd.

### No `exec()`

Remove `shell.exec()` entirely — it runs arbitrary system commands which defeats the purpose of a virtual shell. If users need it, they can add it back via the plugin system.

### TypeScript

Convert the project to TypeScript during the fork. Define proper types for all command return values, options, and the fs interface.

### The fs interface contract

Define a minimal `VirtualFS` interface type that documents exactly which `fs` methods the shell needs:

```typescript
interface VirtualFS {
  readFileSync(path: string, options?: any): string | Buffer;
  writeFileSync(path: string, data: string | Buffer, options?: any): void;
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean; mtime: Date; size: number; mode: number };
  lstatSync(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
  readdirSync(path: string): string[];
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  copyFileSync?(src: string, dest: string): void;
  symlinkSync?(target: string, path: string): void;
  readlinkSync?(path: string): string;
  chmodSync?(path: string, mode: number): void;
  realpathSync?(path: string): string;
}
```

This interface is intentionally compatible with memfs, Node's fs, BrowserFS, Filer, and any other fs implementation.

---

## Issues / Work Breakdown

Work is broken into sequential phases. Each phase produces a working, testable artifact. If the session breaks, resume from the last completed phase.

---

### Phase 0: Project Scaffolding

**Issue 0.1: Initialize the project**

- Create a new repo/directory `shelljs-virtual`
- Set up TypeScript with strict mode
- Set up vitest (or jest) for testing
- Set up eslint + prettier
- Create the package.json with proper metadata
- Add a tsconfig.json targeting ES2020 / Node16 module resolution
- Create the directory structure:

```
shelljs-virtual/
├── src/
│   ├── index.ts          # Main Shell class + exports
│   ├── types.ts          # VirtualFS interface, ShellResult type, option types
│   ├── shell.ts          # Shell class with cwd, fs, and command dispatch
│   ├── common.ts         # Shared utilities (path resolution, glob expansion, error handling)
│   ├── commands/
│   │   ├── cat.ts
│   │   ├── cd.ts
│   │   ├── chmod.ts
│   │   ├── cp.ts
│   │   ├── diff.ts       # NEW - not in original ShellJS
│   │   ├── echo.ts
│   │   ├── find.ts
│   │   ├── grep.ts       # EXTENDED - additional flags
│   │   ├── head.ts
│   │   ├── ln.ts
│   │   ├── ls.ts
│   │   ├── mkdir.ts
│   │   ├── mv.ts
│   │   ├── pwd.ts
│   │   ├── rm.ts
│   │   ├── sed.ts
│   │   ├── sort.ts
│   │   ├── splice.ts     # NEW - line-based file editing
│   │   ├── tail.ts
│   │   ├── touch.ts
│   │   ├── uniq.ts
│   │   ├── wc.ts         # NEW - not in original ShellJS
│   │   └── which.ts      # Reimplemented for virtual PATH
│   └── utils/
│       ├── glob.ts        # Glob expansion against virtual fs
│       ├── path.ts        # Virtual cwd-aware path resolution
│       └── pipe.ts        # ShellString and piping infrastructure
├── tests/
│   ├── fixtures/          # Reusable filesystem snapshots as JSON
│   ├── helpers.ts         # Test utilities: createShell(), assertFile(), etc.
│   ├── cat.test.ts
│   ├── grep.test.ts
│   ├── ... (one test file per command)
│   └── integration.test.ts  # Multi-command workflows
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

**Issue 0.2: Define core types**

Create `src/types.ts` with:
- `VirtualFS` interface (as above)
- `ShellResult` type (wraps string output with `.code`, `.stdout`, `.stderr`, `.toString()`, and pipe methods)
- `GrepOptions`, `SedOptions`, `FindOptions`, etc. — typed option objects for each command
- `ShellConfig` type: `{ fs: VirtualFS, cwd?: string, env?: Record<string, string>, silent?: boolean, fatal?: boolean }`

**Issue 0.3: Create test helpers**

Create `tests/helpers.ts`:
- `createTestShell(files?: Record<string, string>)` — creates a memfs Volume from JSON, returns `{ shell, vol, fs }`
- `assertFileContents(vol, path, expected)` — reads from vol and asserts
- `assertFileExists(vol, path)` / `assertFileNotExists(vol, path)`
- Standard fixture: a realistic small TypeScript project structure with ~10 files across multiple directories

```typescript
export const FIXTURE_PROJECT = {
  '/project/package.json': '{"name": "test", "version": "1.0.0"}',
  '/project/tsconfig.json': '{"compilerOptions": {"strict": true}}',
  '/project/src/index.ts': 'export { hello } from "./utils/hello";\nexport { add } from "./math/add";\n',
  '/project/src/utils/hello.ts': '// greeting utility\nexport function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  '/project/src/utils/format.ts': 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n',
  '/project/src/math/add.ts': '// addition\nexport const add = (a: number, b: number): number => a + b;\n',
  '/project/src/math/multiply.ts': '// multiplication\nexport const multiply = (a: number, b: number): number => a * b;\n',
  '/project/src/types.ts': 'export interface User {\n  id: number;\n  name: string;\n  email: string;\n}\n\nexport type Role = "admin" | "user" | "guest";\n',
  '/project/README.md': '# Test Project\n\nA sample project for testing.\n',
  '/project/.gitignore': 'node_modules\ndist\n*.js\n',
};
```

---

### Phase 1: Core Infrastructure

**Issue 1.1: Shell class and virtual cwd**

Implement `src/shell.ts`:
- Constructor takes `ShellConfig`
- Stores `fs`, `cwd`, `env`, `silent`, `fatal`
- `resolvePath(p: string): string` — resolves relative paths against virtual cwd using `path.resolve(this.cwd, p)`
- All commands are methods on the Shell instance
- Commands return `ShellResult` objects

**Issue 1.2: ShellResult / ShellString**

Port ShellJS's `ShellString` concept:
- Wraps a string value
- Has `.code` (exit code), `.stdout`, `.stderr`
- Has `.toString()` returning stdout
- Has `.to(file)` and `.toEnd(file)` for redirect to file
- Has pipe methods: `.grep()`, `.sed()`, `.cat()`, `.head()`, `.tail()`, `.sort()`, `.uniq()`, `.wc()`
- Pipe methods call back into the shell instance with piped input

**Issue 1.3: Glob expansion**

Implement `src/utils/glob.ts`:
- `expandGlob(fs, cwd, pattern): string[]`
- Supports `*`, `**`, `?`, `{a,b}` patterns
- Use the `fast-glob` or `micromatch` library for pattern matching, but walk the virtual fs tree manually (since glob libraries typically use real fs)
- Walk the directory tree via `fs.readdirSync` + `fs.statSync`
- Return absolute paths, sorted

**Tests for Phase 1:**
- Shell construction with memfs
- Path resolution (relative, absolute, `..`, `.`)
- cd changes cwd, pwd returns it
- ShellResult `.to()` writes to memfs file
- ShellResult `.toEnd()` appends
- Glob expansion against memfs directories

---

### Phase 2: File Operation Commands

Port these from ShellJS, replacing all `require('fs')` with the injected fs. Each command gets its own test file.

**Issue 2.1: `cat`**
- `cat(file, ...)` or `cat([files])`
- `-n` flag: number output lines
- Reads from virtual fs, concatenates, returns ShellResult

**Issue 2.2: `cp`**
- `cp(source, dest)` or `cp(source..., dest)`
- `-r` / `-R`: recursive copy
- `-f`: force (default)
- `-n`: no overwrite
- Must handle directory copying recursively via fs.readdirSync + fs.statSync

**Issue 2.3: `mv`**
- `mv(source, dest)` or `mv(source..., dest)`
- `-f`: force (default)
- `-n`: no overwrite
- Implemented as copy + delete for cross-directory moves

**Issue 2.4: `rm`**
- `rm(file, ...)`
- `-r` / `-R`: recursive
- `-f`: force (ignore nonexistent)
- Recursive delete via directory walk

**Issue 2.5: `mkdir`**
- `mkdir(dir, ...)`
- `-p`: create intermediate directories
- Calls `fs.mkdirSync` with `{ recursive: true }` for `-p`

**Issue 2.6: `touch`**
- `touch(file, ...)`
- `-c`: do not create if doesn't exist
- Creates empty file or updates mtime

**Issue 2.7: `ln`**
- `ln(source, dest)`
- `-s`: symbolic link
- `-f`: force
- Uses `fs.symlinkSync`

**Issue 2.8: `chmod`**
- `chmod(mode, file)`
- Octal and symbolic modes
- Uses `fs.chmodSync`

**Issue 2.9: `ls`**
- `ls(path, ...)` or `ls([paths])`
- `-R`: recursive
- `-A`: all (include dotfiles except . and ..)
- `-l`: long format (returns structured objects with stat info)
- `-d`: list directories themselves, not contents
- Returns ShellResult with array-like properties

**Tests for Phase 2:**
- Each command tested against memfs
- Test all listed flags
- Test error cases (missing files, permission errors where applicable)
- Test with glob patterns in paths
- Test cp/mv across directories

---

### Phase 3: Text Processing Commands (The Important Ones)

These are the commands coding agents use most. Extra attention to flag coverage.

**Issue 3.1: `grep` (EXTENDED beyond ShellJS)**

ShellJS grep flags: `-v` (invert), `-l` (files only), `-i` (case insensitive)

Add these flags that coding agents need:
- `-n`: print line numbers (critical for code navigation)
- `-r` / `-R`: recursive directory search (ShellJS uses globs instead, but agents expect `-r`)
- `-c`: count matches only
- `-w`: match whole words only
- `-E`: extended regex (treat pattern as full regex — should be default)
- `--include=GLOB`: only search files matching glob pattern
- `--exclude=GLOB`: skip files matching glob pattern
- `--exclude-dir=PATTERN`: skip directories matching pattern
- `-A NUM`: print NUM lines after match
- `-B NUM`: print NUM lines before match
- `-C NUM`: print NUM lines before and after match
- `-m NUM`: stop after NUM matches per file
- `-H` / `-h`: show/hide filename prefix
- `-o`: only output the matched portion

Implementation notes:
- When searching recursively, skip binary-looking files (files with null bytes in first 512 bytes)
- Default: show filenames when searching multiple files, hide for single file
- Line numbering is 1-based
- Context lines should use `--` separators between non-contiguous groups
- Support both string and RegExp patterns

```typescript
// Expected usage examples that MUST work:
sh.grep('-rn', 'export', 'src/');
sh.grep('-rni', '--include=*.ts', 'function', 'src/');
sh.grep({ '-A': 3 }, 'TODO', 'src/**/*.ts');
sh.grep('-rl', 'import.*React', 'src/');
sh.grep('-c', 'export', 'src/index.ts');
sh.grep('-w', 'add', 'src/math/add.ts');
```

**Tests for grep:**
- Basic string matching in single file
- Regex matching
- `-n` shows correct line numbers
- `-r` recurses into subdirectories
- `-i` case insensitive matching
- `-v` inverts match
- `-l` lists only filenames
- `-c` counts matches
- `-w` matches whole words only (not substrings)
- `--include` filters file types
- `--exclude` skips file types
- `--exclude-dir` skips directories (e.g., node_modules)
- `-A`, `-B`, `-C` context lines with `--` separators
- `-m` stops after N matches
- Multi-file search shows filenames by default
- Single-file search hides filename by default
- `-H` forces filename display, `-h` suppresses it
- Piped input: `sh.cat('file.ts').grep('export')`
- Binary file skipping
- No matches returns empty ShellResult with code 1

**Issue 3.2: `sed`**

Port from ShellJS with all existing functionality:
- `sed(regex, replacement, file)`
- `-i`: in-place editing
- Capture groups with `$1`, `$2`, etc.
- Per-line replacement (matching ShellJS behavior)

Additional:
- Support function replacements: `sed(regex, (match) => ..., file)`
- Global flag awareness (regex with /g replaces all occurrences per line)

**Tests for sed:**
- Simple string replacement
- Regex replacement
- Capture groups
- In-place editing modifies memfs file
- Non-in-place returns modified content without changing file
- Global vs first-match replacement
- Multi-file sed
- Piped input

**Issue 3.3: `head`**
- `head(file)` — default first 10 lines
- `head({'-n': N}, file)` — first N lines
- Support negative N: all but last N lines

**Issue 3.4: `tail`**
- `tail(file)` — default last 10 lines
- `tail({'-n': N}, file)` — last N lines
- Support `+N`: start from line N

**Issue 3.5: `sort`**
- `sort(file)`
- `-r`: reverse
- `-n`: numeric sort
- `-u`: unique (remove duplicates while sorting)
- `-k NUM`: sort by field/column

**Issue 3.6: `uniq`**
- `uniq(file)`
- `-c`: prefix lines with count
- `-d`: only print duplicates
- `-i`: case insensitive comparison

**Tests for Phase 3:**
- Each flag for each command
- Piped input for all commands: `sh.cat('file').sort().uniq()`
- Chain combinations: `sh.grep('-rn', 'TODO', 'src/').sort()`

---

### Phase 4: New Commands (Not in ShellJS)

**Issue 4.1: `wc` (word count)**

- `wc(file, ...)`
- `-l`: line count only
- `-w`: word count only
- `-c`: byte count only
- `-m`: character count only
- Default: all counts (lines, words, bytes)
- With multiple files, show totals row

```typescript
sh.wc('-l', 'src/index.ts');  // => "  12 src/index.ts"
sh.find('src/').filter(f => f.endsWith('.ts')).length; // file count
```

**Issue 4.2: `diff` (file comparison)**

- `diff(file1, file2)`
- `-u`: unified format (default — this is what agents expect)
- `--no-color`: plain text output (default for programmatic use)
- Show filename headers with `---` and `+++`
- Show `@@` hunk headers with line numbers
- Exit code: 0 = identical, 1 = differences, 2 = error

Use the `diff` npm package (Myers algorithm) for the core diffing. Write the unified output formatting yourself.

```typescript
const result = sh.diff('old.ts', 'new.ts');
// --- old.ts
// +++ new.ts
// @@ -1,3 +1,4 @@
//  import { foo } from './foo';
// -import { bar } from './bar';
// +import { bar } from './bar';
// +import { baz } from './baz';
//  
```

**Tests for diff:**
- Identical files return code 0
- Different files return code 1
- Unified format output is parseable
- Handles new file (diff against /dev/null)
- Handles deleted content, added content, modified content
- Handles files with no trailing newline

**Issue 4.3: `splice` (line-based file editing — NEW COMMAND)**

This is a command that doesn't exist in Unix but is exactly what coding agents need. It edits files by line number ranges.

- `splice(file, startLine, deleteCount, ...insertLines)`
- Lines are 1-indexed
- `splice('file.ts', 5, 0, 'new line')` — insert at line 5
- `splice('file.ts', 5, 3)` — delete lines 5-7
- `splice('file.ts', 5, 3, 'replacement')` — replace lines 5-7 with new content
- `-d`: dry run, return the result without writing
- Returns the modified file content

```typescript
sh.splice('src/index.ts', 3, 0, 'import { baz } from "./baz";');
// Inserts a new import at line 3

sh.splice('src/index.ts', 5, 2, 
  'export function updated() {',
  '  return "new implementation";',
  '}'
);
// Replaces lines 5-6 with 3 new lines
```

**Tests for splice:**
- Insert at beginning, middle, end
- Delete single line, multiple lines
- Replace range with fewer lines, same lines, more lines
- Line numbers out of bounds (error handling)
- Dry run returns content without modifying file

**Issue 4.4: `realpath` / `dirname` / `basename`**
- `realpath(path)` — resolve to absolute path (via virtual cwd)
- `dirname(path)` — directory portion
- `basename(path, ext?)` — filename portion, optionally strip extension
- These wrap Node's `path` module but resolve against virtual cwd

---

### Phase 5: Piping and Composition

**Issue 5.1: Full piping infrastructure**

Ensure all text-processing commands can appear on both sides of pipes:

```typescript
// All of these must work:
sh.cat('file.ts').grep('export').sort().uniq();
sh.grep('-rn', 'TODO', 'src/').head({ '-n': 5 });
sh.find('src/').grep('test').wc('-l');
sh.cat('data.csv').sort({ '-t': ',', '-k': 2 }).head({ '-n': 10 });
```

The pipe mechanism should pass `.stdout` of the previous result as implicit stdin to the next command.

**Issue 5.2: `.to()` and `.toEnd()` write to virtual fs**

```typescript
sh.grep('-rn', 'TODO', 'src/').to('/project/todos.txt');
// todos.txt now exists in memfs

sh.echo('new entry').toEnd('/project/log.txt');
// appends to log.txt in memfs
```

**Tests for Phase 5:**
- Chain at least 3 commands in a pipe
- Pipe output to file with `.to()`
- Pipe output to append with `.toEnd()`
- Empty pipe input handled gracefully
- Error propagation through pipes (non-zero exit code)

---

### Phase 6: Integration Tests and Quality

**Issue 6.1: Real-world agent workflow tests**

Create integration tests that simulate actual coding agent workflows:

```typescript
test('agent explores a codebase', () => {
  const { shell } = createTestShell(FIXTURE_PROJECT);
  
  // Agent discovers project structure
  const files = shell.find('/project/src');
  expect(files).toContain('/project/src/index.ts');
  
  // Agent searches for all exports
  const exports = shell.grep('-rn', 'export', '/project/src/');
  expect(exports.stdout).toContain('index.ts:1:');
  
  // Agent finds all TypeScript files
  const tsFiles = shell.grep('-rl', '--include=*.ts', 'function', '/project/src/');
  expect(tsFiles.code).toBe(0);
  
  // Agent reads a specific file
  const content = shell.cat('/project/src/utils/hello.ts');
  expect(content.stdout).toContain('export function hello');
  
  // Agent modifies the file
  shell.sed('-i', /hello/g, 'greet', '/project/src/utils/hello.ts');
  const updated = shell.cat('/project/src/utils/hello.ts');
  expect(updated.stdout).toContain('export function greet');
  expect(updated.stdout).not.toContain('export function hello');
});

test('agent creates new files and directories', () => {
  const { shell, vol } = createTestShell(FIXTURE_PROJECT);
  
  shell.mkdir('-p', '/project/src/new-feature');
  shell.echo('export const newThing = true;').to('/project/src/new-feature/index.ts');
  
  const exists = shell.test('-f', '/project/src/new-feature/index.ts');
  expect(exists).toBe(true);
  
  const content = shell.cat('/project/src/new-feature/index.ts');
  expect(content.stdout).toContain('newThing');
});

test('agent refactors across multiple files', () => {
  const { shell } = createTestShell(FIXTURE_PROJECT);
  
  // Find all files importing from a module
  const importers = shell.grep('-rl', 'from.*"./utils/hello"', '/project/src/');
  
  // Apply rename across all of them
  const files = importers.stdout.trim().split('\n').filter(Boolean);
  files.forEach(f => {
    shell.sed('-i', /"\.\/utils\/hello"/, '"./utils/greet"', f);
  });
  
  // Rename the actual file
  shell.mv('/project/src/utils/hello.ts', '/project/src/utils/greet.ts');
  
  // Verify
  expect(shell.test('-f', '/project/src/utils/greet.ts')).toBe(true);
  expect(shell.test('-f', '/project/src/utils/hello.ts')).toBe(false);
});

test('agent uses diff to review changes', () => {
  const { shell } = createTestShell(FIXTURE_PROJECT);
  
  shell.cp('/project/src/utils/hello.ts', '/tmp/hello.ts.bak');
  shell.sed('-i', /Hello/, 'Greetings', '/project/src/utils/hello.ts');
  
  const diff = shell.diff('/tmp/hello.ts.bak', '/project/src/utils/hello.ts');
  expect(diff.code).toBe(1); // files differ
  expect(diff.stdout).toContain('-  return `Hello');
  expect(diff.stdout).toContain('+  return `Greetings');
});

test('filesystem persists through vol.toJSON() round-trip', () => {
  const { shell, vol } = createTestShell(FIXTURE_PROJECT);
  
  // Make changes
  shell.sed('-i', /hello/g, 'greet', '/project/src/utils/hello.ts');
  shell.mkdir('-p', '/project/src/new');
  shell.echo('new file').to('/project/src/new/thing.ts');
  
  // Snapshot and restore
  const snapshot = vol.toJSON();
  const vol2 = Volume.fromJSON(snapshot);
  const shell2 = new Shell({ fs: createFsFromVolume(vol2), cwd: '/project' });
  
  // Changes persisted
  expect(shell2.cat('/project/src/utils/hello.ts').stdout).toContain('greet');
  expect(shell2.test('-f', '/project/src/new/thing.ts')).toBe(true);
});
```

**Issue 6.2: Edge case tests**

- Empty files
- Files with no trailing newline
- Very long lines (>10k characters)
- Unicode content (emoji, CJK characters, RTL text)
- Deeply nested directories (10+ levels)
- Filenames with spaces, special characters
- Symlinks (if fs supports them)
- Large number of files (1000+ in a directory)
- Binary-looking content (null bytes)
- Empty directories
- Paths with trailing slashes
- Dot files and dot directories
- Relative paths with `..` going above cwd (should error or resolve correctly)

**Issue 6.3: Ensure test coverage and clean build**

- All commands have >90% line coverage
- `npm run build` produces clean output with no TypeScript errors
- `npm run lint` passes with no warnings
- `npm run test` passes all tests
- README.md documents all commands, flags, and usage examples
- package.json has correct `main`, `types`, `exports` fields

---

## Session Durability

If the Codex session is interrupted, the agent should be able to resume. Build durability as follows:

### Checkpoint strategy

After completing each Phase, create a checkpoint commit:

```bash
git add -A
git commit -m "checkpoint: Phase N complete - [description]"
```

### Resumption protocol

If resuming a broken session, the agent should:

1. Run `git log --oneline -10` to see which phases are complete
2. Run `npm test` to verify the current state works
3. Read this document to identify the next incomplete phase
4. Continue from there

### Phase completion criteria

A phase is "complete" when:
1. All issue code for that phase is implemented
2. All tests for that phase pass
3. The build succeeds (`npm run build`)
4. A checkpoint commit has been made

---

## Dependencies

```json
{
  "dependencies": {
    "fast-glob": "^3.x",
    "diff": "^5.x"
  },
  "devDependencies": {
    "memfs": "^4.x",
    "typescript": "^5.x",
    "vitest": "^2.x",
    "eslint": "^9.x",
    "prettier": "^3.x",
    "@types/node": "^20.x",
    "@types/diff": "^5.x"
  }
}
```

Note: `fast-glob` is used for pattern matching logic only, NOT for filesystem traversal. Directory walking must use the injected `fs` so it works with memfs. Use `micromatch` or `picomatch` if you only need the matching portion without any fs access.

---

## What NOT to Build

- No `exec()` — no system shell access
- No `which()` with real PATH lookup — can stub it or remove it
- No process management (`exit()`, `error()`, `env`)
- No `pushd`/`popd`/`dirs` (stack-based directory navigation — nice to have but not needed for v1)
- No POSIX permission enforcement (just store mode bits, don't enforce them)
- No async versions of commands — all synchronous like ShellJS
- No git commands — isomorphic-git handles that separately
- No `awk` or `jq` — too complex for v1, agents can use JS directly for these

---

## Quality Bar

Before declaring the project complete:

1. **Every command works against memfs** — verified by tests that create a Volume, run commands, and assert on results
2. **Grep is production-quality** — this is the single most important command for coding agents. All listed flags must work correctly with edge cases tested
3. **Piping works end to end** — at least 5 integration tests showing multi-command pipes
4. **vol.toJSON() round-trip preserves all changes** — verified by integration test
5. **TypeScript types are complete** — a consumer can `import { Shell } from 'shelljs-virtual'` and get full autocomplete
6. **Zero dependencies on real filesystem** — no `require('fs')` anywhere in production code (only in tests for comparison)
7. **README is comprehensive** — documents every command, every flag, with code examples

---

## Reference Materials

- **ShellJS source:** https://github.com/shelljs/shelljs/tree/master/src — reference implementations of all ported commands
- **POSIX utility specs:** https://pubs.opengroup.org/onlinepubs/9699919799/utilities/ — formal specifications for grep, sed, find, etc.
- **GNU coreutils docs:** https://www.gnu.org/software/coreutils/manual/ — extended flag documentation
- **memfs API:** https://github.com/streamich/memfs — the primary target fs implementation
- **Node.js fs API:** https://nodejs.org/api/fs.html — the interface contract
