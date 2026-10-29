import type { Socket } from 'node:net';
import { serve } from '@hono/node-server';
import { Command, Option } from 'commander';
import { createLogger } from '../util/log.js';

import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { createApp } from '../server/app.js';

/** Own only this listener and its sockets; never terminate another process. */
export async function runServer(config: Config): Promise<void> {
  const logger = createLogger(config);
  const app = createApp(config);
  const sockets = new Set<Socket>();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const server = serve({
    fetch: app.fetch,
    hostname: config.listen.host,
    port: config.listen.port,
  }, () => {
    if (config.gate.mode === 'shadow') logger.warn('Shadow mode records hypothetical decisions without blocking tools');
    logger.info('Server listening');
  });
  let closing = false;
  let deadline: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    logger.info('Server stopping');
    server.close();
    // Graceful draining is bounded, including an indefinitely open SSE peer.
    deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 10_000);
    deadline.unref();
  };
  const cleanup = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    clearTimeout(deadline);
  };
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.once('close', () => {
    cleanup();
    const expired = Promise.withResolvers<void>();
    const auditDeadline = setTimeout(expired.resolve, 5_000);
    void Promise.race([app.flushAudit(), expired.promise]).then(resolve, reject).finally(() => clearTimeout(auditDeadline));
  });
  server.once('error', () => {
    cleanup();
    server.close();
    for (const socket of sockets) socket.destroy();
    reject(new Error('Unable to serve configured listener'));
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await promise;
}

export function registerServeCommand(program: Command): void {
  program.command('serve')
    .description('Run authenticated transport with protocol-specific tool-use enforcement.')
    .option('--config <path>', 'configuration file path')
    .addOption(new Option('--log-level <level>', 'override configured log level')
      .choices(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']))
    .action(async (options: { config?: string; logLevel?: Config['log_level'] }) => {
      const config = await loadConfig(options.config);
      if (options.logLevel) config.log_level = options.logLevel;
      await runServer(config);
    });
}
