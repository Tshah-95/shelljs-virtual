import type { Shell } from '../shell.js';

export function mkdirCommand(shell: Shell, ...args: unknown[]) {
  return shell.mkdir(...args);
}
