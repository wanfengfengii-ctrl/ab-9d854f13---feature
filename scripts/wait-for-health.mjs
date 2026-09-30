#!/usr/bin/env node
/**
 * Poll an HTTP health endpoint until it reports healthy or a deadline
 * elapses. Exit code 0 / 1 respectively.
 *
 * Usage: node scripts/wait-for-health.mjs <url> [timeoutSeconds] [intervalMs]
 */

const url = process.argv[2];
const timeoutSeconds = Number.parseInt(process.argv[3] ?? '120', 10);
const intervalMs = Number.parseInt(process.argv[4] ?? '1000', 10);

if (!url) {
  console.error('usage: wait-for-health.mjs <url> [timeoutSeconds] [intervalMs]');
  process.exit(2);
}

const deadline = Date.now() + timeoutSeconds * 1000;

const attempt = async () => {
  try {
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.status === 'ok') return true;
    }
  } catch {
    // not ready yet
  }
  return false;
};

const tick = async () => {
  if (await attempt()) {
    console.log(`API healthy at ${url}`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    console.error(`API did not become healthy within ${timeoutSeconds}s (${url})`);
    process.exit(1);
  }
  setTimeout(tick, intervalMs);
};

tick();
