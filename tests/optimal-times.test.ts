import { describe, expect, it } from 'vitest';
import { optimalTimes } from '../src/core/solver.js';

/**
 * The tight-edge-chain candidate enumeration inside optimalTimes must span
 * an optimum. These tests compare it with a DP over the ENTIRE integer
 * coordinate domain (no candidate-generation assumptions), using wide
 * windows so the claim is exercised beyond the narrow fuzz intervals.
 */

interface P {
  lo: number;
  hi: number;
  mid2: number;
}

/** Reference: full-domain integer DP + lex-smallest greedy reconstruction. */
function fullDomainOptimal(
  packets: P[],
  windows: { lo: number; hi: number }[],
  gaps: number[],
  minInterval: number,
  maxInterval: number,
): { times: number[]; deviation2: number } {
  const n = windows.length;
  const L = gaps.map((d) => d * minInterval);
  const U = gaps.map((d) => d * maxInterval);
  let domLo = Infinity;
  let domHi = -Infinity;
  for (const w of windows) {
    domLo = Math.min(domLo, w.lo);
    domHi = Math.max(domHi, w.hi);
  }
  // Every feasible value lies inside [domLo, domHi]; use it as the domain.
  const coords: number[] = [];
  for (let v = domLo; v <= domHi; v++) coords.push(v);
  const inWin = (k: number, v: number) => v >= windows[k].lo && v <= windows[k].hi;
  const dev = (k: number, v: number) => Math.abs(2 * v - packets[k].mid2);

  const suffix: Map<number, number>[] = new Array(n);
  suffix[n - 1] = new Map(coords.filter((v) => inWin(n - 1, v)).map((v) => [v, dev(n - 1, v)]));
  for (let k = n - 2; k >= 0; k--) {
    suffix[k] = new Map();
    for (const v of coords) {
      if (!inWin(k, v)) continue;
      let best = Infinity;
      for (const u of coords) {
        if (!inWin(k + 1, u)) continue;
        const g = u - v;
        if (g < L[k] || g > U[k]) continue;
        const c = suffix[k + 1].get(u);
        if (c !== undefined && c < best) best = c;
      }
      if (Number.isFinite(best)) suffix[k].set(v, best + dev(k, v));
    }
  }
  let globalBest = Infinity;
  for (const c of suffix[0].values()) globalBest = Math.min(globalBest, c);

  const times: number[] = [];
  let target = globalBest;
  let prev = NaN;
  for (let k = 0; k < n; k++) {
    let pick = NaN;
    for (const v of coords) {
      if (!inWin(k, v)) continue;
      if (k > 0) {
        const g = v - prev;
        if (g < L[k - 1] || g > U[k - 1]) continue;
      }
      if (suffix[k].get(v) === target) {
        pick = v;
        break;
      }
    }
    if (Number.isNaN(pick)) throw new Error('reference reconstruction failed');
    times.push(pick);
    target -= dev(k, pick);
    prev = pick;
  }
  return { times, deviation2: globalBest };
}

let seed = 20260930;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

describe('optimalTimes candidate completeness', () => {
  it('matches the full-domain DP on 200 random wide-window chains', () => {
    for (let iter = 0; iter < 200; iter++) {
      const n = 2 + Math.floor(rnd() * 6); // 2..7
      const packets: P[] = [];
      const center: number[] = [];
      for (let k = 0; k < n; k++) {
        center.push(-20 + Math.floor(rnd() * 60));
        const half = Math.floor(rnd() * 9);
        const lo = center[k] - half;
        const hi = center[k] + half;
        packets.push({ lo, hi, mid2: lo + hi });
      }
      const gaps = Array.from({ length: n - 1 }, () => 1 + Math.floor(rnd() * 3));
      const minInterval = 1 + Math.floor(rnd() * 4);
      const maxInterval = minInterval + Math.floor(rnd() * 8);

      // Tighten exactly like the solver does.
      const windows = packets.map((p) => ({ lo: p.lo, hi: p.hi }));
      let feasible = true;
      for (let k = 1; k < n; k++) {
        windows[k].lo = Math.max(windows[k].lo, windows[k - 1].lo + gaps[k - 1] * minInterval);
        windows[k].hi = Math.min(windows[k].hi, windows[k - 1].hi + gaps[k - 1] * maxInterval);
        if (windows[k].lo > windows[k].hi) {
          feasible = false;
          break;
        }
      }
      if (!feasible) continue;
      for (let k = n - 2; k >= 0; k--) {
        windows[k].lo = Math.max(windows[k].lo, windows[k + 1].lo - gaps[k] * maxInterval);
        windows[k].hi = Math.min(windows[k].hi, windows[k + 1].hi - gaps[k] * minInterval);
        if (windows[k].lo > windows[k].hi) {
          feasible = false;
          break;
        }
      }
      if (!feasible) continue;

      // optimalTimes expects the solver's Packet shape; only mid2 is read.
      const order = packets.map((_, i) => i);
      const asPackets = packets as unknown as Parameters<typeof optimalTimes>[0];
      const got = optimalTimes(asPackets, order, windows, gaps, minInterval, maxInterval);
      const ref = fullDomainOptimal(packets, windows, gaps, minInterval, maxInterval);

      expect(got.deviation2).toBe(ref.deviation2);
      expect(got.times).toEqual(ref.times);
    }
  });
});
