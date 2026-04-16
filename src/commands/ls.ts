import type { Shell } from '../shell.js';

export function lsCommand(shell: Shell, ...args: unknown[]) {
  return shell.ls(...args);
}
