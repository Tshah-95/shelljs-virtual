import type { Shell } from '../shell.js';

export function catCommand(shell: Shell, ...args: unknown[]) {
  return shell.cat(...args);
}
