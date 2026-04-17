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
});
