import type { Shell } from '../shell.js';

export function cpCommand(shell: Shell, ...args: unknown[]) {
  return shell.cp(...args);
}
