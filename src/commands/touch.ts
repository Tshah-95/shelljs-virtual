import type { Shell } from '../shell.js';

export function touchCommand(shell: Shell, ...args: unknown[]) {
  return shell.touch(...args);
}
