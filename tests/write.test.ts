import { describe, expect, test } from 'bun:test';
import { assertFileContents, assertFileNotExists, createTestShell } from './helpers.js';

describe('Shell.write', () => {
  test('creates a new file with the given content', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write('/scratch/notes.md', '# hello\nbody\n');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('wrote 13 bytes');
    expect(result.stdout).toContain('/scratch/notes.md');
    assertFileContents(vol, '/scratch/notes.md', '# hello\nbody\n');
  });

  test('overwrites an existing file with new content', () => {
    const { shell, vol } = createTestShell({
      '/project/main.txt': 'old contents',
    });

    const result = shell.write('/project/main.txt', 'new contents');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/project/main.txt', 'new contents');
  });

  test('auto-creates missing parent directories', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write('/deep/nested/dir/file.txt', 'x');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/deep/nested/dir/file.txt', 'x');
  });

  test('missing content arg writes an empty file', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write('/blank.txt');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/blank.txt', '');
  });

  test('rejects empty path', () => {
    const { shell } = createTestShell();

    const result = shell.write('', 'content');

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('non-empty');
  });

  test('rejects when no positional args supplied', () => {
    const { shell } = createTestShell();

    const result = shell.write();

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('requires a target path');
  });

  test('rejects extra positional args (likely a tool-call mistake)', () => {
    const { shell } = createTestShell();

    const result = shell.write('/foo', 'a', 'b');

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('positional args');
  });

  test('relative paths resolve against cwd', () => {
    const { shell, vol } = createTestShell();
    shell.cd('/project');

    const result = shell.write('foo.txt', 'data');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/project/foo.txt', 'data');
  });

  // Regression — path traversal attacks via `..` segments. Without the
  // normalize-then-check pass, a startsWith-on-raw-input root check
  // would falsely accept these inputs.
  test('normalizes `..` segments before applying root check', () => {
    const { shell, vol } = createTestShell();

    // Without --root, traversal still normalizes: /repo/foo/../../bar.txt → /bar.txt
    const result = shell.write('/repo/foo/../../bar.txt', 'esc');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/bar.txt', 'esc');
  });

  test('rejects writes outside --root allowlist', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write('--root=/repo', '/etc/passwd', 'oops');

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('outside allowed roots');
    assertFileNotExists(vol, '/etc/passwd');
  });

  test('rejects `..` traversal that escapes --root after normalize', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write(
      '--root=/repo',
      '/repo/foo/../../etc/shadow',
      'p',
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('outside allowed roots');
    assertFileNotExists(vol, '/etc/shadow');
  });

  test('rejects multi-slash paths that escape --root after normalize', () => {
    const { shell, vol } = createTestShell();

    // `///docs/foo` normalizes to `/docs/foo` — outside /repo allowlist.
    const result = shell.write('--root=/repo', '///docs/foo', 'x');

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('outside allowed roots');
    assertFileNotExists(vol, '/docs/foo');
  });

  test('accepts paths under --root after normalize', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write(
      '--root=/repo',
      '/repo/scenarios/aggressive.yaml',
      'name: aggressive',
    );

    expect(result.code).toBe(0);
    assertFileContents(
      vol,
      '/repo/scenarios/aggressive.yaml',
      'name: aggressive',
    );
  });

  test('--root accepts repeated flag for multiple allowed roots', () => {
    const { shell, vol } = createTestShell();

    const r1 = shell.write('--root=/repo', '--root=/scratch', '/scratch/a', '1');
    const r2 = shell.write('--root=/repo', '--root=/scratch', '/repo/b', '2');
    const r3 = shell.write('--root=/repo', '--root=/scratch', '/etc/c', '3');

    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(r3.code).toBe(2);
    assertFileContents(vol, '/scratch/a', '1');
    assertFileContents(vol, '/repo/b', '2');
  });

  test('--root accepts space-separated form too', () => {
    const { shell, vol } = createTestShell();

    const result = shell.write('--root', '/repo', '/repo/x.txt', 'data');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/repo/x.txt', 'data');
  });

  test('--root requires a value (rejects --root with no following arg)', () => {
    const { shell } = createTestShell();

    const result = shell.write('--root');

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--root requires a path');
  });

  test('exact root path (no subpath) is accepted', () => {
    // /repo with --root=/repo — writing TO /repo would create a file at
    // the root mount, which is an unusual but well-defined operation.
    // Validate the boundary: the path EQUAL to the root (no trailing
    // slash) is treated as inside the root.
    const { shell, vol } = createTestShell();

    const result = shell.write('--root=/repo', '/repo', 'data');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/repo', 'data');
  });
});
