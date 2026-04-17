import path from 'node:path';
import { Shell } from '../src/shell.js';
import type { VirtualDirent, VirtualFS, VirtualStat } from '../src/types.js';
import { dirnameVirtualPath, normalizeVirtualPath } from '../src/utils/path.js';

type NodeKind = 'file' | 'directory' | 'symlink';

interface VolumeNode {
  kind: NodeKind;
  name: string;
  mode: number;
  mtime: Date;
  data?: string;
  target?: string;
  children?: Map<string, VolumeNode>;
}

class MemoryStat implements VirtualStat {
  readonly mtime: Date;
  readonly size: number;
  readonly mode: number;
  private readonly kind: NodeKind;

  constructor(node: VolumeNode) {
    this.kind = node.kind;
    this.mtime = node.mtime;
    this.mode = node.mode;
    this.size = node.kind === 'file' ? Buffer.byteLength(node.data ?? '', 'utf8') : 0;
  }

  isFile(): boolean {
    return this.kind === 'file';
  }

  isDirectory(): boolean {
    return this.kind === 'directory';
  }

  isSymbolicLink(): boolean {
    return this.kind === 'symlink';
  }
}

class MemoryDirent implements VirtualDirent {
  readonly name: string;
  private readonly kind: NodeKind;

  constructor(node: VolumeNode) {
    this.name = node.name;
    this.kind = node.kind;
  }

  isFile(): boolean {
    return this.kind === 'file';
  }

  isDirectory(): boolean {
    return this.kind === 'directory';
  }

  isSymbolicLink(): boolean {
    return this.kind === 'symlink';
  }
}

function createDirectoryNode(name: string): VolumeNode {
  return {
    kind: 'directory',
    name,
    mode: 0o755,
    mtime: new Date(),
    children: new Map(),
  };
}

function createFileNode(name: string, data = ''): VolumeNode {
  return {
    kind: 'file',
    name,
    mode: 0o644,
    mtime: new Date(),
    data,
  };
}

function createSymlinkNode(name: string, target: string): VolumeNode {
  return {
    kind: 'symlink',
    name,
    mode: 0o777,
    mtime: new Date(),
    target,
  };
}

export class Volume {
  private readonly root: VolumeNode;

  constructor() {
    this.root = createDirectoryNode('');
  }

  static fromJSON(files: Record<string, string>): Volume {
    const volume = new Volume();
    for (const [filePath, contents] of Object.entries(files)) {
      volume.writeFileSync(filePath, contents, 'utf8');
    }
    return volume;
  }

  toJSON(): Record<string, string> {
    const snapshot: Record<string, string> = {};

    const visit = (basePath: string, node: VolumeNode): void => {
      if (node.kind === 'file') {
        snapshot[basePath] = node.data ?? '';
        return;
      }
      if (node.kind === 'symlink') {
        snapshot[`${basePath} ->`] = node.target ?? '';
        return;
      }

      for (const child of node.children?.values() ?? []) {
        const nextPath = basePath === '/' ? `/${child.name}` : `${basePath}/${child.name}`;
        visit(nextPath, child);
      }
    };

    visit('/', this.root);
    return snapshot;
  }

  existsSync(target: string): boolean {
    return this.lookup(target, true) !== null;
  }

  readFileSync(target: string, options?: unknown): string | Uint8Array {
    const node = this.requireNode(target);
    if (node.kind !== 'file') {
      throw new Error(`ENOENT: not a file: ${target}`);
    }

    const value = node.data ?? '';
    if (options === 'utf8' || (typeof options === 'object' && options !== null && 'encoding' in options)) {
      return value;
    }
    return Buffer.from(value, 'utf8');
  }

  writeFileSync(target: string, data: string | Uint8Array, _options?: unknown): void {
    const normalized = normalizeVirtualPath(target);
    this.ensureDirectory(dirnameVirtualPath(normalized));
    const parent = this.requireDirectory(dirnameVirtualPath(normalized));
    const name = path.posix.basename(normalized);
    parent.children!.set(name, createFileNode(name, typeof data === 'string' ? data : Buffer.from(data).toString('utf8')));
  }

  appendFileSync(target: string, data: string | Uint8Array, _options?: unknown): void {
    const normalized = normalizeVirtualPath(target);
    const value = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const existing = this.existsSync(normalized) ? String(this.readFileSync(normalized, 'utf8')) : '';
    this.writeFileSync(normalized, `${existing}${value}`);
  }

  statSync(target: string): VirtualStat {
    const node = this.requireNode(target, true);
    return new MemoryStat(node);
  }

  lstatSync(target: string): VirtualStat {
    const node = this.requireNode(target, false);
    return new MemoryStat(node);
  }

