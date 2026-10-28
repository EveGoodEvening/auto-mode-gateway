import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateToken, registerTokenCommand } from '../../src/cli/token.js';

function createProgram() {
  const diagnostics: string[] = [];
  const program = new Command()
    .name('auto-mode-proxy')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => diagnostics.push(text),
      writeErr: (text) => diagnostics.push(text),
    });
  registerTokenCommand(program);
  return { program, diagnostics };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateToken', () => {
  it('encodes exactly 32 random bytes with a fixed prefix and no padding', () => {
    const samples = Array.from({ length: 128 }, () => generateToken());
    const decoded = samples.map((token) => {
      expect(token).toMatch(/^amp_[A-Za-z0-9_-]{43}$/);
      expect(token).toHaveLength(47);
      const payload = token.slice(4);
      const bytes = Buffer.from(payload, 'base64url');
      expect(bytes).toHaveLength(32);
      // Canonical encoding checks unused trailing bits, not just permissive decoding.
      expect(bytes.toString('base64url')).toBe(payload);
      return bytes;
    });

    expect(new Set(samples).size).toBe(samples.length);
    // Catch truncated/padded randomness, including constant first or last bytes.
    // This is a regression check, not a statistical proof of cryptographic entropy.
    for (let offset = 0; offset < 32; offset++) {
      expect(new Set(decoded.map((bytes) => bytes[offset])).size).toBeGreaterThan(1);
    }
  });
});

describe('token new', () => {
  it('writes exactly one token and newline to stdout, without logging or diagnostics', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { program, diagnostics } = createProgram();

    await program.parseAsync(['token', 'new'], { from: 'user' });

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]?.[0]).toMatch(/^amp_[A-Za-z0-9_-]{43}\n$/);
    expect(stderr).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it('issues a fresh token for each invocation', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().program.parseAsync(['token', 'new'], { from: 'user' });
    await createProgram().program.parseAsync(['token', 'new'], { from: 'user' });

    expect(stdout).toHaveBeenCalledTimes(2);
    expect(stdout.mock.calls[0]?.[0]).not.toBe(stdout.mock.calls[1]?.[0]);
  });

  it.each([
    ['token', 'new', 'unexpected'],
    ['token', 'new', '--unexpected'],
    ['token', 'unexpected'],
  ])('rejects unsupported arguments without issuing a token: %j', async (...args) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { program } = createProgram();

    await expect(program.parseAsync(args, { from: 'user' })).rejects.toBeInstanceOf(CommanderError);
    expect(stdout).not.toHaveBeenCalled();
  });
});
