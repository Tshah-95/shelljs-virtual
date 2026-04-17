import { describe, expect, test } from 'bun:test';
import { assertFileContents, createTestShell } from './helpers.js';

describe('failure semantics', () => {
  test('cp, mv, and rm validate all inputs before mutating', () => {
    const { shell, vol } = createTestShell({
      '/project/a.txt': 'a\n',
      '/project/b.txt': 'b\n',
    });

    const copy = shell.cp('a.txt', 'missing.txt', 'copies');
    expect(copy.code).toBe(1);
    expect(copy.stderr).toBe('cp: no such file or directory: missing.txt');
    expect(vol.existsSync('/project/copies')).toBe(false);
    assertFileContents(vol, '/project/a.txt', 'a\n');

    const move = shell.mv('a.txt', 'missing.txt', 'moved');
    expect(move.code).toBe(1);
    expect(move.stderr).toBe('mv: no such file or directory: missing.txt');
    expect(vol.existsSync('/project/moved')).toBe(false);
    assertFileContents(vol, '/project/a.txt', 'a\n');

    const remove = shell.rm('a.txt', 'missing.txt');
    expect(remove.code).toBe(1);
    expect(remove.stderr).toBe('rm: no such file or directory: missing.txt');
    assertFileContents(vol, '/project/a.txt', 'a\n');
  });

  test('text commands reject mixed stdin and file-path input, and pipes preserve upstream failures', () => {
    const { shell } = createTestShell({
      '/project/list.txt': 'pear\napple\n',
    });

    const mixedCat = shell.echo('x').cat('/project/list.txt');
    expect(mixedCat.code).toBe(1);
    expect(mixedCat.stderr).toBe('cat: provide either stdin or file paths, not both');

    const mixedSort = shell.echo('x').sort('/project/list.txt');
    expect(mixedSort.code).toBe(1);
    expect(mixedSort.stderr).toBe('sort: provide either stdin or file paths, not both');

    const mixedGrep = shell.echo('x').grep('x', '/project/list.txt');
    expect(mixedGrep.code).toBe(1);
    expect(mixedGrep.stderr).toBe('grep: provide either stdin or file paths, not both');

    const missing = shell.cat('/project/missing.txt');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('cat: no such file or directory: missing.txt');

    const downstream = missing.head(1);
    expect(downstream.code).toBe(1);
    expect(downstream.stderr).toBe('cat: no such file or directory: missing.txt');
    expect(downstream.stdout).toBe('');
  });

  test('text-oriented file reads and mutations fail clearly on missing or binary targets', () => {
    const { shell, fs } = createTestShell();
    fs.writeFileSync('/project/blob.bin', new Uint8Array([0, 1, 2, 3]));

    const sedMissing = shell.sed('-i', /hello/g, 'greet', '/project/missing.ts');
    expect(sedMissing.code).toBe(1);
    expect(sedMissing.stderr).toBe('sed: no such file or directory: missing.ts');

    const sedBinary = shell.sed('-i', /a/g, 'b', '/project/blob.bin');
    expect(sedBinary.code).toBe(1);
    expect(sedBinary.stderr).toBe('sed: binary file not supported: blob.bin');

    const spliceBinary = shell.splice('/project/blob.bin', 1, 1, 'x');
    expect(spliceBinary.code).toBe(1);
    expect(spliceBinary.stderr).toBe('splice: binary file not supported: blob.bin');

    const showMissing = shell.show('/project/missing.ts', 1, 1);
    expect(showMissing.code).toBe(1);
    expect(showMissing.stderr).toBe('show: no such file or directory: missing.ts');

    const realpathMissing = shell.realpath('/project/missing.ts');
    expect(realpathMissing.code).toBe(1);
    expect(realpathMissing.stderr).toBe('realpath: no such file or directory: missing.ts');
  });

  test('find and ls fail cleanly on missing explicit paths', () => {
    const { shell } = createTestShell();

    const found = shell.find('/project/missing');
    expect(found.code).toBe(1);
    expect(found.stderr).toBe('find: no such file or directory: missing');
    expect([...found]).toEqual([]);

    const listed = shell.ls('/project/missing');
    expect(listed.code).toBe(1);
    expect(listed.stderr).toBe('ls: no such file or directory: missing');
    expect([...listed]).toEqual([]);
  });
});
