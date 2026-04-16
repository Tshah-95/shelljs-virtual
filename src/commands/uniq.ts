import type { Shell } from '../shell.js';

export function uniqCommand(shell: Shell, ...args: unknown[]) {
  return shell.uniq(...args);
}
