#!/usr/bin/env node
/**
 * Container HEALTHCHECK probe. Exits 0 when the API answers /health,
 * 1 otherwise. Used both by the Dockerfile HEALTHCHECK and indirectly by
 * docker compose's `service_healthy` condition.
 */

const port = process.env.API_PORT ?? '3000';
// Always probe over loopback regardless of the server's bind address.
const url = `http://127.0.0.1:${port}/health`;

fetch(url)
  .then((res) => {
    if (res.ok) {
      process.exit(0);
    }
    console.error(`health check failed: HTTP ${res.status}`);
    process.exit(1);
  })
  .catch((err) => {
    console.error(`health check error: ${err?.message ?? err}`);
    process.exit(1);
  });
