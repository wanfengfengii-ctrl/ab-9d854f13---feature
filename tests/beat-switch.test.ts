import { describe, expect, it } from 'vitest';
import { solve } from '../src/core/solver.js';
import { SolveError } from '../src/core/types.js';
import type { BeatSwitchInput, PacketInput } from '../src/core/types.js';
import { handleSolve } from '../src/api/handler.js';
import { bruteSolve, beatSpecFrom, lexIds, makeRng, refSplit, type RefSolution } from './helpers/brute.js';

/**
 * Ground truth, modulus 10, switch at absolute count 14:
 *
 *   A    B    C    D    E    F    G
 *   10 ->11 ->12 ->14 ->15 ->16 ->17
 *   r0   r1   r2   r4   r5   r6   r7
 *
 * Steps ending at counts <= 13 use the OLD beat 9..11; steps ending at
 * counts >= 14 use the NEW beat 19..21. Edge C -> D (12 -> 14) straddles the
 * switch: one old step plus one new step compose 28..32, never 18..22 (which
 * is what applying a single beat to the gap of 2 would give).
 */
const switchAt = 14;
const packets: PacketInput[] = [
  { id: 'G', remainder: 7, timeLower: 207, timeUpper: 213 },
  { id: 'A', remainder: 0, timeLower: 97, timeUpper: 103 },
  { id: 'F', remainder: 6, timeLower: 187, timeUpper: 193 },
  { id: 'C', remainder: 2, timeLower: 117, timeUpper: 123 },
  { id: 'B', remainder: 1, timeLower: 107, timeUpper: 113 },
  { id: 'E', remainder: 5, timeLower: 167, timeUpper: 173 },
  { id: 'D', remainder: 4, timeLower: 147, timeUpper: 153 },
];
const baseReq = {
  modulus: 10,
  countLower: 0,
  countUpper: 60,
  minInterval: 9,
  maxInterval: 11,
  packets,
};
const beatSwitch: BeatSwitchInput = {
  firstNewBeatCount: switchAt,
  newMinInterval: 19,
  newMaxInterval: 21,
};

