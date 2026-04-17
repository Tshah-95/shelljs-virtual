import { describe, expect, test } from 'bun:test';
import { assertFileContents, createTestShell } from './helpers.js';

describe('exact edit primitives', () => {
  test('replace updates a single exact match in a file', () => {
    const { shell, vol } = createTestShell();

    const result = shell.replace('/project/src/utils/hello.ts', 'Hello', 'Greetings');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Greetings');
    assertFileContents(
      vol,
      '/project/src/utils/hello.ts',
      '// greeting utility\nexport function hello(name: string): string {\n  return `Greetings, ${name}!`;\n}\n',
    );
  });

  test('replace fails loudly on ambiguous exact matches by default', () => {
    const { shell, vol } = createTestShell({
      '/project/demo.ts': 'foo\nfoo\n',
    });

    const result = shell.replace('/project/demo.ts', 'foo', 'bar');

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('replace: expected exactly 1 match in demo.ts, found 2');
    assertFileContents(vol, '/project/demo.ts', 'foo\nfoo\n');
  });

  test('replace supports dry-run, regex mode, and piped stdin', () => {
    const { shell } = createTestShell();

    const result = shell.echo('import x\nimport y\n').replace('--dry-run', '--regex', '--expected=2', 'import\\s+', 'export ');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('export x\nexport y\n');
  });

  test('replace accepts LF-authored search text against CRLF files and preserves newline style', () => {
    const { shell, vol } = createTestShell({
      '/project/crlf.ts': 'first\r\nsecond\r\n',
    });

    const preview = shell.replace('--dry-run', '/project/crlf.ts', 'first\n', 'uno\n');
    expect(preview.code).toBe(0);
    expect(preview.stdout).toBe('uno\r\nsecond\r\n');
    assertFileContents(vol, '/project/crlf.ts', 'first\r\nsecond\r\n');

    const applied = shell.replace('/project/crlf.ts', 'first\n', 'uno\n');
    expect(applied.code).toBe(0);
    assertFileContents(vol, '/project/crlf.ts', 'uno\r\nsecond\r\n');
  });

  test('replace can intentionally update all matches', () => {
    const { shell, vol } = createTestShell({
      '/project/demo.ts': 'foo\nfoo\n',
    });

    const result = shell.replace('--all', '/project/demo.ts', 'foo', 'bar');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/project/demo.ts', 'bar\nbar\n');
  });

  test('insert supports anchor-based placement and dry-run', () => {
    const { shell, vol } = createTestShell();

    const preview = shell.insert(
      '--dry-run',
      '--after',
      '/project/src/index.ts',
      'export { hello } from "./utils/hello";\n',
      'import type { User } from "./types";\n',
    );

    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain('import type { User } from "./types";');
    assertFileContents(vol, '/project/src/index.ts', 'export { hello } from "./utils/hello";\nexport { add } from "./math/add";\n');

    const applied = shell.insert(
      '--after',
      '/project/src/index.ts',
      'export { hello } from "./utils/hello";\n',
      'import type { User } from "./types";\n',
    );

    expect(applied.code).toBe(0);
    assertFileContents(
      vol,
      '/project/src/index.ts',
      'export { hello } from "./utils/hello";\nimport type { User } from "./types";\nexport { add } from "./math/add";\n',
    );
  });

  test('insert supports file-boundary insertion and rejects ambiguous anchors', () => {
    const { shell, vol } = createTestShell({
      '/project/demo.ts': 'target\ntarget\n',
      '/project/empty.ts': '',
    });

    const atStart = shell.insert('--at-start', '/project/empty.ts', 'export const ready = true;\n');
    expect(atStart.code).toBe(0);
    assertFileContents(vol, '/project/empty.ts', 'export const ready = true;\n');

    const ambiguous = shell.insert('--before', '/project/demo.ts', 'target\n', '// note\n');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toBe('insert: expected exactly 1 anchor match in demo.ts, found 2');
    assertFileContents(vol, '/project/demo.ts', 'target\ntarget\n');
  });

  test('insert accepts LF-authored anchors against CRLF files and preserves newline style', () => {
    const { shell, vol } = createTestShell({
      '/project/crlf.ts': 'uno\r\nsecond\r\n',
    });

    const preview = shell.insert('--dry-run', '--after', '/project/crlf.ts', 'uno\n', 'dos\n');
    expect(preview.code).toBe(0);
    expect(preview.stdout).toBe('uno\r\ndos\r\nsecond\r\n');
    assertFileContents(vol, '/project/crlf.ts', 'uno\r\nsecond\r\n');

    const applied = shell.insert('--after', '/project/crlf.ts', 'uno\n', 'dos\n');
    expect(applied.code).toBe(0);
    assertFileContents(vol, '/project/crlf.ts', 'uno\r\ndos\r\nsecond\r\n');
  });

  test('replace preserves missing trailing newlines on unicode paths and content', () => {
    const { shell, vol } = createTestShell({
      '/project/naïve-🙂.ts': 'export const café = "🙂";',
    });

    const result = shell.replace('/project/naïve-🙂.ts', 'café', 'bistro');

    expect(result.code).toBe(0);
    assertFileContents(vol, '/project/naïve-🙂.ts', 'export const bistro = "🙂";');
  });
});
