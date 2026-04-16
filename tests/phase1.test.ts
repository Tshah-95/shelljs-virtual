import { describe, expect, test } from 'bun:test';
import { createTestShell } from './helpers.js';

describe('phase 1 infrastructure', () => {
  test('constructs a shell with a virtual cwd', () => {
    const { shell } = createTestShell();

    expect(shell.cwd).toBe('/project');
    expect(shell.resolvePath('./src/index.ts')).toBe('/project/src/index.ts');
    expect(shell.resolvePath('../project/README.md')).toBe('/project/README.md');
  });

  test('changes directories without mutating the process cwd', () => {
    const { shell } = createTestShell();

    expect(shell.cd('src').code).toBe(0);
    expect(shell.pwd().stdout).toBe('/project/src');
    expect(shell.cd('utils').stdout).toBe('/project/src/utils');
    expect(shell.cd('../math').stdout).toBe('/project/src/math');
  });

  test('writes result output back into the virtual filesystem', () => {
    const { shell, vol } = createTestShell();

    shell.echo('hello').to('/project/out.txt');
    shell.echo(' world').toEnd('/project/out.txt');

    expect(vol.readFileSync('/project/out.txt', 'utf8')).toBe('hello world');
  });

  test('expands glob patterns using the injected filesystem', () => {
    const { shell } = createTestShell();

    expect(shell.glob('/project/src/**/*.ts')).toEqual([
      '/project/src/index.ts',
      '/project/src/math/add.ts',
      '/project/src/math/multiply.ts',
      '/project/src/types.ts',
      '/project/src/utils/format.ts',
      '/project/src/utils/hello.ts',
    ]);
  });

  test('supports basic piping against shell results', () => {
    const { shell } = createTestShell();

    const result = shell.echo('c', 'a', 'b').sort().uniq().head(1);
    expect(result.stdout).toBe('c a b');
  });
});
