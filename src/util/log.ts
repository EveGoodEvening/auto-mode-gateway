import { isIP } from 'node:net';
import pino, { type DestinationStream, type Logger } from 'pino';

import { collectConfigSecrets, sanitizeAuditValue } from '../audit/record.js';
import type { Config } from '../config/schema.js';
import { resolvePolicy } from '../policy/effective.js';

const protectedHeader = /^(?:authorization|x-api-key|cf-aig-authorization)$/i;

/** Forwarded addresses are untrusted logging metadata, never an authorization
 * identity. Only the first address is meaningful; malformed chains use the peer. */
export function clientAddressForLog(headers: Headers, remoteAddress: string | undefined, trustProxy: boolean): string | undefined {
  if (!trustProxy) return remoteAddress;
  const first = headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim();
  return first && isIP(first) !== 0 ? first : remoteAddress;
}

/** One logger for CLI and HTTP diagnostics. Redact complete source values before
 * pino formats them: neither error serialization nor message interpolation may
 * create a path around configured-literal and case-insensitive header masking. */
export function createLogger(config: Config, destination: DestinationStream = process.stderr): Logger {
  const credentials = collectConfigSecrets(config);
  const policy = resolvePolicy(config.policy);
  function sanitize(value: unknown): unknown {
    const seen = new WeakMap<object, object>();
    function project(input: unknown): unknown {
      if (input === null || typeof input !== 'object') return input;
      const previous = seen.get(input);
      if (previous) return previous;
      const result: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : {};
      seen.set(input, result);
      if (input instanceof Headers) {
        for (const [key, entry] of input) {
          Object.defineProperty(result, key, {
            value: protectedHeader.test(key) ? '[REDACTED:credential]' : entry,
            enumerable: true, configurable: true, writable: true,
          });
        }
        return result;
      }
      // Error message/stack/cause are normally non-enumerable. Read data
      // descriptors only, so hostile getters/toJSON/inspect cannot run in logs.
      const keys = new Set(Object.keys(input));
      if (input instanceof Error) {
        for (const key of ['name', 'message', 'stack', 'cause', 'errors']) keys.add(key);
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) continue;
        Object.defineProperty(result, key, {
          value: protectedHeader.test(key) ? '[REDACTED:credential]' : project(descriptor.value),
          enumerable: true, configurable: true, writable: true,
        });
      }
      return result;
    }
    try {
      // Reuse audit's full-source literal pass, inert property handling, policy
      // redaction and omission of already-truncated, unsafe content excerpts.
      return sanitizeAuditValue(project(value), credentials, policy);
    } catch {
      // Never report arbitrary serialization exceptions or partially scrubbed data.
      return { diagnostic: 'Log value could not be serialized' };
    }
  }
  const logger = pino({
    level: config.log_level,
    serializers: { err: sanitize },
    formatters: {
      bindings: (bindings) => sanitize(bindings) as Record<string, unknown>,
      log: (object) => sanitize(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const safe = args.map((value) => sanitize(value));
        method.apply(this, safe as Parameters<typeof method>);
      },
    },
  }, destination);
  // Pino intentionally resets the bindings formatter when creating children.
  // Scrub bindings before its normal child factory serializes them; retaining
  // the dynamic receiver preserves options, callbacks and descendant behavior.
  const child = logger.child;
  logger.child = function (this: Logger, bindings, options) {
    return child.call(this, bindings && sanitize(bindings) as pino.Bindings, options);
  } as typeof logger.child;
  // setBindings uses the same reset formatter on descendants. Sanitize before
  // native binding accumulation rather than replacing or rebuilding that state.
  const setBindings = logger.setBindings;
  logger.setBindings = function (this: Logger, bindings) {
    setBindings.call(this, sanitize(bindings) as pino.Bindings);
  };
  return logger;
}
