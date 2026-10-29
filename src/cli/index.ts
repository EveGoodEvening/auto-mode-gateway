#!/usr/bin/env node

import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { registerInitCommand } from './init.js';
import { registerTokenCommand } from './token.js';
import { registerServeCommand } from './serve.js';
import { registerCheckCommand } from './check.js';
import { registerAuditCommand } from './audit.js';
import { registerEvalCommand } from './eval.js';

const program = new Command();

program
  .name('auto-mode-proxy')
  .description('A local proxy for agent tool-use safety decisions.')
  .version(pkg.version);

registerInitCommand(program);
registerTokenCommand(program);
registerServeCommand(program);
registerCheckCommand(program);
registerAuditCommand(program);
registerEvalCommand(program);

try {
  await program.parseAsync();
} catch {
  // Thrown errors may contain configuration values, credentials or prompt input.
  process.stderr.write('Error: command failed. Check the command options and configuration.\n');
  process.exitCode = 1;
}