describe('solver: sampling-beat switch', () => {
  const result = solve(
    baseReq.packets,
    baseReq.modulus,
    baseReq.countLower,
    baseReq.countUpper,
    baseReq.minInterval,
    baseReq.maxInterval,
    beatSwitch,
  );

  it('jointly recovers order, absolute counts and integer times across the switch', () => {
    expect(result.order).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(result.assignments.map((a) => a.absoluteCount)).toEqual([10, 11, 12, 14, 15, 16, 17]);
    expect(result.assignments.map((a) => a.time)).toEqual([100, 110, 120, 150, 170, 190, 210]);
    expect(result.observedCountRange).toEqual({ first: 10, last: 17 });
    expect(result.missingCountTotal).toBe(1);
    expect(result.missingSegments).toEqual([{ fromCount: 13, toCount: 13, length: 1 }]);
  });

  it('splits every adjacency into old/new steps and composes the allowed range', () => {
    const ev = result.adjacency;
    expect(ev).toHaveLength(6);
    const byPair = new Map(ev.map((e) => [`${String(e.fromId)}>${String(e.toId)}`, e]));

    const ab = byPair.get('A>B')!;
    expect([ab.oldSteps, ab.newSteps]).toEqual([1, 0]);
    expect(ab.allowedTimeGap).toEqual({ min: 9, max: 11 });
    expect(ab.beatBreakdown?.switchAtCount).toBe(switchAt);
    expect(ab.beatBreakdown?.old).toMatchObject({ steps: 1, minTimeGap: 9, maxTimeGap: 11 });
    expect(ab.beatBreakdown?.next).toMatchObject({ steps: 0, minTimeGap: 0, maxTimeGap: 0 });

    const cd = byPair.get('C>D')!;
    expect(cd.fromCount).toBe(12);
    expect(cd.toCount).toBe(14);
    expect([cd.oldSteps, cd.newSteps]).toEqual([1, 1]);
    // 1*[9,11] + 1*[19,21] = [28,32] — not 2*[9,11] = [18,22].
    expect(cd.allowedTimeGap).toEqual({ min: 28, max: 32 });
    expect(cd.timeGap).toBe(30);
    expect(cd.beatBreakdown?.old).toMatchObject({
      steps: 1,
      minInterval: 9,
      maxInterval: 11,
      minTimeGap: 9,
      maxTimeGap: 11,
    });
    expect(cd.beatBreakdown?.next).toMatchObject({
      steps: 1,
      minInterval: 19,
      maxInterval: 21,
      minTimeGap: 19,
      maxTimeGap: 21,
    });
    expect(cd.satisfied).toBe(true);

    const de = byPair.get('D>E')!;
    expect([de.oldSteps, de.newSteps]).toEqual([0, 1]);
    expect(de.allowedTimeGap).toEqual({ min: 19, max: 21 });

    for (const e of ev) {
      expect(e.satisfied).toBe(true);
      expect(e.timeGap).toBeGreaterThanOrEqual(e.allowedTimeGap.min);
      expect(e.timeGap).toBeLessThanOrEqual(e.allowedTimeGap.max);
      expect(e.oldSteps + e.newSteps).toBe(e.countGap);
      // Independent reference split.
      const split = refSplit(beatSpecFrom(beatSwitch), e.fromCount, e.countGap);
      expect(e.oldSteps).toBe(split.oldSteps);
      expect(e.newSteps).toBe(split.newSteps);
    }
  });

  it('echoes the beat configuration in the result', () => {
    expect(result.beatSwitch).toEqual({
      firstNewBeatCount: switchAt,
      oldMinInterval: 9,
      oldMaxInterval: 11,
      newMinInterval: 19,
      newMaxInterval: 21,
    });
  });

  it('would be infeasible if the single old beat were applied to the whole gap', () => {
    // The straddling edge needs a 28..32 time difference; a single 9..11 beat
    // over gap 2 allows only 18..22, and no alternative chain fits the
    // search window.
    expect(() =>
      solve(
        baseReq.packets,
        baseReq.modulus,
        baseReq.countLower,
        baseReq.countUpper,
        baseReq.minInterval,
        baseReq.maxInterval,
      ),
    ).toThrow(SolveError);
  });

  it('rejects the instance when the switch lies entirely after the recovered span', () => {
    // Switch far in the future: every step is old beat, so the straddling
    // composition the packets were built around never happens.
    const late: BeatSwitchInput = { firstNewBeatCount: 1000, newMinInterval: 19, newMaxInterval: 21 };
    expect(() =>
      solve(
        baseReq.packets,
        baseReq.modulus,
        baseReq.countLower,
        baseReq.countUpper,
        baseReq.minInterval,
        baseReq.maxInterval,
        late,
      ),
    ).toThrow(SolveError);
  });
});

