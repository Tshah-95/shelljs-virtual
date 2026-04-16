import type { Shell } from '../shell.js';

export function headCommand(shell: Shell, ...args: unknown[]) {
  return shell.head(...args);
}
