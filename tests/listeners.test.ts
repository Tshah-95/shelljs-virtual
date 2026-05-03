import { describe, expect, it } from 'bun:test';
import { createTwoFilesPatch } from 'diff';
import { Shell } from '../src/shell.js';
import type {
  HookResult,
  HookVetoResult,
  MutationCtx,
  ShellListener,
} from '../src/types.js';
import { Volume, createFsFromVolume } from './helpers.js';

function makeShell(
  files: Record<string, string> = {},
  listeners: ShellListener[] = [],
  beforeModel?: unknown,
): { shell: Shell; vol: Volume } {
  const vol = Volume.fromJSON(files);
  const fs = createFsFromVolume(vol);
  const shell = new Shell({ fs, cwd: '/repo', env: { PATH: '/bin' }, listeners, beforeModel });
  return { shell, vol };
}

describe('listener API — match shape matrix', () => {
  it('single string glob', () => {
    const calls: string[] = [];
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        calls.push(ctx.path);
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/main.carlo', 'x = 1');
    shell.write('/repo/notes.txt', 'hi');
    expect(calls).toEqual(['/repo/main.carlo']);
  });

  it('single RegExp', () => {
    const calls: string[] = [];
    const listener: ShellListener = {
      match: /\.carlo$/,
      onWrite: (ctx) => {
        calls.push(ctx.path);
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/main.carlo', 'x = 1');
    shell.write('/repo/notes.txt', 'hi');
    expect(calls).toEqual(['/repo/main.carlo']);
  });

  it('mixed array of string + RegExp', () => {
    const calls: string[] = [];
    const listener: ShellListener = {
      match: ['**/*.carlo', /\.ya?ml$/],
      onWrite: (ctx) => {
        calls.push(ctx.path);
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/main.carlo', 'x = 1');
    shell.write('/repo/scenarios/h.yaml', 'name: a');
    shell.write('/repo/notes.txt', 'hi');
    expect(calls).toEqual(['/repo/main.carlo', '/repo/scenarios/h.yaml']);
  });

  it('empty array matches nothing (fail-closed)', () => {
    let called = false;
    const listener: ShellListener = {
      match: [],
      onWrite: () => {
        called = true;
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/main.carlo', 'x = 1');
    expect(called).toBe(false);
  });

  it('non-matching path skips ALL handlers including onBefore', () => {
    let beforeCalled = false;
    let writeCalled = false;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onBefore: () => {
        beforeCalled = true;
        return undefined;
      },
      onWrite: () => {
        writeCalled = true;
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/notes.txt', 'hi');
    expect(beforeCalled).toBe(false);
    expect(writeCalled).toBe(false);
  });
});

describe('listener API — per-verb dispatch matrix', () => {
  // For each verb, register all six handlers + onAny; assert ONLY the matching
  // verb-handler + onAny fire.
  const verbs = ['write', 'replace', 'sed', 'splice', 'patch', 'insert'] as const;
  for (const verb of verbs) {
    it(`${verb} fires onlyits handler + onAny`, () => {
      const fired: string[] = [];
      const listener: ShellListener = {
        match: '**/*.carlo',
        onWrite: () => { fired.push('onWrite'); return undefined; },
        onReplace: () => { fired.push('onReplace'); return undefined; },
        onSed: () => { fired.push('onSed'); return undefined; },
        onSplice: () => { fired.push('onSplice'); return undefined; },
        onPatch: () => { fired.push('onPatch'); return undefined; },
        onInsert: () => { fired.push('onInsert'); return undefined; },
        onAny: () => { fired.push('onAny'); return undefined; },
      };
      const { shell } = makeShell(
        { '/repo/main.carlo': 'a = 1\nb = 2\n' },
        [listener],
      );

      switch (verb) {
        case 'write':
          shell.write('/repo/main.carlo', 'x = 1');
          break;
        case 'replace':
          shell.replace('/repo/main.carlo', 'a = 1', 'a = 99');
          break;
        case 'sed':
          shell.sed('-i', /a/g, 'A', '/repo/main.carlo');
          break;
        case 'splice':
          shell.splice('/repo/main.carlo', 1, 1, 'A = 1');
          break;
        case 'patch': {
          const patchText = createTwoFilesPatch(
            'main.carlo',
            'main.carlo',
            'a = 1\nb = 2\n',
            'a = 99\nb = 2\n',
          );
          shell.patch(patchText);
          break;
        }
        case 'insert':
          shell.insert('--at-end', '/repo/main.carlo', 'c = 3');
          break;
      }

      const expectedHandler = `on${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
      expect(fired).toEqual([expectedHandler, 'onAny']);
    });
  }
});

describe('listener API — composition order', () => {
  it('listeners run in registration order; both side-effect and output ordering match', () => {
    const sideEffects: string[] = [];
    const makeListener = (name: string): ShellListener => ({
      match: '**/*.carlo',
      onWrite: () => {
        sideEffects.push(name);
        return { warnings: [`${name}-warn`] };
      },
    });
    const { shell } = makeShell({}, [makeListener('A'), makeListener('B'), makeListener('C')]);
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(sideEffects).toEqual(['A', 'B', 'C']);
    expect(result.hookResult?.warnings).toEqual(['A-warn', 'B-warn', 'C-warn']);
  });

  it('last-non-undefined wins for impact / workspaceEdit / beforeModelHint; concat for diagnostics / warnings', () => {
    const L1: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({
        diagnostics: ['d1'],
        warnings: ['w1'],
        impact: { tag: 'I1' },
        workspaceEdit: { tag: 'E1' },
        beforeModelHint: { tag: 'H1' },
      }),
    };
    const L2: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({
        diagnostics: ['d2'],
        warnings: ['w2'],
        impact: { tag: 'I2' },
        workspaceEdit: { tag: 'E2' },
        beforeModelHint: { tag: 'H2' },
      }),
    };
    const { shell } = makeShell({}, [L1, L2]);
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(result.hookResult?.diagnostics).toEqual(['d1', 'd2']);
    expect(result.hookResult?.warnings).toEqual(['w1', 'w2']);
    expect(result.hookResult?.impact).toEqual({ tag: 'I2' });
    expect(result.hookResult?.workspaceEdit).toEqual({ tag: 'E2' });
    expect(result.hookResult?.beforeModelHint).toEqual({ tag: 'H2' });
  });

  it('last-non-undefined-wins (not last-wins): undefined preserves prior value', () => {
    const L1: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({ impact: { tag: 'I1' } }),
    };
    const L2: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({ impact: undefined }),
    };
    const { shell } = makeShell({}, [L1, L2]);
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(result.hookResult?.impact).toEqual({ tag: 'I1' });
  });
});

describe('listener API — onBefore veto', () => {
  it('refuses mutation; file unchanged byte-for-byte', () => {
    const veto: ShellListener = {
      match: '**/*.carlo',
      onBefore: () => ({ refuse: true, reason: 'nope', diagnostics: ['vetoDiag'] }),
    };
    const { shell, vol } = makeShell({ '/repo/main.carlo': 'BEFORE' }, [veto]);
    const beforeSnapshot = JSON.stringify(vol.toJSON());

    const result = shell.write('/repo/main.carlo', 'AFTER');

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('write: nope');
    expect(result.hookResult?.diagnostics).toEqual(['vetoDiag']);
    expect(vol.readFileSync('/repo/main.carlo', 'utf8')).toBe('BEFORE');
    expect(JSON.stringify(vol.toJSON())).toBe(beforeSnapshot);
  });

  it('veto on a path that did not exist: file still does not exist post-veto', () => {
    const veto: ShellListener = {
      match: '**/*.carlo',
      onBefore: () => ({ refuse: true, reason: 'no creates' }),
    };
    const { shell, vol } = makeShell({}, [veto]);
    const result = shell.write('/repo/main.carlo', 'AFTER');
    expect(result.code).toBe(1);
    expect(vol.existsSync('/repo/main.carlo')).toBe(false);
  });

  it('first refuse wins; subsequent listeners do not fire onBefore', () => {
    const aFired: string[] = [];
    const A: ShellListener = {
      match: '**/*.carlo',
      onBefore: () => {
        aFired.push('A.onBefore');
        return { refuse: true, reason: 'A says no' };
      },
    };
    const B: ShellListener = {
      match: '**/*.carlo',
      onBefore: () => {
        aFired.push('B.onBefore');
        return undefined;
      },
    };
    const { shell } = makeShell({ '/repo/main.carlo': 'x' }, [A, B]);
    shell.write('/repo/main.carlo', 'y');
    expect(aFired).toEqual(['A.onBefore']);
  });
});

describe('listener API — throw-safety', () => {
  it('onWrite throws → subsequent listeners fire, file is written, throw captured in warnings', () => {
    const calls: string[] = [];
    const A: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => {
        calls.push('A');
        throw new Error('boom from A');
      },
    };
    const B: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => {
        calls.push('B');
        return { diagnostics: ['from B'] };
      },
    };
    const { shell, vol } = makeShell({}, [A, B]);
    const result = shell.write('/repo/main.carlo', 'x = 1');

    expect(result.code).toBe(0);
    expect(vol.readFileSync('/repo/main.carlo', 'utf8')).toBe('x = 1');
    expect(calls).toEqual(['A', 'B']);
    expect(result.hookResult?.warnings).toContain('write threw: boom from A');
    expect(result.hookResult?.diagnostics).toEqual(['from B']);
  });

  it('onBefore throws → treated NON-veto; mutation proceeds', () => {
    const A: ShellListener = {
      match: '**/*.carlo',
      onBefore: () => {
        throw new Error('boom in onBefore');
      },
    };
    const { shell, vol } = makeShell({}, [A]);
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(result.code).toBe(0);
    expect(vol.readFileSync('/repo/main.carlo', 'utf8')).toBe('x = 1');
    expect(result.hookResult?.warnings).toContain('onBefore threw: boom in onBefore');
  });

  it('handler returns undefined → no-op, aggregator skips', () => {
    const A: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => undefined,
    };
    const B: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({ diagnostics: ['from B'] }),
    };
    const { shell } = makeShell({}, [A, B]);
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(result.code).toBe(0);
    expect(result.hookResult?.diagnostics).toEqual(['from B']);
  });

  it('onAny throws → other listeners still fire', () => {
    const A: ShellListener = {
      match: '**/*.carlo',
      onAny: () => {
        throw new Error('boom in onAny');
      },
    };
    const B: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({ diagnostics: ['from B'] }),
    };
    const { shell } = makeShell({}, [A, B]);
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(result.code).toBe(0);
    expect(result.hookResult?.warnings).toContain('onAny threw: boom in onAny');
    expect(result.hookResult?.diagnostics).toEqual(['from B']);
  });
});

describe('listener API — prevContent semantics', () => {
  it('prevContent is undefined when file did not exist', () => {
    let observed: string | undefined = 'sentinel';
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        observed = ctx.prevContent;
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/main.carlo', 'AFTER');
    expect(observed).toBeUndefined();
  });

  it("prevContent is '' (empty string) when file existed and was empty", () => {
    let observed: string | undefined;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        observed = ctx.prevContent;
        return undefined;
      },
    };
    const { shell } = makeShell({ '/repo/main.carlo': '' }, [listener]);
    shell.write('/repo/main.carlo', 'AFTER');
    expect(observed).toBe('');
  });

  it("prevContent is the literal string 'undefined' when content happened to be that string", () => {
    let observed: unknown;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        observed = ctx.prevContent;
        return undefined;
      },
    };
    const { shell } = makeShell({ '/repo/main.carlo': 'undefined' }, [listener]);
    shell.write('/repo/main.carlo', 'AFTER');
    expect(observed).toBe('undefined');
  });
});

describe('listener API — beforeModel opacity', () => {
  it('beforeModel passes by reference; the package never clones or strips methods', () => {
    class CompileResult {
      readonly model = { id: 42 };
      callable(): string {
        return 'callable returned';
      }
    }
    const original = new CompileResult();
    let observed: unknown;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        observed = ctx.beforeModel;
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener], original);
    shell.write('/repo/main.carlo', 'x = 1');
    expect(observed).toBe(original);
    expect((observed as CompileResult).callable()).toBe('callable returned');
  });

  it('HookResult.beforeModelHint updates the next call`s ctx.beforeModel', () => {
    const observed: unknown[] = [];
    const seq = ['hint-A', 'hint-B'];
    let i = 0;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        observed.push(ctx.beforeModel);
        return { beforeModelHint: seq[i++] };
      },
    };
    const { shell } = makeShell({}, [listener], 'initial');
    shell.write('/repo/a.carlo', 'a');
    shell.write('/repo/b.carlo', 'b');
    expect(observed).toEqual(['initial', 'hint-A']);
  });

  it('setBeforeModel updates the value passed to the next ctx.beforeModel', () => {
    let observed: unknown;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        observed = ctx.beforeModel;
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.setBeforeModel({ tag: 'set' });
    shell.write('/repo/main.carlo', 'x');
    expect(observed).toEqual({ tag: 'set' });
  });
});

describe('listener API — verb context (MutationCtx)', () => {
  it('passes verb name, path, content, and fs to the handler', () => {
    let captured: MutationCtx | undefined;
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: (ctx) => {
        captured = ctx;
        return undefined;
      },
    };
    const { shell } = makeShell({}, [listener]);
    shell.write('/repo/main.carlo', 'x = 1');
    expect(captured?.verb).toBe('write');
    expect(captured?.path).toBe('/repo/main.carlo');
    expect(captured?.content).toBe('x = 1');
    expect(typeof captured?.fs.writeFileSync).toBe('function');
  });
});

describe('listener API — sed multi-file aggregation', () => {
  it('sed across multiple files aggregates diagnostics from all matching writes', () => {
    const listener: ShellListener = {
      match: '**/*.carlo',
      onSed: (ctx) => ({ diagnostics: [`sed-on-${ctx.path}`] }),
    };
    const { shell } = makeShell(
      { '/repo/a.carlo': 'a', '/repo/b.carlo': 'b' },
      [listener],
    );
    const result = shell.sed('-i', /./g, 'X', '/repo/a.carlo', '/repo/b.carlo');
    expect(result.code).toBe(0);
    expect(result.hookResult?.diagnostics).toEqual([
      'sed-on-/repo/a.carlo',
      'sed-on-/repo/b.carlo',
    ]);
  });
});

describe('listener API — backwards compatibility', () => {
  it('Shell with no listeners behaves exactly as before; hookResult is undefined', () => {
    const { shell, vol } = makeShell({});
    const result = shell.write('/repo/main.carlo', 'x = 1');
    expect(result.code).toBe(0);
    expect(result.hookResult).toBeUndefined();
    expect(vol.readFileSync('/repo/main.carlo', 'utf8')).toBe('x = 1');
  });

  it('Shell with listeners but no matches: hookResult is undefined (not empty object)', () => {
    const listener: ShellListener = {
      match: '**/*.carlo',
      onWrite: () => ({ diagnostics: ['should not appear'] }),
    };
    const { shell } = makeShell({}, [listener]);
    const result = shell.write('/repo/notes.txt', 'hi');
    expect(result.code).toBe(0);
    expect(result.hookResult).toBeUndefined();
  });
});
