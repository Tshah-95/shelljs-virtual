import type { Shell } from '../shell.js';

export function findCommand(shell: Shell, ...paths: string[]) {
  return shell.find(...paths);
}
