import type { Socket } from 'node:net';
import { serve } from '@hono/node-server';
import { Command, Option } from 'commander';
import type { DestinationStream } from 'pino';
import { createLogger } from '../util/log.js';

import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { ApprovalBroker } from '../approval/broker.js';
import { createApprovalApp } from '../approval/web.js';
import { createApp } from '../server/app.js';

export interface RunServerOptions {
  /** Aborting runs the same bounded shutdown as SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** Shared broker to use instead of a fresh one; consulted only when enabled in enforce. */
  approvals?: ApprovalBroker;
  /** Startup/shutdown log sink; defaults to stderr. */
  logDestination?: DestinationStream;
}

function approvalUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}

/** Own only this listener and its sockets; never terminate another process. */
export async function runServer(config: Config, options: RunServerOptions = {}): Promise<void> {
  const logger = createLogger(config, options.logDestination);
  const human = config.human_approval;
  // One process-local queue shared by the gate and the approval listener.
  const approvals = human.enabled && config.gate.mode === 'enforce'
    ? options.approvals ?? new ApprovalBroker({ timeout_ms: human.timeout_ms, max_pending: human.max_pending })
    : undefined;
  const app = createApp(config, { approvals });
  const sockets = new Set<Socket>();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let approvalServer: ReturnType<typeof serve> | undefined;
  const approvalSockets = new Set<Socket>();
  const approvalClosed = Promise.withResolvers<void>();
  if (!approvals) approvalClosed.resolve();
  if (human.enabled && !approvals) logger.warn('Human approval is disabled in shadow mode');
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
  const closeApprovals = () => {
    // Pending requests settle as blocked before the gateway drains held turns.
    approvals?.close();
    if (approvalServer?.listening) {
      approvalServer.close(() => approvalClosed.resolve());
      // The broker is closed, so no UI request can still change a decision.
      for (const socket of approvalSockets) socket.destroy();
    } else approvalClosed.resolve();
  };
  const shutdown = () => {
    if (closing) return;
    closing = true;
    logger.info('Server stopping');
    closeApprovals();
    server.close();
    // Graceful draining is bounded, including an indefinitely open SSE peer.
    deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      for (const socket of approvalSockets) socket.destroy();
    }, 10_000);
    deadline.unref();
  };
  const cleanup = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    options.signal?.removeEventListener('abort', shutdown);
    clearTimeout(deadline);
  };
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.once('close', () => {
    const expired = Promise.withResolvers<void>();
    const auditDeadline = setTimeout(expired.resolve, 5_000);
    // The approval listener is drained within the same bounded shutdown.
    void approvalClosed.promise.then(() => {
      cleanup();
      return Promise.race([app.flushAudit(), expired.promise]);
    }).then(resolve, reject).finally(() => clearTimeout(auditDeadline));
  });
  server.once('error', () => {
    cleanup();
    closing = true;
    closeApprovals();
    for (const socket of approvalSockets) socket.destroy();
    server.close();
    for (const socket of sockets) socket.destroy();
    reject(new Error('Unable to serve configured listener'));
  });
  if (approvals) {
    const approvalApp = createApprovalApp(approvals, human);
    approvalServer = serve({ fetch: approvalApp.fetch, hostname: human.host, port: human.port }, () => {
      // Shutdown raced startup: close the late listener instead of keeping the process alive.
      if (closing) approvalServer!.close(() => approvalClosed.resolve());
      else {
        // Never put the token in the logged URL; operators append #token=... themselves.
        logger.info({ url: approvalUrl(human.host, human.port) }, 'Approval UI listening');
        if (human.token === undefined) {
          logger.warn('Approval UI has no token (require_token: false): any local process, including gated agents, can approve held actions');
        }
      }
    });
    approvalServer.on('connection', (socket: Socket) => {
      approvalSockets.add(socket);
      socket.once('close', () => approvalSockets.delete(socket));
    });
    approvalServer.once('error', () => {
      // Without its UI no human can answer: fail startup rather than queue blocks.
      approvals.close();
      approvalClosed.resolve();
      for (const socket of approvalSockets) socket.destroy();
      if (!closing) {
        closing = true;
        cleanup();
        server.close();
        for (const socket of sockets) socket.destroy();
        reject(new Error('Unable to serve configured approval listener'));
      }
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (options.signal?.aborted) shutdown();
  else options.signal?.addEventListener('abort', shutdown, { once: true });
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
