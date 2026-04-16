import type { Shell } from '../shell.js';

export function echoCommand(shell: Shell, ...values: unknown[]) {
  return shell.echo(...values);
}
