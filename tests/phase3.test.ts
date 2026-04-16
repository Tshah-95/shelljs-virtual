import { describe, expect, test } from 'bun:test';
import { assertFileContents, createTestShell } from './helpers.js';

describe('phase 3 text processing', () => {
  test('grep supports recursive search, line numbers, and include filtering', () => {
    const { shell } = createTestShell();

    const result = shell.grep('-rni', '--include=*.ts', 'export', '/project/src');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('src/index.ts:1:export { hello }');
    expect(result.stdout).toContain('src/utils/hello.ts:2:export function hello');
    expect(result.stdout).not.toContain('README.md');
  });

  test('grep supports invert, files-only, count, whole-word, include and exclude-dir filters', () => {
    const { shell } = createTestShell({
      ...createTestShell().vol.toJSON(),
      '/project/src/vendor/skip.ts': 'export const ignore = true;\n',
      '/project/src/math/adder.ts': 'export const adder = add;\n',
      '/project/src/react.tsx': 'import React from "react";\n',
    });

    expect(shell.grep('-v', 'export', '/project/README.md').stdout).toContain('# Test Project');
    expect(shell.grep('-rl', 'hello', '/project/src').stdout).toContain('src/index.ts');
    expect(shell.grep('-rl', 'import.*React', '/project/src').stdout).toContain('src/react.tsx');
    expect(shell.grep('-c', 'export', '/project/src/index.ts').stdout).toBe('2');
    expect(shell.grep('-w', 'add', '/project/src/math/add.ts').stdout).toContain('add =');

    const filtered = shell.grep(
      '-r',
      '--include=*.ts',
      '--exclude-dir=vendor',
      'export',
      '/project/src',
    );
    expect(filtered.stdout).not.toContain('vendor/skip.ts');
    expect(filtered.stdout).toContain('src/math/adder.ts');
  });

  test('grep supports context flags, max count, filename controls, and only-matching output', () => {
    const { shell } = createTestShell({
      '/project/log.txt': 'zero\none two\nTODO first\nmiddle\nbridge\nspacer\nTODO second\nend\n',
    });

    const context = shell.grep({ '-C': 1 }, 'TODO', '/project/log.txt');
    expect(context.stdout).toContain('one two');
    expect(context.stdout).toContain('middle');
    expect(context.stdout).toContain('--');

    const max = shell.grep('-m', '1', 'TODO', '/project/log.txt');
    expect(max.stdout).not.toContain('TODO second');

    expect(shell.grep('-H', 'TODO', '/project/log.txt').stdout).toContain('log.txt:TODO first');
    expect(shell.grep('-h', 'TODO', '/project/log.txt').stdout).toBe('TODO first\nTODO second');
    expect(shell.grep('-o', 'TODO', '/project/log.txt').stdout).toBe('TODO\nTODO');
  });

  test('grep supports piped input and skips binary-looking files', () => {
    const { shell, fs } = createTestShell({
      ...createTestShell().vol.toJSON(),
      '/project/src/binary.bin': 'a\u0000b',
    });

    const piped = shell.cat('/project/src/index.ts').grep('export');
    expect(piped.stdout).toContain('export { hello }');

    const recursive = shell.grep('-r', 'a', '/project/src');
    expect(recursive.stdout).not.toContain('binary.bin');
    expect(fs.readFileSync('/project/src/binary.bin') instanceof Uint8Array).toBe(true);
  });

  test('cat and grep return shell failures for missing paths instead of throwing', () => {
    const { shell } = createTestShell();

    const catResult = shell.cat('/project/missing.txt');
    expect(catResult.code).toBe(1);
    expect(catResult.stderr).toContain('ENOENT');

    const grepResult = shell.grep('hello', '/project/missing.txt');
    expect(grepResult.code).toBe(1);
    expect(grepResult.stderr).toContain('ENOENT');
  });

  test('sed supports in-place updates, capture groups, function replacements, and piping', () => {
    const { shell, vol } = createTestShell();

    const capture = shell.sed(/(hello)/g, 'greet-$1', '/project/src/index.ts');
    expect(capture.stdout).toContain('greet-hello');

    shell.sed('-i', /hello/g, 'greet', '/project/src/utils/hello.ts');
    assertFileContents(
      vol,
      '/project/src/utils/hello.ts',
      '// greeting utility\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
    );

    const functional = shell.sed(/add/g, (match) => match.toUpperCase(), '/project/src/math/add.ts');
    expect(functional.stdout).toContain('ADD');

    const piped = shell.cat('/project/src/math/add.ts').sed(/add/g, 'sum');
    expect(piped.stdout).toContain('sum =');
  });

  test('head and tail honor numeric options', () => {
    const { shell } = createTestShell({
      '/project/lines.txt': '1\n2\n3\n4\n5\n6\n',
    });

    expect(shell.head('/project/lines.txt').stdout).toBe('1\n2\n3\n4\n5\n6\n');
    expect(shell.head({ '-n': 3 }, '/project/lines.txt').stdout).toBe('1\n2\n3');
    expect(shell.head({ '-n': -2 }, '/project/lines.txt').stdout).toBe('1\n2\n3\n4');
    expect(shell.tail({ '-n': 2 }, '/project/lines.txt').stdout).toBe('5\n6\n');
    expect(shell.tail({ '-n': '+4' }, '/project/lines.txt').stdout).toBe('4\n5\n6\n');
  });

  test('sort, uniq, and wc cover the agent-oriented flags', () => {
    const { shell } = createTestShell({
      '/project/data.txt': '10 zebra\n2 yak\n2 yak\n30 ant\n',
      '/project/data.csv': 'pear,2\napple,10\nbanana,1\n',
    });

    expect(shell.sort('-n', '/project/data.txt').stdout).toBe('2 yak\n2 yak\n10 zebra\n30 ant');
    expect(shell.sort({ '-k': 2, '-r': true }, '/project/data.txt').stdout).toBe('10 zebra\n2 yak\n2 yak\n30 ant');
    expect(shell.sort({ '-t': ',', '-k': 2, '-n': true }, '/project/data.csv').stdout).toBe('banana,1\npear,2\napple,10');
    expect(shell.sort('-u', '/project/data.txt').stdout).toBe('10 zebra\n2 yak\n30 ant');

    expect(shell.uniq('-c', '/project/data.txt').stdout).toContain('2 2 yak');
    expect(shell.uniq('-d', '/project/data.txt').stdout).toBe('2 yak');
    expect(shell.uniq('-i', { stdin: 'A\na\nb' }).stdout).toBe('A\nb');

    expect(shell.wc('/project/data.txt').stdout).toContain('data.txt');
    expect(shell.wc('-l', '/project/data.txt').stdout.trim()).toEndWith('data.txt');
  });
});
