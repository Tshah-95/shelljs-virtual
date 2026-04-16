import path from 'node:path';
import {
  appendTextFile,
  basename,
  decodeText,
  ensureParentDir,
  hasTrailingNewline,
  isDirectory,
  isFile,
  joinLines,
  looksBinary,
  parseMode,
  readTextFile,
  relativeDisplayPath,
  safeStat,
  splitLines,
  toArray,
  writeTextFile,
} from './common.js';
import { expandGlob, matchesGlob } from './utils/glob.js';
import { basenameVirtualPath, dirnameVirtualPath, normalizeVirtualPath, resolveVirtualPath } from './utils/path.js';
import type {
  LongListEntry,
  ParsedGrepOptions,
  ParsedHeadTailOptions,
  ParsedSortOptions,
  ParsedUniqOptions,
  ShellConfig,
  VirtualFS,
} from './types.js';
import { ShellArrayResult, ShellString } from './utils/pipe.js';

type PipeInput = { stdin?: string };

function isPipeInput(value: unknown): value is PipeInput {
  return typeof value === 'object' && value !== null && 'stdin' in value;
}

function parseShortFlags(token: string): string[] {
  return token
    .slice(1)
    .split('')
    .map((flag) => `-${flag}`);
}

function splitContentAndTrailingNewline(value: string): { lines: string[]; trailingNewline: boolean } {
  return {
    lines: splitLines(value),
    trailingNewline: hasTrailingNewline(value),
  };
}

function formatCount(value: number, label: string): string {
  return `${String(value).padStart(7, ' ')} ${label}`;
}

interface DiffOp {
  type: ' ' | '+' | '-';
  value: string;
}

