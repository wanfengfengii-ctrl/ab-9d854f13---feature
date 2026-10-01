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

/**
 * In-voyage beat-switch scenario. Modulus 10, old beat 9..11, new beat
 * 19..21, switch at absolute count 14. Ground truth:
 *
 *   A    B    C    D    E    F    G
 *   10 ->11 ->12 ->14 ->15 ->16 ->17
 *   r0   r1   r2   r4   r5   r6   r7
 *
 * The edge C -> D (12 -> 14) straddles the switch: one old step and one new
 * step compose an allowed time difference of 28..32 (observed 30), not the
 * 18..22 that a single beat over the gap of 2 would give.
 */
const beatSample = {
  modulus: 10,
  countLower: 0,
  countUpper: 60,
  minInterval: 9,
  maxInterval: 11,
  beatSwitch: { firstNewBeatCount: 14, newMinInterval: 19, newMaxInterval: 21 },
  packets: [
    { id: 'G', remainder: 7, timeLower: 207, timeUpper: 213 },
    { id: 'A', remainder: 0, timeLower: 97, timeUpper: 103 },
    { id: 'F', remainder: 6, timeLower: 187, timeUpper: 193 },
    { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
    { id: 'B', remainder: 1, timeLower: 107, timeUpper: 113 },
    { id: 'E', remainder: 5, timeLower: 167, timeUpper: 173 },
    { id: 'D', remainder: 4, timeLower: 147, timeUpper: 153 },
  ],
};
const beatExpectedOrder = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const beatExpectedCounts = [10, 11, 12, 14, 15, 16, 17];
const beatExpectedSteps = [
  [1, 0], // A -> B
  [1, 0], // B -> C
  [1, 1], // C -> D straddles the switch
  [0, 1],
  [0, 1],
  [0, 1],
];

const expectedOrder = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const expectedCounts = [8, 9, 12, 21, 22, 30, 31];
const expectedMissing = [
  [10, 11],
  [13, 20],
  [23, 29],
];

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

  // 4. Beat-switch recovery: composed old/new time ranges across the switch.
  const beatRes = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(beatSample),
  });
  if (beatRes.status !== 200) {
    fail(`beat-switch request returned ${beatRes.status}: ${await beatRes.text()}`);
  }
  const beatBody = await beatRes.json();
  if (beatBody.status !== 'ok') fail(`beat-switch response not ok: ${JSON.stringify(beatBody)}`);
  const bd = beatBody.data;
  if (JSON.stringify(bd.order) !== JSON.stringify(beatExpectedOrder)) {
    fail(`beat-switch wrong order: got ${JSON.stringify(bd.order)}`);
  }
  if (JSON.stringify(bd.assignments.map((a) => a.absoluteCount)) !== JSON.stringify(beatExpectedCounts)) {
    fail(`beat-switch wrong counts: got ${JSON.stringify(bd.assignments.map((a) => a.absoluteCount))}`);
  }
  if (bd.adjacency.length !== 6) fail('expected 6 beat adjacency entries');
  bd.adjacency.forEach((ev, i) => {
    if (!ev.satisfied) fail(`beat adjacency unsatisfied: ${JSON.stringify(ev)}`);
    if (ev.oldSteps + ev.newSteps !== ev.countGap) fail('beat steps do not partition the gap');
    if (JSON.stringify([ev.oldSteps, ev.newSteps]) !== JSON.stringify(beatExpectedSteps[i])) {
      fail(`edge ${i} wrong old/new steps: got ${ev.oldSteps}/${ev.newSteps}`);
    }
    const bd2 = ev.beatBreakdown;
    if (!bd2 || bd2.switchAtCount !== 14) fail('missing beat breakdown on adjacency');
    const composedMin = bd2.old.minTimeGap + bd2.next.minTimeGap;
    const composedMax = bd2.old.maxTimeGap + bd2.next.maxTimeGap;
    if (ev.allowedTimeGap.min !== composedMin || ev.allowedTimeGap.max !== composedMax) {
      fail('composed allowed range is not the sum of per-beat ranges');
    }
    if (ev.timeGap < ev.allowedTimeGap.min || ev.timeGap > ev.allowedTimeGap.max) {
      fail(`time gap ${ev.timeGap} outside composed [${ev.allowedTimeGap.min}, ${ev.allowedTimeGap.max}]`);
    }
  });
  if (!bd.beatSwitch || bd.beatSwitch.firstNewBeatCount !== 14) {
    fail('result must echo the beat switch configuration');
  }

  // 5. Malformed beat parameters -> INVALID_REQUEST (HTTP 400).
  const invalidBeat = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...beatSample, beatSwitch: { firstNewBeatCount: 14, newMinInterval: 30, newMaxInterval: 5 } }),
  });
  if (invalidBeat.status !== 400) fail(`malformed beat params returned HTTP ${invalidBeat.status}`);
  const invalidBeatBody = await invalidBeat.json();
  if (invalidBeatBody.error.code !== 'INVALID_REQUEST') {
    fail(`expected INVALID_REQUEST, got ${invalidBeatBody.error.code}`);
  }

  // 6. Beat-switch timing conflict -> NO_CONSISTENT_INTERPRETATION (422) with
  // absolute-count range and old/new beat decomposition in the first blocker.
  const conflictPackets = [
    { id: 'A', remainder: 0, timeLower: 0, timeUpper: 6 },
    { id: 'B', remainder: 1, timeLower: 9, timeUpper: 15 },
    { id: 'C', remainder: 2, timeLower: 18, timeUpper: 24 },
    { id: 'D', remainder: 4, timeLower: 28, timeUpper: 34 },
    { id: 'E', remainder: 5, timeLower: 47, timeUpper: 53 },
    { id: 'F', remainder: 6, timeLower: 66, timeUpper: 72 },
    { id: 'G', remainder: 7, timeLower: 85, timeUpper: 91 },
  ];
  const conflictRes = await fetch(`${baseUrl}/api/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...beatSample, packets: conflictPackets, countUpper: 80 }),
  });
  if (conflictRes.status !== 422) {
    fail(`beat conflict expected HTTP 422, got ${conflictRes.status}: ${await conflictRes.text()}`);
  }
  const conflictBody = await conflictRes.json();
  if (conflictBody.error.code !== 'NO_CONSISTENT_INTERPRETATION') {
    fail(`expected NO_CONSISTENT_INTERPRETATION, got ${conflictBody.error.code}`);
  }
  const detail = conflictBody.error.evidence?.detail;
  if (!detail?.absoluteCountRange || !detail?.beatBreakdown) {
    fail(`first blocker must include absolute count range and beat decomposition: ${JSON.stringify(conflictBody.error.evidence)}`);
  }
  if (detail.beatBreakdown.switchAtCount !== 14) fail('beat decomposition must name the switch count');
  if (detail.beatBreakdown.oldBeat.steps === undefined || detail.beatBreakdown.newBeat.steps === undefined) {
    fail('beat decomposition must split the gap into old/new step counts');
  }

  console.log('SMOKE PASSED');
  console.log(`  order     : ${data.order.join(' -> ')}`);
  console.log(`  counts    : ${counts.join(', ')}`);
  console.log(`  missing   : ${data.missingCountTotal} packets in ${segments.length} segment(s)`);
  console.log(`  adjacency : all ${data.adjacency.length} constraints satisfied`);
  console.log(`  beat      : switch at 14, order ${bd.order.join(' -> ')}`);
  console.log(`  beat gaps : ${bd.adjacency.map((e) => `${e.oldSteps}old+${e.newSteps}new`).join(', ')}`);
}

main().catch((err) => fail(err.stack ?? String(err)));
