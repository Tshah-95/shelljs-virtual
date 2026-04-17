import { describe, expect, test } from 'bun:test';
import { createTestShell } from './helpers.js';

describe('search hardening', () => {
  test('find skips hidden descendants by default, but can include or explicitly target them', () => {
    const { shell } = createTestShell({
      '/project/.secret/config.ts': 'hidden\n',
      '/project/src/.cache/tmp.ts': 'cache\n',
      '/project/src/visible.ts': 'visible\n',
    });

    const defaultFound = shell.find('/project');
    expect(defaultFound).toContain('/project/src/visible.ts');
    expect(defaultFound).not.toContain('/project/.secret');
    expect(defaultFound).not.toContain('/project/.secret/config.ts');
    expect(defaultFound).not.toContain('/project/src/.cache/tmp.ts');

    const withHidden = shell.find('--hidden', '/project');
    expect(withHidden).toContain('/project/.secret');
    expect(withHidden).toContain('/project/.secret/config.ts');
    expect(withHidden).toContain('/project/src/.cache/tmp.ts');

    const explicitHidden = shell.find('/project/.secret');
    expect(Array.from(explicitHidden)).toEqual(['/project/.secret', '/project/.secret/config.ts']);
  });

  test('find supports exclude globs and deterministic max-results', () => {
    const { shell } = createTestShell({
      '/project/search/a.ts': 'a\n',
      '/project/search/b.ts': 'b\n',
      '/project/search/c.ts': 'c\n',
      '/project/search/vendor/skip.ts': 'skip\n',
    });

    const excluded = shell.find('--exclude=search/vendor', '/project/search');
    expect(excluded).not.toContain('/project/search/vendor');
    expect(excluded).not.toContain('/project/search/vendor/skip.ts');

    const limited = shell.find('--max-results=3', '/project/search');
    expect([...limited]).toEqual(['/project/search', '/project/search/a.ts', '/project/search/b.ts']);
  });

  test('grep skips hidden recursive matches by default, but can include or explicitly target them', () => {
    const { shell } = createTestShell({
      '/project/.env': 'TOKEN=hidden\n',
      '/project/.secrets/key.txt': 'TOKEN=deep\n',
      '/project/src/open.ts': 'TOKEN=open\n',
    });

    const defaultSearch = shell.grep('-rH', 'TOKEN', '/project');
    expect(defaultSearch.code).toBe(0);
    expect(defaultSearch.stdout).toContain('src/open.ts:TOKEN=open');
    expect(defaultSearch.stdout).not.toContain('.env');
    expect(defaultSearch.stdout).not.toContain('.secrets/key.txt');

    const withHidden = shell.grep('--hidden', '-rH', 'TOKEN', '/project');
    expect(withHidden.stdout).toContain('.env:TOKEN=hidden');
    expect(withHidden.stdout).toContain('.secrets/key.txt:TOKEN=deep');

    const explicitHidden = shell.grep('TOKEN', '/project/.env');
    expect(explicitHidden.code).toBe(0);
    expect(explicitHidden.stdout).toBe('TOKEN=hidden');
  });

  test('grep respects nested excludes and max-count-total deterministically', () => {
    const { shell } = createTestShell({
      '/project/search/a.ts': 'TODO first\n',
      '/project/search/b.ts': 'TODO second\nTODO third\n',
      '/project/search/generated/skip.ts': 'TODO skip\n',
    });

    const excluded = shell.grep('-rn', '--exclude=search/generated/*', 'TODO', '/project/search');
    expect(excluded.stdout).toContain('search/a.ts:1:TODO first');
    expect(excluded.stdout).not.toContain('generated/skip.ts');

    const limited = shell.grep('-rn', '--max-count-total=2', 'TODO', '/project/search');
    expect(limited.stdout).toContain('search/a.ts:1:TODO first');
    expect(limited.stdout).toContain('search/b.ts:1:TODO second');
    expect(limited.stdout).not.toContain('TODO third');
    expect(limited.stdout).not.toContain('TODO skip');

    const filesOnly = shell.grep('-rl', '--max-count-total=1', 'TODO', '/project/search');
    expect(filesOnly.stdout).toBe('search/a.ts');
  });
});
