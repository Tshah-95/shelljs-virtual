import { describe, expect, test } from 'bun:test';
import { createTestShell } from './helpers.js';

describe('diff review modes', () => {
  test('diff supports multi-hunk output with configurable context', () => {
    const { shell } = createTestShell({
      '/project/left.ts': 'a\nkeep\nmiddle\nkeep\nz\n',
      '/project/right.ts': 'b\nkeep\nmiddle\nkeep\ny\n',
    });

    const result = shell.diff('-U0', '/project/left.ts', '/project/right.ts');

    expect(result.code).toBe(1);
    expect(result.stdout.match(/@@ /g)?.length).toBe(2);
    expect(result.stdout).toContain('--- left.ts');
    expect(result.stdout).toContain('+++ right.ts');
    expect(result.stdout).toContain('-a');
    expect(result.stdout).toContain('+b');
    expect(result.stdout).not.toContain('\n keep\n');
  });

  test('diff supports directory name-only and stat views with stable ordering', () => {
    const { shell } = createTestShell({
      '/before/a.ts': 'left\n',
      '/before/removed.ts': 'gone\n',
      '/after/a.ts': 'right\n',
      '/after/added.ts': 'new\n',
    });

    const names = shell.diff('--name-only', '/before', '/after');
    expect(names.code).toBe(1);
    expect(names.stdout).toBe('a.ts\nadded.ts\nremoved.ts');

    const stat = shell.diff('--stat', '/before', '/after');
    expect(stat.code).toBe(1);
    expect(stat.stdout).toContain('a.ts');
    expect(stat.stdout).toContain('added.ts');
    expect(stat.stdout).toContain('removed.ts');
  });

  test('diff rejects missing paths and file-directory mismatches clearly', () => {
    const { shell } = createTestShell({
      '/project/file.ts': 'value\n',
      '/project/dir/nested.ts': 'nested\n',
    });

    const missing = shell.diff('/project/file.ts', '/project/missing.ts');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('diff: both paths must exist');

    const mismatch = shell.diff('/project/file.ts', '/project/dir');
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toBe('diff: cannot compare file to directory');
  });

  test('diff renders no-final-newline markers explicitly', () => {
    const { shell } = createTestShell({
      '/project/left.txt': 'one\ntwo',
      '/project/right.txt': 'one\nTWO',
    });

    const result = shell.diff('/project/left.txt', '/project/right.txt');

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('-two');
    expect(result.stdout).toContain('+TWO');
    expect(result.stdout.match(/\\ No newline at end of file/g)?.length).toBe(2);
  });

  test('diff reports binary files and unicode paths explicitly', () => {
    const { shell, fs } = createTestShell({
      '/before/naïve-🙂.ts': 'export const café = "🙂";\n',
      '/after/naïve-🙂.ts': 'export const café = "🚀";\n',
    });

    fs.writeFileSync('/before/blob.bin', new Uint8Array([0, 1]));
    fs.writeFileSync('/after/blob.bin', new Uint8Array([0, 2]));

    const binary = shell.diff('/before', '/after');
    expect(binary.code).toBe(1);
    expect(binary.stdout).toContain('Binary files blob.bin and blob.bin differ');
    expect(binary.stdout).toContain('naïve-🙂.ts');
    expect(binary.stdout).toContain('"🚀"');

    const stat = shell.diff('--stat', '/before', '/after');
    expect(stat.code).toBe(1);
    expect(stat.stdout).toContain('binary blob.bin');
    expect(stat.stdout).toContain('naïve-🙂.ts');
  });
});
