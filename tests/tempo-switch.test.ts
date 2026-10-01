import { describe, expect, it } from 'vitest';
import { solve } from '../src/core/solver.js';
import { validateRequest } from '../src/core/validation.js';
import { handleSolve } from '../src/api/handler.js';
import { SolveError } from '../src/core/types.js';
import type { PacketInput, TempoSwitchInput } from '../src/core/types.js';

/**
 * Ground truth, modulus 10, old tempo 9..11 until count 19, new tempo 4..6
 * from count 20 on:
 *
 *   A    B    C            D    E      F
 *    8 -> 9 ->12 --- ... ->22 ->23 --->25
 *   r=8  r=9  r=2          r=2  r=3    r=5
 *
 * Edge C -> D spans the switch: 7 old steps (12..18 -> endpoints 13..19)
 * plus 3 new steps (19..20,20..21,21..22), synthesizing
 *   [7*9 + 3*4, 7*11 + 3*6] = [75, 95].
 * Missing counters: 10-11, 13-21, 24 (12 missing total).
 */
const packets: PacketInput[] = [
  { id: 'F', remainder: 5, timeLower: 222, timeUpper: 228 },
  { id: 'A', remainder: 8, timeLower: 77, timeUpper: 83 },
  { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
  { id: 'D', remainder: 2, timeLower: 207, timeUpper: 213 },
  { id: 'E', remainder: 3, timeLower: 212, timeUpper: 218 },
  { id: 'B', remainder: 9, timeLower: 87, timeUpper: 93 },
];

const tempoSwitch: TempoSwitchInput = {
  firstNewCount: 20,
  newMinInterval: 4,
  newMaxInterval: 6,
};

const args = [10, 0, 60, 9, 11] as const;

describe('tempo switch: recovery', () => {
  const result = solve(packets, ...args, tempoSwitch);

  it('recovers order and absolute counts across the switch', () => {
    expect(result.order).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(result.assignments.map((a) => a.absoluteCount)).toEqual([8, 9, 12, 22, 23, 25]);
    expect(result.observedCountRange).toEqual({ first: 8, last: 25 });
  });

  it('chooses timestamps consistent with both tempos', () => {
    expect(result.assignments.map((a) => a.time)).toEqual([80, 90, 120, 210, 215, 225]);
  });

  it('reports old/new step split per adjacency', () => {
    const byPair = new Map(result.adjacency.map((e) => [`${e.fromId}->${e.toId}`, e]));
    expect(byPair.get('A->B')!).toMatchObject({
      countGap: 1,
      oldSteps: 1,
      newSteps: 0,
      tempoSwitchAt: 20,
      timeGap: 10,
      allowedTimeGap: { min: 9, max: 11 },
      satisfied: true,
    });
    const span = byPair.get('C->D')!;
    expect(span.countGap).toBe(10);
    expect(span.oldSteps).toBe(7);
    expect(span.newSteps).toBe(3);
    expect(span.allowedTimeGap).toEqual({ min: 75, max: 95 });
    expect(span.timeGap).toBe(90);
    expect(span.satisfied).toBe(true);
    expect(byPair.get('D->E')!).toMatchObject({
      countGap: 1,
      oldSteps: 0,
      newSteps: 1,
      allowedTimeGap: { min: 4, max: 6 },
      timeGap: 5,
      satisfied: true,
    });
    expect(byPair.get('E->F')!).toMatchObject({
      countGap: 2,
      oldSteps: 0,
      newSteps: 2,
      allowedTimeGap: { min: 8, max: 12 },
      timeGap: 10,
      satisfied: true,
    });
    for (const e of result.adjacency) {
      expect(e.oldSteps + e.newSteps).toBe(e.countGap);
    }
  });

  it('reports missing segments on both sides of the switch', () => {
    expect(result.missingCountTotal).toBe(12);
    expect(result.missingSegments).toEqual([
      { fromCount: 10, toCount: 11, length: 2 },
      { fromCount: 13, toCount: 21, length: 9 },
      { fromCount: 24, toCount: 24, length: 1 },
    ]);
  });
});

describe('tempo switch: endpoint-count semantics', () => {
  it('uses the old interval for the step arriving at firstNewCount - 1 and new at firstNewCount', () => {
    // Two tight packets: counts 18 (r8) and 20 (r0). Gap 2: step 18->19 is
    // old (endpoint 19 < 20), step 19->20 is new (endpoint 20 >= 20).
    const pkts: PacketInput[] = [
      { id: 'a', remainder: 8, timeLower: 0, timeUpper: 0 },
      { id: 'b', remainder: 0, timeLower: 13, timeUpper: 13 },
      { id: 'c', remainder: 1, timeLower: 30, timeUpper: 30 },
      { id: 'd', remainder: 2, timeLower: 40, timeUpper: 40 },
      { id: 'e', remainder: 3, timeLower: 50, timeUpper: 50 },
      { id: 'f', remainder: 4, timeLower: 60, timeUpper: 60 },
    ];
    // 9..11 old, 2..100 new: 13 = 9(old) + 4(new) must be feasible, while
    // applying the old interval to the whole gap ([18,22]) would not.
    const r = solve(pkts, 10, 0, 60, 9, 11, {
      firstNewCount: 20,
      newMinInterval: 2,
      newMaxInterval: 100,
    });
    const edge = r.adjacency[0];
    expect(edge.fromCount).toBe(18);
    expect(edge.toCount).toBe(20);
    expect(edge.oldSteps).toBe(1);
    expect(edge.newSteps).toBe(1);
    expect(edge.allowedTimeGap).toEqual({ min: 11, max: 111 });
    expect(edge.timeGap).toBe(13);
    expect(edge.satisfied).toBe(true);
  });
});

describe('tempo switch: incompatibility evidence', () => {
  it('is infeasible under the old-only tempo (distinguishes tempo from packet loss)', () => {
    expect(() => solve(packets, ...args)).toThrow(SolveError);
    let caught: SolveError | null = null;
    try {
      solve(packets, ...args);
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
  });

  it('first blocking evidence includes the absolute count range and tempo decomposition', () => {
    let caught: SolveError | null = null;
    try {
      // Tight count window forces F at count 35 (gap 2 from E at 33, both
      // steps new), but the new tempo 1..2 only permits a 2..4 time gap
      // while the intervals require 7..16: a tempo conflict, not a loss.
      solve(packets, 10, 0, 40, 9, 11, {
        firstNewCount: 20,
        newMinInterval: 1,
        newMaxInterval: 2,
      });
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    const ev = caught!.evidence!;
    expect(ev.stage).toBe('extension');
    expect(ev.candidateId).toBe('F');
    const detail = ev.detail!;
    expect(detail.cause).toBe('TIME_GAP');
    expect(detail.absoluteCountRange).toBeDefined();
    expect(detail.absoluteCountRange!.modulus).toBe(10);
    expect(detail.absoluteCountRange!.remainder).toBe(5);
    expect(detail.absoluteCountRange!.min).toBeLessThanOrEqual(detail.absoluteCountRange!.max);
    expect(detail.tempoBreakdown).toBeDefined();
    const tb = detail.tempoBreakdown!;
    expect(tb.tempoSwitchAt).toBe(20);
    expect(tb.oldSteps).toBe(0);
    expect(tb.newSteps).toBe(2);
    expect(tb.oldSteps + tb.newSteps).toBe(detail.countGap);
    expect(tb.oldInterval).toEqual({ min: 9, max: 11 });
    expect(tb.newInterval).toEqual({ min: 1, max: 2 });
    expect(tb.allowedTimeGap).toEqual({ min: 2, max: 4 });
    expect(tb.fromCount).toEqual({ min: 33, max: 33 });
    expect(tb.representativeFromCount).toBe(33);
    expect(ev.reason).toContain('tempo');
  });
});

describe('tempo switch: request validation', () => {
  const base = {
    modulus: 10,
    countLower: 0,
    countUpper: 60,
    minInterval: 9,
    maxInterval: 11,
    packets,
  };

  it('accepts a well-formed switch descriptor', () => {
    const req = validateRequest({ ...base, tempoSwitch });
    expect(req.tempoSwitch).toEqual(tempoSwitch);
  });

  it('leaves tempoSwitch undefined when omitted (legacy compatibility)', () => {
    const req = validateRequest({ ...base });
    expect(req.tempoSwitch).toBeUndefined();
  });

  it.each([
    ['not an object', { ...tempoSwitch, firstNewCount: 'x' }],
    ['missing a field', { firstNewCount: 20, newMinInterval: 4 }],
    ['non-integer interval', { ...tempoSwitch, newMaxInterval: 4.5 }],
    ['switch outside the count window', { ...tempoSwitch, firstNewCount: 61 }],
    ['non-positive new minimum', { ...tempoSwitch, newMinInterval: 0 }],
    ['inverted new interval', { firstNewCount: 20, newMinInterval: 9, newMaxInterval: 4 }],
  ])('rejects %s', (_label, ts) => {
    let caught: SolveError | null = null;
    try {
      validateRequest({ ...base, tempoSwitch: ts });
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('INVALID_REQUEST');
  });
});

describe('tempo switch: HTTP handler', () => {
  it('returns the switched solution and per-edge decomposition', () => {
    const res = handleSolve({
      modulus: 10,
      countLower: 0,
      countUpper: 60,
      minInterval: 9,
      maxInterval: 11,
      packets,
      tempoSwitch,
    });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.data.order).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const span = res.data.adjacency.find((e) => e.fromId === 'C' && e.toId === 'D')!;
    expect(span.oldSteps).toBe(7);
    expect(span.newSteps).toBe(3);
  });

  it('maps an illegal switch descriptor to INVALID_REQUEST', () => {
    const res = handleSolve({
      modulus: 10,
      countLower: 0,
      countUpper: 60,
      minInterval: 9,
      maxInterval: 11,
      packets,
      tempoSwitch: { firstNewCount: 20, newMinInterval: 8 },
    });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_REQUEST');
  });
});
