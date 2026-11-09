import { shellCommandAllowed } from '../../shared/permissions';

const SHELL_METACHAR_REGEX = /[;&|`$(){}[\]<>!#~]/;

/**
 * `allowedCommands` entries are whole command lines (see `shellCommandAllowed`):
 * `git status` allows only that, `git *` allows any git arguments.
 * `blockedCommands` entries are executable names.
 */
export function validateCommand(
  command: string,
  args: readonly string[],
  allowedCommands: readonly string[],
  blockedCommands: readonly string[],
): string {
  if (!command || typeof command !== 'string') {
    throw new Error('Command is required');
  }

  const trimmed = command.trim();

  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    throw new Error(`Command contains disallowed characters: "${trimmed}"`);
  }

  const executable = trimmed;

  // A blocked name also blocks every path that ends in it: `/bin/rm` is `rm`.
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  if (blockedCommands.length > 0 && (blockedCommands.includes(executable) || blockedCommands.includes(name))) {
    throw new Error(`Command "${executable}" is blocked`);
  }

  if (allowedCommands.length > 0) {
    if (!shellCommandAllowed(allowedCommands, executable, args)) {
      throw new Error(`Command "${executable}" is not in the allowed commands list`);
    }
  }

  return executable;
}
