import type { Shell } from '../shell.js';

export function pwdCommand(shell: Shell) {
  return shell.pwd();
}
