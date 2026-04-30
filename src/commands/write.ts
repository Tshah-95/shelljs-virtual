import type { Shell } from '../shell.js';

export function writeCommand(shell: Shell, ...args: unknown[]) {
  return shell.write(...args);
}
