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
  listeners?: ShellListener[];
  beforeModel?: unknown;
}

export type VerbName = 'write' | 'replace' | 'splice' | 'sed' | 'patch' | 'insert';

export interface MutationCtx {
  verb: VerbName;
  path: string;
  content: string;
  prevContent: string | undefined;
  fs: VirtualFS;
  beforeModel?: unknown;
}

export interface HookResult {
  diagnostics?: unknown[];
  impact?: unknown;
  workspaceEdit?: unknown;
  warnings?: string[];
  beforeModelHint?: unknown;
}

export interface HookVetoResult {
  refuse: true;
  reason: string;
  diagnostics?: unknown[];
}

export interface ShellListener {
  match: string | RegExp | (string | RegExp)[];
  onWrite?: (ctx: MutationCtx) => HookResult | undefined;
  onReplace?: (ctx: MutationCtx) => HookResult | undefined;
  onSplice?: (ctx: MutationCtx) => HookResult | undefined;
  onSed?: (ctx: MutationCtx) => HookResult | undefined;
  onPatch?: (ctx: MutationCtx) => HookResult | undefined;
  onInsert?: (ctx: MutationCtx) => HookResult | undefined;
  onAny?: (ctx: MutationCtx) => HookResult | undefined;
  onBefore?: (ctx: MutationCtx) => HookVetoResult | undefined;
}

export interface ShellResultBase {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  toString(): string;
}

export class ShellString implements ShellResultBase {
  constructor(stdout?: string, options?: { code?: number; stderr?: string; hookResult?: HookResult });
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly hookResult?: HookResult;
  toString(): string;
  to(file: string): this;
  toEnd(file: string): this;
  grep(...args: unknown[]): ShellString;
  sed(...args: unknown[]): ShellString;
  cat(...args: unknown[]): ShellString;
  head(...args: unknown[]): ShellString;
  tail(...args: unknown[]): ShellString;
  sort(...args: unknown[]): ShellString;
  uniq(...args: unknown[]): ShellString;
  wc(...args: unknown[]): ShellString;
}

export class ShellArrayResult<T = string> extends Array<T> implements ShellResultBase {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  toString(): string;
  to(file: string): this;
  toEnd(file: string): this;
  grep(...args: unknown[]): ShellString;
  sed(...args: unknown[]): ShellString;
  cat(...args: unknown[]): ShellString;
  head(...args: unknown[]): ShellString;
  tail(...args: unknown[]): ShellString;
  sort(compareFn?: (a: T, b: T) => number): this;
  sort(...args: unknown[]): ShellString;
  uniq(...args: unknown[]): ShellString;
  wc(...args: unknown[]): ShellString;
}

export type ShellResult = ShellString | ShellArrayResult;

export interface LongListEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mode: number;
  mtime: Date;
}

export class Shell {
  constructor(config: ShellConfig);
  readonly fs: VirtualFS;
  cwd: string;
  env: Record<string, string>;
  silent: boolean;
  fatal: boolean;
  setBeforeModel(model: unknown): void;
  resolvePath(target?: string): string;
  cd(target?: string): ShellString;
  pwd(): ShellString;
  echo(...values: unknown[]): ShellString;
  cat(...args: unknown[]): ShellString;
  find(...paths: string[]): ShellArrayResult<string>;
  grep(...args: unknown[]): ShellString;
  sed(...args: unknown[]): ShellString;
  head(...args: unknown[]): ShellString;
  tail(...args: unknown[]): ShellString;
  sort(...args: unknown[]): ShellString;
  uniq(...args: unknown[]): ShellString;
  wc(...args: unknown[]): ShellString;
  cp(...args: unknown[]): ShellString;
  mv(...args: unknown[]): ShellString;
  rm(...args: unknown[]): ShellString;
  mkdir(...args: unknown[]): ShellString;
  touch(...args: unknown[]): ShellString;
  write(...args: unknown[]): ShellString;
  ln(...args: unknown[]): ShellString;
  chmod(mode: string | number, ...paths: string[]): ShellString;
  ls(...args: unknown[]): ShellArrayResult<string | LongListEntry>;
  diff(...args: unknown[]): ShellString;
  splice(...args: unknown[]): ShellString;
  which(commandName: string): ShellString;
  realpath(target: string): ShellString;
  dirname(target: string): ShellString;
  basename(target: string, ext?: string): ShellString;
  test(flag: '-e' | '-f' | '-d' | '-L', target: string): boolean;
  glob(pattern: string): ShellArrayResult<string>;
}
