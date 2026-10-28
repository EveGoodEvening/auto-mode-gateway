import { describe, expect, it } from 'vitest';
import { redact, redactText } from '../../src/policy/redact.js';

describe('redactText', () => {
  it.each([
    ['OpenAI key', 'sk-1234567890abcdef', 'sk-1234567890abcdef'],
    ['Anthropic key', 'sk-ant-1234567890abcdef', 'sk-ant-1234567890abcdef'],
    ['project API key', 'sk-proj-1234567890abcdef', 'sk-proj-1234567890abcdef'],
    ['GitHub classic', 'ghp_1234567890abcdef', 'ghp_1234567890abcdef'],
    ['GitHub fine grained', 'github_pat_1234567890abcdef', 'github_pat_1234567890abcdef'],
    ['AWS access key', 'AKIA' + 'A'.repeat(16), 'AKIA' + 'A'.repeat(16)],
    ['bearer header', 'Authorization: Bearer abc.def.token', 'abc.def.token'],
    ['lowercase bearer', 'bearer secret-token', 'secret-token'],
    ['API assignment', 'API_KEY=my-private-value', 'my-private-value'],
    ['JSON API key', '{"api_key":"private-api-value"}', 'private-api-value'],
    ['access token', 'access_token=private-access-value', 'private-access-value'],
    ['auth token', 'auth-token=private-auth-value', 'private-auth-value'],
    ['token', 'token=private-token-value', 'private-token-value'],
    ['password assignment', 'PASSWORD=private-password-value', 'private-password-value'],
    ['password argument', '--password private-password-value', 'private-password-value'],
    ['password short argument', '-p private-password-value', 'private-password-value'],
    ['API key argument', '--api-key private-api-value', 'private-api-value'],
    ['token argument', '--token private-token-value', 'private-token-value'],
    ['quoted assignment', 'password="very private value"', 'very private value'],
    ['single quote assignment', "password='very private value'", 'very private value'],
    ['quoted CLI password', '--password "very private value"', 'very private value'],
    ['PostgreSQL connection', 'postgresql://user:private-pass@db.example/app', 'private-pass'],
    ['MySQL connection', 'mysql://user:private-pass@db.example/app', 'private-pass'],
    ['MongoDB connection', 'mongodb+srv://user:private-pass@db.example/app', 'private-pass'],
    ['Redis connection', 'rediss://user:private-pass@db.example/0', 'private-pass'],
    ['AMQP connection', 'amqps://user:private-pass@mq.example/', 'private-pass'],
    ['HTTP basic URL', 'https://user:private-pass@service.example/', 'private-pass'],
    ...['RSA ', 'EC ', '', 'OPENSSH '].map((type) => [
      `${type}private PEM`,
      '-'.repeat(5) + `BEGIN ${type}PRIVATE KEY` + '-'.repeat(5) + '\nprivate-body\n' + '-'.repeat(5) + `END ${type}PRIVATE KEY` + '-'.repeat(5),
      'private-body',
    ]),
    ['incomplete PEM', '-----BEGIN PRIVATE KEY-----\nprivate-body', 'private-body'],
    ['ADO password', 'Server=db;User Id=u;Password=private-pass;', 'private-pass'],
  ])('redacts %s', (_name, input, secret) => {
    const output = redactText(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED:');
  });

  it('replaces configured literals including regex punctuation', () => {
    expect(redactText('literal a.b+[c] stays secret', ['a.b+[c]'])).toBe('literal [REDACTED:credential] stays secret');
  });

  it('replaces longer overlapping credentials first and all occurrences', () => {
    expect(redactText('prefix-secret prefix-secret', ['prefix', 'prefix-secret'])).toBe('[REDACTED:credential] [REDACTED:credential]');
  });

  it('ignores empty literal credentials', () => {
    expect(redactText('ordinary text', [''])).toBe('ordinary text');
  });

  it('does not redact ordinary prose, safe URLs, and source code', () => {
    const input = 'read README.md and https://example.com/docs; const passwordLength = 8;';
    expect(redactText(input)).toBe(input);
  });

  it('does not carry regular expression lastIndex between calls', () => {
    expect(redactText('Bearer abc.def')).toBe(redactText('Bearer abc.def'));
  });
});

describe('redact recursive data', () => {
  it.each(['apiKey', 'API_KEY', 'access_token', 'refresh-token', 'token', 'password', 'passwd', 'secret', 'client_secret', 'authorization', 'connection_string'])('redacts structured %s', (key) => {
    expect(redact({ [key]: 'opaque-private-value' })[key]).toBe('[REDACTED:credential]');
  });

  it('traverses arrays and nested objects without mutating source', () => {
    const input = { nested: [{ message: 'abc-private-literal' }], text: 'keep' };
    const output = redact(input, ['abc-private-literal']);
    expect(output).toEqual({ nested: [{ message: '[REDACTED:credential]' }], text: 'keep' });
    expect(input.nested[0]?.message).toBe('abc-private-literal');
    expect(output).not.toBe(input);
  });

  it('preserves primitive JSON values', () => {
    expect(redact([null, true, false, 12, 'hello'])).toEqual([null, true, false, 12, 'hello']);
  });

  it('never assigns attacker controlled __proto__ into an object prototype', () => {
    const input: unknown = JSON.parse('{"__proto__":{"polluted":"yes","password":"private"},"constructor":{"prototype":{"polluted":"yes"}}}');
    const output = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('does not invoke accessors while projecting inert JSON data', () => {
    let invoked = false;
    const input = Object.defineProperty({}, 'password', { enumerable: true, get() { invoked = true; throw new Error('must not run'); } });
    expect(redact(input)).toEqual({});
    expect(invoked).toBe(false);
  });

  it('preserves cycles and repeated references without recursion overflow', () => {
    const input: { self?: unknown; password: string } = { password: 'private' };
    input.self = input;
    const output = redact(input);
    expect(output.self).toBe(output);
    expect(output.password).toBe('[REDACTED:credential]');
  });
});
