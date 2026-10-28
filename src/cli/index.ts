#!/usr/bin/env node

import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };

const program = new Command();

program
  .name('auto-mode-proxy')
  .description('A local proxy for agent tool-use safety decisions.')
  .version(pkg.version);

program.parse();
