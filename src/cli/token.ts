import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';

export function generateToken(): string {
  return `amp_${randomBytes(32).toString('base64url')}`;
}

export function registerTokenCommand(program: Command): void {
  program
    .command('token')
    .description('Manage proxy client tokens.')
    .command('new')
    .description('Print a new client token. Treat the output as a secret.')
    .action(() => {
      // Issuance deliberately returns the secret to the caller, never to a logger.
      process.stdout.write(`${generateToken()}\n`);
    });
}
