import path from 'node:path';
import { isDirectory, readdirEntryName } from '../common.js';
import type { VirtualFS } from '../types.js';
import { dirnameVirtualPath, normalizeVirtualPath, resolveVirtualPath } from './path.js';

function hasMagic(pattern: string): boolean {
  return /[*?{]/.test(pattern);
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) {
    return [pattern];
  }

  const [token, rawOptions] = match;
  if (!rawOptions) {
    return [pattern];
  }
  return rawOptions
    .split(',')
    .flatMap((option) => expandBraces(pattern.replace(token, option)));
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matchSegment(patternSegment: string, candidate: string): boolean {
  const source = `^${Array.from(patternSegment)
    .map((char) => {
      if (char === '*') {
        return '[^/]*';
      }
      if (char === '?') {
        return '[^/]';
      }
      return escapeRegex(char);
    })
    .join('')}$`;

  return new RegExp(source).test(candidate);
}

function matchSegments(patternSegments: string[], candidateSegments: string[]): boolean {
  if (patternSegments.length === 0) {
    return candidateSegments.length === 0;
  }

  const head = patternSegments[0]!;
  const tail = patternSegments.slice(1);
  if (head === '**') {
    if (matchSegments(tail, candidateSegments)) {
      return true;
    }
    return candidateSegments.length > 0 ? matchSegments(patternSegments, candidateSegments.slice(1)) : false;
  }

  if (candidateSegments.length === 0 || !matchSegment(head, candidateSegments[0]!)) {
    return false;
  }

  return matchSegments(tail, candidateSegments.slice(1));
}

export function matchesGlob(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeVirtualPath(pattern);
  const normalizedCandidate = normalizeVirtualPath(candidate);
  const patternSegments = normalizedPattern.split('/').filter(Boolean);
  const candidateSegments = normalizedCandidate.split('/').filter(Boolean);
  return matchSegments(patternSegments, candidateSegments);
}

function walkTree(fs: VirtualFS, currentPath: string, acc: string[]): void {
  acc.push(currentPath);
  if (!isDirectory(fs, currentPath)) {
    return;
  }

  const entries = fs.readdirSync(currentPath);
  for (const entry of entries) {
    const name = readdirEntryName(entry);
    walkTree(fs, normalizeVirtualPath(path.posix.join(currentPath, name)), acc);
  }
}

export function expandGlob(fs: VirtualFS, cwd: string, pattern: string): string[] {
  const resolvedVariants = expandBraces(resolveVirtualPath(cwd, pattern));
  const exactMatches = resolvedVariants.filter((variant) => !hasMagic(variant));
  if (exactMatches.length === resolvedVariants.length) {
    return exactMatches.filter((variant) => fs.existsSync(variant)).sort((left, right) => left.localeCompare(right));
  }

  const prefixes = resolvedVariants.map((variant) => {
    const index = variant.search(/[*?{]/);
    if (index === -1) {
      return dirnameVirtualPath(variant);
    }
    const slice = variant.slice(0, index);
    const prefix = slice.endsWith('/') ? slice.slice(0, -1) : slice;
    return prefix.length === 0 ? '/' : dirnameVirtualPath(prefix);
  });

  const root = prefixes.sort((left, right) => left.length - right.length)[0] ?? '/';
  const walked: string[] = [];
  walkTree(fs, root, walked);

  return walked
    .filter((candidate) => resolvedVariants.some((variant) => matchesGlob(variant, candidate)))
    .sort((left, right) => left.localeCompare(right));
}
