import type { Shell } from '../shell.js';

export function sortCommand(shell: Shell, ...args: unknown[]) {
  return shell.sort(...args);
}
