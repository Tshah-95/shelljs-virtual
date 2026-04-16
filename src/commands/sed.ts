import type { Shell } from '../shell.js';

export function sedCommand(shell: Shell, ...args: unknown[]) {
  return shell.sed(...args);
}
