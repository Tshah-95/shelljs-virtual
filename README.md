# shelljs-virtual

`shelljs-virtual` is a synchronous, ShellJS-style API that runs against an injected `fs` implementation instead of the host filesystem. It is aimed at coding agents and other tools that need shell-like filesystem and text-processing commands inside an in-memory or otherwise virtualized tree.

Production code never imports the real filesystem. All file access goes through the `VirtualFS` contract, so the same `Shell` instance can run against `memfs`, a database-backed adapter, or a custom sandbox filesystem.

## Design Goals

- Zero production dependency on the real filesystem
- Virtual `cwd` instead of `process.chdir()`
- Production-quality recursive `grep` for code navigation
- Pipeable `ShellString` and `ShellArrayResult` outputs
- Sync-only API surface
- No `exec()`

## Installation

```bash
bun add shelljs-virtual
```

## Quick Start

```ts
import { Volume, createFsFromVolume } from 'memfs';
import { Shell } from 'shelljs-virtual';

const vol = Volume.fromJSON({
  '/project/src/index.ts': 'export { hello } from "./utils/hello";\n',
  '/project/src/utils/hello.ts': 'export function hello() { return "world"; }\n',
  '/project/README.md': '# Demo\n',
});

const fs = createFsFromVolume(vol);
const sh = new Shell({
  fs,
  cwd: '/project',
  env: { PATH: '/project/bin:/bin' },
});

const exports = sh.grep('-rni', '--include=*.ts', 'export', '/project/src');
console.log(exports.stdout);

sh.sed('-i', /hello/g, 'greet', '/project/src/utils/hello.ts');
sh.echo('build ok').to('/project/log.txt');

const snapshot = vol.toJSON();
```

## Public API

```ts
interface ShellConfig {
  fs: VirtualFS;
  cwd?: string;
  env?: Record<string, string>;
  silent?: boolean;
  fatal?: boolean;
}
```

```ts
interface VirtualFS {
  readFileSync(path: string, options?: unknown): string | Uint8Array;
  writeFileSync(path: string, data: string | Uint8Array, options?: unknown): void;
  appendFileSync?(path: string, data: string | Uint8Array, options?: unknown): void;
  existsSync(path: string): boolean;
  statSync(path: string): VirtualStat;
  lstatSync?(path: string): VirtualStat;
  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | VirtualDirent[];
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync?(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  rmdirSync?(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  copyFileSync?(src: string, dest: string): void;
  symlinkSync?(target: string, path: string): void;
  readlinkSync?(path: string): string;
  chmodSync?(path: string, mode: number): void;
  realpathSync?(path: string): string;
  utimesSync?(path: string, atime: Date | number, mtime: Date | number): void;
}
```

## Results And Piping

Text-oriented commands return `ShellString`. Array-oriented commands such as `find()` and `ls()` return `ShellArrayResult`.

Both support:

- `.stdout`
- `.stderr`
- `.code`
- `.toString()`
- `.to(file)`
- `.toEnd(file)`

Text results also support shell-style chaining:

```ts
sh.cat('/project/list.txt').sort().uniq().head({ '-n': 10 });
sh.grep('-rn', 'TODO', '/project/src').to('/project/todos.txt');
sh.find('/project/src').grep('hello').wc('-l');
```

The pipe mechanism passes the previous command's `.stdout` as implicit stdin. Empty or failing pipeline inputs preserve the non-zero exit code so later commands do not quietly convert a failure into success. Commands that accept stdin-like input reject mixed stdin plus file-path usage instead of silently ignoring one side.

## Commands

### Navigation And Path Helpers

- `cd(path)`
- `pwd()`
- `realpath(path)`
- `dirname(path)`
- `basename(path, ext?)`
- `test('-e' | '-f' | '-d' | '-L', path)`
- `glob(pattern)`
- `which(commandName)`

`which()` searches the shell's virtual `PATH`, not the host machine path.

