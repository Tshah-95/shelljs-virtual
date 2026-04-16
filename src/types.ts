export interface VirtualStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mtime: Date;
  readonly size: number;
  readonly mode: number;
}

export interface VirtualDirent {
  name: string;
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

export interface ShellConfig {
  fs: VirtualFS;
  cwd?: string;
  env?: Record<string, string>;
  silent?: boolean;
  fatal?: boolean;
}

export interface ResultOptions {
  code?: number;
  stderr?: string;
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
}

export interface ParsedUniqOptions {
  count: boolean;
  duplicatesOnly: boolean;
  ignoreCase: boolean;
}

export interface ParsedGrepOptions {
  invert: boolean;
  filesWithMatches: boolean;
  ignoreCase: boolean;
  lineNumbers: boolean;
  recursive: boolean;
  countOnly: boolean;
  wordRegexp: boolean;
  include: string[];
  exclude: string[];
  excludeDir: string[];
  after: number;
  before: number;
  maxCount?: number;
  withFilename?: boolean;
  onlyMatching: boolean;
}
