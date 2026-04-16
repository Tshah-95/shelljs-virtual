import type { Shell } from '../shell.js';

export function grepCommand(shell: Shell, ...args: unknown[]) {
  return shell.grep(...args);
}
