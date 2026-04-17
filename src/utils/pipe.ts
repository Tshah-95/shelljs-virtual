import { appendTextFile, writeTextFile } from '../common.js';
import type { ResultOptions } from '../types.js';
import type { Shell } from '../shell.js';

export type ShellResult = ShellString | ShellArrayResult<unknown>;

export class ShellString {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  protected readonly shell?: Shell;

  constructor(stdout = '', options: ResultOptions & { shell?: Shell } = {}) {
    this.stdout = stdout;
    this.stderr = options.stderr ?? '';
    this.code = options.code ?? 0;
    this.shell = options.shell;
  }

  toString(): string {
    return this.stdout;
  }

  to(file: string): this {
    const shell = this.requireShell();
    writeTextFile(shell.fs, shell.resolvePath(file), this.stdout);
    return this;
  }

  toEnd(file: string): this {
    const shell = this.requireShell();
    appendTextFile(shell.fs, shell.resolvePath(file), this.stdout);
    return this;
  }

  grep(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().grep(...args, { stdin: this.stdout });
  }

  sed(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().sed(...args, { stdin: this.stdout });
  }

  cat(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().cat(...args, { stdin: this.stdout });
  }

  patch(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().patch(...args, { stdin: this.stdout });
  }

  replace(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().replace(...args, { stdin: this.stdout });
  }

  head(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().head(...args, { stdin: this.stdout });
  }

  tail(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().tail(...args, { stdin: this.stdout });
  }

  sort(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().sort(...args, { stdin: this.stdout });
  }

  uniq(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().uniq(...args, { stdin: this.stdout });
  }

  wc(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().wc(...args, { stdin: this.stdout });
  }

  protected requireShell(): Shell {
    if (!this.shell) {
      throw new Error('Shell context is required for this operation.');
    }
    return this.shell;
  }
}

export class ShellArrayResult<T = string> extends Array<T> {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  protected readonly shell?: Shell;

  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  constructor(items: T[] = [], options: ResultOptions & { shell?: Shell } = {}) {
    super();
    this.push(...items);
    this.stdout = items.map((item) => String(item)).join('\n');
    this.stderr = options.stderr ?? '';
    this.code = options.code ?? 0;
    this.shell = options.shell;
  }

  static from<T>(items: T[], shell?: Shell, options: ResultOptions = {}): ShellArrayResult<T> {
    return new ShellArrayResult(items, { ...options, shell });
  }

  toString(): string {
    return this.stdout;
  }

  to(file: string): this {
    const shell = this.requireShell();
    writeTextFile(shell.fs, shell.resolvePath(file), this.stdout);
    return this;
  }

  toEnd(file: string): this {
    const shell = this.requireShell();
    appendTextFile(shell.fs, shell.resolvePath(file), this.stdout);
    return this;
  }

  grep(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().grep(...args, { stdin: this.stdout });
  }

  sed(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().sed(...args, { stdin: this.stdout });
  }

  cat(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().cat(...args, { stdin: this.stdout });
  }

  patch(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().patch(...args, { stdin: this.stdout });
  }

  replace(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().replace(...args, { stdin: this.stdout });
  }

  head(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().head(...args, { stdin: this.stdout });
  }

  tail(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().tail(...args, { stdin: this.stdout });
  }

  // @ts-expect-error Intentional shell-style pipeline override; differs from Array.prototype.sort.
  sort(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().sort(...args, { stdin: this.stdout });
  }

  uniq(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().uniq(...args, { stdin: this.stdout });
  }

  wc(...args: unknown[]): ShellString {
    if (this.code !== 0 && this.stdout.length === 0) {
      return new ShellString('', { code: this.code, stderr: this.stderr, shell: this.shell });
    }
    return this.requireShell().wc(...args, { stdin: this.stdout });
  }

  private requireShell(): Shell {
    if (!this.shell) {
      throw new Error('Shell context is required for this operation.');
    }
    return this.shell;
  }
}
