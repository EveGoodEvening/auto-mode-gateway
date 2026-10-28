import { describe, expect, it } from 'vitest';
import type { Action, ActionContext } from '../../src/gate/types.js';
import { resolvePolicy } from '../../src/policy/effective.js';
import { normalizePolicyPath, sensitivePaths } from '../../src/policy/sensitive-paths.js';

const context: ActionContext = { platform: 'linux', project_dir: '/work/project', workdir: '/work/project', home_dir: '/home/user' };
const read = (path: string): Action => ({ kind: 'other', tool: 'Read', paths: [path], recognized_exemption: 'read', content_truncated: false, raw: {} });

describe('sensitivePaths lexical policy', () => {
  it.each([
    ['.env', true], ['.env.local', true], ['nested/.env.production', true],
    ['private.pem', true], ['nested/private.key', true], ['~/.ssh/id_rsa', true],
    ['~/.ssh/id_ed25519', true], ['/home/user/.ssh/id_ecdsa.pub', true],
    ['.claude/settings.json', true], ['.claude/settings.local.json', true],
    ['.claude/hooks/run.sh', true], ['.claude/hooks', true], ['.codex/config.toml', true],
    ['.codex', true], ['.git/hooks/pre-commit', true], ['.github/workflows/ci.yaml', true],
    ['package.json', true], ['packages/app/package.json', true], ['.ssh/authorized_keys', true],
    ['README.md', false], ['src/main.ts', false], ['package-lock.json', false],
    ['.github/ISSUE_TEMPLATE/bug.yaml', false], ['.git/config', false],
    ['env.example', false], ['key.txt', false], ['settings.json', false],
    ['src/../.env', true], ['src/../README.md', false],
    ['*.key', true], ['**/*', true], ['.env*', true],
  ] as const)('reading %s requires review=%s', (path, expected) => {
    expect(sensitivePaths(read(path), context).review).toBe(expected);
  });

  it.each([
    ['src/new.ts', false], ['../sibling/new.ts', true], ['/work/project-other/file', true],
    ['/work/project/file', false], ['/tmp/new.ts', true], ['../../etc/config', true],
    ['sub/../../project/file', false], ['.github/workflows/new.yml', true],
  ] as const)('writing %s requires review=%s', (path, expected) => {
    expect(sensitivePaths({ ...read(path), kind: 'file_write', recognized_exemption: undefined }, context).review).toBe(expected);
  });

  it('does not treat trusted directories as an exemption for out-of-project writes', () => {
    expect(sensitivePaths({ ...read('/shared/file'), kind: 'file_write' }, { ...context, trusted_directories: ['/shared'] }).reasons).toContain('outside_project_write');
  });

  it.each(['cat ~/.ssh/id_rsa', 'cat .env', 'head private.pem', 'grep secret nested/.env', 'cat README.md | cat .env'])('reviews inert shell sensitive read %s', (text) => {
    expect(sensitivePaths({ kind: 'command', tool: 'Bash', text, paths: [], content_truncated: false, raw: {} }, context).review).toBe(true);
  });

  it.each([
    'grep -r token ~/.ssh',
    'grep -R token /home/user/.ssh/',
    'rg token ~/.ssh',
    'find ~/.ssh -type f',
  ])('reviews inert recursive SSH directory scope %s', (text) => {
    expect(sensitivePaths({ kind: 'command', tool: 'Bash', text, paths: [], content_truncated: false, raw: {} }, context).review).toBe(true);
  });

  it('reviews direct argv recursive SSH directory scope', () => {
    expect(sensitivePaths({ kind: 'command', tool: 'exec_command', argv: ['grep', '-r', 'token', '~/.ssh'], paths: [], content_truncated: false, raw: {} }, context).review).toBe(true);
  });

  it.each(['~/.ssh', '/home/user/.ssh/'])('reviews native searches of SSH directory scope %s', (path) => {
    for (const [tool, recognized_exemption] of [['Grep', 'grep'], ['Glob', 'glob']] as const) {
      expect(sensitivePaths({ ...read(path), tool, recognized_exemption }, context).review).toBe(true);
    }
  });

  it.each(['.', 'src', '/home/user', '.claude', 'nested/config'])('reviews possible native sensitive descendants under %s', (path) => {
    for (const recognized_exemption of ['grep', 'glob'] as const) {
      expect(sensitivePaths({ ...read(path), recognized_exemption }, context).reasons).toContain('sensitive_path_scope');
    }
  });

  it.each([
    'grep -ri token src', 'grep --rec token .', 'grep --dereference-recursive token .claude',
    'grep --directories=recurse token src', 'grep --dir recurse token src', 'grep -d recurse token src',
    'grep -drecurse token src', 'rg token src', 'find src -type f',
  ])('reviews general recursive sensitive descendant scope in %s', (text) => {
    expect(sensitivePaths({ kind: 'command', tool: 'Bash', text, paths: [], content_truncated: false, raw: {} }, context).reasons).toContain('sensitive_path_scope');
  });

  it('preserves nonrecursive explicit safe-file reads', () => {
    expect(sensitivePaths({ kind: 'command', tool: 'Bash', text: 'grep token README.md', paths: [], content_truncated: false, raw: {} }, context).review).toBe(false);
  });

  it('does not treat options after the grep terminator as recursive flags', () => {
    expect(sensitivePaths({ kind: 'command', tool: 'Bash', argv: ['grep', '--', '-r', 'README.md'], paths: [], content_truncated: false, raw: {} }, context).review).toBe(false);
  });

  it('checks direct argv without shell reparsing', () => {
    expect(sensitivePaths({ kind: 'command', tool: 'exec_command', argv: ['cat', '.env'], paths: [], content_truncated: false, raw: {} }, context).review).toBe(true);
  });

  it.each(['grep --file=.env README.md', 'grep -f.env README.md', 'head --file=private.pem'])('checks option-carried sensitive paths in %s', (text) => {
    expect(sensitivePaths({ kind: 'command', tool: 'Bash', text, paths: [], content_truncated: false, raw: {} }, context).review).toBe(true);
  });

  it.each(['read', 'grep', 'glob', 'ls'] as const)('never lets native %s exemption hide a sensitive path', (recognized_exemption) => {
    expect(sensitivePaths({ ...read('.env'), recognized_exemption }, context).review).toBe(true);
  });

  it.each(['$HOME/.ssh/id_rsa', '~other/.ssh/id_rsa', 'relative/file', '', 'bad\0name'])('does not establish safety for unresolved %s', (path) => {
    expect(sensitivePaths(read(path), {}).review).toBe(true);
  });

  it('requires a native read path but preserves pathless generic other semantics', () => {
    expect(sensitivePaths({ ...read(''), paths: [] }, context).review).toBe(true);
    expect(sensitivePaths({ kind: 'other', tool: 'custom', paths: [], raw: {}, content_truncated: false }, {}).review).toBe(false);
  });

  it('appends configured sensitive globs', () => {
    const policy = resolvePolicy({ sensitive_paths_extra: ['**/secrets/**'] });
    expect(sensitivePaths(read('secrets/vault.txt'), context, policy).review).toBe(true);
    expect(sensitivePaths(read('.env'), context, policy).review).toBe(true);
  });

  it('uses replacement globs without retaining the default sensitive list', () => {
    const policy = resolvePolicy({ sensitive_path_globs: ['**/vault/**'], sensitive_paths_extra: ['**/secrets/**'] });
    expect(sensitivePaths(read('vault/private.txt'), context, policy).review).toBe(true);
    expect(sensitivePaths(read('secrets/private.txt'), context, policy).review).toBe(true);
    expect(sensitivePaths(read('.env'), context, policy).review).toBe(false);
  });

  it('applies the same effective shell policy while extracting paths', () => {
    const policy = resolvePolicy({ shell_unsafe_programs: ['cat'] });
    const action: Action = { kind: 'command', tool: 'Bash', text: 'cat README.md', paths: [], content_truncated: false, raw: {} };
    expect(sensitivePaths(action, context, policy).reasons).toContain('unresolved_shell_paths');
  });

  it('keeps structural unresolved and containment checks with an empty sensitive list', () => {
    const policy = resolvePolicy({ sensitive_path_globs: [] });
    expect(sensitivePaths({ ...read('src'), recognized_exemption: 'grep' }, context, policy).review).toBe(false);
    expect(sensitivePaths(read('$UNKNOWN/file'), context, policy).reasons).toContain('unresolved_path');
    expect(sensitivePaths({ ...read('/outside/file'), kind: 'file_write' }, context, policy).reasons).toContain('outside_project_write');
    expect(sensitivePaths(read('C:\\repo\\safe.txt.'), { platform: 'win32' }, policy).reasons).toContain('unresolved_path');
  });

  it.each([
    ['C:\\repo\\src\\file.ts', false], ['C:\\REPO\\.ENV', true],
    ['C:\\repo-other\\file.ts', true], ['D:\\repo\\file.ts', true],
    ['C:\\repo\\..\\outside\\file.ts', true], ['%USERPROFILE%\\.ssh\\id_rsa', true],
  ] as const)('uses trusted Windows context for %s', (path, expected) => {
    expect(sensitivePaths({ ...read(path), kind: 'file_write' }, { platform: 'win32', project_dir: 'C:\\repo', userprofile: 'C:\\Users\\Alice' }).review).toBe(expected);
  });

  it.each([
    'C:\\repo\\private.pem.',
    'C:\\repo\\private.pem ',
    'C:\\repo\\private.key. ',
    'C:\\repo\\private.pem:backup',
    'C:\\repo\\private.pem::$DATA',
    'C:\\repo\\.claude.\\settings.json',
    'C:\\repo\\.claude \\settings.json',
    'C:\\repo\\.codex.\\config.toml',
    'C:\\repo\\.ssh.\\id_rsa',
    'C:\\repo\\.ssh \\id_rsa',
  ].flatMap((path) => (['read', 'write'] as const).map((operation) => [operation, path] as const)))('reviews native Windows %s alias %s', (operation, path) => {
    const windowsContext: ActionContext = { platform: 'win32', project_dir: 'C:\\repo', workdir: 'C:\\repo' };
    const action: Action = operation === 'read'
      ? read(path)
      : { ...read(path), kind: 'file_write', tool: 'Write', recognized_exemption: undefined };
    expect(sensitivePaths(action, windowsContext).review).toBe(true);
    expect(sensitivePaths(action, windowsContext).reasons).toContain('unresolved_path');
    expect(normalizePolicyPath(path, windowsContext)).toBeUndefined();
  });

  it('never expands USERPROFILE from the gateway host environment', () => {
    expect(normalizePolicyPath('%USERPROFILE%\\file', { platform: 'win32', project_dir: 'C:\\repo' })).toBeUndefined();
  });

  it('rejects drive-relative and root-relative Windows ambiguity', () => {
    expect(normalizePolicyPath('C:file', { platform: 'win32' })).toBeUndefined();
    expect(normalizePolicyPath('\\Windows\\file', { platform: 'win32' })).toBeUndefined();
  });

  it.each(['C:\\repo\\safe.txt.', 'C:\\repo\\safe.txt ', 'C:\\repo\\folder.\\..\\safe.txt', 'C:\\repo\\file:stream', '\\\\server\\share.\\file'])('rejects Windows aliases independent of sensitivity in %s', (path) => {
    expect(normalizePolicyPath(path, { platform: 'win32' })).toBeUndefined();
  });

  it('preserves UNC share boundaries lexically', () => {
    expect(normalizePolicyPath('\\\\server\\share\\dir\\..\\file', { platform: 'win32' })).toBe('//server/share/file');
  });

  it('resolves action workdir before context defaults', () => {
    expect(sensitivePaths({ ...read('.env'), workdir: '/other' }, context).paths).toEqual(['/other/.env']);
  });

  it('documents that a lexical path is not symlink resolution evidence', () => {
    const result = sensitivePaths({ ...read('alias/file.txt'), kind: 'file_write' }, context);
    expect(result.review).toBe(false);
    expect(result.paths).toEqual(['/work/project/alias/file.txt']);
    // alias may be a client symlink; this pure policy cannot inspect or authorize its target.
  });
});
