import type { Shell } from '../shell.js';

export function whichCommand(shell: Shell, commandName: string) {
  return shell.which(commandName);
}
