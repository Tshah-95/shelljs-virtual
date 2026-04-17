import path from 'node:path';
import type { VirtualDirent, VirtualFS, VirtualStat } from './types.js';
import { basenameVirtualPath, dirnameVirtualPath, normalizeVirtualPath } from './utils/path.js';

export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function safeStat(fs: VirtualFS, target: string, dereference = true): VirtualStat | null {
  try {
    if (!dereference && fs.lstatSync) {
      return fs.lstatSync(target);
    }
    return fs.statSync(target);
  } catch {
    return null;
  }
}

export function isDirectory(fs: VirtualFS, target: string): boolean {
  return safeStat(fs, target)?.isDirectory() ?? false;
}

export function isFile(fs: VirtualFS, target: string): boolean {
  return safeStat(fs, target)?.isFile() ?? false;
}

export function ensureParentDir(fs: VirtualFS, target: string): void {
  const parent = dirnameVirtualPath(target);
  if (parent !== target && !fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

export function decodeText(value: string | Uint8Array): string {
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.from(value).toString('utf8');
}

export function readdirEntryName(entry: string | Uint8Array | VirtualDirent): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry instanceof Uint8Array) {
    return decodeText(entry);
  }
  return decodeText(entry.name);
}

export function readTextFile(fs: VirtualFS, target: string): string {
  return decodeText(fs.readFileSync(target, 'utf8'));
}

export function writeTextFile(fs: VirtualFS, target: string, value: string): void {
  ensureParentDir(fs, target);
  fs.writeFileSync(target, value, 'utf8');
}

export function appendTextFile(fs: VirtualFS, target: string, value: string): void {
  ensureParentDir(fs, target);
  if (fs.appendFileSync) {
    fs.appendFileSync(target, value, 'utf8');
    return;
  }

  const existing = fs.existsSync(target) ? readTextFile(fs, target) : '';
  fs.writeFileSync(target, `${existing}${value}`, 'utf8');
}

export function splitLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  const normalized = value.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    parts.pop();
  }
  return parts;
}

export function joinLines(lines: string[], trailingNewline = false): string {
  const content = lines.join('\n');
  return trailingNewline && lines.length > 0 ? `${content}\n` : content;
}

export function hasTrailingNewline(value: string): boolean {
  return value.endsWith('\n');
}

export function detectNewlineStyle(value: string): '\n' | '\r\n' {
  const crlfCount = value.match(/\r\n/g)?.length ?? 0;
  const newlineCount = value.match(/\n/g)?.length ?? 0;
  const lfCount = newlineCount - crlfCount;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

export function normalizeToNewlineStyle(value: string, newline: '\n' | '\r\n'): string {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, newline);
}

export function relativeDisplayPath(cwd: string, absolutePath: string): string {
  const relative = path.posix.relative(normalizeVirtualPath(cwd), normalizeVirtualPath(absolutePath));
  return relative.length === 0 ? '.' : relative;
}

export function basename(target: string): string {
  return basenameVirtualPath(target);
}

export function normalizeInputPath(cwd: string, value: string): string {
  if (value.startsWith('/')) {
    return normalizeVirtualPath(value);
  }
  return normalizeVirtualPath(path.posix.resolve(cwd, value));
}

export function parseMode(mode: number | string): number {
  if (typeof mode === 'number') {
    return mode;
  }

  if (/^[0-7]{3,4}$/.test(mode)) {
    return Number.parseInt(mode, 8);
  }

  throw new Error(`Unsupported chmod mode: ${mode}`);
}

export function looksBinary(value: string | Uint8Array): boolean {
  const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  return sample.includes(0);
}
