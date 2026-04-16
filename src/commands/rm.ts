import type { Shell } from '../shell.js';

export function rmCommand(shell: Shell, ...args: unknown[]) {
  return shell.rm(...args);
}
