import type { Shell } from '../shell.js';

export function wcCommand(shell: Shell, ...args: unknown[]) {
  return shell.wc(...args);
}
