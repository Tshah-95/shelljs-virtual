import type { Shell } from '../shell.js';

export function mvCommand(shell: Shell, ...args: unknown[]) {
  return shell.mv(...args);
}
