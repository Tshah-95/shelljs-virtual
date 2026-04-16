import { describe, expect, test } from 'bun:test';
import { Shell } from '../src/index.js';
import { Volume, createFsFromVolume, createTestShell, FIXTURE_PROJECT } from './helpers.js';

describe('phase 6 integration and edge cases', () => {
  test('agent explores and edits a codebase end to end', () => {
    const { shell } = createTestShell(FIXTURE_PROJECT);

    const files = shell.find('/project/src');
    expect(files).toContain('/project/src/index.ts');

    const exports = shell.grep('-rn', 'export', '/project/src');
    expect(exports.stdout).toContain('src/index.ts:1:');

    const tsFiles = shell.grep('-rl', '--include=*.ts', 'function', '/project/src');
    expect(tsFiles.code).toBe(0);
    expect(tsFiles.stdout).toContain('src/utils/hello.ts');

    const content = shell.cat('/project/src/utils/hello.ts');
    expect(content.stdout).toContain('export function hello');

    shell.sed('-i', /hello/g, 'greet', '/project/src/utils/hello.ts');
    const updated = shell.cat('/project/src/utils/hello.ts');
    expect(updated.stdout).toContain('export function greet');
    expect(updated.stdout).not.toContain('export function hello');
  });

  test('agent creates new files and directories inside the virtual filesystem', () => {
    const { shell } = createTestShell(FIXTURE_PROJECT);

    shell.mkdir('-p', '/project/src/new-feature');
    shell.echo('export const newThing = true;').to('/project/src/new-feature/index.ts');

    expect(shell.test('-f', '/project/src/new-feature/index.ts')).toBe(true);
    expect(shell.cat('/project/src/new-feature/index.ts').stdout).toContain('newThing');
  });

  test('agent refactors across multiple files and renames modules', () => {
    const { shell } = createTestShell({
      ...FIXTURE_PROJECT,
      '/project/src/consumer.ts': 'import { hello } from "./utils/hello";\nexport const run = hello;\n',
    });

    const importers = shell.grep('-rl', './utils/hello', '/project/src');
    const files = importers.stdout.trim().split('\n').filter(Boolean);
    for (const file of files) {
      shell.sed('-i', /"\.\/utils\/hello"/g, '"./utils/greet"', file);
    }

    shell.mv('/project/src/utils/hello.ts', '/project/src/utils/greet.ts');

    expect(shell.test('-f', '/project/src/utils/greet.ts')).toBe(true);
    expect(shell.test('-f', '/project/src/utils/hello.ts')).toBe(false);
    expect(shell.cat('/project/src/consumer.ts').stdout).toContain('"./utils/greet"');
  });

  test('filesystem state survives a Volume toJSON round-trip', () => {
    const { shell, vol } = createTestShell(FIXTURE_PROJECT);

    shell.sed('-i', /hello/g, 'greet', '/project/src/utils/hello.ts');
    shell.mkdir('-p', '/project/src/new');
    shell.echo('new file').to('/project/src/new/thing.ts');

    const snapshot = vol.toJSON();
    const vol2 = Volume.fromJSON(snapshot);
    const shell2 = new Shell({ fs: createFsFromVolume(vol2), cwd: '/project' });

    expect(shell2.cat('/project/src/utils/hello.ts').stdout).toContain('greet');
    expect(shell2.test('-f', '/project/src/new/thing.ts')).toBe(true);
  });

  test('edge cases cover unicode, spaces, deep trees, and large directory scans', () => {
    const files: Record<string, string> = {
      '/project/unicode.txt': 'hello\n🙂 emoji\n漢字\n',
      '/project/with spaces/file name.ts': 'export const spaced = true;\n',
      '/project/deep/a/b/c/d/e/f/g/h/i/j/k.txt': 'deep value\n',
    };

    for (let index = 0; index < 250; index += 1) {
      files[`/project/many/file-${index}.txt`] = `value ${index}\n`;
    }

    const { shell } = createTestShell(files);

    expect(shell.grep('🙂', '/project/unicode.txt').stdout).toContain('🙂 emoji');
    expect(shell.find('/project/with spaces')).toContain('/project/with spaces/file name.ts');
    expect(shell.cat('/project/deep/a/b/c/d/e/f/g/h/i/j/k.txt').stdout).toBe('deep value\n');
    expect(shell.find('/project/many').length).toBe(251);
  });
});
