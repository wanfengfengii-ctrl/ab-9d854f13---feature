import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleSolve } from './handler.js';

const PORT = Number.parseInt(process.env.API_PORT ?? '3000', 10);
const HOST = process.env.API_HOST ?? '0.0.0.0';
if (!Number.isSafeInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`Invalid API_PORT: ${process.env.API_PORT}`);
  process.exit(1);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    sendJson(res, 200, {
      status: 'ok',
      service: 'buoy-telemetry-recovery',
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/v1/recover') {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 1_048_576) {
        rejected = true;
        sendJson(res, 413, {
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'request body too large (limit 1 MiB)' },
        });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        sendJson(res, 400, {
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'request body must be valid JSON' },
        });
        return;
      }
      try {
        const outcome = handleSolve(parsed);
        if (outcome.status === 'ok') {
          sendJson(res, 200, outcome);
        } else {
          const httpStatus = outcome.error.code === 'INVALID_REQUEST' ? 400 : 422;
          sendJson(res, httpStatus, outcome);
        }
      } catch (err) {
        console.error('unexpected solver failure', err);
        sendJson(res, 500, {
          status: 'error',
          error: { code: 'INTERNAL', message: 'internal server error' },
        });
      }
    });
    req.on('error', () => {
      if (!rejected) {
        sendJson(res, 400, {
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'request read error' },
        });
      }
    });
    return;
  }

  sendJson(res, 404, {
    status: 'error',
    error: { code: 'NOT_FOUND', message: `no route for ${req.method ?? '?'} ${req.url ?? ''}` },
  });
});

server.listen(PORT, HOST, () => {
  console.log(`buoy-telemetry-recovery listening on http://${HOST}:${PORT}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`server error: ${err.code ?? err.message}`);
  process.exit(1);
});

const shutdown = (signal: string): void => {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Force-exit if open connections keep the server from closing promptly.
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
