import type { Shell } from '../shell.js';

export function lnCommand(shell: Shell, ...args: unknown[]) {
  return shell.ln(...args);
}
