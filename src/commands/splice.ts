import type { Shell } from '../shell.js';

export function spliceCommand(shell: Shell, ...args: unknown[]) {
  return shell.splice(...args);
}
