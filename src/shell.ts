import path from 'node:path';
import { applyPatch as applyUnifiedPatch, parsePatch, reversePatch, structuredPatch, type ParsedDiff } from 'diff';
import {
  appendTextFile,
  basename,
  decodeText,
  detectNewlineStyle,
  ensureParentDir,
  hasTrailingNewline,
  normalizeToNewlineStyle,
  isDirectory,
  isFile,
  joinLines,
  looksBinary,
  parseMode,
  readdirEntryName,
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
  HookResult,
  HookVetoResult,
  LongListEntry,
  MutationCtx,
  ParsedFindOptions,
  ParsedGrepOptions,
  ParsedHeadTailOptions,
  ParsedSortOptions,
  ParsedUniqOptions,
  ShellConfig,
  ShellListener,
  VerbName,
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

interface PatchCommandOptions {
  dryRun: boolean;
  check: boolean;
  reverse: boolean;
}

interface PatchMutation {
  sourcePath: string | null;
  targetPath: string | null;
  output: string;
  hunks: number;
  created: boolean;
  deleted: boolean;
}

interface ReplaceCommandOptions {
  dryRun: boolean;
  all: boolean;
  regex: boolean;
  expected?: number;
}

interface InsertCommandOptions {
  dryRun: boolean;
  mode: 'before' | 'after' | 'at-start' | 'at-end';
}

interface TextMatch {
  start: number;
  end: number;
  text: string;
}

interface DiffCommandOptions {
  nameOnly: boolean;
  stat: boolean;
  context: number;
}

interface DiffEntry {
  label: string;
  oldLabel: string;
  newLabel: string;
  patch: ParsedDiff | null;
  added: number;
  removed: number;
  binary: boolean;
}

interface ShowCommandOptions {
  numbers: boolean;
  context: number;
  startLine?: number;
  endLine?: number;
  aroundLine?: number;
  aroundMatch?: string | RegExp;
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


/**
 * Thrown by `Shell.write` when the resolved target path lies outside the
 * caller-supplied `--root` allowlist. Surfaced as `code: 2` so callers
 * can distinguish authorization rejections from generic write failures.
 */
class WriteOutOfRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteOutOfRootError';
  }
}

export class Shell {
  readonly fs: VirtualFS;
  cwd: string;
  env: Record<string, string>;
  silent: boolean;
  fatal: boolean;
  private readonly listeners: ShellListener[];
  private beforeModel: unknown;

  constructor(config: ShellConfig) {
    this.fs = config.fs;
    this.cwd = resolveVirtualPath(config.cwd ?? '/');
    this.env = { ...(config.env ?? {}) };
    this.silent = config.silent ?? false;
    this.fatal = config.fatal ?? false;
    this.listeners = config.listeners ?? [];
    this.beforeModel = config.beforeModel;
  }

