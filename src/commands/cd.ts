import type { Shell } from '../shell.js';

export function cdCommand(shell: Shell, target?: string) {
  return shell.cd(target);
}
