import { createTwoFilesPatch } from 'diff';
import { describe, expect, test } from 'bun:test';
import { assertFileContents, assertFileNotExists, createTestShell } from './helpers.js';

describe('patch command', () => {
  test('applies a unified diff to an existing file', () => {
    const { shell, vol } = createTestShell();
    const original = shell.cat('/project/src/utils/hello.ts').stdout;
    const updated = original.replace('Hello', 'Greetings');
    const patchText = createTwoFilesPatch('src/utils/hello.ts', 'src/utils/hello.ts', original, updated);

    const result = shell.patch(patchText);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('patched src/utils/hello.ts (1 hunk)');
    assertFileContents(vol, '/project/src/utils/hello.ts', updated);
  });

  test('supports check-only mode from piped stdin without mutating files', () => {
    const { shell, vol } = createTestShell();
    const original = shell.cat('/project/README.md').stdout;
    const updated = `${original}\nPatched in check mode.\n`;
    const patchText = createTwoFilesPatch('README.md', 'README.md', original, updated);

    const result = shell.echo(patchText).patch('--check');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('checked README.md (1 hunk)');
    assertFileContents(vol, '/project/README.md', original);
  });

  test('creates a new file from /dev/null and can reverse that patch', () => {
    const { shell, vol } = createTestShell();
    const patchText = createTwoFilesPatch('/dev/null', 'src/generated.ts', '', 'export const generated = true;\n');

    const created = shell.patch(patchText);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('patched src/generated.ts (1 hunk, created)');
    assertFileContents(vol, '/project/src/generated.ts', 'export const generated = true;\n');

    const reversed = shell.patch('--reverse', patchText);
    expect(reversed.code).toBe(0);
    expect(reversed.stdout).toContain('patched src/generated.ts (1 hunk, deleted)');
    assertFileNotExists(vol, '/project/src/generated.ts');
  });

  test('preserves no-trailing-newline files when applying and reversing patches', () => {
    const { shell, vol } = createTestShell({
      '/project/no-newline.txt': 'one\ntwo',
    });
    const patchText = createTwoFilesPatch('no-newline.txt', 'no-newline.txt', 'one\ntwo', 'one\nTWO');

    const applied = shell.patch(patchText);
    expect(applied.code).toBe(0);
    assertFileContents(vol, '/project/no-newline.txt', 'one\nTWO');

    const reversed = shell.patch('--reverse', patchText);
    expect(reversed.code).toBe(0);
    assertFileContents(vol, '/project/no-newline.txt', 'one\ntwo');
  });

  test('supports successful multi-file patches with labels resolved from the current cwd', () => {
    const { shell, vol } = createTestShell({
      '/project/src/demo.ts': 'one\ntwo\n',
      '/project/README.md': '# Title\n',
    });
    shell.cd('/project/src');

    const demoPatch = createTwoFilesPatch('demo.ts', 'demo.ts', 'one\ntwo\n', 'one\nTWO\n');
    const readmePatch = createTwoFilesPatch('../README.md', '../README.md', '# Title\n', '# Title\nUpdated\n');

    const result = shell.patch(`${demoPatch.trimEnd()}\n${readmePatch}`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('patched demo.ts (1 hunk)');
    expect(result.stdout).toContain('patched ../README.md (1 hunk)');
    assertFileContents(vol, '/project/src/demo.ts', 'one\nTWO\n');
    assertFileContents(vol, '/project/README.md', '# Title\nUpdated\n');
  });

  test('applies patches against existing empty files', () => {
    const { shell, vol } = createTestShell({
      '/project/empty.txt': '',
    });
    const patchText = createTwoFilesPatch('empty.txt', 'empty.txt', '', 'hello\n');

    const result = shell.patch(patchText);

    expect(result.code).toBe(0);
    assertFileContents(vol, '/project/empty.txt', 'hello\n');
  });

  test('fails all-or-nothing when a later file hunk mismatches', () => {
    const { shell, vol } = createTestShell();
    const readmeOriginal = shell.cat('/project/README.md').stdout;
    const readmeUpdated = readmeOriginal.replace('sample project', 'patched project');
    const validPatch = createTwoFilesPatch('README.md', 'README.md', readmeOriginal, readmeUpdated);
    const invalidPatch = createTwoFilesPatch(
      'src/utils/hello.ts',
      'src/utils/hello.ts',
      'totally wrong source\n',
      'totally wrong replacement\n',
    );
    const combined = `${validPatch.trimEnd()}\n${invalidPatch}`;

    const result = shell.patch(combined);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('patch: hunk 1 failed for src/utils/hello.ts');
    assertFileContents(vol, '/project/README.md', readmeOriginal);
  });

  test('rejects malformed patch text', () => {
    const { shell } = createTestShell();

    const result = shell.patch('not a patch');

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('patch: no patch data');
  });

  test('rejects binary-looking targets instead of corrupting them', () => {
    const { shell, fs } = createTestShell();
    fs.writeFileSync('/project/blob.bin', new Uint8Array([0, 1, 2, 3]));
    const patchText = createTwoFilesPatch('blob.bin', 'blob.bin', 'old\n', 'new\n');

    const result = shell.patch(patchText);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('patch: binary file not supported: blob.bin');
  });
});
