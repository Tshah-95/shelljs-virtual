import { describe, expect, test } from 'bun:test';
import { assertFileContents, assertFileExists, assertFileNotExists, createTestShell } from './helpers.js';

describe('phase 2 file commands', () => {
  test('cat concatenates files and numbers lines with -n', () => {
    const { shell } = createTestShell();

    const plain = shell.cat('/project/src/index.ts', '/project/README.md');
    expect(plain.stdout).toContain('export { hello }');
    expect(plain.stdout).toContain('# Test Project');

    const numbered = shell.cat('-n', '/project/src/index.ts');
    expect(numbered.stdout).toContain('     1  export { hello }');
    expect(numbered.stdout).toContain('     2  export { add }');
  });

  test('mkdir -p and touch create files in nested directories', () => {
    const { shell, vol } = createTestShell();

    shell.mkdir('-p', '/project/src/features/demo');
    shell.touch('/project/src/features/demo/index.ts');

    assertFileExists(vol, '/project/src/features/demo/index.ts');
    expect(shell.test('-d', '/project/src/features/demo')).toBe(true);
  });

  test('cp copies files and directories recursively', () => {
    const { shell, vol } = createTestShell();

    shell.cp('/project/src/index.ts', '/project/copied-index.ts');
    shell.cp('-R', '/project/src/utils', '/project/copied-utils');

    assertFileContents(vol, '/project/copied-index.ts', shell.cat('/project/src/index.ts').stdout);
    assertFileContents(
      vol,
      '/project/copied-utils/hello.ts',
      shell.cat('/project/src/utils/hello.ts').stdout,
    );
  });

  test('mv relocates files and preserves contents', () => {
    const { shell, vol } = createTestShell();

    shell.mkdir('-p', '/project/archive');
    shell.mv('/project/src/math/add.ts', '/project/archive/add.ts');

    assertFileExists(vol, '/project/archive/add.ts');
    assertFileNotExists(vol, '/project/src/math/add.ts');
    expect(shell.cat('/project/archive/add.ts').stdout).toContain('export const add');
  });

  test('rm removes files and directories recursively', () => {
    const { shell, vol } = createTestShell();

    shell.rm('/project/src/types.ts');
    shell.rm('-rf', '/project/src/utils');

    assertFileNotExists(vol, '/project/src/types.ts');
    assertFileNotExists(vol, '/project/src/utils/hello.ts');
  });

  test('ln -s creates symbolic links and chmod updates mode bits', () => {
    const { shell, fs } = createTestShell();

    shell.ln('-s', '/project/src/index.ts', '/project/src/index-link.ts');
    shell.chmod('755', '/project/src/index.ts');

    expect(shell.test('-L', '/project/src/index-link.ts')).toBe(true);
    expect(fs.statSync('/project/src/index.ts').mode).toBe(0o755);
  });

  test('ls supports recursive, all, directory, and long listing modes', () => {
    const { shell } = createTestShell({
      ...createTestShell().vol.toJSON(),
      '/project/.hidden': 'secret\n',
    });

    const recursive = shell.ls('-R', '/project/src');
    expect(recursive).toContain('src/index.ts');
    expect(recursive).toContain('src/utils/hello.ts');

    const all = shell.ls('-A', '/project');
    expect(all).toContain('.hidden');

    const directoryOnly = shell.ls('-d', '/project/src');
    expect(directoryOnly).toContain('src');

    const long = shell.ls('-l', '/project/src/index.ts');
    expect(typeof long[0]).toBe('object');
    expect((long[0] as { type: string }).type).toBe('file');
  });
});