### File Operations

#### `cat(file...)`

- Flags: `-n`
- Reads one or more files and concatenates them into a `ShellString`

#### `cp(source..., dest)`

- Flags: `-r`, `-R`, `-n`
- Recursively copies directories through the injected filesystem

#### `mv(source..., dest)`

- Flags: `-n`
- Moves one or more files or directories inside the virtual tree

#### `rm(path...)`

- Flags: `-r`, `-R`, `-f`
- Removes files or directories without touching the host filesystem

#### `mkdir(path...)`

- Flags: `-p`
- Creates directories, including nested parents with `-p`

#### `touch(path...)`

- Flags: `-c`
- Creates empty files or updates timestamps when supported by the filesystem

#### `ln(source, dest)`

- Flags: `-s`, `-f`
- Creates links using `fs.symlinkSync()` when the adapter supports it

#### `chmod(mode, path...)`

- Accepts octal modes such as `755`

#### `ls(path...)`

- Flags: `-R`, `-A`, `-l`, `-d`
- Long mode returns structured entries with type, size, mode, and mtime

#### `find(path...)`

- Long options: `--hidden`, `--exclude=GLOB`, `--max-results=N`
- Recursively walks the virtual tree and returns absolute paths
- Hidden files and directories are skipped by default unless `--hidden` is passed or a hidden target is addressed directly

### Text Processing

#### `grep(pattern, path...)`

- Flags: `-v`, `-l`, `-i`, `-n`, `-r`, `-R`, `-c`, `-w`, `-H`, `-h`, `-o`
- Structured options: `-A`, `-B`, `-C`, `-m`
- Long options: `--hidden`, `--include=GLOB`, `--exclude=GLOB`, `--exclude-dir=GLOB`, `--max-count-total=N`
- Accepts `string` or `RegExp` patterns
- Skips binary-looking files when recursing
- Uses 1-based line numbers
- Emits `--` separators between non-contiguous context groups

Examples:

```ts
sh.grep('-rn', 'export', '/project/src');
sh.grep('-rni', '--include=*.ts', 'function', '/project/src');
sh.grep({ '-A': 3 }, 'TODO', '/project/src/**/*.ts');
sh.grep('-rl', 'import.*React', '/project/src');
sh.grep('-c', 'export', '/project/src/index.ts');
sh.grep('-w', 'add', '/project/src/math/add.ts');
```

#### `sed(search, replacement, path...)`

- Flags: `-i`
- Supports string and regex replacement
- Supports capture groups like `$1`
- Supports function replacements
- Respects regex global flags on a per-line basis

#### `head(path...)`

- Options: `-n`
- Default is the first 10 lines
- Negative `-n` keeps all but the last N lines

#### `tail(path...)`

- Options: `-n`
- Default is the last 10 lines
- Supports `+N` to start from line N

#### `sort(path...)`

- Flags: `-r`, `-n`, `-u`
- Options: `-k`

#### `uniq(path...)`

- Flags: `-c`, `-d`, `-i`

#### `wc(path...)`

- Flags: `-l`, `-w`, `-c`, `-m`
- Default output includes lines, words, and bytes
- Multiple files include a totals row

### Text And Newline Behavior

- Read-oriented and stream-processing commands normalize CRLF input to LF in `stdout`.
- `replace()` and `insert()` accept LF-authored search or anchor text against CRLF-backed files.
- Exact-edit commands preserve the target file's newline style on write when they rewrite an existing file.
- Files without a trailing newline stay that way unless the command explicitly inserts one.

### Failure Semantics

- Routine command failures return `.code` and `.stderr` instead of throwing.
- Text-oriented file reads and mutations fail explicitly on binary-looking targets instead of silently decoding them.
- `cp()`, `mv()`, and `rm()` validate all explicit inputs before mutating the virtual filesystem, so a later missing path does not leave a partial change behind.
- `find()` and `ls()` surface missing explicit paths as non-zero results with empty output.