  readdirSync(target: string, options?: { withFileTypes?: boolean }): string[] | VirtualDirent[] {
    const node = this.requireNode(target, true);
    if (node.kind !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${target}`);
    }

    const entries = Array.from(node.children?.values() ?? []).sort((left, right) => left.name.localeCompare(right.name));
    return options?.withFileTypes ? entries.map((entry) => new MemoryDirent(entry)) : entries.map((entry) => entry.name);
  }

  mkdirSync(target: string, options?: { recursive?: boolean }): void {
    const normalized = normalizeVirtualPath(target);
    if (options?.recursive) {
      this.ensureDirectory(normalized);
      return;
    }

    const parent = this.requireDirectory(dirnameVirtualPath(normalized));
    const name = path.posix.basename(normalized);
    if (parent.children!.has(name)) {
      throw new Error(`EEXIST: file already exists: ${target}`);
    }
    parent.children!.set(name, createDirectoryNode(name));
  }

  rmSync(target: string): void {
    this.unlinkPath(target);
  }

  rmdirSync(target: string): void {
    this.unlinkPath(target);
  }

  unlinkSync(target: string): void {
    this.unlinkPath(target);
  }

  renameSync(oldPath: string, newPath: string): void {
    const sourceParent = this.requireDirectory(dirnameVirtualPath(oldPath));
    const sourceName = path.posix.basename(normalizeVirtualPath(oldPath));
    const node = sourceParent.children?.get(sourceName);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory: ${oldPath}`);
    }

