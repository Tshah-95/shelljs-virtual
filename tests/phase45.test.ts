import { describe, expect, test } from 'bun:test';
import { assertFileContents, createTestShell } from './helpers.js';

describe('phase 4 and 5 commands', () => {
  test('find walks the virtual tree and diff emits unified output', () => {
    const { shell, vol } = createTestShell();

    const found = shell.find('/project/src');
    expect(found).toContain('/project/src/utils/hello.ts');
    expect(found).toContain('/project/src/math/multiply.ts');

    shell.cp('/project/src/utils/hello.ts', '/project/tmp-hello.ts');
    shell.sed('-i', /Hello/g, 'Greetings', '/project/src/utils/hello.ts');

    const diff = shell.diff('/project/tmp-hello.ts', '/project/src/utils/hello.ts');
    expect(diff.code).toBe(1);
    expect(diff.stdout).toContain('--- tmp-hello.ts');
    expect(diff.stdout).toContain('+++ src/utils/hello.ts');
    expect(diff.stdout).toContain('+  return `Greetings, ${name}!`;');

    const same = shell.diff('/project/tmp-hello.ts', '/project/tmp-hello.ts');
    expect(same.code).toBe(0);
    expect(same.stdout).toBe('');

    shell.rm('/project/tmp-hello.ts');
    expect(vol.existsSync('/project/tmp-hello.ts')).toBe(false);
  });

  test('splice edits files by line range and supports dry-run mode', () => {
    const { shell, vol } = createTestShell({
      '/project/demo.ts': 'line1\nline2\nline3\nline4\n',
    });

    const preview = shell.splice('-d', '/project/demo.ts', 2, 1, 'replacement');
    expect(preview.stdout).toBe('line1\nreplacement\nline3\nline4\n');
    assertFileContents(vol, '/project/demo.ts', 'line1\nline2\nline3\nline4\n');

    const updated = shell.splice('/project/demo.ts', 3, 2, 'fresh', 'tail');
    expect(updated.stdout).toBe('line1\nline2\nfresh\ntail\n');
    assertFileContents(vol, '/project/demo.ts', 'line1\nline2\nfresh\ntail\n');
  });

  test('path helpers resolve through the virtual filesystem', () => {
    const { shell } = createTestShell();

    expect(shell.realpath('./src/index.ts').stdout).toBe('/project/src/index.ts');
    expect(shell.dirname('/project/src/utils/hello.ts').stdout).toBe('/project/src/utils');
    expect(shell.basename('/project/src/utils/hello.ts', '.ts').stdout).toBe('hello');
  });

  test('which searches the virtual PATH instead of the real system', () => {
    const { shell } = createTestShell({
      ...createTestShell().vol.toJSON(),
      '/project/bin/grep': '#!/bin/virtual\n',
    });

    expect(shell.which('grep').stdout).toBe('/project/bin/grep');
    expect(shell.which('missing').code).toBe(1);
  });

  test('pipes compose across multiple commands and file redirection', () => {
    const { shell, vol } = createTestShell({
      '/project/list.txt': 'pear\napple\napple\nbanana\n',
    });

    const chained = shell.cat('/project/list.txt').sort().uniq().head({ '-n': 2 });
    expect(chained.stdout).toBe('apple\nbanana');

    chained.to('/project/out.txt');
    shell.echo('carrot').toEnd('/project/out.txt');
    assertFileContents(vol, '/project/out.txt', 'apple\nbananacarrot');
  });

  test('empty and failing pipes preserve non-zero status', () => {
    const { shell } = createTestShell();

    const missing = shell.grep('not-found', '/project/README.md');
    expect(missing.code).toBe(1);
    expect(missing.sort().code).toBe(1);
    expect(missing.sort().stdout).toBe('');

    const empty = shell.echo('').grep('x');
    expect(empty.code).toBe(1);
    expect(empty.head(1).code).toBe(1);
  });
});
