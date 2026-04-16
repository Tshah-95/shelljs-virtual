import path from 'node:path';

const ROOT = '/';

export function normalizeVirtualPath(inputPath: string): string {
  if (inputPath.length === 0) {
    return ROOT;
  }

  const normalized = path.posix.normalize(inputPath);
  if (normalized === '.' || normalized === '') {
    return ROOT;
  }

  return normalized.startsWith(ROOT) ? normalized : path.posix.join(ROOT, normalized);
}

export function resolveVirtualPath(cwd: string, target = '.'): string {
  if (target.length === 0) {
    return normalizeVirtualPath(cwd);
  }
  return normalizeVirtualPath(path.posix.isAbsolute(target) ? target : path.posix.resolve(cwd, target));
}

export function dirnameVirtualPath(target: string): string {
  const resolved = normalizeVirtualPath(target);
  return normalizeVirtualPath(path.posix.dirname(resolved));
}

export function basenameVirtualPath(target: string, ext?: string): string {
  return path.posix.basename(normalizeVirtualPath(target), ext);
}