    sourceParent.children!.delete(sourceName);
    this.ensureDirectory(dirnameVirtualPath(newPath));
    const destinationParent = this.requireDirectory(dirnameVirtualPath(newPath));
    const destinationName = path.posix.basename(normalizeVirtualPath(newPath));
    destinationParent.children!.set(destinationName, { ...this.cloneNode(node), name: destinationName });
  }

  copyFileSync(src: string, dest: string): void {
    const data = this.readFileSync(src);
    this.writeFileSync(dest, data as Uint8Array);
  }

  symlinkSync(target: string, linkPath: string): void {
    const normalized = normalizeVirtualPath(linkPath);
    this.ensureDirectory(dirnameVirtualPath(normalized));
    const parent = this.requireDirectory(dirnameVirtualPath(normalized));
    const name = path.posix.basename(normalized);
    parent.children!.set(name, createSymlinkNode(name, normalizeVirtualPath(target)));
  }

  readlinkSync(target: string): string {
    const node = this.requireNode(target, false);
    if (node.kind !== 'symlink') {
      throw new Error(`EINVAL: invalid argument: ${target}`);
    }
    return node.target ?? '';
  }

  chmodSync(target: string, mode: number): void {
    const node = this.requireNode(target, false);
    node.mode = mode;
  }

  realpathSync(target: string): string {
    return normalizeVirtualPath(this.resolveNode(target, true).path);
  }

  utimesSync(target: string, _atime: Date | number, mtime: Date | number): void {
    const node = this.requireNode(target, false);
    node.mtime = typeof mtime === 'number' ? new Date(mtime) : mtime;
  }

  private cloneNode(node: VolumeNode): VolumeNode {
    if (node.kind === 'directory') {
      const clone = createDirectoryNode(node.name);
      clone.mode = node.mode;
      clone.mtime = new Date(node.mtime);
      for (const child of node.children?.values() ?? []) {
        clone.children!.set(child.name, this.cloneNode(child));
      }
      return clone;
    }

    if (node.kind === 'symlink') {
      const clone = createSymlinkNode(node.name, node.target ?? '');
      clone.mode = node.mode;
      clone.mtime = new Date(node.mtime);
      return clone;
    }

    const clone = createFileNode(node.name, node.data ?? '');
    clone.mode = node.mode;
    clone.mtime = new Date(node.mtime);
    return clone;
  }

  private resolveNode(target: string, followLinks: boolean): { node: VolumeNode; path: string } {
    const normalized = normalizeVirtualPath(target);
    if (normalized === '/') {
      return { node: this.root, path: '/' };
    }

    const parts = normalized.split('/').filter(Boolean);
    let current = this.root;
    let currentPath = '/';

    for (const part of parts) {
      const next = current.children?.get(part);
      if (!next) {
        throw new Error(`ENOENT: no such file or directory: ${target}`);
      }

      currentPath = currentPath === '/' ? `/${part}` : `${currentPath}/${part}`;
      if (next.kind === 'symlink' && followLinks) {
        const resolved = this.resolveNode(next.target ?? '/', true);
        current = resolved.node;
        currentPath = resolved.path;
      } else {
        current = next;
      }
    }

    return { node: current, path: currentPath };
  }

  private lookup(target: string, followLinks: boolean): VolumeNode | null {
    try {
      return this.resolveNode(target, followLinks).node;
    } catch {
      return null;
    }
  }

  private requireNode(target: string, followLinks = true): VolumeNode {
    const node = this.lookup(target, followLinks);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory: ${target}`);
    }
    return node;
  }

  private ensureDirectory(target: string): void {
    const normalized = normalizeVirtualPath(target);
    if (normalized === '/') {
      return;
    }

    const parts = normalized.split('/').filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      let next = current.children?.get(part);
      if (!next) {
        next = createDirectoryNode(part);
        current.children!.set(part, next);
      }
      if (next.kind !== 'directory') {
        throw new Error(`ENOTDIR: not a directory: ${target}`);
      }
      current = next;
    }
  }

  private requireDirectory(target: string): VolumeNode {
    const node = this.requireNode(target, true);
    if (node.kind !== 'directory') {
      throw new Error(`ENOTDIR: not a directory: ${target}`);
    }
    return node;
  }

  private unlinkPath(target: string): void {
    const normalized = normalizeVirtualPath(target);
    if (normalized === '/') {
      throw new Error('EPERM: cannot remove root directory');
    }

    const parent = this.requireDirectory(dirnameVirtualPath(normalized));
    const name = path.posix.basename(normalized);
    if (!parent.children?.has(name)) {
      throw new Error(`ENOENT: no such file or directory: ${target}`);
    }
    parent.children.delete(name);
  }
}

export function createFsFromVolume(volume: Volume): VirtualFS {
  return {
    readFileSync: volume.readFileSync.bind(volume),
    writeFileSync: volume.writeFileSync.bind(volume),
    appendFileSync: volume.appendFileSync.bind(volume),
    existsSync: volume.existsSync.bind(volume),
    statSync: volume.statSync.bind(volume),
    lstatSync: volume.lstatSync.bind(volume),
    readdirSync: volume.readdirSync.bind(volume),
    mkdirSync: volume.mkdirSync.bind(volume),
    rmSync: volume.rmSync.bind(volume),
    rmdirSync: volume.rmdirSync.bind(volume),
    unlinkSync: volume.unlinkSync.bind(volume),
    renameSync: volume.renameSync.bind(volume),
    copyFileSync: volume.copyFileSync.bind(volume),
    symlinkSync: volume.symlinkSync.bind(volume),
    readlinkSync: volume.readlinkSync.bind(volume),
    chmodSync: volume.chmodSync.bind(volume),
    realpathSync: volume.realpathSync.bind(volume),
    utimesSync: volume.utimesSync.bind(volume),
  };
}

export const FIXTURE_PROJECT: Record<string, string> = {
  '/project/package.json': '{\n  "name": "test",\n  "version": "1.0.0"\n}\n',
  '/project/tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
  '/project/src/index.ts': 'export { hello } from "./utils/hello";\nexport { add } from "./math/add";\n',
  '/project/src/utils/hello.ts':
    '// greeting utility\nexport function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  '/project/src/utils/format.ts': 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n',
  '/project/src/math/add.ts': '// addition\nexport const add = (a: number, b: number): number => a + b;\n',
  '/project/src/math/multiply.ts':
    '// multiplication\nexport const multiply = (a: number, b: number): number => a * b;\n',
  '/project/src/types.ts':
    'export interface User {\n  id: number;\n  name: string;\n  email: string;\n}\n\nexport type Role = "admin" | "user" | "guest";\n',
  '/project/README.md': '# Test Project\n\nA sample project for testing.\n',
  '/project/.gitignore': 'node_modules\ndist\n*.js\n',
};

export function createTestShell(files: Record<string, string> = FIXTURE_PROJECT): {
  shell: Shell;
  vol: Volume;
  fs: VirtualFS;
} {
  const vol = Volume.fromJSON(files);
  const fs = createFsFromVolume(vol);
  const shell = new Shell({ fs, cwd: '/project', env: { PATH: '/project/bin:/bin' } });
  return { shell, vol, fs };
}

export function assertFileContents(vol: Volume, filePath: string, expected: string): void {
  const actual = vol.readFileSync(filePath, 'utf8') as string;
  if (actual !== expected) {
    throw new Error(`Expected ${filePath} to equal:\n${expected}\n\nReceived:\n${actual}`);
  }
}

export function assertFileExists(vol: Volume, filePath: string): void {
  if (!vol.existsSync(filePath)) {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
}

export function assertFileNotExists(vol: Volume, filePath: string): void {
  if (vol.existsSync(filePath)) {
    throw new Error(`Expected file not to exist: ${filePath}`);
  }
}
