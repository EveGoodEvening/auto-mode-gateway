import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'auto-mode-proxy', 'config.yaml');
export const DEFAULT_AUDIT_PATH = join(homedir(), '.local', 'state', 'auto-mode-proxy', 'audit.jsonl');
