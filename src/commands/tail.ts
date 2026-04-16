import type { Shell } from '../shell.js';

export function tailCommand(shell: Shell, ...args: unknown[]) {
  return shell.tail(...args);
}
