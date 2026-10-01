#!/usr/bin/env node
/**
 * HTTP smoke check against a running API instance. Posts the canonical
 * cross-week + missing-packet sample and asserts the recovered interpretation.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 * Exit code 0 on success, 1 on any failure.
 */

const baseUrl = process.argv[2] ?? process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

const sample = {
  modulus: 10,
  countLower: 0,
  countUpper: 120,
  minInterval: 9,
  maxInterval: 11,
  packets: [
    { id: 'G', remainder: 1, timeLower: 307, timeUpper: 313 },
    { id: 'A', remainder: 8, timeLower: 77, timeUpper: 83 },
    { id: 'F', remainder: 0, timeLower: 297, timeUpper: 303 },
    { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
    { id: 'B', remainder: 9, timeLower: 87, timeUpper: 93 },
    { id: 'E', remainder: 2, timeLower: 217, timeUpper: 223 },
    { id: 'D', remainder: 1, timeLower: 207, timeUpper: 213 },
  ],
};

const expectedOrder = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const expectedCounts = [8, 9, 12, 21, 22, 30, 31];
const expectedMissing = [
  [10, 11],
  [13, 20],
  [23, 29],
];

// New-tempo (sampling-beat switch) sample. Old interval 9..11 applies until
// count 19; the new interval 4..6 starts at absolute count 20. Edge C -> D
// spans the switch (7 old steps + 3 new steps, allowed gap [75, 95]).
const switchSample = {
  modulus: 10,
  countLower: 0,
  countUpper: 60,
  minInterval: 9,
  maxInterval: 11,
  tempoSwitch: { firstNewCount: 20, newMinInterval: 4, newMaxInterval: 6 },
  packets: [
    { id: 'F', remainder: 5, timeLower: 222, timeUpper: 228 },
    { id: 'A', remainder: 8, timeLower: 77, timeUpper: 83 },
    { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
    { id: 'D', remainder: 2, timeLower: 207, timeUpper: 213 },
    { id: 'E', remainder: 3, timeLower: 212, timeUpper: 218 },
    { id: 'B', remainder: 9, timeLower: 87, timeUpper: 93 },
  ],
};
const switchExpectedOrder = ['A', 'B', 'C', 'D', 'E', 'F'];
const switchExpectedCounts = [8, 9, 12, 22, 23, 25];

function fail(message) {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

async function main() {
  // 1. Health endpoint.
  const healthRes = await fetch(`${baseUrl}/health`);
  if (!healthRes.ok) fail(`GET /health returned ${healthRes.status}`);
  const health = await healthRes.json();
  if (health.status !== 'ok') fail(`health payload not ok: ${JSON.stringify(health)}`);

  // 2. Recovery on the cross-week sample.
  const res = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sample),
  });
  if (res.status !== 200) {
    fail(`POST /api/v1/recover returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.status !== 'ok') fail(`response status not ok: ${JSON.stringify(body)}`);

  const { data } = body;
  if (JSON.stringify(data.order) !== JSON.stringify(expectedOrder)) {
    fail(`wrong order: got ${JSON.stringify(data.order)}`);
  }
  const counts = data.assignments.map((a) => a.absoluteCount);
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
    fail(`wrong absolute counts: got ${JSON.stringify(counts)}`);
  }
  for (let k = 1; k < data.assignments.length; k++) {
    const prev = data.assignments[k - 1];
    const cur = data.assignments[k];
    if (cur.absoluteCount <= prev.absoluteCount) fail('counts not strictly increasing');
    if (cur.time <= prev.time) fail('timestamps not strictly increasing');
    if (((cur.absoluteCount % 10) + 10) % 10 !== cur.remainder) fail('count/remainder mismatch');
    if (cur.time < cur.timeInterval.lower || cur.time > cur.timeInterval.upper) {
      fail('selected time outside packet closed interval');
    }
  }
  const segments = data.missingSegments.map((s) => [s.fromCount, s.toCount]);
  if (JSON.stringify(segments) !== JSON.stringify(expectedMissing)) {
    fail(`wrong missing segments: got ${JSON.stringify(segments)}`);
  }
  if (data.missingCountTotal !== 17) fail(`wrong missing total: ${data.missingCountTotal}`);
  if (data.adjacency.length !== 6) fail('expected 6 adjacency evidence entries');
  for (const ev of data.adjacency) {
    if (!ev.satisfied) fail(`unsatisfied adjacency evidence: ${JSON.stringify(ev)}`);
    if (ev.timeGap < ev.allowedTimeGap.min || ev.timeGap > ev.allowedTimeGap.max) {
      fail(`time gap ${ev.timeGap} outside [${ev.allowedTimeGap.min}, ${ev.allowedTimeGap.max}]`);
    }
  }

  // 3. Infeasible request must surface the stable business error code.
  const bad = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sample, countUpper: 3 }),
  });
  if (bad.status !== 400 && bad.status !== 422) {
    fail(`infeasible request returned HTTP ${bad.status}`);
  }
  const badBody = await bad.json();
  if (badBody.status !== 'error' || !badBody.error.code) fail('error body missing stable code');

  // 4. Tempo-switch recovery (new sampling beat from absolute count 20).
  const swRes = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(switchSample),
  });
  if (swRes.status !== 200) {
    fail(`tempo-switch request returned ${swRes.status}: ${await swRes.text()}`);
  }
  const swBody = await swRes.json();
  if (swBody.status !== 'ok') fail(`tempo-switch response not ok: ${JSON.stringify(swBody)}`);
  const sw = swBody.data;
  if (JSON.stringify(sw.order) !== JSON.stringify(switchExpectedOrder)) {
    fail(`tempo-switch wrong order: got ${JSON.stringify(sw.order)}`);
  }
  if (JSON.stringify(sw.assignments.map((a) => a.absoluteCount)) !== JSON.stringify(switchExpectedCounts)) {
    fail(`tempo-switch wrong counts: got ${JSON.stringify(sw.assignments.map((a) => a.absoluteCount))}`);
  }
  const span = sw.adjacency.find((e) => e.fromId === 'C' && e.toId === 'D');
  if (!span) fail('tempo-switch missing spanning adjacency C -> D');
  if (span.oldSteps !== 7 || span.newSteps !== 3 || span.countGap !== 10) {
    fail(`tempo-switch step split wrong: ${JSON.stringify({ g: span.countGap, o: span.oldSteps, n: span.newSteps })}`);
  }
  if (span.allowedTimeGap.min !== 75 || span.allowedTimeGap.max !== 95) {
    fail(`tempo-switch synthesized range wrong: ${JSON.stringify(span.allowedTimeGap)}`);
  }
  if (span.timeGap < 75 || span.timeGap > 95 || !span.satisfied) {
    fail('tempo-switch spanning edge not satisfied');
  }
  for (const ev of sw.adjacency) {
    if (ev.oldSteps + ev.newSteps !== ev.countGap) fail('tempo-switch step counts do not sum to gap');
  }

  // 5. An illegal switch descriptor must map to INVALID_REQUEST.
  const invalidSw = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...switchSample, tempoSwitch: { firstNewCount: 20, newMinInterval: 9 } }),
  });
  if (invalidSw.status !== 400) fail(`invalid switch returned HTTP ${invalidSw.status}`);
  const invalidSwBody = await invalidSw.json();
  if (invalidSwBody.status !== 'error' || invalidSwBody.error.code !== 'INVALID_REQUEST') {
    fail(`invalid switch error body wrong: ${JSON.stringify(invalidSwBody)}`);
  }

  // 6. A tempo conflict (new beat too tight for the forced count gap) is a
  //    422 with absolute-count range and old/new decomposition evidence.
  const conflict = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...switchSample, countUpper: 40,
      tempoSwitch: { firstNewCount: 20, newMinInterval: 1, newMaxInterval: 2 } }),
  });
  if (conflict.status !== 422) fail(`tempo conflict returned HTTP ${conflict.status}`);
  const conflictBody = await conflict.json();
  if (conflictBody.error.code !== 'NO_CONSISTENT_INTERPRETATION') {
    fail(`tempo conflict code wrong: ${JSON.stringify(conflictBody)}`);
  }
  const detail = conflictBody.error.evidence?.detail;
  if (!detail?.absoluteCountRange || !detail?.tempoBreakdown) {
    fail('tempo conflict evidence missing count range / tempo breakdown');
  }

  console.log('SMOKE PASSED');
  console.log(`  order     : ${data.order.join(' -> ')}`);
  console.log(`  counts    : ${counts.join(', ')}`);
  console.log(`  missing   : ${data.missingCountTotal} packets in ${segments.length} segment(s)`);
  console.log(`  adjacency : all ${data.adjacency.length} constraints satisfied`);
}

main().catch((err) => fail(err.stack ?? String(err)));
