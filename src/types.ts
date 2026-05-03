export interface VirtualStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mtime: Date;
  readonly size: number;
  readonly mode: number;
}

export interface VirtualDirent {
  name: string | Uint8Array;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface VirtualFS {
  readFileSync(path: string, options?: unknown): string | Uint8Array;
  writeFileSync(path: string, data: string | Uint8Array, options?: unknown): void;
  appendFileSync?(path: string, data: string | Uint8Array, options?: unknown): void;
  existsSync(path: string): boolean;
  statSync(path: string): VirtualStat;
  lstatSync?(path: string): VirtualStat;
  readdirSync(path: string, options?: { withFileTypes?: boolean }): Array<string | Uint8Array | VirtualDirent>;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync?(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  rmdirSync?(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  copyFileSync?(src: string, dest: string): void;
  symlinkSync?(target: string, path: string): void;
  readlinkSync?(path: string): string | Uint8Array;
  chmodSync?(path: string, mode: number): void;
  realpathSync?(path: string): string | Uint8Array;
  utimesSync?(path: string, atime: Date | number, mtime: Date | number): void;
}

export interface ShellConfig {
  fs: VirtualFS;
  cwd?: string;
  env?: Record<string, string>;
  silent?: boolean;
  fatal?: boolean;
  /**
   * Listeners that fire on content-mutation verbs (write/replace/sed/insert/
   * patch/splice). Each listener declares a `match` glob/regex; non-matching
   * paths skip every handler (including onBefore). Results aggregate into the
   * verb's `ShellString.hookResult`.
   *
   * Listeners run in registration order. Per listener, onBefore runs first;
   * a {refuse:true} result aborts the mutation. Then the per-verb handler
   * (onWrite/onReplace/...) runs, then onAny. Exceptions thrown inside any
   * handler are caught at the dispatcher, captured as warnings, and never
   * abort the file write.
   */
  listeners?: ShellListener[];
  /**
   * Initial value passed to listeners as `MutationCtx.beforeModel`. Treated
   * as opaque by this package — never inspected, cloned, or serialized.
   * Listeners can return `HookResult.beforeModelHint` to update this for
   * subsequent verb calls within the same Shell instance.
   */
  beforeModel?: unknown;
}

export interface ResultOptions {
  code?: number;
  stderr?: string;
  hookResult?: HookResult;
}

/**
 * The set of content-mutation verbs that fire listeners. Read verbs (ls/cat/
 * grep/etc.) and non-text mutations (mv/rm/mkdir/touch/chmod/ln/cp) do NOT
 * fire listeners in v1.
 */
export type VerbName = 'write' | 'replace' | 'splice' | 'sed' | 'patch' | 'insert';

export interface MutationCtx {
  verb: VerbName;
  path: string;
  content: string;
  /** undefined when the file did not exist before this verb. '' for an
   *  existing-but-empty file. */
  prevContent: string | undefined;
  fs: VirtualFS;
  /** Opaque to this package; consumers (e.g. carlo) pass a CompileResult. */
  beforeModel?: unknown;
}

export interface HookResult {
  /** Diagnostics emitted by this listener. Concat across listeners. */
  diagnostics?: unknown[];
  /** Last-non-undefined wins across listeners. */
  impact?: unknown;
  /** Last-non-undefined wins across listeners. */
  workspaceEdit?: unknown;
  /** Concat across listeners. Also receives caught listener-throw messages. */
  warnings?: string[];
  /** Last-non-undefined wins. Updates the Shell's beforeModel for the next
   *  verb call (avoids cold-call double-parse on subsequent edits). */
  beforeModelHint?: unknown;
}

export interface HookVetoResult {
  refuse: true;
  reason: string;
  diagnostics?: unknown[];
}

export interface ShellListener {
  /**
   * Path-glob(s) the listener cares about. Empty array matches nothing
   * (fail-closed). Non-matching paths skip every handler including onBefore.
   */
  match: string | RegExp | (string | RegExp)[];
  onWrite?: (ctx: MutationCtx) => HookResult | undefined;
  onReplace?: (ctx: MutationCtx) => HookResult | undefined;
  onSplice?: (ctx: MutationCtx) => HookResult | undefined;
  onSed?: (ctx: MutationCtx) => HookResult | undefined;
  onPatch?: (ctx: MutationCtx) => HookResult | undefined;
  onInsert?: (ctx: MutationCtx) => HookResult | undefined;
  /** Catch-all; runs in addition to verb-specific handler after the write. */
  onAny?: (ctx: MutationCtx) => HookResult | undefined;
  /**
   * Runs before the write. Returning {refuse:true} aborts the mutation and
   * subsequent listeners. Throwing is treated as non-veto; the throw message
   * lands in HookResult.warnings and the mutation proceeds.
   */
  onBefore?: (ctx: MutationCtx) => HookVetoResult | undefined;
}

export interface LongListEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mode: number;
  mtime: Date;
}

export interface ParsedHeadTailOptions {
  count: number;
  fromStart?: boolean;
}

export interface ParsedSortOptions {
  numeric: boolean;
  reverse: boolean;
  unique: boolean;
  key?: number;
  separator?: string;
}

export interface ParsedUniqOptions {
  count: boolean;
  duplicatesOnly: boolean;
  ignoreCase: boolean;
}

export interface ParsedFindOptions {
  hidden: boolean;
  exclude: string[];
  maxResults?: number;
}

export interface ParsedGrepOptions {
  invert: boolean;
  filesWithMatches: boolean;
  ignoreCase: boolean;
  lineNumbers: boolean;
  recursive: boolean;
  countOnly: boolean;
  wordRegexp: boolean;
  hidden: boolean;
  include: string[];
  exclude: string[];
  excludeDir: string[];
  after: number;
  before: number;
  maxCount?: number;
  maxCountTotal?: number;
  withFilename?: boolean;
  onlyMatching: boolean;
}
