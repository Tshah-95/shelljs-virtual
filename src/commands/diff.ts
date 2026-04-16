import type { Shell } from '../shell.js';

export function diffCommand(shell: Shell, ...args: unknown[]) {
  return shell.diff(...args);
}
