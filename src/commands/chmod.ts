import type { Shell } from '../shell.js';

export function chmodCommand(shell: Shell, mode: string | number, ...paths: string[]) {
  return shell.chmod(mode, ...paths);
}
