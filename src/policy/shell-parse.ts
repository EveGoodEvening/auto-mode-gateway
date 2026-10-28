import { parse } from 'shell-quote';

import { SHELL_INTERPRETERS, SHELL_UNSAFE_PROGRAMS } from './constants.js';

export interface ShellSegment {
  argv: string[];
  /** The shell operator following this segment, when present. */
  operator?: string;
}

export interface ParsedShell {
  segments: ShellSegment[];
  valid: boolean;
  unsafe: boolean;
  reasons: string[];
}

/** Lex only: never expand the environment, invoke a shell, or execute a token. */
export function parseShell(text: string): ParsedShell {
  const reasons = new Set<string>();
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  let source = '';
  let wordStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      if (char !== '\n') source += `\\${char}`;
      escaped = false;
      wordStart = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
    } else if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
    } else if (quote !== 'single' && (char === '$' || char === '`')) {
      reasons.add(char === '`' || text[index + 1] === '(' ? 'substitution' : 'expansion');
    }
    if (!quote && char === '#' && wordStart) {
      while (index < text.length && text[index] !== '\n') index += 1;
      if (index < text.length) source += ';';
      wordStart = true;
      continue;
    }
    if (!quote && char === '\n') {
      source += ';';
      wordStart = true;
      continue;
    }
    if (char === '\0' || char === '\r') reasons.add('unsupported-control');
    source += char;
    wordStart = !quote && /[\s;|&()<>]/u.test(char);
  }
  const balanced = quote === undefined && !escaped;
  if (!balanced) reasons.add('unbalanced-quote-or-escape');
  const segments: ShellSegment[] = [];
  let argv: string[] = [];
  let valid = balanced;
  try {
    const entries = parse(source, (name) => `$${name}`);
    for (const entry of entries) {
      if (typeof entry === 'string') {
        argv.push(entry);
      } else if ('comment' in entry) {
        continue;
      } else if (entry.op === 'glob') {
        argv.push(entry.pattern);
      } else {
        const operator: string = entry.op;
        if (['|', '|&', ';', '&&', '||', '&'].includes(operator)) {
          if (argv.length === 0) {
            // A blank line or trailing comment may produce a redundant semicolon.
            if (operator !== ';') valid = false;
          } else {
            segments.push({ argv, operator });
            argv = [];
          }
          if (operator === '&' || operator === '|&') reasons.add('unsupported-operator');
        } else {
          reasons.add(/[<>]/u.test(operator) ? 'redirection' : 'unsupported-operator');
        }
      }
    }
    if (argv.length > 0) segments.push({ argv });
    const last = segments.at(-1);
    if (last?.operator && ['|', '|&', '&&', '||'].includes(last.operator)) valid = false;
  } catch {
    valid = false;
    reasons.add('parse-error');
  }
  if (segments.length === 0) valid = false;
  for (const segment of segments) {
    const program = shellProgram(segment.argv[0] ?? '');
    if (SHELL_UNSAFE_PROGRAMS.includes(program)) reasons.add('execution-wrapper');
    if (SHELL_INTERPRETERS.includes(program)) reasons.add('interpreter');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(segment.argv[0] ?? '')) reasons.add('assignment');
    if (program === 'base64' && segment.argv.some((arg) => arg === '--decode' || /^-[^-]*[dD]/u.test(arg))) {
      reasons.add('base64-decode');
    }
  }
  if (!valid) reasons.add('invalid-shell');
  return { segments, valid, unsafe: reasons.size > 0, reasons: [...reasons] };
}

export function shellProgram(token: string): string {
  return token.replaceAll('\\', '/').split('/').at(-1) ?? '';
}