### Agent-Oriented Commands

#### `patch(patchText)`

- Flags: `--dry-run`, `--check`, `--reverse`
- Applies unified diffs to one or many files in the virtual filesystem
- Defaults to all-or-fail behavior across multi-file patches
- Supports create and delete patches via `/dev/null`
- Preserves standard no-final-newline patch semantics

#### `replace(path, search, replacement)`

- Flags: `--dry-run`, `--all`, `--regex`, `--expected=N`
- Defaults to exact single-match replacement
- Supports file and piped-input modes
- Fails explicitly on zero or ambiguous matches

#### `insert(mode, path, anchor?, content)`

- Modes: `--before`, `--after`, `--at-start`, `--at-end`
- Defaults to exact single-anchor matching for before and after modes
- Supports dry-run previews before mutating files

#### `show(path, startLine, endLine)`

- Flags: `--numbers`, `--around-line`, `--around-match`, `--context=N`
- Reads exact line ranges or match-centered excerpts
- Empty files fail explicitly instead of returning accidental output

#### `diff(left, right)`

- Unified output by default
- Exit code `0` when identical
- Exit code `1` when different
- Exit code `2` on command error
- Renders no-final-newline markers and binary-file output explicitly

#### `splice(file, startLine, deleteCount, ...insertLines)`

- Flags: `-d` for dry-run
- Uses 1-indexed line numbers
- Returns the modified file contents

Examples:

```ts
sh.splice('/project/src/index.ts', 3, 0, 'export { greet } from "./utils/greet";');
sh.splice('/project/src/index.ts', 5, 2, 'export const ready = true;');
```

## More Examples

### Recursive grep with line numbers

```ts
sh.grep('-rni', '--include=*.ts', 'export', '/project/src');
```

### Copy, edit, and diff a file

```ts
sh.cp('/project/src/utils/hello.ts', '/project/tmp/hello.ts.bak');
sh.sed('-i', /Hello/g, 'Greetings', '/project/src/utils/hello.ts');
const review = sh.diff('/project/tmp/hello.ts.bak', '/project/src/utils/hello.ts');
```

### Rename a module across a codebase

```ts
const importers = sh.grep('-rl', './utils/hello', '/project/src');
for (const file of importers.stdout.trim().split('\n').filter(Boolean)) {
  sh.sed('-i', /"\.\/utils\/hello"/g, '"./utils/greet"', file);
}
sh.mv('/project/src/utils/hello.ts', '/project/src/utils/greet.ts');
```

### Snapshot and restore a project tree

```ts
const snapshot = vol.toJSON();
const restoredVol = Volume.fromJSON(snapshot);
const restoredShell = new Shell({ fs: createFsFromVolume(restoredVol), cwd: '/project' });
```

## Development

This repository uses bun-native scripts:

- `bun run build`
- `bun run lint`
- `bun test`
- `bun run test:phase1`
- `bun run test:phase2`
- `bun run test:phase3`
- `bun run test:phase45`
- `bun run test:integration`

The build emits `dist/index.js` and `dist/index.d.ts`.

## Verification

The repository includes:

- Phase-specific tests for shell infrastructure
- File command coverage across copying, moving, linking, chmod, and listing
- Grep-focused text-processing tests covering recursion, context, includes, excludes, piping, and binary skipping
- New command and piping tests for `diff`, `splice`, `wc`, `which`, `.to()`, and `.toEnd()`
- Integration tests for codebase exploration, refactoring, and `vol.toJSON()` round-trip persistence
- Edge cases for unicode, spaces, deep trees, large directory scans, CRLF content, and no-trailing-newline workflows

## Limitations

- No `exec()`
- No async command variants
- No real PATH lookup
- No shell process management
- No permission enforcement beyond storing mode bits in the injected filesystem
- `diff()` is line-oriented unified output intended for review workflows rather than exact GNU parity