function buildLineDiff(leftLines: string[], rightLines: string[]): DiffOp[] {
  const rows = leftLines.length + 1;
  const cols = rightLines.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let left = leftLines.length - 1; left >= 0; left -= 1) {
    for (let right = rightLines.length - 1; right >= 0; right -= 1) {
      dp[left]![right] =
        leftLines[left] === rightLines[right]
          ? (dp[left + 1]![right + 1] ?? 0) + 1
          : Math.max(dp[left + 1]![right] ?? 0, dp[left]![right + 1] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLines.length && rightIndex < rightLines.length) {
    if (leftLines[leftIndex] === rightLines[rightIndex]) {
      ops.push({ type: ' ', value: leftLines[leftIndex]! });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if ((dp[leftIndex + 1]![rightIndex] ?? 0) >= (dp[leftIndex]![rightIndex + 1] ?? 0)) {
      ops.push({ type: '-', value: leftLines[leftIndex]! });
      leftIndex += 1;
    } else {
      ops.push({ type: '+', value: rightLines[rightIndex]! });
      rightIndex += 1;
    }
  }

  while (leftIndex < leftLines.length) {
    ops.push({ type: '-', value: leftLines[leftIndex]! });
    leftIndex += 1;
  }

  while (rightIndex < rightLines.length) {
    ops.push({ type: '+', value: rightLines[rightIndex]! });
    rightIndex += 1;
  }

  return ops;
}

export class Shell {
  readonly fs: VirtualFS;
  cwd: string;
  env: Record<string, string>;
  silent: boolean;
  fatal: boolean;

  constructor(config: ShellConfig) {
    this.fs = config.fs;
    this.cwd = resolveVirtualPath(config.cwd ?? '/');
    this.env = { ...(config.env ?? {}) };
    this.silent = config.silent ?? false;
    this.fatal = config.fatal ?? false;
  }

  resolvePath(target = '.'): string {
    return resolveVirtualPath(this.cwd, target);
  }

  cd(target = '.'): ShellString {
    const nextPath = this.resolvePath(target);
    const stat = safeStat(this.fs, nextPath);
    if (!stat) {
      return this.fail(`cd: no such file or directory: ${target}`);
    }
    if (!stat.isDirectory()) {
      return this.fail(`cd: not a directory: ${target}`);
    }
    this.cwd = nextPath;
    return this.success(nextPath);
  }

  pwd(): ShellString {
    return this.success(this.cwd);
  }

  echo(...values: unknown[]): ShellString {
    return this.success(values.map((value) => String(value)).join(' '));
  }

  cat(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    let numberLines = false;
    const files = args
      .filter((value) => !isPipeInput(value))
      .flatMap((value) => toArray(value as string | string[]))
      .filter((value) => {
        if (value === '-n') {
          numberLines = true;
          return false;
        }
        return true;
      });
    if (files.length === 0) {
      const content = pipe?.stdin ?? '';
      return this.success(numberLines ? this.numberLines(content) : content);
    }

    const parts = files.flatMap((input) => this.expandPaths(String(input))).map((target) => readTextFile(this.fs, target));
    const content = parts.join('');
    return this.success(numberLines ? this.numberLines(content) : content);
  }

  find(...paths: string[]): ShellArrayResult<string> {
    const inputs = paths.length === 0 ? ['.'] : paths;
    const found = new Set<string>();

    const visit = (target: string): void => {
      const absolute = this.resolvePath(target);
      if (!this.fs.existsSync(absolute)) {
        return;
      }
      const queue = [absolute];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (found.has(current)) {
          continue;
        }
        found.add(current);
        if (isDirectory(this.fs, current)) {
          const entries = this.fs.readdirSync(current);
          for (const entry of entries) {
            const name = typeof entry === 'string' ? entry : entry.name;
            queue.push(normalizeVirtualPath(path.posix.join(current, name)));
          }
        }
      }
    };

    for (const target of inputs) {
      this.expandPaths(target).forEach((match) => visit(match));
    }

    return ShellArrayResult.from(Array.from(found).sort((left, right) => left.localeCompare(right)), this);
  }

  grep(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    const { options, pattern, paths } = this.parseGrepArgs(args.filter((value) => !isPipeInput(value)));
    const matcher = this.createMatcher(pattern, options);
    const targets = this.collectGrepTargets(paths, options);
    const fromStdin = pipe?.stdin;

    if (fromStdin !== undefined) {
      const stdout = this.grepContent('(stdin)', fromStdin, matcher, options, false);
      return this.success(stdout, stdout.length > 0 ? 0 : 1);
    }

    const showFilenameDefault = targets.length > 1;
    const outputs: string[] = [];

    for (const target of targets) {
      const content = this.fs.readFileSync(target);
      if (looksBinary(content)) {
        continue;
      }

      const displayName = relativeDisplayPath(this.cwd, target);
      const stdout = this.grepContent(displayName, decodeText(content), matcher, options, showFilenameDefault);
      if (stdout.length > 0) {
        outputs.push(stdout);
      }
    }

    const combined = outputs.filter(Boolean).join('\n');
    return this.success(combined, combined.length > 0 ? 0 : 1);
  }

  sed(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    let inPlace = false;
    if (args[0] === '-i') {
      inPlace = true;
      args.shift();
    }

    const [search, replacement, ...pathArgs] = args.filter((value) => !isPipeInput(value)) as [
      string | RegExp,
      string | ((substring: string, ...captures: string[]) => string),
      ...string[],
    ];

    const apply = (content: string): string => {
      const normalizedSearch =
        typeof search === 'string' ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : search;
      return content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(normalizedSearch, replacement as never))
        .join('\n');
    };

    if (pipe?.stdin !== undefined) {
      return this.success(apply(pipe.stdin));
    }

    const outputs: string[] = [];
    for (const input of pathArgs.flatMap((value) => this.expandPaths(value))) {
      const source = readTextFile(this.fs, input);
      const updated = apply(source);
      outputs.push(updated);
      if (inPlace) {
        writeTextFile(this.fs, input, updated);
      }
    }

    return this.success(outputs.join('\n'));
  }

  head(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    const { options, paths } = this.parseHeadTailArgs(args.filter((value) => !isPipeInput(value)), 10);
    const source = pipe?.stdin ?? this.readInputs(paths);
    const { lines, trailingNewline } = splitContentAndTrailingNewline(source);

    let selected = lines;
    if (options.count >= 0) {
      selected = lines.slice(0, options.count);
    } else {
      selected = lines.slice(0, Math.max(0, lines.length + options.count));
    }

    return this.success(joinLines(selected, trailingNewline && selected.length === lines.length));
  }

  tail(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    const { options, paths } = this.parseHeadTailArgs(args.filter((value) => !isPipeInput(value)), 10);
    const source = pipe?.stdin ?? this.readInputs(paths);
    const { lines, trailingNewline } = splitContentAndTrailingNewline(source);

    let selected = lines;
    if (options.fromStart) {
      selected = lines.slice(Math.max(0, options.count - 1));
    } else if (options.count >= 0) {
      selected = lines.slice(Math.max(0, lines.length - options.count));
    } else {
      selected = lines.slice(Math.min(lines.length, Math.abs(options.count)));
    }

    return this.success(joinLines(selected, trailingNewline));
  }

  sort(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    const { options, paths } = this.parseSortArgs(args.filter((value) => !isPipeInput(value)));
    let lines = splitLines(pipe?.stdin ?? this.readInputs(paths));

    lines.sort((left, right) => {
      const leftKey = this.sortKey(left, options.key);
      const rightKey = this.sortKey(right, options.key);
      const order = options.numeric ? Number.parseFloat(leftKey) - Number.parseFloat(rightKey) : leftKey.localeCompare(rightKey);
      return Number.isNaN(order) ? 0 : order;
    });

    if (options.reverse) {
      lines.reverse();
    }
    if (options.unique) {
      lines = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    }

    return this.success(lines.join('\n'));
  }

  uniq(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    const { options, paths } = this.parseUniqArgs(args.filter((value) => !isPipeInput(value)));
    const lines = splitLines(pipe?.stdin ?? this.readInputs(paths));
    const groups: Array<{ value: string; count: number }> = [];

    for (const line of lines) {
      const key = options.ignoreCase ? line.toLowerCase() : line;
      const last = groups.at(-1);
      if (last && (options.ignoreCase ? last.value.toLowerCase() : last.value) === key) {
        last.count += 1;
      } else {
        groups.push({ value: line, count: 1 });
      }
    }

    const output = groups
      .filter((group) => !options.duplicatesOnly || group.count > 1)
      .map((group) => (options.count ? `${String(group.count).padStart(7, ' ')} ${group.value}` : group.value))
      .join('\n');

    return this.success(output);
  }

  wc(...args: unknown[]): ShellString {
    const pipe = this.extractPipeInput(args);
    const flags = new Set<string>();
    const paths: string[] = [];

    for (const arg of args.filter((value) => !isPipeInput(value))) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    const entries =
      pipe?.stdin !== undefined
        ? [{ label: '', content: pipe.stdin }]
        : paths.flatMap((input) => this.expandPaths(input)).map((target) => ({
            label: relativeDisplayPath(this.cwd, target),
            content: readTextFile(this.fs, target),
          }));

    const counts = entries.map((entry) => this.wcCounts(entry.content, entry.label));
    const display = (count: ReturnType<Shell['wcCounts']>): string => {
      const selected: string[] = [];
      if (flags.size === 0 || flags.has('-l')) {
        selected.push(String(count.lines).padStart(7, ' '));
      }
      if (flags.size === 0 || flags.has('-w')) {
        selected.push(String(count.words).padStart(7, ' '));
      }
      if (flags.size === 0 || flags.has('-c')) {
        selected.push(String(count.bytes).padStart(7, ' '));
      }
      if (flags.has('-m')) {
        selected.push(String(count.characters).padStart(7, ' '));
      }
      return `${selected.join(' ')}${count.label ? ` ${count.label}` : ''}`;
    };

    const lines = counts.map(display);
    if (counts.length > 1) {
      const total = counts.reduce(
        (acc, entry) => ({
          label: 'total',
          lines: acc.lines + entry.lines,
          words: acc.words + entry.words,
          bytes: acc.bytes + entry.bytes,
          characters: acc.characters + entry.characters,
        }),
        { label: 'total', lines: 0, words: 0, bytes: 0, characters: 0 },
      );
      lines.push(display(total));
    }

    return this.success(lines.join('\n'));
  }

  cp(...args: unknown[]): ShellString {
    const flags = new Set<string>();
    const inputs: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        inputs.push(arg);
      }
    }

    if (inputs.length < 2) {
      return this.fail('cp: expected source and destination');
    }

    const destination = this.resolvePath(inputs.at(-1)!);
    const sources = inputs.slice(0, -1).flatMap((input) => this.expandPaths(input));
    const recursive = flags.has('-r') || flags.has('-R');
    const noOverwrite = flags.has('-n');
    const destinationIsDirectory = sources.length > 1 || (this.fs.existsSync(destination) && isDirectory(this.fs, destination));

    for (const source of sources) {
      const sourceStat = this.fs.statSync(source);
      if (sourceStat.isDirectory() && !recursive) {
        return this.fail(`cp: omitting directory '${relativeDisplayPath(this.cwd, source)}'`);
      }

      const target = destinationIsDirectory
        ? normalizeVirtualPath(path.posix.join(destination, basenameVirtualPath(source)))
        : destination;
      this.copyNode(source, target, { noOverwrite, recursive });
    }

    return this.success('');
  }

  mv(...args: unknown[]): ShellString {
    const flags = new Set<string>();
    const inputs: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        inputs.push(arg);
      }
    }

    if (inputs.length < 2) {
      return this.fail('mv: expected source and destination');
    }

    const destination = this.resolvePath(inputs.at(-1)!);
    const sources = inputs.slice(0, -1).flatMap((input) => this.expandPaths(input));
    const noOverwrite = flags.has('-n');
    const destinationIsDirectory = sources.length > 1 || (this.fs.existsSync(destination) && isDirectory(this.fs, destination));

    for (const source of sources) {
      const target = destinationIsDirectory
        ? normalizeVirtualPath(path.posix.join(destination, basenameVirtualPath(source)))
        : destination;
      if (noOverwrite && this.fs.existsSync(target)) {
        continue;
      }

      try {
        ensureParentDir(this.fs, target);
        this.fs.renameSync(source, target);
      } catch {
        this.copyNode(source, target, { noOverwrite, recursive: true });
        this.removeNode(source, true, true);
      }
    }

    return this.success('');
  }

  rm(...args: unknown[]): ShellString {
    const flags = new Set<string>();
    const paths: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    const recursive = flags.has('-r') || flags.has('-R');
    const force = flags.has('-f');

    for (const target of paths.flatMap((value) => this.expandPaths(value))) {
      this.removeNode(target, recursive, force);
    }

    return this.success('');
  }

  mkdir(...args: unknown[]): ShellString {
    const flags = new Set<string>();
    const paths: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    for (const target of paths) {
      this.fs.mkdirSync(this.resolvePath(target), { recursive: flags.has('-p') });
    }

    return this.success('');
  }

  touch(...args: unknown[]): ShellString {
    const flags = new Set<string>();
    const paths: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    const noCreate = flags.has('-c');
    for (const target of paths.map((value) => this.resolvePath(value))) {
      if (!this.fs.existsSync(target)) {
        if (noCreate) {
          continue;
        }
        writeTextFile(this.fs, target, '');
      } else if (this.fs.utimesSync) {
        const now = new Date();
        this.fs.utimesSync(target, now, now);
      }
    }

    return this.success('');
  }

  ln(...args: unknown[]): ShellString {
    const flags = new Set<string>();
    const inputs: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        inputs.push(arg);
      }
    }

    if (inputs.length !== 2) {
      return this.fail('ln: expected source and destination');
    }

    const source = this.resolvePath(inputs[0]!);
    const destination = this.resolvePath(inputs[1]!);
    if (flags.has('-f') && this.fs.existsSync(destination)) {
      this.removeNode(destination, true, true);
    }

    ensureParentDir(this.fs, destination);
    if (flags.has('-s')) {
      if (!this.fs.symlinkSync) {
        return this.fail('ln: symbolic links are not supported by this filesystem');
      }
      this.fs.symlinkSync(source, destination);
      return this.success('');
    }

    this.copyNode(source, destination, { noOverwrite: false, recursive: true });
    return this.success('');
  }

  chmod(mode: string | number, ...paths: string[]): ShellString {
    if (!this.fs.chmodSync) {
      return this.fail('chmod: filesystem does not support chmod');
    }
    const parsed = parseMode(mode);
    for (const target of paths.flatMap((input) => this.expandPaths(input))) {
      this.fs.chmodSync(target, parsed);
    }
    return this.success('');
  }

  ls(...args: unknown[]): ShellArrayResult<string | LongListEntry> {
    const flags = new Set<string>();
    const inputs: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 1) {
        parseShortFlags(arg).forEach((flag) => flags.add(flag));
      } else if (typeof arg === 'string') {
        inputs.push(arg);
      }
    }

    const recursive = flags.has('-R');
    const all = flags.has('-A');
    const long = flags.has('-l');
    const listDirs = flags.has('-d');
    const targets = (inputs.length === 0 ? ['.'] : inputs).flatMap((input) => this.expandPaths(input));
    const results: Array<string | LongListEntry> = [];

    const listPath = (target: string): void => {
      const stat = this.fs.statSync(target);
      if (!stat.isDirectory() || listDirs) {
        results.push(long ? this.longEntry(target) : relativeDisplayPath(this.cwd, target));
        return;
      }

      const entries = this.fs.readdirSync(target);
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (!all && name.startsWith('.')) {
          continue;
        }
        const child = normalizeVirtualPath(path.posix.join(target, name));
        results.push(long ? this.longEntry(child) : relativeDisplayPath(this.cwd, child));
        if (recursive && isDirectory(this.fs, child)) {
          listPath(child);
        }
      }
    };

    targets.forEach((target) => listPath(target));
    return ShellArrayResult.from(results, this);
  }

  diff(...args: unknown[]): ShellString {
    const inputs = args.filter((value) => typeof value === 'string') as string[];
    if (inputs.length !== 2) {
      return this.fail('diff: expected two file paths');
    }

    const leftPath = this.resolvePath(inputs[0]!);
    const rightPath = this.resolvePath(inputs[1]!);
    const left = this.fs.existsSync(leftPath) ? readTextFile(this.fs, leftPath) : '';
    const right = this.fs.existsSync(rightPath) ? readTextFile(this.fs, rightPath) : '';

    if (left === right) {
      return this.success('', 0);
    }

    const leftLines = splitLines(left);
    const rightLines = splitLines(right);
    const ops = buildLineDiff(leftLines, rightLines);
    const body = ops.map((op) => `${op.type}${op.value}`).join('\n');
    const stdout = [
      `--- ${relativeDisplayPath(this.cwd, leftPath)}`,
      `+++ ${relativeDisplayPath(this.cwd, rightPath)}`,
      `@@ -1,${leftLines.length} +1,${rightLines.length} @@`,
      body,
    ]
      .filter(Boolean)
      .join('\n');

    return this.success(stdout, 1);
  }

  splice(...args: unknown[]): ShellString {
    let dryRun = false;
    if (args[0] === '-d') {
      dryRun = true;
      args.shift();
    }

    const [file, startLine, deleteCount, ...insertLines] = args as [string, number, number, ...string[]];
    const target = this.resolvePath(file);
    const source = readTextFile(this.fs, target);
    const { lines, trailingNewline } = splitContentAndTrailingNewline(source);
    const startIndex = startLine - 1;

    if (startIndex < 0 || startIndex > lines.length) {
      return this.fail(`splice: start line out of bounds: ${startLine}`);
    }

    const updated = [...lines];
    updated.splice(startIndex, deleteCount, ...insertLines);
    const output = joinLines(updated, trailingNewline || insertLines.length > 0);

    if (!dryRun) {
      writeTextFile(this.fs, target, output);
    }

    return this.success(output);
  }

  which(commandName: string): ShellString {
    const candidates = commandName.includes('/')
      ? [this.resolvePath(commandName)]
      : (this.env.PATH ?? '')
          .split(':')
          .filter(Boolean)
          .map((entry) => resolveVirtualPath(this.cwd, entry))
          .map((entry) => normalizeVirtualPath(path.posix.join(entry, commandName)));

    const match = candidates.find((candidate) => isFile(this.fs, candidate));
    return match ? this.success(match) : this.fail('', 1);
  }

  realpath(target: string): ShellString {
    const resolved = this.resolvePath(target);
    if (this.fs.realpathSync) {
      return this.success(normalizeVirtualPath(this.fs.realpathSync(resolved)));
    }
    return this.success(resolved);
  }

  dirname(target: string): ShellString {
    return this.success(dirnameVirtualPath(this.resolvePath(target)));
  }

  basename(target: string, ext?: string): ShellString {
    return this.success(basenameVirtualPath(target, ext));
  }

  test(flag: '-e' | '-f' | '-d' | '-L', target: string): boolean {
    const resolved = this.resolvePath(target);
    if (!this.fs.existsSync(resolved)) {
      return false;
    }
    if (flag === '-e') {
      return true;
    }
    if (flag === '-f') {
      return this.fs.statSync(resolved).isFile();
    }
    if (flag === '-d') {
      return this.fs.statSync(resolved).isDirectory();
    }
    const stat = this.fs.lstatSync ? this.fs.lstatSync(resolved) : this.fs.statSync(resolved);
    return stat.isSymbolicLink();
  }

  glob(pattern: string): ShellArrayResult<string> {
    return ShellArrayResult.from(expandGlob(this.fs, this.cwd, pattern), this);
  }

  private extractPipeInput(args: unknown[]): PipeInput | undefined {
    const last = args.at(-1);
    return isPipeInput(last) ? last : undefined;
  }

  private success(stdout: string, code = 0): ShellString {
    return new ShellString(stdout, { code, shell: this });
  }

  private fail(stderr: string, code = 1): ShellString {
    return new ShellString('', { code, stderr, shell: this });
  }

  private expandPaths(value: string): string[] {
    return /[*?{]/.test(value) ? expandGlob(this.fs, this.cwd, value) : [this.resolvePath(value)];
  }

  private readInputs(paths: string[]): string {
    return paths.flatMap((input) => this.expandPaths(input)).map((target) => readTextFile(this.fs, target)).join('');
  }

  private parseHeadTailArgs(args: unknown[], defaultCount: number): { options: ParsedHeadTailOptions; paths: string[] } {
    const paths: string[] = [];
    let count = defaultCount;
    let fromStart = false;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (typeof arg === 'number') {
        count = arg;
        continue;
      }
      if (typeof arg === 'object' && arg !== null && '-n' in arg) {
        const raw = (arg as Record<string, unknown>)['-n'];
        if (typeof raw === 'string' && raw.startsWith('+')) {
          fromStart = true;
          count = Number(raw.slice(1));
        } else {
          count = Number(raw);
        }
        continue;
      }
      if (arg === '-n') {
        const raw = String(args[index + 1]);
        if (raw.startsWith('+')) {
          fromStart = true;
          count = Number(raw.slice(1));
        } else {
          count = Number(raw);
        }
        index += 1;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('+')) {
        fromStart = true;
        count = Number(arg.slice(1));
        continue;
      }
      if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    return { options: { count, fromStart }, paths };
  }

  private parseSortArgs(args: unknown[]): { options: ParsedSortOptions; paths: string[] } {
    const options: ParsedSortOptions = { numeric: false, reverse: false, unique: false };
    const paths: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (typeof arg === 'object' && arg !== null) {
        const record = arg as Record<string, unknown>;
        if (record['-r']) options.reverse = true;
        if (record['-n']) options.numeric = true;
        if (record['-u']) options.unique = true;
        if (record['-k']) options.key = Number(record['-k']);
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('-') && arg !== '-k') {
        parseShortFlags(arg).forEach((flag) => {
          if (flag === '-r') options.reverse = true;
          if (flag === '-n') options.numeric = true;
          if (flag === '-u') options.unique = true;
          if (flag === '-k') options.key = Number(args[index + 1]);
        });
        if (arg.includes('k')) {
          index += 1;
        }
        continue;
      }
      if (arg === '-k') {
        options.key = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    return { options, paths };
  }

  private parseUniqArgs(args: unknown[]): { options: ParsedUniqOptions; paths: string[] } {
    const options: ParsedUniqOptions = { count: false, duplicatesOnly: false, ignoreCase: false };
    const paths: string[] = [];

    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null) {
        const record = arg as Record<string, unknown>;
        if (record['-c']) options.count = true;
        if (record['-d']) options.duplicatesOnly = true;
        if (record['-i']) options.ignoreCase = true;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('-')) {
        parseShortFlags(arg).forEach((flag) => {
          if (flag === '-c') options.count = true;
          if (flag === '-d') options.duplicatesOnly = true;
          if (flag === '-i') options.ignoreCase = true;
        });
        continue;
      }
      if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    return { options, paths };
  }

  private parseGrepArgs(args: unknown[]): { options: ParsedGrepOptions; pattern: string | RegExp; paths: string[] } {
    const options: ParsedGrepOptions = {
      invert: false,
      filesWithMatches: false,
      ignoreCase: false,
      lineNumbers: false,
      recursive: false,
      countOnly: false,
      wordRegexp: false,
      include: [],
      exclude: [],
      excludeDir: [],
      after: 0,
      before: 0,
      onlyMatching: false,
    };

    let pattern: string | RegExp | undefined;
    const paths: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (pattern === undefined && typeof arg === 'object' && arg !== null && !(arg instanceof RegExp)) {
        const record = arg as Record<string, unknown>;
        if (record['-A'] !== undefined) options.after = Number(record['-A']);
        if (record['-B'] !== undefined) options.before = Number(record['-B']);
        if (record['-C'] !== undefined) {
          options.after = Number(record['-C']);
          options.before = Number(record['-C']);
        }
        if (record['-m'] !== undefined) options.maxCount = Number(record['-m']);
        continue;
      }

      if (pattern === undefined && typeof arg === 'string' && arg.startsWith('--include=')) {
        options.include.push(arg.slice('--include='.length));
        continue;
      }
      if (pattern === undefined && typeof arg === 'string' && arg.startsWith('--exclude=')) {
        options.exclude.push(arg.slice('--exclude='.length));
        continue;
      }
      if (pattern === undefined && typeof arg === 'string' && arg.startsWith('--exclude-dir=')) {
        options.excludeDir.push(arg.slice('--exclude-dir='.length));
        continue;
      }
      if (pattern === undefined && typeof arg === 'string' && arg.startsWith('-') && !(arg instanceof RegExp)) {
        if (arg === '-A' || arg === '-B' || arg === '-C' || arg === '-m') {
          const value = Number(args[index + 1]);
          if (arg === '-A') options.after = value;
          if (arg === '-B') options.before = value;
          if (arg === '-C') {
            options.after = value;
            options.before = value;
          }
          if (arg === '-m') options.maxCount = value;
          index += 1;
          continue;
        }

        parseShortFlags(arg).forEach((flag) => {
          if (flag === '-v') options.invert = true;
          if (flag === '-l') options.filesWithMatches = true;
          if (flag === '-i') options.ignoreCase = true;
          if (flag === '-n') options.lineNumbers = true;
          if (flag === '-r' || flag === '-R') options.recursive = true;
          if (flag === '-c') options.countOnly = true;
          if (flag === '-w') options.wordRegexp = true;
          if (flag === '-H') options.withFilename = true;
          if (flag === '-h') options.withFilename = false;
          if (flag === '-o') options.onlyMatching = true;
        });
        continue;
      }

      if (pattern === undefined) {
        pattern = arg as string | RegExp;
      } else if (typeof arg === 'string') {
        paths.push(arg);
      }
    }

    if (pattern === undefined) {
      throw new Error('grep: missing pattern');
    }

    return { options, pattern, paths: paths.length === 0 ? ['.'] : paths };
  }

  private createMatcher(pattern: string | RegExp, options: ParsedGrepOptions): RegExp {
    const base =
      typeof pattern === 'string'
        ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : pattern.source;
    const source = options.wordRegexp ? `\\b(?:${base})\\b` : base;
    const flags = new Set(((typeof pattern === 'string' ? '' : pattern.flags) + (options.ignoreCase ? 'i' : '')).split(''));
    flags.add('g');
    return new RegExp(source, Array.from(flags).join(''));
  }

  private collectGrepTargets(paths: string[], options: ParsedGrepOptions): string[] {
    const results = new Set<string>();

    const addPath = (absolutePath: string): void => {
      const relative = relativeDisplayPath(this.cwd, absolutePath);
      const stat = this.fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        if (!options.recursive) {
          return;
        }

        const basenameValue = basename(absolutePath);
        if (options.excludeDir.some((pattern) => matchesGlob(pattern, basenameValue) || matchesGlob(pattern, absolutePath))) {
          return;
        }

        const entries = this.fs.readdirSync(absolutePath);
        for (const entry of entries) {
          const name = typeof entry === 'string' ? entry : entry.name;
          addPath(normalizeVirtualPath(path.posix.join(absolutePath, name)));
        }
        return;
      }

      if (options.include.length > 0 && !options.include.some((pattern) => matchesGlob(pattern, relative) || matchesGlob(pattern, basename(relative)))) {
        return;
      }
      if (options.exclude.some((pattern) => matchesGlob(pattern, relative) || matchesGlob(pattern, basename(relative)))) {
        return;
      }

      results.add(absolutePath);
    };

    for (const input of paths) {
      this.expandPaths(input).forEach((target) => addPath(target));
    }

    return Array.from(results).sort((left, right) => left.localeCompare(right));
  }

  private grepContent(
    displayName: string,
    content: string,
    matcher: RegExp,
    options: ParsedGrepOptions,
    showFilenameDefault: boolean,
  ): string {
    const lines = splitLines(content);
    const groups: Array<{ start: number; end: number; matches: Array<{ lineIndex: number; matches: string[] }> }> = [];
    let totalMatches = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const matches = Array.from(line.matchAll(matcher)).map((match) => match[0]);
      const isMatch = options.invert ? matches.length === 0 : matches.length > 0;
      if (!isMatch) {
        continue;
      }

      totalMatches += options.onlyMatching && !options.invert ? matches.length : 1;
      const start = Math.max(0, index - options.before);
      const end = Math.min(lines.length - 1, index + options.after);
      const last = groups.at(-1);
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
        last.matches.push({ lineIndex: index, matches });
      } else {
        groups.push({ start, end, matches: [{ lineIndex: index, matches }] });
      }

      if (options.maxCount !== undefined && totalMatches >= options.maxCount) {
        break;
      }
    }

    if (totalMatches === 0) {
      return '';
    }
    if (options.filesWithMatches) {
      return displayName;
    }
    if (options.countOnly) {
      const showFilename = options.withFilename ?? showFilenameDefault;
      return `${showFilename && displayName ? `${displayName}:` : ''}${totalMatches}`;
    }

    const showFilename = options.withFilename ?? showFilenameDefault;
    const outputLines: string[] = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]!;
      for (let lineIndex = group.start; lineIndex <= group.end; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const matchInfo = group.matches.find((entry) => entry.lineIndex === lineIndex);
        const isContext = !matchInfo;
        const prefixParts: string[] = [];
        if (showFilename && displayName) {
          prefixParts.push(displayName);
        }
        if (options.lineNumbers) {
          prefixParts.push(String(lineIndex + 1));
        }
        const delimiter = isContext ? '-' : ':';
        const prefix = prefixParts.length > 0 ? `${prefixParts.join(delimiter)}${delimiter}` : '';

        if (options.onlyMatching && matchInfo && !options.invert) {
          for (const match of matchInfo.matches) {
            outputLines.push(`${prefix}${match}`);
          }
        } else {
          outputLines.push(`${prefix}${line}`);
        }
      }

      if (groupIndex < groups.length - 1 && (options.before > 0 || options.after > 0)) {
        outputLines.push('--');
      }
    }

    return outputLines.join('\n');
  }

  private sortKey(line: string, key?: number): string {
    if (!key || key <= 1) {
      return line;
    }
    return line.trim().split(/\s+/)[key - 1] ?? '';
  }

  private wcCounts(content: string, label: string): {
    label: string;
    lines: number;
    words: number;
    bytes: number;
    characters: number;
  } {
    return {
      label,
      lines: content.length === 0 ? 0 : splitLines(content).length,
      words: content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length,
      bytes: Buffer.byteLength(content),
      characters: Array.from(content).length,
    };
  }

  private numberLines(content: string): string {
    return splitLines(content)
      .map((line, index) => `${String(index + 1).padStart(6, ' ')}  ${line}`)
      .join('\n');
  }

  private copyNode(source: string, destination: string, options: { noOverwrite: boolean; recursive: boolean }): void {
    if (options.noOverwrite && this.fs.existsSync(destination)) {
      return;
    }

    const sourceStat = this.fs.lstatSync ? this.fs.lstatSync(source) : this.fs.statSync(source);
    if (sourceStat.isSymbolicLink() && this.fs.readlinkSync && this.fs.symlinkSync) {
      ensureParentDir(this.fs, destination);
      this.fs.symlinkSync(this.fs.readlinkSync(source), destination);
      return;
    }

    const stat = this.fs.statSync(source);
    if (stat.isDirectory()) {
      if (!options.recursive) {
        throw new Error(`cp: omitting directory '${source}'`);
      }
      this.fs.mkdirSync(destination, { recursive: true });
      const entries = this.fs.readdirSync(source);
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        this.copyNode(
          normalizeVirtualPath(path.posix.join(source, name)),
          normalizeVirtualPath(path.posix.join(destination, name)),
          options,
        );
      }
      return;
    }

    ensureParentDir(this.fs, destination);
    if (this.fs.copyFileSync) {
      this.fs.copyFileSync(source, destination);
      return;
    }
    this.fs.writeFileSync(destination, this.fs.readFileSync(source));
  }

  private removeNode(target: string, recursive: boolean, force: boolean): void {
    if (!this.fs.existsSync(target)) {
      if (force) {
        return;
      }
      throw new Error(`rm: no such file or directory: ${target}`);
    }

    const stat = this.fs.lstatSync ? this.fs.lstatSync(target) : this.fs.statSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!recursive) {
        throw new Error(`rm: cannot remove '${target}': is a directory`);
      }
      const entries = this.fs.readdirSync(target);
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        this.removeNode(normalizeVirtualPath(path.posix.join(target, name)), true, force);
      }
      if (this.fs.rmSync) {
        this.fs.rmSync(target, { recursive: false, force });
      } else if (this.fs.rmdirSync) {
        this.fs.rmdirSync(target, { recursive: false });
      }
      return;
    }

    this.fs.unlinkSync(target);
  }

  private longEntry(target: string): LongListEntry {
    const stat = this.fs.lstatSync ? this.fs.lstatSync(target) : this.fs.statSync(target);
    return {
      path: target,
      name: basenameVirtualPath(target),
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      mode: stat.mode,
      mtime: stat.mtime,
    };
  }
}
