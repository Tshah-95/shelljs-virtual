import { describe, expect, test } from 'bun:test';
import { createTestShell } from './helpers.js';

describe('show command', () => {
  test('shows exact line ranges with optional numbering', () => {
    const { shell } = createTestShell();

    const plain = shell.show('/project/src/index.ts', 1, 2);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe('export { hello } from "./utils/hello";\nexport { add } from "./math/add";');

    const numbered = shell.show('--numbers', '/project/src/index.ts', 1, 2);
    expect(numbered.code).toBe(0);
    expect(numbered.stdout).toBe('     1  export { hello } from "./utils/hello";\n     2  export { add } from "./math/add";');
  });

  test('supports around-line and around-match contextual reads', () => {
    const { shell } = createTestShell({
      '/project/demo.ts': 'one\ntwo\nthree\nfour\nfive\n',
    });

    const aroundLine = shell.show('--around-line', 3, '--context', 1, '/project/demo.ts');
    expect(aroundLine.code).toBe(0);
    expect(aroundLine.stdout).toBe('two\nthree\nfour');

    const aroundMatch = shell.show('--around-match', 'three', '--context', 1, '/project/demo.ts');
    expect(aroundMatch.code).toBe(0);
    expect(aroundMatch.stdout).toBe('two\nthree\nfour');
  });

  test('fails clearly on invalid ranges and ambiguous match lookups', () => {
    const { shell } = createTestShell({
      '/project/demo.ts': 'target\nother\ntarget\n',
    });

    const invalidRange = shell.show('/project/demo.ts', 3, 5);
    expect(invalidRange.code).toBe(1);
    expect(invalidRange.stderr).toBe('show: invalid line range for demo.ts: 3-5');

    const ambiguous = shell.show('--around-match', 'target', '/project/demo.ts');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toBe('show: expected exactly 1 match in demo.ts, found 2');
  });

  test('normalizes CRLF reads, preserves missing trailing newlines, and treats empty files explicitly', () => {
    const { shell } = createTestShell({
      '/project/crlf.txt': 'one\r\ntwo\r\nthree',
      '/project/empty.txt': '',
    });

    const crlf = shell.show('/project/crlf.txt', 2, 3);
    expect(crlf.code).toBe(0);
    expect(crlf.stdout).toBe('two\nthree');

    const empty = shell.show('/project/empty.txt', 1, 1);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toBe('show: file is empty: empty.txt');
  });
});