  /**
   * Update the `MutationCtx.beforeModel` value passed to listeners on the
   * next verb call. Carlo's dispatcher uses this between calls to thread
   * the cached `CompileResult` through. Treated as opaque — never inspected
   * or cloned by the package.
   */
  setBeforeModel(model: unknown): void {
    this.beforeModel = model;
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
    try {
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

      this.ensureNoMixedInput('cat', pipe, files);
      const content = pipe?.stdin ?? (files.length === 0 ? '' : this.readInputs('cat', files));
      return this.success(numberLines ? this.numberLines(content) : content);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  find(...args: string[]): ShellArrayResult<string> {
    try {
      const { options, paths } = this.parseFindArgs(args);
      const roots = this.expandCommandPaths('find', paths);
      const found: string[] = [];
      const seen = new Set<string>();

      const enqueueChildren = (queue: Array<{ path: string; allowHidden: boolean }>, current: string, allowHidden: boolean): void => {
        const entries = this.fs.readdirSync(current);
        const names = entries
          .map((entry) => readdirEntryName(entry))
          .sort((left, right) => left.localeCompare(right));

        for (const name of names) {
          queue.push({
            path: normalizeVirtualPath(path.posix.join(current, name)),
            allowHidden,
          });
        }
      };

      for (const root of roots) {
        const queue = [{
          path: root,
          allowHidden: options.hidden || this.isHiddenSearchPath(relativeDisplayPath(this.cwd, root)),
        }];

        while (queue.length > 0) {
          if (options.maxResults !== undefined && found.length >= options.maxResults) {
            return ShellArrayResult.from(found.sort((left, right) => left.localeCompare(right)), this);
          }

          const { path: current, allowHidden } = queue.shift()!;
          if (seen.has(current)) {
            continue;
          }

          const relative = relativeDisplayPath(this.cwd, current);
          if (!allowHidden && this.isHiddenSearchPath(relative)) {
            continue;
          }
          if (this.matchesSearchPatterns(options.exclude, relative)) {
            continue;
          }

          seen.add(current);
          found.push(current);

          if (isDirectory(this.fs, current)) {
            enqueueChildren(queue, current, allowHidden);
          }
        }
      }

      return ShellArrayResult.from(found.sort((left, right) => left.localeCompare(right)), this);
    } catch (error) {
      return ShellArrayResult.from([], this, { code: 1, stderr: this.errorMessage(error) });
    }
  }

  grep(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, pattern, paths } = this.parseGrepArgs(args.filter((value) => !isPipeInput(value)));
      this.ensureNoMixedInput('grep', pipe, paths);
      const matcher = this.createMatcher(pattern, options);
      const fromStdin = pipe?.stdin;

      if (fromStdin !== undefined) {
        const result = this.grepContent('(stdin)', fromStdin, matcher, {
          ...options,
          maxCount: this.limitSearchCount(options.maxCount, options.maxCountTotal),
        }, false);
        return this.success(result.stdout, result.totalMatches > 0 ? 0 : 1);
      }

      const targets = this.collectGrepTargets(paths.length === 0 ? ['.'] : paths, options);
      const showFilenameDefault = targets.length > 1;
      const outputs: string[] = [];
      let remainingTotal = options.maxCountTotal;

      for (const target of targets) {
        const content = this.fs.readFileSync(target);
        if (looksBinary(content)) {
          continue;
        }

        if (remainingTotal !== undefined && remainingTotal <= 0) {
          break;
        }

        const displayName = relativeDisplayPath(this.cwd, target);
        const effectiveOptions = {
          ...options,
          maxCount: this.limitSearchCount(options.maxCount, remainingTotal),
        };
        const result = this.grepContent(displayName, decodeText(content), matcher, effectiveOptions, showFilenameDefault);
        if (result.stdout.length > 0) {
          outputs.push(result.stdout);
        }

        if (remainingTotal !== undefined) {
          remainingTotal -= result.totalMatches;
        }
      }

      const combined = outputs.filter(Boolean).join('\n');
      return this.success(combined, combined.length > 0 ? 0 : 1);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  sed(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      let inPlace = false;
      if (args[0] === '-i') {
        inPlace = true;
        args = args.slice(1);
      }

      const [search, replacement, ...pathArgs] = args.filter((value) => !isPipeInput(value)) as [
        string | RegExp,
        string | ((substring: string, ...captures: string[]) => string),
        ...string[],
      ];

      if (search === undefined || replacement === undefined) {
        throw new Error('sed: expected search and replacement');
      }

      this.ensureNoMixedInput('sed', pipe, pathArgs);
      if (pipe?.stdin !== undefined && inPlace) {
        throw new Error('sed: cannot use -i with stdin');
      }
      if (pipe?.stdin === undefined && pathArgs.length === 0) {
        throw new Error('sed: expected file paths or stdin');
      }

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

      const updates = this.expandCommandPaths('sed', pathArgs).map((target) => {
        const { source } = this.readCommandTextFile(target, 'sed');
        return { target, updated: apply(source) };
      });

      let aggregated: HookResult | undefined;
      if (inPlace) {
        for (const update of updates) {
          const dispatch = this.dispatchHooks('sed', update.target, update.updated);
          if ('veto' in dispatch) {
            return this.fail(`sed: ${dispatch.veto.reason}`, 1, dispatch.hookResult);
          }
          aggregated = this.mergeHookResults(aggregated, dispatch.hookResult);
        }
      }

      return this.success(updates.map((update) => update.updated).join('\n'), 0, aggregated);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  replace(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, targetPath, search, replacement } = this.parseReplaceArgs(args.filter((value) => !isPipeInput(value)), pipe);
      const { source, label } = this.readReplaceableTarget(targetPath, 'replace', pipe);
      const output = this.applyReplace(source, search, replacement, options, label);

      if (!options.dryRun && targetPath) {
        const dispatch = this.dispatchHooks('replace', targetPath, output);
        if ('veto' in dispatch) {
          return this.fail(`replace: ${dispatch.veto.reason}`, 1, dispatch.hookResult);
        }
        return this.success(output, 0, dispatch.hookResult);
      }

      return this.success(output);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  insert(...args: unknown[]): ShellString {
    try {
      const { options, targetPath, anchor, content } = this.parseInsertArgs(args);
      const { source, label } = this.readReplaceableTarget(targetPath, 'insert');
      const output = this.applyInsert(source, anchor, content, options, label);

      if (!options.dryRun) {
        const dispatch = this.dispatchHooks('insert', targetPath, output);
        if ('veto' in dispatch) {
          return this.fail(`insert: ${dispatch.veto.reason}`, 1, dispatch.hookResult);
        }
        return this.success(output, 0, dispatch.hookResult);
      }

      return this.success(output);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  show(...args: unknown[]): ShellString {
    try {
      const { options, targetPath } = this.parseShowArgs(args);
      const { source, label } = this.readCommandTextFile(targetPath, 'show');
      const normalized = source.replace(/\r\n/g, '\n');
      const lines = splitLines(normalized);
      if (lines.length === 0) {
        throw new Error(`show: file is empty: ${label}`);
      }

      const range = this.resolveShowRange(normalized, lines, options, label);
      const selected = lines.slice(range.startLine - 1, range.endLine);
      const output = selected
        .map((line, index) => {
          const lineNumber = range.startLine + index;
          return options.numbers ? `${String(lineNumber).padStart(6, ' ')}  ${line}` : line;
        })
        .join('\n');

      return this.success(output);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  head(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, paths } = this.parseHeadTailArgs(args.filter((value) => !isPipeInput(value)), 10);
      this.ensureNoMixedInput('head', pipe, paths);
      const source = pipe?.stdin ?? this.readInputs('head', paths);
      const { lines, trailingNewline } = splitContentAndTrailingNewline(source);

      let selected = lines;
      if (options.count >= 0) {
        selected = lines.slice(0, options.count);
      } else {
        selected = lines.slice(0, Math.max(0, lines.length + options.count));
      }

      return this.success(joinLines(selected, trailingNewline && selected.length === lines.length));
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  tail(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, paths } = this.parseHeadTailArgs(args.filter((value) => !isPipeInput(value)), 10);
      this.ensureNoMixedInput('tail', pipe, paths);
      const source = pipe?.stdin ?? this.readInputs('tail', paths);
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  sort(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, paths } = this.parseSortArgs(args.filter((value) => !isPipeInput(value)));
      this.ensureNoMixedInput('sort', pipe, paths);
      let lines = splitLines(pipe?.stdin ?? this.readInputs('sort', paths));

      lines.sort((left, right) => {
        const leftKey = this.sortKey(left, options.key, options.separator);
        const rightKey = this.sortKey(right, options.key, options.separator);
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  uniq(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, paths } = this.parseUniqArgs(args.filter((value) => !isPipeInput(value)));
      this.ensureNoMixedInput('uniq', pipe, paths);
      const lines = splitLines(pipe?.stdin ?? this.readInputs('uniq', paths));
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  wc(...args: unknown[]): ShellString {
    try {
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

      this.ensureNoMixedInput('wc', pipe, paths);
      const entries =
        pipe?.stdin !== undefined
          ? [{ label: '', content: pipe.stdin }]
          : this.expandCommandPaths('wc', paths).map((target) => ({
              label: relativeDisplayPath(this.cwd, target),
              content: this.readCommandTextFile(target, 'wc').source,
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  cp(...args: unknown[]): ShellString {
    try {
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
      const sources = this.expandCommandPaths('cp', inputs.slice(0, -1));
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  mv(...args: unknown[]): ShellString {
    try {
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
      const sources = this.expandCommandPaths('mv', inputs.slice(0, -1));
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  rm(...args: unknown[]): ShellString {
    try {
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
      const targets = this.expandCommandPaths('rm', paths, { allowMissing: force });

      for (const target of targets) {
        this.removeNode(target, recursive, force);
      }

      return this.success('');
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
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


  /**
   * Write content to a virtual-fs path, creating parent directories as
   * needed. The flat (path, content) shape is the agent-ergonomic
   * complement to ShellJS's chaining `echo(content).to(path)` API — both
   * exist because dispatcher contexts (tools, CLIs) need a positional
   * verb form, not a fluent pipeline.
   *
   * Forms:
   *   shell.write(path, content)
   *   shell.write('--root=/repo', '--root=/scratch', path, content)
   *
   * Path handling:
   *   - Relative paths resolve against `cwd`.
   *   - `..` segments collapse via `path.posix.normalize` BEFORE the
   *     allowed-roots check, so a path like `/repo/foo/../../etc/passwd`
   *     normalizes to `/etc/passwd` and is rejected if /etc isn't an
   *     allowed root. (Without this, a startsWith check on the raw input
   *     would falsely accept `/repo/...` paths that escape via `..`.)
   *   - Multiple slashes (e.g. `///repo/foo`) and trailing-`.` segments
   *     are normalized away by the same pass.
   *
   * Allowed roots (optional, repeatable `--root <prefix>` or `--root=<prefix>`):
   *   - When supplied, the resolved path must live under at least one
   *     allowed root after normalization. Out-of-root writes return
   *     `code: 2` with a structured error.
   *   - Caller-side guards (e.g. readonly subtrees within an allowed
   *     root) belong above this layer.
   */
  write(...args: unknown[]): ShellString {
    try {
      const { targetPath, content } = this.parseWriteArgs(args);
      const dispatch = this.dispatchHooks('write', targetPath, content);
      if ('veto' in dispatch) {
        return this.fail(`write: ${dispatch.veto.reason}`, 1, dispatch.hookResult);
      }
      return this.success(
        `wrote ${content.length} bytes \u2192 ${targetPath}`,
        0,
        dispatch.hookResult,
      );
    } catch (error) {
      const code = error instanceof WriteOutOfRootError ? 2 : 1;
      return this.fail(this.errorMessage(error), code);
    }
  }

  private parseWriteArgs(args: unknown[]): {
    targetPath: string;
    content: string;
  } {
    const allowedRoots: string[] = [];
    const positional: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (typeof arg !== 'string') continue;

      if (arg === '--root') {
        const next = args[i + 1];
        if (typeof next !== 'string' || next.length === 0) {
          throw new Error('write: --root requires a path');
        }
        allowedRoots.push(next);
        i += 1;
        continue;
      }
      if (arg.startsWith('--root=')) {
        const value = arg.slice('--root='.length);
        if (value.length === 0) {
          throw new Error('write: --root= requires a path');
        }
        allowedRoots.push(value);
        continue;
      }

      positional.push(arg);
    }

    if (positional.length === 0) {
      throw new Error('write: requires a target path');
    }
    if (positional.length > 2) {
      throw new Error(
        `write: expected <path> [<content>], got ${positional.length} positional args`,
      );
    }

    const rawPath = positional[0] ?? '';
    const content = positional[1] ?? '';
    if (rawPath.length === 0) {
      throw new Error('write: <path> must be a non-empty string');
    }

    const targetPath = this.resolvePath(rawPath);

    if (allowedRoots.length > 0) {
      const normalizedRoots = allowedRoots.map((root) => {
        const resolved = resolveVirtualPath(this.cwd, root);
        return resolved.endsWith('/') ? resolved : `${resolved}/`;
      });
      const within = normalizedRoots.some((root) => {
        const rootNoTrail = root.slice(0, -1);
        return targetPath === rootNoTrail || targetPath.startsWith(root);
      });
      if (!within) {
        throw new WriteOutOfRootError(
          `write: ${targetPath} is outside allowed roots (${allowedRoots.join(', ')})`,
        );
      }
    }

    return { targetPath, content };
  }

  ln(...args: unknown[]): ShellString {
    try {
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

      const source = this.expandCommandPaths('ln', [inputs[0]!])[0]!;
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
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  chmod(mode: string | number, ...paths: string[]): ShellString {
    try {
      if (!this.fs.chmodSync) {
        return this.fail('chmod: filesystem does not support chmod');
      }
      const parsed = parseMode(mode);
      for (const target of this.expandCommandPaths('chmod', paths)) {
        this.fs.chmodSync(target, parsed);
      }
      return this.success('');
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  ls(...args: unknown[]): ShellArrayResult<string | LongListEntry> {
    try {
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
      const targets = this.expandCommandPaths('ls', inputs.length === 0 ? ['.'] : inputs);
      const results: Array<string | LongListEntry> = [];

      const listPath = (target: string): void => {
        const stat = this.fs.statSync(target);
        if (!stat.isDirectory() || listDirs) {
          results.push(long ? this.longEntry(target) : relativeDisplayPath(this.cwd, target));
          return;
        }

        const entries = this.fs.readdirSync(target);
        for (const entry of entries) {
          const name = readdirEntryName(entry);
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
    } catch (error) {
      return ShellArrayResult.from([], this, { code: 1, stderr: this.errorMessage(error) });
    }
  }

  patch(...args: unknown[]): ShellString {
    try {
      const pipe = this.extractPipeInput(args);
      const { options, patchText } = this.parsePatchArgs(args.filter((value) => !isPipeInput(value)), pipe);
      if (patchText.trim().length === 0) {
        return this.fail('patch: missing patch text');
      }

      const parsedPatches = parsePatch(patchText, { strict: true });
      if (
        parsedPatches.length === 0
        || parsedPatches.every((patch) => patch.hunks.length === 0 && !patch.oldFileName && !patch.newFileName)
      ) {
        return this.fail('patch: no patch data');
      }

      const patches = options.reverse ? (reversePatch(parsedPatches) as unknown as ParsedDiff[]) : parsedPatches;
      const mutations = this.buildPatchMutations(patches);
      const action = options.dryRun || options.check ? 'checked' : 'patched';

      let aggregated: HookResult | undefined;
      if (!options.dryRun && !options.check) {
        for (const mutation of mutations) {
          if (mutation.deleted) {
            this.removeNode(mutation.sourcePath!, false, false);
            continue;
          }

          if (!mutation.targetPath) {
            continue;
          }

          const dispatch = this.dispatchHooks('patch', mutation.targetPath, mutation.output);
          if ('veto' in dispatch) {
            return this.fail(`patch: ${dispatch.veto.reason}`, 1, dispatch.hookResult);
          }
          aggregated = this.mergeHookResults(aggregated, dispatch.hookResult);

          if (mutation.sourcePath && mutation.sourcePath !== mutation.targetPath && this.fs.existsSync(mutation.sourcePath)) {
            this.removeNode(mutation.sourcePath, false, false);
          }
        }
      }

      const stdout = mutations
        .map((mutation) => {
          const labelPath = mutation.targetPath ?? mutation.sourcePath ?? '.';
          const details: string[] = [];
          if (mutation.created) details.push('created');
          if (mutation.deleted) details.push('deleted');
          const suffix = details.length > 0 ? `, ${details.join(', ')}` : '';
          return `${action} ${relativeDisplayPath(this.cwd, labelPath)} (${mutation.hunks} hunk${mutation.hunks === 1 ? '' : 's'}${suffix})`;
        })
        .join('\n');

      return this.success(stdout, 0, aggregated);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  diff(...args: unknown[]): ShellString {
    try {
      const { options, leftPath, rightPath } = this.parseDiffArgs(args);
      if (!this.fs.existsSync(leftPath) || !this.fs.existsSync(rightPath)) {
        throw new Error('diff: both paths must exist');
      }

      const leftStat = this.fs.statSync(leftPath);
      const rightStat = this.fs.statSync(rightPath);
      if (leftStat.isDirectory() !== rightStat.isDirectory()) {
        throw new Error('diff: cannot compare file to directory');
      }

      const entries = leftStat.isDirectory()
        ? this.buildDirectoryDiffEntries(leftPath, rightPath, options.context)
        : this.buildSingleFileDiffEntries(leftPath, rightPath, options.context);

      if (entries.length === 0) {
        return this.success('', 0);
      }

      return this.success(this.renderDiffEntries(entries, options), 1);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
  }

  splice(...args: unknown[]): ShellString {
    try {
      let dryRun = false;
      if (args[0] === '-d') {
        dryRun = true;
        args = args.slice(1);
      }

      const [file, startLine, deleteCount, ...insertLines] = args as [string, number, number, ...string[]];
      const target = this.resolvePath(file);
      const { source } = this.readCommandTextFile(target, 'splice');
      const { lines, trailingNewline } = splitContentAndTrailingNewline(source);
      const startIndex = startLine - 1;

      if (startIndex < 0 || startIndex > lines.length) {
        return this.fail(`splice: start line out of bounds: ${startLine}`);
      }

      const updated = [...lines];
      updated.splice(startIndex, deleteCount, ...insertLines);
      const output = joinLines(updated, trailingNewline || insertLines.length > 0);

      if (!dryRun) {
        const dispatch = this.dispatchHooks('splice', target, output);
        if ('veto' in dispatch) {
          return this.fail(`splice: ${dispatch.veto.reason}`, 1, dispatch.hookResult);
        }
        return this.success(output, 0, dispatch.hookResult);
      }

      return this.success(output);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
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
    try {
      const resolved = this.resolvePath(target);
      if (!safeStat(this.fs, resolved, false)) {
        return this.fail(`realpath: no such file or directory: ${relativeDisplayPath(this.cwd, resolved)}`);
      }
      if (this.fs.realpathSync) {
        return this.success(normalizeVirtualPath(decodeText(this.fs.realpathSync(resolved))));
      }
      return this.success(resolved);
    } catch (error) {
      return this.fail(this.errorMessage(error));
    }
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

  private parseShowArgs(args: unknown[]): { options: ShowCommandOptions; targetPath: string } {
    const options: ShowCommandOptions = { numbers: false, context: 0 };
    const positional: unknown[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--numbers') {
        options.numbers = true;
        continue;
      }
      if (arg === '--context') {
        options.context = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('--context=')) {
        options.context = Number(arg.slice('--context='.length));
        continue;
      }
      if (arg === '--around-line') {
        options.aroundLine = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (arg === '--around-match') {
        options.aroundMatch = args[index + 1] as string | RegExp;
        index += 1;
        continue;
      }
      positional.push(arg);
    }

    if (!Number.isInteger(options.context) || options.context < 0) {
      throw new Error('show: context must be a non-negative integer');
    }

    const contextualModes = Number(options.aroundLine !== undefined) + Number(options.aroundMatch !== undefined);
    if (contextualModes > 1) {
      throw new Error('show: choose either --around-line or --around-match');
    }

    if (options.aroundLine !== undefined || options.aroundMatch !== undefined) {
      if (positional.length !== 1) {
        throw new Error('show: expected exactly one file path for contextual mode');
      }
      return {
        options,
        targetPath: this.resolvePath(String(positional[0])),
      };
    }

    if (positional.length !== 3) {
      throw new Error('show: expected file path, start line, and end line');
    }

    options.startLine = Number(positional[1]);
    options.endLine = Number(positional[2]);
    return {
      options,
      targetPath: this.resolvePath(String(positional[0])),
    };
  }

  private resolveShowRange(
    source: string,
    lines: string[],
    options: ShowCommandOptions,
    label: string,
  ): { startLine: number; endLine: number } {
    if (options.aroundLine !== undefined) {
      if (!Number.isInteger(options.aroundLine) || options.aroundLine < 1 || options.aroundLine > lines.length) {
        throw new Error(`show: line out of bounds for ${label}: ${options.aroundLine}`);
      }
      return {
        startLine: Math.max(1, options.aroundLine - options.context),
        endLine: Math.min(lines.length, options.aroundLine + options.context),
      };
    }

    if (options.aroundMatch !== undefined) {
      const matches = this.collectTextMatches(source, options.aroundMatch, 'insert');
      if (matches.length !== 1) {
        throw new Error(`show: expected exactly 1 match in ${label}, found ${matches.length}`);
      }

      const lineNumber = source.slice(0, matches[0]!.start).split('\n').length;
      return {
        startLine: Math.max(1, lineNumber - options.context),
        endLine: Math.min(lines.length, lineNumber + options.context),
      };
    }

    if (
      !Number.isInteger(options.startLine)
      || !Number.isInteger(options.endLine)
      || options.startLine === undefined
      || options.endLine === undefined
      || options.startLine < 1
      || options.endLine < options.startLine
      || options.endLine > lines.length
    ) {
      throw new Error(`show: invalid line range for ${label}: ${String(options.startLine)}-${String(options.endLine)}`);
    }

    return { startLine: options.startLine, endLine: options.endLine };
  }

  private parseDiffArgs(args: unknown[]): { options: DiffCommandOptions; leftPath: string; rightPath: string } {
    const options: DiffCommandOptions = { nameOnly: false, stat: false, context: 3 };
    const positional: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--name-only') {
        options.nameOnly = true;
        continue;
      }
      if (arg === '--stat') {
        options.stat = true;
        continue;
      }
      if (arg === '-U') {
        options.context = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (typeof arg === 'string' && /^-U\d+$/.test(arg)) {
        options.context = Number(arg.slice(2));
        continue;
      }
      if (typeof arg === 'string') {
        positional.push(arg);
        continue;
      }
      throw new Error(`diff: unsupported argument: ${String(arg)}`);
    }

    if (options.nameOnly && options.stat) {
      throw new Error('diff: choose either --name-only or --stat');
    }
    if (!Number.isInteger(options.context) || options.context < 0) {
      throw new Error('diff: context must be a non-negative integer');
    }
    if (positional.length !== 2) {
      throw new Error('diff: expected two paths');
    }

    return {
      options,
      leftPath: this.resolvePath(positional[0]!),
      rightPath: this.resolvePath(positional[1]!),
    };
  }

  private buildSingleFileDiffEntries(leftPath: string, rightPath: string, context: number): DiffEntry[] {
    const leftLabel = relativeDisplayPath(this.cwd, leftPath);
    const rightLabel = relativeDisplayPath(this.cwd, rightPath);
    const entry = this.buildDiffEntry(leftPath, rightPath, leftLabel === rightLabel ? rightLabel : `${leftLabel} -> ${rightLabel}`, leftLabel, rightLabel, context);
    return entry ? [entry] : [];
  }

  private buildDirectoryDiffEntries(leftRoot: string, rightRoot: string, context: number): DiffEntry[] {
    const leftFiles = this.collectDiffFiles(leftRoot);
    const rightFiles = this.collectDiffFiles(rightRoot);
    const labels = Array.from(new Set([...leftFiles.keys(), ...rightFiles.keys()])).sort((left, right) => left.localeCompare(right));

    const entries: DiffEntry[] = [];
    for (const label of labels) {
      const entry = this.buildDiffEntry(leftFiles.get(label) ?? null, rightFiles.get(label) ?? null, label, label, label, context);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  private collectDiffFiles(rootPath: string): Map<string, string> {
    const files = new Map<string, string>();

    const visit = (absolutePath: string, relativePath: string): void => {
      const stat = this.fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        const entries = this.fs.readdirSync(absolutePath);
        const names = entries
          .map((entry) => readdirEntryName(entry))
          .sort((left, right) => left.localeCompare(right));

        for (const name of names) {
          const childPath = normalizeVirtualPath(path.posix.join(absolutePath, name));
          const childRelativePath = relativePath.length === 0 ? name : `${relativePath}/${name}`;
          visit(childPath, childRelativePath);
        }
        return;
      }

      files.set(relativePath, absolutePath);
    };

    visit(rootPath, '');
    files.delete('');
    return files;
  }

  private buildDiffEntry(
    leftPath: string | null,
    rightPath: string | null,
    label: string,
    oldLabel: string,
    newLabel: string,
    context: number,
  ): DiffEntry | null {
    const leftRaw = leftPath ? this.fs.readFileSync(leftPath) : null;
    const rightRaw = rightPath ? this.fs.readFileSync(rightPath) : null;
    const binary = (leftRaw !== null && looksBinary(leftRaw)) || (rightRaw !== null && looksBinary(rightRaw));

    if (binary) {
      const sameBinary = leftRaw !== null && rightRaw !== null && Buffer.from(leftRaw).equals(Buffer.from(rightRaw));
      if (sameBinary) {
        return null;
      }
      return {
        label,
        oldLabel: leftPath ? oldLabel : '/dev/null',
        newLabel: rightPath ? newLabel : '/dev/null',
        patch: null,
        added: 0,
        removed: 0,
        binary: true,
      };
    }

    const left = leftRaw === null ? '' : decodeText(leftRaw);
    const right = rightRaw === null ? '' : decodeText(rightRaw);
    if (left === right && leftPath !== null && rightPath !== null) {
      return null;
    }

    const patch = structuredPatch(
      leftPath ? oldLabel : '/dev/null',
      rightPath ? newLabel : '/dev/null',
      left,
      right,
      '',
      '',
      { context },
    );
    const { added, removed } = this.countPatchStats(patch);

    return {
      label,
      oldLabel: patch.oldFileName ?? oldLabel,
      newLabel: patch.newFileName ?? newLabel,
      patch,
      added,
      removed,
      binary: false,
    };
  }

  private countPatchStats(patch: ParsedDiff): { added: number; removed: number } {
    let added = 0;
    let removed = 0;

    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          added += 1;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          removed += 1;
        }
      }
    }

    return { added, removed };
  }

  private renderDiffEntries(entries: DiffEntry[], options: DiffCommandOptions): string {
    if (options.nameOnly) {
      return entries.map((entry) => entry.label).join('\n');
    }

    if (options.stat) {
      return entries
        .map((entry) => (entry.binary ? `binary ${entry.label}` : `${String(entry.added).padStart(4)}+ ${String(entry.removed).padStart(4)}- ${entry.label}`))
        .join('\n');
    }

    return entries
      .map((entry) => (entry.binary ? `Binary files ${entry.oldLabel} and ${entry.newLabel} differ` : this.renderStructuredPatch(entry.patch!)))
      .join('\n');
  }

  private renderStructuredPatch(patch: ParsedDiff): string {
    const lines = [
      `--- ${patch.oldFileName ?? '/dev/null'}`,
      `+++ ${patch.newFileName ?? '/dev/null'}`,
    ];

    for (const hunk of patch.hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      lines.push(...hunk.lines);
    }

    return lines.join('\n');
  }

  private parsePatchArgs(args: unknown[], pipe?: PipeInput): { options: PatchCommandOptions; patchText: string } {
    const options: PatchCommandOptions = { dryRun: false, check: false, reverse: false };
    const patchArgs: string[] = [];

    for (const arg of args) {
      if (arg === '--dry-run') {
        options.dryRun = true;
        continue;
      }
      if (arg === '--check') {
        options.check = true;
        continue;
      }
      if (arg === '--reverse') {
        options.reverse = true;
        continue;
      }
      if (typeof arg === 'string') {
        patchArgs.push(arg);
        continue;
      }
      throw new Error(`patch: unsupported argument: ${String(arg)}`);
    }

    if (pipe?.stdin !== undefined && patchArgs.length > 0) {
      throw new Error('patch: provide patch text either via stdin or a single argument');
    }
    if (patchArgs.length > 1) {
      throw new Error('patch: expected a single patch text argument');
    }

    return { options, patchText: pipe?.stdin ?? patchArgs[0] ?? '' };
  }

  private buildPatchMutations(patches: ParsedDiff[]): PatchMutation[] {
    return patches.map((patch, index) => {
      const sourceName = this.resolvePatchPath(patch.oldFileName, patch.newFileName, 'a/');
      const targetName = this.resolvePatchPath(patch.newFileName, patch.oldFileName, 'b/');
      const displayName = targetName ?? sourceName ?? `patch ${index + 1}`;
      if (!sourceName && !targetName) {
        throw new Error(`patch: missing file path for ${displayName}`);
      }
      if (patch.hunks.length === 0) {
        throw new Error(`patch: no hunks for ${displayName}`);
      }

      const sourcePath = sourceName ? this.resolvePath(sourceName) : null;
      const targetPath = targetName ? this.resolvePath(targetName) : null;

      let source = '';
      if (sourcePath) {
        if (!this.fs.existsSync(sourcePath)) {
          throw new Error(`patch: target file missing: ${sourceName}`);
        }

        const raw = this.fs.readFileSync(sourcePath);
        if (looksBinary(raw)) {
          throw new Error(`patch: binary file not supported: ${sourceName}`);
        }
        source = decodeText(raw);
      }

      const output = applyUnifiedPatch(source, patch, { fuzzFactor: 0 });
      if (output === false) {
        const failedHunk = this.findFailingPatchHunk(source, patch);
        throw new Error(`patch: hunk ${failedHunk ?? '?'} failed for ${displayName}`);
      }

      return {
        sourcePath,
        targetPath,
        output,
        hunks: patch.hunks.length,
        created: sourcePath === null && targetPath !== null,
        deleted: sourcePath !== null && targetPath === null,
      };
    });
  }

  private findFailingPatchHunk(source: string, patch: ParsedDiff): number | null {
    for (let index = 0; index < patch.hunks.length; index += 1) {
      const attempt = applyUnifiedPatch(
        source,
        {
          ...patch,
          hunks: patch.hunks.slice(0, index + 1),
        },
        { fuzzFactor: 0 },
      );

      if (attempt === false) {
        return index + 1;
      }
    }

    return null;
  }

  private resolvePatchPath(
    fileName: string | undefined,
    counterpartFileName: string | undefined,
    expectedPrefix: 'a/' | 'b/',
  ): string | null {
    if (!fileName || fileName === '/dev/null') {
      return null;
    }

    const oppositePrefix = expectedPrefix === 'a/' ? 'b/' : 'a/';
    if (
      fileName.startsWith(expectedPrefix)
      && (counterpartFileName === '/dev/null' || counterpartFileName?.startsWith(oppositePrefix))
    ) {
      return fileName.slice(expectedPrefix.length);
    }

    return fileName;
  }

  private parseReplaceArgs(
    args: unknown[],
    pipe?: PipeInput,
  ): { options: ReplaceCommandOptions; targetPath: string | null; search: string | RegExp; replacement: string } {
    const options: ReplaceCommandOptions = { dryRun: false, all: false, regex: false };
    const positional: unknown[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--dry-run') {
        options.dryRun = true;
        continue;
      }
      if (arg === '--all') {
        options.all = true;
        continue;
      }
      if (arg === '--regex') {
        options.regex = true;
        continue;
      }
      if (arg === '--expected') {
        options.expected = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('--expected=')) {
        options.expected = Number(arg.slice('--expected='.length));
        continue;
      }
      positional.push(arg);
    }

    const requiredArgs = pipe?.stdin !== undefined ? 2 : 3;
    if (positional.length !== requiredArgs) {
      throw new Error(`replace: expected ${requiredArgs} arguments`);
    }

    const pathValue = pipe?.stdin !== undefined ? null : positional[0];
    const search = positional[pipe?.stdin !== undefined ? 0 : 1];
    const replacement = positional[pipe?.stdin !== undefined ? 1 : 2];

    if ((typeof search !== 'string' && !(search instanceof RegExp)) || search === '') {
      throw new Error('replace: missing search pattern');
    }

    return {
      options,
      targetPath: pathValue === null ? null : this.resolvePath(String(pathValue)),
      search,
      replacement: String(replacement),
    };
  }

  private parseInsertArgs(
    args: unknown[],
  ): { options: InsertCommandOptions; targetPath: string; anchor: string | RegExp | null; content: string } {
    let mode: InsertCommandOptions['mode'] | null = null;
    let dryRun = false;
    const positional: unknown[] = [];

    for (const arg of args) {
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--before' || arg === '--after' || arg === '--at-start' || arg === '--at-end') {
        if (mode) {
          throw new Error('insert: choose exactly one insertion mode');
        }
        mode = arg.slice(2) as InsertCommandOptions['mode'];
        continue;
      }
      positional.push(arg);
    }

    if (!mode) {
      throw new Error('insert: missing insertion mode');
    }

    if (mode === 'at-start' || mode === 'at-end') {
      if (positional.length !== 2) {
        throw new Error('insert: expected file path and content');
      }
      return {
        options: { dryRun, mode },
        targetPath: this.resolvePath(String(positional[0])),
        anchor: null,
        content: String(positional[1]),
      };
    }

    if (positional.length !== 3) {
      throw new Error('insert: expected file path, anchor, and content');
    }

    const anchor = positional[1];
    if ((typeof anchor !== 'string' && !(anchor instanceof RegExp)) || anchor === '') {
      throw new Error('insert: missing anchor');
    }

    return {
      options: { dryRun, mode },
      targetPath: this.resolvePath(String(positional[0])),
      anchor,
      content: String(positional[2]),
    };
  }

  private readReplaceableTarget(
    targetPath: string | null,
    command: 'replace' | 'insert',
    pipe?: PipeInput,
  ): { source: string; label: string } {
    if (targetPath === null) {
      return { source: pipe?.stdin ?? '', label: '(stdin)' };
    }

    return this.readCommandTextFile(targetPath, command);
  }

  private applyReplace(
    source: string,
    search: string | RegExp,
    replacement: string,
    options: ReplaceCommandOptions,
    label: string,
  ): string {
    const normalizedSearch = typeof search === 'string' ? this.normalizeExactEditText(source, search) : search;
    const normalizedReplacement = this.normalizeExactEditText(source, replacement);
    const matcher = this.normalizeMatcher(normalizedSearch, options.regex);
    const matches = this.collectTextMatches(source, matcher, 'replace');
    const replaceAll = options.expected !== undefined || options.all;

    if (options.expected !== undefined && matches.length !== options.expected) {
      throw new Error(`replace: expected ${options.expected} matches in ${label}, found ${matches.length}`);
    }
    if (options.expected === undefined && options.all && matches.length === 0) {
      throw new Error(`replace: expected at least 1 match in ${label}, found 0`);
    }
    if (options.expected === undefined && !options.all && matches.length !== 1) {
      throw new Error(`replace: expected exactly 1 match in ${label}, found ${matches.length}`);
    }

    if (typeof matcher === 'string') {
      if (replaceAll) {
        return source.split(matcher).join(normalizedReplacement);
      }

      const match = matches[0]!;
      return `${source.slice(0, match.start)}${normalizedReplacement}${source.slice(match.end)}`;
    }

    const regex = replaceAll ? this.withGlobalFlag(matcher) : matcher;
    return source.replace(regex, normalizedReplacement);
  }

  private applyInsert(
    source: string,
    anchor: string | RegExp | null,
    content: string,
    options: InsertCommandOptions,
    label: string,
  ): string {
    const normalizedContent = this.normalizeExactEditText(source, content);

    if (options.mode === 'at-start') {
      return `${normalizedContent}${source}`;
    }
    if (options.mode === 'at-end') {
      return `${source}${normalizedContent}`;
    }
    if (!anchor) {
      throw new Error('insert: missing anchor');
    }

    const normalizedAnchor = typeof anchor === 'string' ? this.normalizeExactEditText(source, anchor) : anchor;
    const matches = this.collectTextMatches(source, normalizedAnchor, 'insert');
    if (matches.length !== 1) {
      throw new Error(`insert: expected exactly 1 anchor match in ${label}, found ${matches.length}`);
    }

    const match = matches[0]!;
    const index = options.mode === 'before' ? match.start : match.end;
    return `${source.slice(0, index)}${normalizedContent}${source.slice(index)}`;
  }

  private normalizeExactEditText(source: string, value: string): string {
    return normalizeToNewlineStyle(value, detectNewlineStyle(source));
  }

  private normalizeMatcher(search: string | RegExp, regexMode: boolean): string | RegExp {
    if (search instanceof RegExp) {
      return search;
    }

    if (regexMode) {
      return new RegExp(search);
    }

    if (search.length === 0) {
      throw new Error('replace: empty search is not allowed');
    }

    return search;
  }

  private collectTextMatches(source: string, search: string | RegExp, command: 'replace' | 'insert'): TextMatch[] {
    if (typeof search === 'string') {
      if (search.length === 0) {
        throw new Error(`${command}: empty search is not allowed`);
      }

      const matches: TextMatch[] = [];
      let start = 0;
      while (start <= source.length) {
        const index = source.indexOf(search, start);
        if (index === -1) {
          break;
        }
        matches.push({ start: index, end: index + search.length, text: search });
        start = index + search.length;
      }
      return matches;
    }

    const regex = this.withGlobalFlag(search);
    const matches: TextMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const value = match[0] ?? '';
      if (value.length === 0) {
        throw new Error(`${command}: zero-length regex matches are not supported`);
      }
      matches.push({ start: match.index, end: match.index + value.length, text: value });
    }

    return matches;
  }

  private withGlobalFlag(pattern: RegExp): RegExp {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return new RegExp(pattern.source, flags);
  }

  private isGlobPattern(value: string): boolean {
    return /[*?{]/.test(value);
  }

  private expandCommandPaths(command: string, inputs: string[], options: { allowMissing?: boolean } = {}): string[] {
    const resolved: string[] = [];

    for (const input of inputs) {
      const matches = this.expandPaths(input);
      if (matches.length === 0) {
        if (this.isGlobPattern(input) || options.allowMissing) {
          continue;
        }
        throw new Error(`${command}: no such file or directory: ${relativeDisplayPath(this.cwd, this.resolvePath(input))}`);
      }

      for (const match of matches) {
        if (!safeStat(this.fs, match, false)) {
          if (options.allowMissing) {
            continue;
          }
          throw new Error(`${command}: no such file or directory: ${relativeDisplayPath(this.cwd, match)}`);
        }
        resolved.push(match);
      }
    }

    return resolved;
  }

  private readCommandTextFile(target: string, command: string): { source: string; label: string } {
    const label = relativeDisplayPath(this.cwd, target);
    const stat = safeStat(this.fs, target, false);
    if (!stat) {
      throw new Error(`${command}: no such file or directory: ${label}`);
    }
    if (!stat.isFile()) {
      throw new Error(`${command}: not a file: ${label}`);
    }

    const raw = this.fs.readFileSync(target);
    if (looksBinary(raw)) {
      throw new Error(`${command}: binary file not supported: ${label}`);
    }

    return { source: decodeText(raw), label };
  }

  private ensureNoMixedInput(command: string, pipe: PipeInput | undefined, paths: string[]): void {
    if (pipe?.stdin !== undefined && paths.length > 0) {
      throw new Error(`${command}: provide either stdin or file paths, not both`);
    }
  }

  private extractPipeInput(args: unknown[]): PipeInput | undefined {
    const last = args.at(-1);
    return isPipeInput(last) ? last : undefined;
  }

  private success(stdout: string, code = 0, hookResult?: HookResult): ShellString {
    return new ShellString(stdout, { code, shell: this, hookResult });
  }

  private fail(stderr: string, code = 1, hookResult?: HookResult): ShellString {
    return new ShellString('', { code, stderr, shell: this, hookResult });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Run the listener pipeline for a content-mutation verb, then perform the
   * write. Returns either:
   *   - `{ veto: HookVetoResult, hookResult }` — onBefore vetoed; no write happened.
   *   - `{ ok: true, hookResult }` — write completed; aggregated results follow.
   *
   * Composition rules (locked by tests):
   *   - Listeners run in registration order.
   *   - Non-matching `match` glob skips ALL handlers including onBefore.
   *   - onBefore exceptions are caught, captured as warnings, treated NON-veto.
   *   - First {refuse:true} aborts; subsequent listeners do not fire onBefore.
   *   - Per-verb handler runs after the write, then onAny.
   *   - Per-handler exceptions are caught, captured as warnings.
   *   - diagnostics/warnings concat (registration order); impact/workspaceEdit/
   *     beforeModelHint use last-non-undefined-wins.
   *   - Handler returning `undefined` is a no-op (skipped, doesn't crash).
   *
   * If no listeners match, returns `{ ok: true, hookResult: undefined }` and
   * the verb performs its write directly. The hookResult field on ShellString
   * stays undefined — the listener pipeline was a true no-op.
   */
  private dispatchHooks(verb: VerbName, target: string, content: string):
    | { veto: HookVetoResult; hookResult: HookResult }
    | { ok: true; hookResult: HookResult | undefined } {
    const matched = this.listeners.filter((listener) =>
      this.listenerMatches(listener, target),
    );

    if (matched.length === 0) {
      // Fast path: no listener cares about this path. Perform the write and
      // return undefined hookResult so callers know nothing was aggregated.
      writeTextFile(this.fs, target, content);
      return { ok: true, hookResult: undefined };
    }

    const prevContent: string | undefined = this.fs.existsSync(target)
      ? readTextFile(this.fs, target)
      : undefined;

    const ctx: MutationCtx = {
      verb,
      path: target,
      content,
      prevContent,
      fs: this.fs,
      beforeModel: this.beforeModel,
    };

    const warnings: string[] = [];
    const diagnostics: unknown[] = [];
    let impact: unknown;
    let workspaceEdit: unknown;
    let beforeModelHint: unknown;

    // Phase 1: onBefore. First {refuse:true} aborts. Throws are non-veto.
    for (const listener of matched) {
      if (!listener.onBefore) continue;
      let veto: HookVetoResult | undefined;
      try {
        veto = listener.onBefore(ctx);
      } catch (error) {
        warnings.push(`onBefore threw: ${this.errorMessage(error)}`);
        continue;
      }
      if (veto && veto.refuse === true) {
        if (veto.diagnostics) diagnostics.push(...veto.diagnostics);
        return {
          veto,
          hookResult: { warnings, diagnostics },
        };
      }
    }

    // Phase 2: perform the actual write.
    writeTextFile(this.fs, target, content);

    // Phase 3: per-verb handler + onAny on each matched listener.
    const verbHandlerKey = (
      'on' + verb.charAt(0).toUpperCase() + verb.slice(1)
    ) as keyof ShellListener;

    const applyResult = (result: HookResult | undefined): void => {
      if (!result) return;
      if (result.diagnostics) diagnostics.push(...result.diagnostics);
      if (result.warnings) warnings.push(...result.warnings);
      if (result.impact !== undefined) impact = result.impact;
      if (result.workspaceEdit !== undefined) workspaceEdit = result.workspaceEdit;
      if (result.beforeModelHint !== undefined) beforeModelHint = result.beforeModelHint;
    };

    for (const listener of matched) {
      const verbHandler = listener[verbHandlerKey] as
        | ((ctx: MutationCtx) => HookResult | undefined)
        | undefined;
      if (typeof verbHandler === 'function') {
        try {
          applyResult(verbHandler(ctx));
        } catch (error) {
          warnings.push(`${verb} threw: ${this.errorMessage(error)}`);
        }
      }
      if (typeof listener.onAny === 'function') {
        try {
          applyResult(listener.onAny(ctx));
        } catch (error) {
          warnings.push(`onAny threw: ${this.errorMessage(error)}`);
        }
      }
    }

    // Update internal beforeModel if a listener fed back a hint.
    if (beforeModelHint !== undefined) {
      this.beforeModel = beforeModelHint;
    }

    return {
      ok: true,
      hookResult: { diagnostics, warnings, impact, workspaceEdit, beforeModelHint },
    };
  }

  /**
   * Merge two hookResult shells. Used by verbs that issue multiple writes
   * in one call (e.g. sed across N files). Concat diagnostics/warnings;
   * last-non-undefined wins for impact/workspaceEdit/beforeModelHint.
   */
  private mergeHookResults(
    left: HookResult | undefined,
    right: HookResult | undefined,
  ): HookResult | undefined {
    if (!left) return right;
    if (!right) return left;
    return {
      diagnostics: [...(left.diagnostics ?? []), ...(right.diagnostics ?? [])],
      warnings: [...(left.warnings ?? []), ...(right.warnings ?? [])],
      impact: right.impact !== undefined ? right.impact : left.impact,
      workspaceEdit:
        right.workspaceEdit !== undefined ? right.workspaceEdit : left.workspaceEdit,
      beforeModelHint:
        right.beforeModelHint !== undefined ? right.beforeModelHint : left.beforeModelHint,
    };
  }

  /**
   * Match a listener's `match` glob/regex/array against a path.
   * Empty array = match-nothing (fail-closed).
   */
  private listenerMatches(listener: ShellListener, target: string): boolean {
    const patterns = Array.isArray(listener.match) ? listener.match : [listener.match];
    if (patterns.length === 0) return false;
    return patterns.some((pattern) => {
      if (typeof pattern === 'string') return matchesGlob(pattern, target);
      return pattern.test(target);
    });
  }

  private expandPaths(value: string): string[] {
    return this.isGlobPattern(value) ? expandGlob(this.fs, this.cwd, value) : [this.resolvePath(value)];
  }

  private readInputs(command: string, paths: string[]): string {
    return this.expandCommandPaths(command, paths).map((target) => this.readCommandTextFile(target, command).source).join('');
  }

  private parseHeadTailArgs(args: unknown[], defaultCount: number): { options: ParsedHeadTailOptions; paths: string[] } {
    const paths: string[] = [];
    let count = defaultCount;
    let fromStart = false;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
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
      const arg = args[index]!;
      if (typeof arg === 'object' && arg !== null) {
        const record = arg as Record<string, unknown>;
        if (record['-r']) options.reverse = true;
        if (record['-n']) options.numeric = true;
        if (record['-u']) options.unique = true;
        if (record['-k']) options.key = Number(record['-k']);
        if (typeof record['-t'] === 'string') options.separator = record['-t'];
        continue;
      }
      if (arg === '-k') {
        options.key = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (arg === '-t') {
        options.separator = String(args[index + 1]);
        index += 1;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('-')) {
        const flags = parseShortFlags(arg);
        flags.forEach((flag) => {
          if (flag === '-r') options.reverse = true;
          if (flag === '-n') options.numeric = true;
          if (flag === '-u') options.unique = true;
        });
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

  private parseFindArgs(args: string[]): { options: ParsedFindOptions; paths: string[] } {
    const options: ParsedFindOptions = { hidden: false, exclude: [] };
    const paths: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--hidden') {
        options.hidden = true;
        continue;
      }
      if (arg === '--exclude') {
        options.exclude.push(String(args[index + 1]));
        index += 1;
        continue;
      }
      if (arg === '--max-results') {
        options.maxResults = Number(args[index + 1]);
        index += 1;
        continue;
      }
      if (arg.startsWith('--exclude=')) {
        options.exclude.push(arg.slice('--exclude='.length));
        continue;
      }
      if (arg.startsWith('--max-results=')) {
        options.maxResults = Number(arg.slice('--max-results='.length));
        continue;
      }
      paths.push(arg);
    }

    if (options.maxResults !== undefined && (!Number.isInteger(options.maxResults) || options.maxResults < 1)) {
      throw new Error('find: max-results must be a positive integer');
    }

    return { options, paths: paths.length === 0 ? ['.'] : paths };
  }

  private isHiddenSearchPath(value: string): boolean {
    const normalized = value.startsWith('/') ? normalizeVirtualPath(value) : normalizeVirtualPath(`/${value}`);
    return normalized
      .split('/')
      .filter(Boolean)
      .some((segment) => segment !== '.' && segment !== '..' && segment.startsWith('.'));
  }

  private matchesSearchPatterns(patterns: string[], value: string): boolean {
    return patterns.some((pattern) => matchesGlob(pattern, value) || matchesGlob(pattern, basename(value)));
  }

  private limitSearchCount(primary?: number, secondary?: number): number | undefined {
    const limits = [primary, secondary].filter((value): value is number => value !== undefined);
    if (limits.length === 0) {
      return undefined;
    }
    return Math.min(...limits);
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
      hidden: false,
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
      const arg = args[index]!;
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

      if (pattern === undefined && arg === '--hidden') {
        options.hidden = true;
        continue;
      }
      if (pattern === undefined && arg === '--exclude') {
        options.exclude.push(String(args[index + 1]));
        index += 1;
        continue;
      }
      if (pattern === undefined && arg === '--exclude-dir') {
        options.excludeDir.push(String(args[index + 1]));
        index += 1;
        continue;
      }
      if (pattern === undefined && arg === '--max-count-total') {
        options.maxCountTotal = Number(args[index + 1]);
        index += 1;
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
      if (pattern === undefined && typeof arg === 'string' && arg.startsWith('--max-count-total=')) {
        options.maxCountTotal = Number(arg.slice('--max-count-total='.length));
        continue;
      }
      if (pattern === undefined && typeof arg === 'string' && arg.startsWith('-')) {
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
    if (options.maxCount !== undefined && (!Number.isInteger(options.maxCount) || options.maxCount < 1)) {
      throw new Error('grep: max count must be a positive integer');
    }
    if (options.maxCountTotal !== undefined && (!Number.isInteger(options.maxCountTotal) || options.maxCountTotal < 1)) {
      throw new Error('grep: max-count-total must be a positive integer');
    }

    return { options, pattern, paths };
  }

  private createMatcher(pattern: string | RegExp, options: ParsedGrepOptions): RegExp {
    const base = typeof pattern === 'string' ? pattern : pattern.source;
    const source = options.wordRegexp ? `\\b(?:${base})\\b` : base;
    const flags = new Set(((typeof pattern === 'string' ? '' : pattern.flags) + (options.ignoreCase ? 'i' : '')).split(''));
    flags.add('g');
    return new RegExp(source, Array.from(flags).join(''));
  }

  private collectGrepTargets(paths: string[], options: ParsedGrepOptions): string[] {
    const results = new Set<string>();

    const addPath = (absolutePath: string, allowHidden: boolean): void => {
      const relative = relativeDisplayPath(this.cwd, absolutePath);
      if (!allowHidden && this.isHiddenSearchPath(relative)) {
        return;
      }

      const stat = this.fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        if (!options.recursive) {
          return;
        }
        if (this.matchesSearchPatterns(options.excludeDir, relative)) {
          return;
        }

        const entries = this.fs.readdirSync(absolutePath);
        const names = entries
          .map((entry) => readdirEntryName(entry))
          .sort((left, right) => left.localeCompare(right));

        for (const name of names) {
          addPath(normalizeVirtualPath(path.posix.join(absolutePath, name)), allowHidden);
        }
        return;
      }

      if (options.include.length > 0 && !this.matchesSearchPatterns(options.include, relative)) {
        return;
      }
      if (this.matchesSearchPatterns(options.exclude, relative)) {
        return;
      }

      results.add(absolutePath);
    };

    for (const input of paths) {
      this.expandCommandPaths('grep', [input]).forEach((target) => addPath(target, options.hidden || this.isHiddenSearchPath(relativeDisplayPath(this.cwd, target))));
    }

    return Array.from(results).sort((left, right) => left.localeCompare(right));
  }

  private grepContent(
    displayName: string,
    content: string,
    matcher: RegExp,
    options: ParsedGrepOptions,
    showFilenameDefault: boolean,
  ): { stdout: string; totalMatches: number } {
    const lines = splitLines(content);
    const groups: Array<{ start: number; end: number; matches: Array<{ lineIndex: number; matches: string[] }> }> = [];
    let totalMatches = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const rawMatches = Array.from(line.matchAll(matcher)).map((match) => match[0]);
      const isMatch = options.invert ? rawMatches.length === 0 : rawMatches.length > 0;
      if (!isMatch) {
        continue;
      }

      const remaining = options.maxCount === undefined ? Number.POSITIVE_INFINITY : options.maxCount - totalMatches;
      if (remaining <= 0) {
        break;
      }

      const matches = options.onlyMatching && !options.invert ? rawMatches.slice(0, remaining) : rawMatches;
      const contribution = options.filesWithMatches ? 1 : options.onlyMatching && !options.invert ? matches.length : 1;
      if (contribution <= 0) {
        break;
      }

      totalMatches += contribution;
      const start = Math.max(0, index - options.before);
      const end = Math.min(lines.length - 1, index + options.after);
      const last = groups.at(-1);
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
        last.matches.push({ lineIndex: index, matches });
      } else {
        groups.push({ start, end, matches: [{ lineIndex: index, matches }] });
      }

      if (options.filesWithMatches || (options.maxCount !== undefined && totalMatches >= options.maxCount)) {
        break;
      }
    }

    if (totalMatches === 0) {
      return { stdout: '', totalMatches: 0 };
    }
    if (options.filesWithMatches) {
      return { stdout: displayName, totalMatches };
    }
    if (options.countOnly) {
      const showFilename = options.withFilename ?? showFilenameDefault;
      return {
        stdout: `${showFilename && displayName ? `${displayName}:` : ''}${totalMatches}`,
        totalMatches,
      };
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

    return { stdout: outputLines.join('\n'), totalMatches };
  }

  private sortKey(line: string, key?: number, separator?: string): string {
    if (!key || key <= 1) {
      return line;
    }
    const parts = separator === undefined ? line.trim().split(/\s+/) : line.split(separator);
    return parts[key - 1]?.trim() ?? '';
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
      this.fs.symlinkSync(decodeText(this.fs.readlinkSync(source)), destination);
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
        const name = readdirEntryName(entry);
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
        const name = readdirEntryName(entry);
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