describe('solver: beat-switch first-blocking evidence', () => {
  it('returns NO_CONSISTENT_INTERPRETATION with count range and beat decomposition', () => {
    // D (remainder 4) sits only ~7..16 time units after C while its gap of 2
    // composes a >= 28 time difference across the switch; no congruent gap
    // rescues it within the window.
    const conflict: PacketInput[] = [
      { id: 'A', remainder: 0, timeLower: 0, timeUpper: 6 },
      { id: 'B', remainder: 1, timeLower: 9, timeUpper: 15 },
      { id: 'C', remainder: 2, timeLower: 18, timeUpper: 24 },
      { id: 'D', remainder: 4, timeLower: 28, timeUpper: 34 },
      { id: 'E', remainder: 5, timeLower: 47, timeUpper: 53 },
      { id: 'F', remainder: 6, timeLower: 66, timeUpper: 72 },
      { id: 'G', remainder: 7, timeLower: 85, timeUpper: 91 },
    ];
    let caught: SolveError | null = null;
    try {
      solve(conflict, 10, 0, 80, 9, 11, beatSwitch);
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(caught!.evidence).toBeTruthy();
    const detail = caught!.evidence!.detail;
    expect(detail).toBeTruthy();
    expect(detail!.absoluteCountRange).toBeTruthy();
    const range = detail!.absoluteCountRange!;
    expect(Number.isSafeInteger(range.from.min)).toBe(true);
    expect(Number.isSafeInteger(range.to.max)).toBe(true);
    expect(range.to.min).toBeGreaterThanOrEqual(0);
    expect(detail!.beatBreakdown).toBeTruthy();
    const bd = detail!.beatBreakdown!;
    expect(bd.switchAtCount).toBe(switchAt);
    expect(bd.oldBeat.steps.min).toBeGreaterThanOrEqual(0);
    expect(bd.oldBeat.steps.max).toBeGreaterThanOrEqual(bd.oldBeat.steps.min);
    expect(bd.newBeat.steps.min).toBeGreaterThanOrEqual(0);
    expect(bd.newBeat.steps.max).toBeGreaterThanOrEqual(bd.newBeat.steps.min);
    // The composed range is the summed old+new contribution at the split
    // corner points, never one beat applied to the whole gap.
    const corners = [
      bd.oldBeat.steps.min * 9 + (bd.countGap - bd.oldBeat.steps.min) * 19,
      bd.oldBeat.steps.max * 9 + (bd.countGap - bd.oldBeat.steps.max) * 19,
    ];
    expect(bd.composedTimeGap.min).toBe(Math.min(...corners));
    expect(bd.composedTimeGap.max).toBeGreaterThanOrEqual(bd.composedTimeGap.min);
    expect(bd.actualTimeGap.max).toBeGreaterThanOrEqual(bd.actualTimeGap.min);
    // The reason text mentions both the count span and the beat split.
    expect(caught!.evidence!.reason).toContain('beat switch');
    expect(caught!.evidence!.reason).toContain('absolute count');
  });

  it('exposes the evidence through the HTTP handler envelope', () => {
    const res = handleSolve({ ...baseReq, countUpper: 8, beatSwitch });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(res.error.evidence).toBeTruthy();
  });

  it('details a complete-chain beat conflict with exact counts and decomposition', () => {
    // A full order is reachable, but no concrete first count certifies it:
    // the first adjacency sits on the old beat (gap 1 allows 2..3) while the
    // intervals need a 6..13 difference. The evidence must name exact
    // endpoint counts and split the gap into old/new steps.
    const leafPackets: PacketInput[] = [
      { id: 427, remainder: 1, timeLower: 55, timeUpper: 61 },
      { id: 285, remainder: 0, timeLower: 38, timeUpper: 42 },
      { id: 241, remainder: 0, timeLower: 17, timeUpper: 24 },
      { id: 422, remainder: 0, timeLower: 42, timeUpper: 46 },
      { id: 531, remainder: 1, timeLower: 38, timeUpper: 47 },
      { id: 693, remainder: 1, timeLower: 30, timeUpper: 30 },
    ];
    let caught: SolveError | null = null;
    try {
      solve(leafPackets, 2, 2, 11, 2, 3, { firstNewBeatCount: 5, newMinInterval: 3, newMaxInterval: 6 });
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    const ev = caught!.evidence!;
    expect(ev.partialLength).toBe(6);
    const detail = ev.detail!;
    expect(detail.absoluteCountRange).toEqual({
      from: { min: 2, max: 2 },
      to: { min: 3, max: 3 },
    });
    expect(detail.beatBreakdown).toMatchObject({
      switchAtCount: 5,
      countGap: 1,
      oldBeat: { steps: { min: 1, max: 1 }, minInterval: 2, maxInterval: 3 },
      newBeat: { steps: { min: 0, max: 0 }, minInterval: 3, maxInterval: 6 },
      composedTimeGap: { min: 2, max: 3 },
      actualTimeGap: { min: 6, max: 13 },
    });
    expect(ev.reason).toContain('old beat');
    expect(ev.reason).toContain('not a missing packet');
  });

  it('marks a seed-stage count-window failure with an absolute-count range', () => {
    let caught: SolveError | null = null;
    try {
      solve(baseReq.packets, baseReq.modulus, baseReq.countLower, 3, 9, 11, beatSwitch);
    } catch (e) {
      caught = e as SolveError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(caught!.evidence?.stage).toBe('seed');
    expect(caught!.evidence?.detail?.absoluteCountRange).toBeTruthy();
  });
});

describe('solver: beat-switch differential fuzzing against exhaustive reference', () => {
  const batches: [number, number, number, number][] = [
    // [rngSeed, instances, intervalWidth, windowSlack]
    [101, 120, 3, 4],
    [202, 120, 6, 5],
    [303, 80, 2, 3],
  ];

  for (const [seedStart, count, width, slack] of batches) {
    it(`agrees with brute force on ${count} random beat-switch instances (seed ${seedStart})`, () => {
      const rnd = makeRng(seedStart);
      for (let iter = 0; iter < count; iter++) {
        const n = 6;
        const modulus = 2 + Math.floor(rnd() * 6);
        const ids = new Set<number>();
        const pkts: PacketInput[] = [];
        for (let i = 0; i < n; i++) {
          let id = Math.floor(rnd() * 1000);
          while (ids.has(id)) id = Math.floor(rnd() * 1000);
          ids.add(id);
          const lo = Math.floor(rnd() * 40);
          pkts.push({
            id,
            remainder: Math.floor(rnd() * modulus),
            timeLower: lo,
            timeUpper: lo + Math.floor(rnd() * (width + 1)),
          });
        }
        const minInterval = 1 + Math.floor(rnd() * 3);
        const maxInterval = minInterval + Math.floor(rnd() * 3);
        const countLower = Math.floor(rnd() * 6);
        const countUpper = countLower + (n - 1) + Math.floor(rnd() * (slack + 1));

        let bsInput: BeatSwitchInput | undefined;
        if (countUpper - countLower >= 3 && rnd() < 0.7) {
          const newMin = 1 + Math.floor(rnd() * 4);
          bsInput = {
            firstNewBeatCount: countLower + 1 + Math.floor(rnd() * Math.max(1, countUpper - countLower - 1)),
            newMinInterval: newMin,
            newMaxInterval: newMin + Math.floor(rnd() * 4),
          };
        }

        if (iter % 4 === 0) {
          pkts[1].remainder = pkts[0].remainder;
          pkts[1].timeLower = pkts[0].timeLower;
          pkts[1].timeUpper = pkts[0].timeUpper;
        }

        let got: RefSolution | null = null;
        let gotError = false;
        try {
          const r = solve(
            pkts,
            modulus,
            countLower,
            countUpper,
            minInterval,
            maxInterval,
            bsInput,
          );
          for (const a of r.assignments) {
            const p = pkts.find((pp) => pp.id === a.id)!;
            expect(a.time).toBeGreaterThanOrEqual(p.timeLower);
            expect(a.time).toBeLessThanOrEqual(p.timeUpper);
            expect(a.absoluteCount).toBeGreaterThanOrEqual(countLower);
            expect(a.absoluteCount).toBeLessThanOrEqual(countUpper);
          }
          for (const ev of r.adjacency) {
            expect(ev.satisfied).toBe(true);
            const split = refSplit(beatSpecFrom(bsInput), ev.fromCount, ev.countGap);
            expect(ev.oldSteps).toBe(split.oldSteps);
            expect(ev.newSteps).toBe(split.newSteps);
            const lo =
              split.oldSteps * minInterval +
              split.newSteps * (bsInput ? bsInput.newMinInterval : minInterval);
            const hi =
              split.oldSteps * maxInterval +
              split.newSteps * (bsInput ? bsInput.newMaxInterval : maxInterval);
            expect(ev.allowedTimeGap).toEqual({ min: lo, max: hi });
          }
          let deviation = 0;
          for (const a of r.assignments) {
            const p = pkts.find((pp) => pp.id === a.id)!;
            deviation += Math.abs(2 * a.time - (p.timeLower + p.timeUpper));
          }
          got = { missing: r.missingCountTotal, deviation, idSeq: r.order };
        } catch (e) {
          if (!(e instanceof SolveError)) throw e;
          gotError = true;
        }

        const ref = bruteSolve(
          pkts,
          modulus,
          countLower,
          countUpper,
          minInterval,
          maxInterval,
          beatSpecFrom(bsInput),
        );
        expect(gotError).toBe(ref === null);
        if (got && ref) {
          expect(got.missing).toBe(ref.missing);
          expect(got.deviation).toBe(ref.deviation);
          expect(lexIds(got.idSeq, ref.idSeq)).toBe(0);
        }
      }
    });
  }
});
