/**
 * Structural seam test: every content-mutation verb routes its write through
 * the centralized `writeTextFile` helper. If a future verb is added that
 * bypasses the seam (e.g., calls `volume.writeFileSync` directly), the
 * listener pipeline silently won't fire on it. This test catches that class
 * of regression.
 *
 * Mechanism: spy on `volume.writeFileSync`. Each content verb should produce
 * exactly one writeFileSync call per output file when run with content in
 * memfs. We don't spy `writeTextFile` directly because it's a module-level
 * function (mocking would require module-level interception); the underlying
 * `fs.writeFileSync` call is the observable proxy and any in-package bypass
 * would fail to update memfs at all.
 */
import { describe, expect, it } from 'bun:test';
import { createTwoFilesPatch } from 'diff';
import { Shell } from '../src/shell.js';
import type { ShellListener, VirtualFS } from '../src/types.js';
import { Volume, createFsFromVolume } from './helpers.js';

function makeSpiedShell(
  files: Record<string, string> = {},
  listeners: ShellListener[] = [],
): { shell: Shell; vol: Volume; fs: VirtualFS; writeCalls: { path: string; content: string }[] } {
  const vol = Volume.fromJSON(files);
  const baseFs = createFsFromVolume(vol);
  const writeCalls: { path: string; content: string }[] = [];
  const fs: VirtualFS = {
    ...baseFs,
    writeFileSync(path: string, data: string | Uint8Array, options?: unknown): void {
      writeCalls.push({
        path,
        content: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
      });
      return baseFs.writeFileSync(path, data, options);
    },
  };
  const shell = new Shell({ fs, cwd: '/repo', env: { PATH: '/bin' }, listeners });
  return { shell, vol, fs, writeCalls };
}

describe('listener seam — every content-mutation verb writes through fs.writeFileSync', () => {
  it('write fires writeFileSync exactly once on the target', () => {
    const { shell, writeCalls } = makeSpiedShell();
    shell.write('/repo/main.carlo', 'x = 1');
    const targetWrites = writeCalls.filter((c) => c.path === '/repo/main.carlo');
    expect(targetWrites).toHaveLength(1);
    expect(targetWrites[0].content).toBe('x = 1');
  });

  it('replace fires writeFileSync exactly once', () => {
    const { shell, writeCalls } = makeSpiedShell({ '/repo/main.carlo': 'a = 1\nb = 2\n' });
    shell.replace('/repo/main.carlo', 'a = 1', 'a = 99');
    const targetWrites = writeCalls.filter((c) => c.path === '/repo/main.carlo');
    expect(targetWrites).toHaveLength(1);
  });

  it('sed -i fires writeFileSync exactly once per input file', () => {
    const { shell, writeCalls } = makeSpiedShell({
      '/repo/a.carlo': 'a',
      '/repo/b.carlo': 'b',
    });
    shell.sed('-i', /./g, 'X', '/repo/a.carlo', '/repo/b.carlo');
    const aWrites = writeCalls.filter((c) => c.path === '/repo/a.carlo');
    const bWrites = writeCalls.filter((c) => c.path === '/repo/b.carlo');
    expect(aWrites).toHaveLength(1);
    expect(bWrites).toHaveLength(1);
  });

  it('insert fires writeFileSync exactly once', () => {
    const { shell, writeCalls } = makeSpiedShell({ '/repo/main.carlo': 'a = 1\n' });
    shell.insert('--at-end', '/repo/main.carlo', 'b = 2');
    const targetWrites = writeCalls.filter((c) => c.path === '/repo/main.carlo');
    expect(targetWrites).toHaveLength(1);
  });

  it('splice fires writeFileSync exactly once', () => {
    const { shell, writeCalls } = makeSpiedShell({ '/repo/main.carlo': 'a\nb\nc\n' });
    shell.splice('/repo/main.carlo', 2, 1, 'B');
    const targetWrites = writeCalls.filter((c) => c.path === '/repo/main.carlo');
    expect(targetWrites).toHaveLength(1);
  });

  it('patch fires writeFileSync exactly once', () => {
    const original = 'a = 1\nb = 2\n';
    const updated = 'a = 99\nb = 2\n';
    const patchText = createTwoFilesPatch('main.carlo', 'main.carlo', original, updated);
    const { shell, writeCalls } = makeSpiedShell({ '/repo/main.carlo': original });
    const result = shell.patch(patchText);
    expect(result.code).toBe(0);
    const targetWrites = writeCalls.filter((c) => c.path === '/repo/main.carlo');
    expect(targetWrites).toHaveLength(1);
  });

  it('listener fires once per content-verb-write (paired with the seam test above)', () => {
    // Confirms the listener pipeline observes writes through the SAME seam
    // the spy observes — i.e. there is no second write path.
    const handlerCalls: { verb: string; path: string }[] = [];
    const listener: ShellListener = {
      match: '**/*.carlo',
      onAny: (ctx) => {
        handlerCalls.push({ verb: ctx.verb, path: ctx.path });
        return undefined;
      },
    };
    const { shell } = makeSpiedShell({ '/repo/main.carlo': 'a = 1\n' }, [listener]);
    shell.write('/repo/main.carlo', 'x = 1');
    shell.replace('/repo/main.carlo', 'x = 1', 'x = 2');
    shell.insert('--at-end', '/repo/main.carlo', 'y = 3');
    shell.splice('/repo/main.carlo', 1, 0, 'z = 4');
    shell.sed('-i', /x/g, 'X', '/repo/main.carlo');
    expect(handlerCalls.map((c) => c.verb)).toEqual([
      'write',
      'replace',
      'insert',
      'splice',
      'sed',
    ]);
  });
});
