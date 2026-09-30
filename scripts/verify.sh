#!/bin/sh
# One-shot verification pipeline for the `verify` compose service.
#
#   1. wait for the API health endpoint
#   2. TypeScript build (tsc, emit to dist/)
#   3. code tests (vitest run)
#   4. HTTP smoke check with the cross-week + missing-packet sample
#
# Exits non-zero on the first failing stage; the container then stops on its
# own (restart: "no" in compose).

set -eu

BASE_URL="${API_BASE_URL:-http://api:3000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT_SECONDS:-120}"

echo "==> [1/4] waiting for API health at ${BASE_URL}/health"
node scripts/wait-for-health.mjs "${BASE_URL}/health" "${HEALTH_TIMEOUT}"

echo "==> [2/4] TypeScript build"
npm run build

echo "==> [3/4] code tests"
npm test

echo "==> [4/4] HTTP smoke check"
node scripts/smoke.mjs "${BASE_URL}"

echo ""
echo "VERIFY PASSED: build, tests and HTTP smoke all succeeded"
