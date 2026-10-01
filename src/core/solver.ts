import type {
  AdjacencyEvidence,
  AssignedPacket,
  MissingSegment,
  PacketInput,
  ConstraintFailureEvidence,
  SolveResult,
  TempoSwitchInput,
} from './types.js';
import { SolveError } from './types.js';

interface Packet {
  index: number;
  id: string | number;
  remainder: number;
  lo: number;
  hi: number;
  /** Twice the interval midpoint (lo + hi); deviation uses |2t - mid2|. */
  mid2: number;
  /** Smallest absolute count >= countLower congruent to remainder. */
  baseCount: number;
  /** Largest absolute count <= countUpper congruent to remainder. */
  topCount: number;
  /** Rank among packets with identical (remainder, lo, hi), by id. */
  symRank: number;
  /** Identifier of the identical-packet symmetry group. */
  symGroup: number;
}

/**
 * Sampling-tempo model. Without a switch, switchAt is null and every unit
 * step uses the old interval. With a switch at absolute count `switchAt`,
 * the unit step c -> c + 1 uses
 *   - the old interval when its ENDPOINT count c + 1 < switchAt,
 *   - the new interval when c + 1 >= switchAt.
 * An adjacency spanning the switch therefore accumulates the allowed time
 * difference from BOTH tempos; it must never be judged with one interval
 * applied to the whole counter gap.
 */
interface Tempo {
  switchAt: number | null;
  minInterval: number;
  maxInterval: number;
  newMinInterval: number;
  newMaxInterval: number;
}

function makeTempo(minInterval: number, maxInterval: number, sw?: TempoSwitchInput): Tempo {
  return {
    switchAt: sw ? sw.firstNewCount : null,
    minInterval,
    maxInterval,
    newMinInterval: sw ? sw.newMinInterval : minInterval,
    newMaxInterval: sw ? sw.newMaxInterval : maxInterval,
  };
}

/** Last absolute count whose arriving step still uses the OLD tempo. */
function lastOldEndpoint(tempo: Tempo): number | null {
  return tempo.switchAt === null ? null : tempo.switchAt - 1;
}

/**
 * Split a gap of d unit steps starting at absolute count `a` into old/new
 * tempo steps. `old` counts steps whose endpoint count is < switchAt.
 */
function splitSteps(tempo: Tempo, a: number, d: number): { old: number; new: number } {
  if (tempo.switchAt === null) return { old: d, new: 0 };
  const s = lastOldEndpoint(tempo)!;
  const old = Math.max(0, Math.min(d, s - a));
  return { old, new: d - old };
}

/** Inclusive allowed time-difference range of one adjacency edge. */
function edgeBounds(tempo: Tempo, a: number, d: number): { L: number; U: number } {
  const { old, new: neu } = splitSteps(tempo, a, d);
  return {
    L: old * tempo.minInterval + neu * tempo.newMinInterval,
    U: old * tempo.maxInterval + neu * tempo.newMaxInterval,
  };
}

/**
 * Extremal (most permissive) edge bounds when the start count is only known
 * to lie in [aLo, aHi]. The piecewise-linear bounds attain extrema at the
 * interval endpoints or the switch kink; the result is a sound conservative
 * range for window tightening across an uncommitted seed count.
 */
function edgeExtents(
  tempo: Tempo,
  aLo: number,
  aHi: number,
  d: number,
): { Lmin: number; Umax: number } {
  if (tempo.switchAt === null) {
    return { Lmin: d * tempo.minInterval, Umax: d * tempo.maxInterval };
  }
  const s = lastOldEndpoint(tempo)!;
  // oldSteps(a) = clamp(0, d, s - a) is piecewise linear with kinks at
  // a = s - d (edge starts straddling) and a = s (edge fully new); both
  // bounds are linear inside each region, so extrema occur at region ends.
  const probes = new Set<number>([aLo, aHi]);
  if (s - d >= aLo && s - d <= aHi) probes.add(s - d);
  if (s >= aLo && s <= aHi) probes.add(s);
  let Lmin = Infinity;
  let Umax = -Infinity;
  for (const a of probes) {
    const b = edgeBounds(tempo, a, d);
    if (b.L < Lmin) Lmin = b.L;
    if (b.U > Umax) Umax = b.U;
  }
  return { Lmin, Umax };
}

/** Intrinsic feasibility of an adjacency i -> j: congruent d in [dLo, dHi]. */
interface PairFeas {
  /** Required residue d ≡ delta (mod modulus); 0 means a multiple. */
  delta: number;
  dLo: number;
  dHi: number;
}

interface DeadState {
  depth: number;
  placed: number[];
  last: number;
  S: number;
  c0lo: number;
  c0hi: number;
  tLo: number;
  tHi: number;
}

function modNonNeg(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** Smallest value >= bound congruent to residue mod m. */
function ceilResidue(bound: number, residue: number, m: number): number {
  return bound + modNonNeg(residue - bound, m);
}

/** Largest value <= bound congruent to residue mod m. */
function floorResidue(bound: number, residue: number, m: number): number {
  return bound - modNonNeg(bound - residue, m);
}

/**
 * Canonical id comparison for the tertiary tie-break:
 * numbers by numeric value, then strings by UTF-16 code unit order.
 */
function compareId(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lexicographic comparison of integer time vectors. */
function compareTimes(a: number[], b: number[]): number {
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

/** Minimum |2t - mid2| for an integer t inside [lo, hi]. */
function minDeviation2(lo: number, hi: number, mid2: number): number {
  const low = Math.floor(mid2 / 2);
  const high = mid2 % 2 === 0 ? low : low + 1;
  const t = high < lo ? lo : low > hi ? hi : Math.max(low, lo);
  return Math.abs(2 * t - mid2);
}

type Win = { lo: number; hi: number };

/**
 * Tighten timestamp windows along a fixed order with explicit per-edge
 * difference bounds L[k] ≤ t_{k+1} - t_k ≤ U[k]. Forward then backward
 * intersection; null = infeasible.
 */
function tightenChain(
  packets: Packet[],
  order: number[],
  L: number[],
  U: number[],
): Win[] | null {
  const n = order.length;
  const win = new Array<Win>(n);
  win[0] = { lo: packets[order[0]].lo, hi: packets[order[0]].hi };
  for (let k = 1; k < n; k++) {
    const p = packets[order[k]];
    const lo = Math.max(p.lo, win[k - 1].lo + L[k - 1]);
    const hi = Math.min(p.hi, win[k - 1].hi + U[k - 1]);
    if (lo > hi) return null;
    win[k] = { lo, hi };
  }
  for (let k = n - 2; k >= 0; k--) {
    const lo = Math.max(win[k].lo, win[k + 1].lo - U[k]);
    const hi = Math.min(win[k].hi, win[k + 1].hi - L[k]);
    if (lo > hi) return null;
    win[k] = { lo, hi };
  }
  return win;
}

/**
 * Candidate-value generation + suffix/prefix L1 DP for a fixed chain.
 *
 * At an integral optimum every variable is pinned — directly or through a
 * chain of tight lower/upper edge constraints — to a pivot (interval bound
 * or one of the two integers adjacent to the midpoint). Propagating pivots
 * along every tight lower/upper chain spans an optimum (chains have at most
 * 14 positions). Monotone sliding-window minima make both DPs linear in the
 * candidate counts.
 */
interface ChainL1 {
  candidates: number[][];
  dev: (k: number, t: number) => number;
  /** suffix[k][c] = min deviation on positions k..end given t_k = cand. */
  suffix: number[][];
  /** prefix[k][c] = min deviation on positions 0..k given t_k = cand. */
  prefix: number[][];
}

function buildChainL1(
  packets: Packet[],
  order: number[],
  windows: Win[],
  L: number[],
  U: number[],
): ChainL1 {
  const n = order.length;
  const candSets: Set<number>[] = windows.map(() => new Set<number>());
  const add = (k: number, v: number): void => {
    if (Number.isSafeInteger(v) && v >= windows[k].lo && v <= windows[k].hi) {
      candSets[k].add(v);
    }
  };

  const pivotsOf = (k: number): number[] => {
    const p = packets[order[k]];
    const f = Math.floor(p.mid2 / 2);
    const c = p.mid2 % 2 === 0 ? f : f + 1;
    return [p.lo, p.hi, f, c];
  };

  // Forward tight-edge chains.
  for (let j = 0; j < n; j++) {
    for (const s of pivotsOf(j)) add(j, s);
    if (j === n - 1) continue;
    const visit = (pos: number, v: number): void => {
      add(pos, v);
      if (pos < n - 1) {
        visit(pos + 1, v + L[pos]);
        visit(pos + 1, v + U[pos]);
      }
    };
    for (const s of pivotsOf(j)) {
      visit(j + 1, s + L[j]);
      visit(j + 1, s + U[j]);
    }
  }
  // Backward tight-edge chains.
  for (let j = 1; j < n; j++) {
    const visit = (pos: number, v: number): void => {
      add(pos, v);
      if (pos > 0) {
        visit(pos - 1, v - L[pos - 1]);
        visit(pos - 1, v - U[pos - 1]);
      }
    };
    for (const s of pivotsOf(j)) {
      visit(j - 1, s - L[j - 1]);
      visit(j - 1, s - U[j - 1]);
    }
  }

  const candidates = candSets.map((set) => [...set].sort((a, b) => a - b));
  const dev = (k: number, t: number): number => Math.abs(2 * t - packets[order[k]].mid2);

  const suffix: number[][] = new Array(n);
  suffix[n - 1] = candidates[n - 1].map((t) => dev(n - 1, t));
  for (let k = n - 2; k >= 0; k--) {
    const prev = suffix[k + 1];
    const nextCands = candidates[k + 1];
    const cur: number[] = new Array(candidates[k].length);
    // Feasible t_{k+1} for t is [t + L_e, t + U_e]; monotone deque minimum.
    const deque: number[] = [];
    let head = 0;
    let pushed = -1;
    for (let c = 0; c < candidates[k].length; c++) {
      const t = candidates[k][c];
      const low = t + L[k];
      const high = t + U[k];
      while (head < deque.length && nextCands[deque[head]] < low) head++;
      while (pushed + 1 < nextCands.length && nextCands[pushed + 1] <= high) {
        pushed++;
        while (deque.length > head && prev[deque[deque.length - 1]] >= prev[pushed]) deque.pop();
        deque.push(pushed);
      }
      const best = head < deque.length ? prev[deque[head]] : Infinity;
      cur[c] = best + dev(k, t);
    }
    suffix[k] = cur;
  }

  const prefix: number[][] = new Array(n);
  prefix[0] = candidates[0].map((t) => dev(0, t));
  for (let k = 1; k < n; k++) {
    const before = prefix[k - 1];
    const prevCands = candidates[k - 1];
    const cur: number[] = new Array(candidates[k].length);
    // Feasible t_{k-1} for t is [t - U_e, t - L_e].
    const deque: number[] = [];
    let head = 0;
    let pushed = -1;
    for (let c = 0; c < candidates[k].length; c++) {
      const t = candidates[k][c];
      const low = t - U[k - 1];
      const high = t - L[k - 1];
      while (head < deque.length && prevCands[deque[head]] < low) head++;
      while (pushed + 1 < prevCands.length && prevCands[pushed + 1] <= high) {
        pushed++;
        while (deque.length > head && before[deque[deque.length - 1]] >= before[pushed]) deque.pop();
        deque.push(pushed);
      }
      const best = head < deque.length ? before[deque[head]] : Infinity;
      cur[c] = best + dev(k, t);
    }
    prefix[k] = cur;
  }

  return { candidates, dev, suffix, prefix };
}

/** Lexicographically smallest optimal timestamp vector for a fixed chain. */
function reconstructForward(chain: ChainL1, L: number[], U: number[]): number[] {
  const { candidates, dev, suffix } = chain;
  const n = candidates.length;
  const globalBest = Math.min(...suffix[0]);
  const times = new Array<number>(n);
  let target = globalBest;
  let prevTime = Number.NaN;
  for (let k = 0; k < n; k++) {
    let chosen = -1;
    for (let c = 0; c < candidates[k].length; c++) {
      const t = candidates[k][c];
      if (k > 0 && (t - prevTime < L[k - 1] || t - prevTime > U[k - 1])) continue;
      if (suffix[k][c] !== target) continue;
      chosen = c;
      break;
    }
    times[k] = candidates[k][chosen];
    target -= dev(k, times[k]);
    prevTime = times[k];
  }
  return times;
}

/**
 * Minimize Σ |2 t_k - mid2_k| over integer timestamps subject to
 * t_k ∈ window_k and L_e ≤ t_{e+1} - t_e ≤ U_e, for a FIXED order.
 */
function optimalTimesGeneric(
  packets: Packet[],
  order: number[],
  windows: Win[],
  L: number[],
  U: number[],
): { times: number[]; deviation2: number } {
  const chain = buildChainL1(packets, order, windows, L, U);
  if (!Number.isFinite(Math.min(...chain.suffix[0]))) return { times: [], deviation2: Infinity };
  const times = reconstructForward(chain, L, U);
  return { times, deviation2: chain.suffix[0][chain.candidates[0].indexOf(times[0])] };
}

/**
 * Backward-compatible uniform-tempo entry point, also exercised directly by
 * the differential tests against a full-domain DP.
 */
export function optimalTimes(
  packets: Packet[],
  order: number[],
  windows: { lo: number; hi: number }[],
  gaps: number[],
  minInterval: number,
  maxInterval: number,
): { times: number[]; deviation2: number } {
  const L = gaps.map((d) => d * minInterval);
  const U = gaps.map((d) => d * maxInterval);
  return optimalTimesGeneric(packets, order, windows, L, U);
}

interface Move {
  j: number;
  d: number;
  c0lo: number;
  c0hi: number;
  tLo: number;
  tHi: number;
}

interface FixedOrderSolution {
  times: number[];
  deviation2: number;
  c0: number;
}

/**
 * Exact integer-L1 time recovery for a FIXED order and gap sequence, jointly
 * choosing the seed absolute count c0 (congruent to the seed remainder) from
 * [c0lo, c0hi].
 *
 * Without a tempo switch edge bounds are independent of c0, so the smallest
 * admissible c0 is used. With a switch, the x-axis of possible seed counts
 * is partitioned into O(n) regions: all-old, a single straddling edge i (all
 * edges before it old, all after it new), and all-new. Inside a straddling
 * region the two tempo-homogeneous segments optimize independently; they
 * only couple through the spanning edge, whose bounds are affine in c0 and
 * are checked exactly (including c0's congruence class).
 */
function makeFixedOrderEvaluator(
  packets: Packet[],
  modulus: number,
  tempo: Tempo,
): (order: number[], gaps: number[], c0lo: number, c0hi: number) => FixedOrderSolution | null {
  const memo = new Map<string, FixedOrderSolution | null>();

  const smallestCongruent = (lo: number, hi: number, residue: number): number | null => {
    if (lo > hi) return null;
    const v = ceilResidue(lo, residue, modulus);
    return v <= hi ? v : null;
  };

  /** Smallest c0 congruent to `residue` inside [lo0, hi0] and all clamps. */
  const congruentInClamps = (
    lo0: number,
    hi0: number,
    residue: number,
    clamps: { lo?: number; hi?: number }[],
  ): number | null => {
    let lo = lo0;
    let hi = hi0;
    for (const c of clamps) {
      if (c.lo !== undefined) lo = Math.max(lo, c.lo);
      if (c.hi !== undefined) hi = Math.min(hi, c.hi);
    }
    return smallestCongruent(lo, hi, residue);
  };

  const run = (order: number[], gaps: number[], c0lo: number, c0hi: number): FixedOrderSolution | null => {
    const n = order.length;
    if (c0lo > c0hi) return null;
    const residue = modNonNeg(packets[order[0]].remainder, modulus);
    let gapSum = 0;
    for (const d of gaps) gapSum += d;
    const prefixS = new Array<number>(n);
    prefixS[0] = 0;
    for (let k = 1; k < n; k++) prefixS[k] = prefixS[k - 1] + gaps[k - 1];

    const candidates: FixedOrderSolution[] = [];

    /** Whole chain under one tempo; c0 is the smallest congruent in range. */
    const uniform = (useNew: boolean, xLo: number, xHi: number): void => {
      const x = congruentInClamps(c0lo, c0hi, residue, [{ lo: xLo }, { hi: xHi }]);
      if (x === null) return;
      const minI = useNew ? tempo.newMinInterval : tempo.minInterval;
      const maxI = useNew ? tempo.newMaxInterval : tempo.maxInterval;
      const L = gaps.map((d) => d * minI);
      const U = gaps.map((d) => d * maxI);
      const windows = tightenChain(packets, order, L, U);
      if (!windows) return;
      const { times, deviation2 } = optimalTimesGeneric(packets, order, windows, L, U);
      if (!Number.isFinite(deviation2)) return;
      candidates.push({ times, deviation2, c0: x });
    };

    if (tempo.switchAt === null) {
      // Edge bounds do not depend on c0; keep the smallest admissible count.
      uniform(false, c0lo, c0hi);
    } else {
      const s = lastOldEndpoint(tempo)!;
      // Fully old region: every observed count is an old-step endpoint,
      // i.e. the final count x + gapSum <= s.
      uniform(false, c0lo, s - gapSum);
      // Fully new region: even the first edge starts at or after s, x >= s.
      uniform(true, s, c0hi);

      // Between the two uniform regions the switch count s falls either
      // strictly inside one edge i with o in 1..d_i-1 old steps, or exactly
      // on an observed packet count. Every integer x is covered by exactly
      // one case. The two homogeneous segments optimize independently (L1
      // path DP); they couple only through the spanning edge's synthesized
      // bounds, linear in o. Among equal-deviation solutions all achieving
      // pairs are reconstructed and the final sort keeps the lex-min time
      // vector, breaking ties on the seed count.

      /** Solve the linear interval of o values making delta = w - v feasible,
       * then return the largest o of the required c0 residue class. */
      const feasibleO = (delta: number, d: number, K: number): number | null => {
        let lo = 1;
        let hi = d - 1;
        // delta >= d*lNew + o*(lOld - lNew)
        const aL = tempo.minInterval - tempo.newMinInterval;
        const bL = delta - d * tempo.newMinInterval;
        if (aL === 0) {
          if (bL < 0) return null;
        } else if (aL > 0) {
          hi = Math.min(hi, Math.floor(bL / aL));
        } else {
          lo = Math.max(lo, Math.ceil(bL / aL));
        }
        // delta <= d*uNew + o*(uOld - uNew)
        const aU = tempo.maxInterval - tempo.newMaxInterval;
        const bU = delta - d * tempo.newMaxInterval;
        if (aU === 0) {
          if (bU > 0) return null;
        } else if (aU > 0) {
          lo = Math.max(lo, Math.ceil(bU / aU));
        } else {
          hi = Math.min(hi, Math.floor(bU / aU));
        }
        if (lo > hi) return null;
        // x = K - o must be congruent to the seed residue: o ≡ K - residue.
        const oResidue = modNonNeg(K - residue, modulus);
        const o = floorResidue(hi, oResidue, modulus);
        if (o < lo) return null;
        const x = K - o;
        if (x < c0lo || x > c0hi) return null;
        return o;
      };

      /** Backward lex-min reconstruction of segment 0..anchorPos. */
      const reconstructBack = (
        chain: ChainL1,
        L: number[],
        U: number[],
        anchorPos: number,
        anchorCi: number,
        costSeg: number,
      ): number[] => {
        const out = new Array<number>(anchorPos + 1);
        out[anchorPos] = chain.candidates[anchorPos][anchorCi];
        for (let k = anchorPos - 1; k >= 0; k--) {
          const nextT = out[k + 1];
          let tailCost = 0;
          for (let u = k + 1; u <= anchorPos; u++) tailCost += chain.dev(u, out[u]);
          let chosen = -1;
          for (let c = 0; c < chain.candidates[k].length; c++) {
            const t = chain.candidates[k][c];
            if (nextT - t < L[k] || nextT - t > U[k]) continue;
            if (chain.prefix[k][c] + tailCost !== costSeg) continue;
            chosen = c;
            break;
          }
          if (chosen === -1) {
            throw new SolveError(
              'NO_CONSISTENT_INTERPRETATION',
              'internal failure reconstructing pre-switch times',
            );
          }
          out[k] = chain.candidates[k][chosen];
        }
        return out;
      };

      /** Forward lex-min reconstruction of a segment anchored at position 0. */
      const reconstructFwd = (
        chain: ChainL1,
        L: number[],
        U: number[],
        anchorCi: number,
      ): number[] => {
        const m = chain.candidates.length;
        const out = new Array<number>(m);
        out[0] = chain.candidates[0][anchorCi];
        let target = chain.suffix[0][anchorCi] - chain.dev(0, out[0]);
        let prev = out[0];
        for (let k = 1; k < m; k++) {
          let chosen = -1;
          for (let c = 0; c < chain.candidates[k].length; c++) {
            const t = chain.candidates[k][c];
            if (t - prev < L[k - 1] || t - prev > U[k - 1]) continue;
            if (chain.suffix[k][c] !== target) continue;
            chosen = c;
            break;
          }
          if (chosen === -1) {
            throw new SolveError(
              'NO_CONSISTENT_INTERPRETATION',
              'internal failure reconstructing post-switch times',
            );
          }
          out[k] = chain.candidates[k][chosen];
          target -= chain.dev(k, out[k]);
          prev = out[k];
        }
        return out;
      };

      // ---- Switch strictly inside an edge ----------------------------------
      for (let i = 0; i < n - 1; i++) {
        if (gaps[i] < 2) continue; // no interior old-step count possible
        const d = gaps[i];
        const K = s - prefixS[i];

        const ordA = order.slice(0, i + 1);
        const gapsA = gaps.slice(0, i);
        const LA = gapsA.map((gg) => gg * tempo.minInterval);
        const UA = gapsA.map((gg) => gg * tempo.maxInterval);
        const winA = tightenChain(packets, ordA, LA, UA);
        if (!winA) continue;
        const chainA = buildChainL1(packets, ordA, winA, LA, UA);

        const ordB = order.slice(i + 1);
        const gapsB = gaps.slice(i + 1);
        const LB = gapsB.map((gg) => gg * tempo.newMinInterval);
        const UB = gapsB.map((gg) => gg * tempo.newMaxInterval);
        const winB = tightenChain(packets, ordB, LB, UB);
        if (!winB) continue;
        const chainB = buildChainL1(packets, ordB, winB, LB, UB);

        type Pair = { vi: number; wi: number; o: number; cost: number };
        const pairs: Pair[] = [];
        let caseMin = Infinity;
        for (let vi = 0; vi < chainA.candidates[i].length; vi++) {
          const costA = chainA.prefix[i][vi];
          if (!Number.isFinite(costA)) continue;
          const v = chainA.candidates[i][vi];
          for (let wi = 0; wi < chainB.candidates[0].length; wi++) {
            const costB = chainB.suffix[0][wi];
            if (!Number.isFinite(costB)) continue;
            const w = chainB.candidates[0][wi];
            const o = feasibleO(w - v, d, K);
            if (o === null) continue;
            const cost = costA + costB;
            if (cost <= caseMin) {
              if (cost < caseMin) pairs.length = 0;
              caseMin = cost;
              pairs.push({ vi, wi, o, cost });
            }
          }
        }
        for (const pr of pairs) {
          const timesA = reconstructBack(chainA, LA, UA, i, pr.vi, chainA.prefix[i][pr.vi]);
          const timesB = reconstructFwd(chainB, LB, UB, pr.wi);
          candidates.push({
            times: [...timesA, ...timesB],
            deviation2: pr.cost,
            c0: K - pr.o,
          });
        }
      }

      // ---- Switch lands exactly on an observed packet count ----------------
      for (let r = 1; r < n; r++) {
        const x = s - prefixS[r];
        if (x < c0lo || x > c0hi || modNonNeg(x, modulus) !== residue) continue;

        const ordA = order.slice(0, r + 1);
        const gapsA = gaps.slice(0, r);
        const LA = gapsA.map((gg) => gg * tempo.minInterval);
        const UA = gapsA.map((gg) => gg * tempo.maxInterval);
        const winA = tightenChain(packets, ordA, LA, UA);
        if (!winA) continue;
        const chainA = buildChainL1(packets, ordA, winA, LA, UA);

        const ordB = order.slice(r);
        const gapsB = gaps.slice(r);
        const LB = gapsB.map((gg) => gg * tempo.newMinInterval);
        const UB = gapsB.map((gg) => gg * tempo.newMaxInterval);
        const winB = tightenChain(packets, ordB, LB, UB);
        if (!winB) continue;
        const chainB = buildChainL1(packets, ordB, winB, LB, UB);

        const wIndex = new Map<number, number>();
        chainB.candidates[0].forEach((v, idx) => wIndex.set(v, idx));

        type Anch = { vi: number; wi: number; cost: number };
        const anchors: Anch[] = [];
        let caseMin = Infinity;
        for (let vi = 0; vi < chainA.candidates[r].length; vi++) {
          const costA = chainA.prefix[r][vi];
          if (!Number.isFinite(costA)) continue;
          const v = chainA.candidates[r][vi];
          const wi = wIndex.get(v);
          if (wi === undefined) continue;
          const costB = chainB.suffix[0][wi];
          if (!Number.isFinite(costB)) continue;
          const cost = costA + costB - chainA.dev(r, v);
          if (cost <= caseMin) {
            if (cost < caseMin) anchors.length = 0;
            caseMin = cost;
            anchors.push({ vi, wi, cost });
          }
        }
        for (const an of anchors) {
          const timesA = reconstructBack(chainA, LA, UA, r, an.vi, chainA.prefix[r][an.vi]);
          const timesB = reconstructFwd(chainB, LB, UB, an.wi).slice(1);
          candidates.push({
            times: [...timesA, ...timesB],
            deviation2: an.cost,
            c0: x,
          });
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => a.deviation2 - b.deviation2 || compareTimes(a.times, b.times) || a.c0 - b.c0,
    );
    return candidates[0];
  };

  return (order: number[], gaps: number[], c0lo: number, c0hi: number): FixedOrderSolution | null => {
    const key = `${order.join(',')}|${gaps.join(',')}|${c0lo}|${c0hi}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result = run(order, gaps, c0lo, c0hi);
    memo.set(key, result);
    return result;
  };
}

/**
 * Jointly recover transmission order, wrap-crossing absolute counters and
 * transmit timestamps.
 *
 * Optimization is lexicographic:
 *   1. missing packet count between first/last observed packet
 *   2. total deviation of chosen times from interval midpoints
 *   3. the recovered packet-id sequence (lexicographic)
 *
 * Implemented as three exhaustive branch-and-bound phases over the same
 * state space:
 *   A — minimum total counter gap (primary value),
 *   B — minimum midpoint deviation subject to primary = optimum,
 *   C — lexicographically smallest id sequence subject to both (greedy
 *       position fixing with a memoized feasibility oracle).
 * Packets sharing (remainder, time interval) are exact symmetry twins: they
 * may only be consumed in ascending id order, which never removes the
 * lex-min solution but collapses permutation families.
 *
 * Throws SolveError(NO_CONSISTENT_INTERPRETATION) with first-failure evidence.
 */
export function solve(
  inputs: PacketInput[],
  modulus: number,
  countLower: number,
  countUpper: number,
  minInterval: number,
  maxInterval: number,
  tempoSwitchInput?: TempoSwitchInput,
): SolveResult {
  const tempo = makeTempo(minInterval, maxInterval, tempoSwitchInput);
  // Extremal per-step intervals across both tempos: used only for SOUND
  // intrinsic pruning (a feasible move must survive the most permissive
  // per-step bound); exact edge bounds are always checked per move.
  const stepMinLoose = Math.min(tempo.minInterval, tempo.newMinInterval);
  const stepMaxLoose = Math.max(tempo.maxInterval, tempo.newMaxInterval);

  const n = inputs.length;
  const W = countUpper - countLower;

  // Group identical (remainder, lo, hi) packets for symmetry breaking.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const p = inputs[i];
    const key = `${p.remainder}|${p.timeLower}|${p.timeUpper}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  const symRank = new Array<number>(n);
  const symGroup = new Array<number>(n);
  let groupId = 0;
  for (const members of groups.values()) {
    members.sort((a, b) => compareId(inputs[a].id, inputs[b].id));
    members.forEach((ix, rank) => {
      symRank[ix] = rank;
      symGroup[ix] = groupId;
    });
    groupId++;
  }

  const packets: Packet[] = inputs.map((p, index) => ({
    index,
    id: p.id,
    remainder: p.remainder,
    lo: p.timeLower,
    hi: p.timeUpper,
    mid2: p.timeLower + p.timeUpper,
    baseCount: ceilResidue(countLower, p.remainder, modulus),
    topCount: floorResidue(countUpper, p.remainder, modulus),
    symRank: symRank[index],
    symGroup: symGroup[index],
  }));

  // Intrinsic adjacency feasibility = congruent-gap RANGE per ordered pair.
  // Time bounds use the loosest per-step interval of the two tempos so that
  // tempo-dependent pruning can never discard a feasible extension; exact
  // split-aware bounds are applied per move below.
  // Counts: c_i, c_j = c_i + d both inside the search window:
  //   base_j - top_i ≤ d ≤ top_j - base_i.
  const pair: PairFeas[][] = packets.map((pi) =>
    packets.map((pj): PairFeas => {
      const delta = modNonNeg(pj.remainder - pi.remainder, modulus);
      const d0 = pi.index === pj.index ? Infinity : delta === 0 ? modulus : delta;
      const dLo = Math.max(
        d0,
        Math.ceil((pj.lo - pi.hi) / stepMaxLoose),
        pj.baseCount - pi.topCount,
      );
      const dHi = Math.min(
        W,
        Math.floor((pj.hi - pi.lo) / stepMinLoose),
        pj.topCount - pi.baseCount,
      );
      return { delta, dLo, dHi };
    }),
  );

  const minGap: number[][] = packets.map((pi) =>
    packets.map((pj) => {
      if (pi.index === pj.index) return Infinity;
      const pf = pair[pi.index][pj.index];
      return pf.dLo <= pf.dHi ? pf.dLo : Infinity;
    }),
  );

  // cont[mask][j] = minimum gap sum of a path starting at j visiting all
  // nodes of `mask` (j ∉ mask). Exact admissible completion bound, O(2^n n²).
  const full = (1 << n) - 1;
  const cont: number[][] = Array.from({ length: 1 << n }, () => new Array<number>(n).fill(Infinity));
  for (let j = 0; j < n; j++) cont[0][j] = 0;
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      let best = Infinity;
      for (let x = 0; x < n; x++) {
        if (!(mask & (1 << x))) continue;
        const v = minGap[j][x] + cont[mask ^ (1 << x)][x];
        if (v < best) best = v;
      }
      cont[mask][j] = best;
    }
  }

  const seedOrder = packets
    .filter((p) => p.baseCount <= Math.min(p.topCount, countUpper - n + 1))
    .sort((a, b) => compareId(a.id, b.id));
  if (seedOrder.length === 0) {
    throw new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'no globally consistent interpretation exists within the search window',
      {
        stage: 'seed',
        partialLength: 0,
        partialOrder: [],
        candidateId: packets[0].id,
        reason:
          `no packet can be seeded inside [${countLower}, ${countUpper}] while leaving ` +
          `room for ${n - 1} further strictly increasing absolute counters`,
      },
    );
  }
  const globalPrimaryLB = Math.min(
    ...seedOrder.map((p) => cont[full ^ (1 << p.index)][p.index]),
  );

  const evaluateFixedOrder = makeFixedOrderEvaluator(packets, modulus, tempo);

  // Per-position arrays shared by the recursive searches.
  const orderArr = new Array<number>(n);
  const tLoArr = new Array<number>(n);
  const tHiArr = new Array<number>(n);
  const gapsArr = new Array<number>(n - 1);
  const used = new Uint8Array(n);
  let bestDead: DeadState | null = null;

  const usedMask = (): number => {
    let bits = 0;
    for (let i = 0; i < n; i++) if (used[i]) bits |= 1 << i;
    return bits;
  };

  /** Symmetry leader: within a twin group only the smallest-ranked still
   * unused member may be picked next. Relabeling identical twins never
   * changes the objectives, and the lex-min order always consumes them in
   * ascending id rank. */
  const isSymmetryAllowed = (j: number, mask: number): boolean => {
    const pj = packets[j];
    if (pj.symRank === 0) return true;
    for (let i = 0; i < n; i++) {
      const pi = packets[i];
      if (pi.symGroup === pj.symGroup && pi.symRank < pj.symRank && !(mask & (1 << i))) {
        return false;
      }
    }
    return true;
  };

  /** Successors in canonical order: every congruent feasible gap per target,
   * sorted by smallest gap then smallest target id. */
  const enumerateMoves = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    mask: number,
  ): Move[] => {
    const slotsAfter = n - 1 - depth;
    const aLo = S + c0lo;
    const aHi = S + c0hi;
    const moves: Move[] = [];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if (!isSymmetryAllowed(j, mask)) continue;
      const pj = packets[j];
      const pf = pair[last][j];
      const dLo = Math.max(
        pf.dLo,
        pj.baseCount - S - c0hi,
        Math.ceil((pj.lo - tHi) / stepMaxLoose),
      );
      const dHi0 = Math.min(
        pf.dHi,
        pj.topCount - S - c0lo,
        countUpper - slotsAfter - S - c0lo,
        Math.floor((pj.hi - tLo) / stepMinLoose),
      );
      if (dLo > dHi0) continue;
      const dMin = ceilResidue(dLo, pf.delta, modulus);
      if (dMin > dHi0) continue;

      const consider = (d: number): Move | null => {
        const njLo = Math.max(c0lo, pj.baseCount - S - d);
        const njHi = Math.min(c0hi, pj.topCount - S - d, countUpper - slotsAfter - S - d);
        // Split-aware conservative edge bounds over the remaining start-count
        // window: sound for existence of some seed count, exactness is
        // recovered by the fixed-order evaluator at leaves.
        const { Lmin, Umax } = edgeExtents(tempo, aLo, aHi, d);
        const ntLo = Math.max(pj.lo, tLo + Lmin);
        const ntHi = Math.min(pj.hi, tHi + Umax);
        if (njLo > njHi || ntLo > ntHi) return null;
        return { j, d, c0lo: njLo, c0hi: njHi, tLo: ntLo, tHi: ntHi };
      };

      for (let d = dMin; d <= dHi0; d += modulus) {
        // The rising time lower bound cannot be loosened by larger gaps
        // beyond the loosest per-step tempo; stop once it clears j's hi.
        if (d * stepMinLoose > pj.hi - tLo) break;
        const mv = consider(d);
        if (mv) moves.push(mv);
      }
    }
    moves.sort((a, b) => a.d - b.d || compareId(packets[a.j].id, packets[b.j].id));
    return moves;
  };

  const recordDead = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
  ): void => {
    if (bestDead === null || depth > bestDead.depth) {
      bestDead = { depth, placed: orderArr.slice(0, depth), last, S, c0lo, c0hi, tLo, tHi };
    }
  };

  /** Cheap leaf time-feasibility used by the primary-optimal oracle and
   * phase A. Without a tempo switch the monotone forward tightening already
   * certifies every reached leaf; with a switch the exact fixed-order
   * evaluator must check some admissible seed count. */
  const leafFeasible = (c0lo: number, c0hi: number): boolean =>
    tempo.switchAt === null || evaluateFixedOrder(orderArr.slice(), gapsArr.slice(), c0lo, c0hi) !== null;

  /** Exact leaf deviation (and optimal times/seed count) for phases B/C. */
  const leafSolution = (c0lo: number, c0hi: number): FixedOrderSolution | null =>
    tempo.switchAt === null
      ? (() => {
          const order = orderArr.slice();
          const gaps = gapsArr.slice();
          const windows = tightenChain(
            packets,
            order,
            gaps.map((d) => d * tempo.minInterval),
            gaps.map((d) => d * tempo.maxInterval),
          );
          if (!windows) return null;
          const { times, deviation2 } = optimalTimesGeneric(
            packets,
            order,
            windows,
            gaps.map((d) => d * tempo.minInterval),
            gaps.map((d) => d * tempo.maxInterval),
          );
          return Number.isFinite(deviation2) ? { times, deviation2, c0: c0lo } : null;
        })()
      : evaluateFixedOrder(orderArr.slice(), gapsArr.slice(), c0lo, c0hi);

  // ------------------------------------------------------------------ Phase A
  // Minimum total counter gap. A state memo caches the best completion gap
  // sum (Infinity = dead). Without a tempo switch the state is Markovian in
  // (used set, last packet, fixed gap sum, tightened c0/last-time windows);
  // with a switch, leaf time feasibility also depends on the complete
  // prefix (every edge's tempo split), so the full prefix joins the key.
  const prefixSignature = (depth: number): string => {
    let s = '';
    for (let k = 0; k < depth; k++) {
      s += `>${orderArr[k]}:${k > 0 ? gapsArr[k - 1] : 0}:${tLoArr[k]},${tHiArr[k]}`;
    }
    return s;
  };
  const memoA = new Map<string, number>();
  let bestA = Infinity;
  let stopA = false;

  const dfsA = (depth: number, last: number, S: number, c0lo: number, c0hi: number, tLo: number, tHi: number): number => {
    if (stopA) return Infinity;
    if (depth === n) {
      // A tempo switch makes time feasibility depend on the actual seed
      // count; verify the complete chain before accepting the leaf.
      if (!leafFeasible(c0lo, c0hi)) return Infinity;
      if (S < bestA) bestA = S;
      if (bestA === globalPrimaryLB) stopA = true;
      return S;
    }
    const mask = usedMask();
    const remaining = full ^ mask;
    // Bound prune only once a feasible solution exists: before that, an
    // infinite intrinsic completion must still be explored to record the
    // deepest non-extendable state for failure evidence.
    if (Number.isFinite(bestA) && S + cont[remaining][last] >= bestA) return Infinity;

    const key = `A|${mask}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}|${tempo.switchAt === null ? '' : prefixSignature(depth)}`;
    const cached = memoA.get(key);
    if (cached !== undefined) return cached;

    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask);
    if (moves.length === 0) {
      recordDead(depth, last, S, c0lo, c0hi, tLo, tHi);
      memoA.set(key, Infinity);
      return Infinity;
    }

    let best = Infinity;
    for (const mv of moves) {
      if (Number.isFinite(bestA) && S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] >= bestA) break;
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      const v = dfsA(depth + 1, mv.j, S + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi);
      used[mv.j] = 0;
      if (v < best) best = v;
      if (stopA) break;
    }
    if (best === Infinity) {
      recordDead(depth, last, S, c0lo, c0hi, tLo, tHi);
    }
    memoA.set(key, best);
    return best;
  };

  for (const seed of seedOrder) {
    if (stopA) break;
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    used.fill(0);
    used[seed.index] = 1;
    orderArr[0] = seed.index;
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    dfsA(1, seed.index, 0, seed.baseCount, c0hi0, seed.lo, seed.hi);
  }
  if (bestA === Infinity) {
    throw buildFailureEvidence(packets, pair, bestDead, modulus, countUpper, tempo);
  }
  const Pstar = bestA;

  // ------------------------------------------------------------- Phase B/C key
  /** Exact state signature for the deviation/lex phases: full prefix packet
   * sequence, its gaps and every position's tightened window. Paths sharing
   * this signature have identical prefix deviation and an identical frontier,
   * so memoized results are interchangeable. */
  const stateKeyBC = (depth: number, last: number, S: number, c0lo: number, c0hi: number, tLo: number, tHi: number): string => {
    let s = `${depth}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}`;
    for (let k = 0; k < depth; k++) {
      s += `>${orderArr[k]}:${k > 0 ? gapsArr[k - 1] : 0}:${tLoArr[k]},${tHiArr[k]}`;
    }
    return s;
  };

  /**
   * Exact primary-optimal-chain oracle. Returns true exactly when a
   * completion of the CURRENT state reaches total gap Pstar AND admits
   * integer timestamps (with some seed count).
   */
  const memoOpt = new Map<string, boolean>();
  const optimalFromState = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    mask: number,
  ): boolean => {
    if (depth === n) return S === Pstar && leafFeasible(c0lo, c0hi);
    const key = `O|${mask}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}|${tempo.switchAt === null ? '' : prefixSignature(depth)}`;
    const cached = memoOpt.get(key);
    if (cached !== undefined) return cached;

    const remaining = full ^ mask;
    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask);
    let ok = false;
    for (const mv of moves) {
      // Necessary bound for reaching Pstar; exact feasibility checked below.
      if (S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] > Pstar) continue;
      used[mv.j] = 1;
      // The leaf time-feasibility check below reconstructs from these
      // arrays, so record the explored move and restore it afterwards.
      const savedJ = orderArr[depth];
      const savedD = gapsArr[depth - 1];
      const savedLo = tLoArr[depth];
      const savedHi = tHiArr[depth];
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      const v = optimalFromState(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        mv.tLo,
        mv.tHi,
        mask | (1 << mv.j),
      );
      orderArr[depth] = savedJ;
      gapsArr[depth - 1] = savedD;
      tLoArr[depth] = savedLo;
      tHiArr[depth] = savedHi;
      used[mv.j] = 0;
      if (v) {
        ok = true;
        break;
      }
    }
    memoOpt.set(key, ok);
    return ok;
  };

  /** Successor moves that lie on at least one primary-optimal completion. */
  const optimalMoves = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
    mask: number,
  ): Move[] => {
    const remaining = full ^ mask;
    const all = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask);
    return all.filter((mv) => {
      if (S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] > Pstar) return false;
      // Record the probed move so the prefix-dependent oracle key and leaf
      // reconstruction see slot `depth` during this standalone probe.
      const savedJ = orderArr[depth];
      const savedD = gapsArr[depth - 1];
      const savedLo = tLoArr[depth];
      const savedHi = tHiArr[depth];
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      const ok = optimalFromState(
        depth + 1,
        mv.j,
        S + mv.d,
        mv.c0lo,
        mv.c0hi,
        mv.tLo,
        mv.tHi,
        mask | (1 << mv.j),
      );
      orderArr[depth] = savedJ;
      gapsArr[depth - 1] = savedD;
      tLoArr[depth] = savedLo;
      tHiArr[depth] = savedHi;
      return ok;
    });
  };

  /** Whether a seed packet can begin any primary-optimal completion. */
  const seedIsOptimal = (seedIndex: number): boolean => {
    const seed = packets[seedIndex];
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    if (seed.baseCount > c0hi0) return false;
    // Initialize position 0 so prefix-dependent leaf checks/memo keys see
    // the seed even during this standalone oracle call.
    orderArr[0] = seedIndex;
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    return optimalFromState(1, seedIndex, 0, seed.baseCount, c0hi0, seed.lo, seed.hi, 1 << seedIndex);
  };

  const leafDeviation = (c0lo: number, c0hi: number): number =>
    leafSolution(c0lo, c0hi)?.deviation2 ?? Infinity;

  // ------------------------------------------------------------------ Phase B
  // Minimum total deviation2 over primary-optimal chains.
  const memoB = new Map<string, number>();
  let bestB = Infinity;

  const independentDevLB = (mask: number): number => {
    let sum = 0;
    const remaining = full ^ mask;
    for (let j = 0; j < n; j++) {
      if (remaining & (1 << j)) sum += minDeviation2(packets[j].lo, packets[j].hi, packets[j].mid2);
    }
    return sum;
  };

  const dfsB = (depth: number, last: number, S: number, c0lo: number, c0hi: number, tLo: number, tHi: number): number => {
    if (depth === n) {
      const v = leafDeviation(c0lo, c0hi);
      if (v < bestB) bestB = v;
      return v;
    }
    const mask = usedMask();

    let placedLB = 0;
    for (let k = 0; k < depth; k++) {
      placedLB += minDeviation2(tLoArr[k], tHiArr[k], packets[orderArr[k]].mid2);
    }
    if (placedLB + independentDevLB(mask) >= bestB) return Infinity;

    const key = stateKeyBC(depth, last, S, c0lo, c0hi, tLo, tHi);
    const cached = memoB.get(key);
    if (cached !== undefined) return cached;

    const moves = optimalMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask);
    let best = Infinity;
    for (const mv of moves) {
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      const v = dfsB(depth + 1, mv.j, S + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi);
      used[mv.j] = 0;
      if (v < best) best = v;
    }
    memoB.set(key, best);
    return best;
  };

  for (const seed of seedOrder) {
    if (!seedIsOptimal(seed.index)) continue;
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    used.fill(0);
    used[seed.index] = 1;
    orderArr[0] = seed.index;
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    dfsB(1, seed.index, 0, seed.baseCount, c0hi0, seed.lo, seed.hi);
  }
  if (bestB === Infinity) {
    // Defensive: phase A guarantees a primary-optimal feasible leaf.
    throw new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'internal search failure during deviation optimization',
    );
  }
  const Dstar = bestB;

  // ------------------------------------------------------------------ Phase C
  // Greedily construct the lexicographically smallest id sequence. At every
  // position candidate packets are tried in ascending id order; a memoized
  // boolean oracle decides whether a primary-optimal, deviation-optimal
  // completion exists with the candidate fixed at the current position.
  const memoC = new Map<string, boolean>();

  const dfsCfeasible = (depth: number, last: number, S: number, c0lo: number, c0hi: number, tLo: number, tHi: number): boolean => {
    if (depth === n) {
      return leafDeviation(c0lo, c0hi) === Dstar;
    }
    const mask = usedMask();
    const key = stateKeyBC(depth, last, S, c0lo, c0hi, tLo, tHi);
    const cached = memoC.get(key);
    if (cached !== undefined) return cached;

    const moves = optimalMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask);
    let ok = false;
    for (const mv of moves) {
      used[mv.j] = 1;
      orderArr[depth] = mv.j;
      gapsArr[depth - 1] = mv.d;
      tLoArr[depth] = mv.tLo;
      tHiArr[depth] = mv.tHi;
      ok = dfsCfeasible(depth + 1, mv.j, S + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi);
      used[mv.j] = 0;
      if (ok) break;
    }
    memoC.set(key, ok);
    return ok;
  };

  const chosen: number[] = [];
  const fixedGaps: number[] = [];
  let curLast = -1;
  let curS = 0;
  let curC0lo = 0;
  let curC0hi = 0;
  let curTLo = 0;
  let curTHi = 0;
  let curMask = 0;

  /** Reproduce the forward-tightened windows of the fixed prefix so the
   * oracle's memoization keys and leaf evaluation see a consistent state.
   * The seed-count window is [curC0lo, curC0hi]; each edge's start-count
   * window is shifted by the sum of the already fixed prefix gaps. */
  const replayPrefixWindows = (): void => {
    let prefixGap = 0;
    for (let k = 0; k < chosen.length; k++) {
      const p = packets[chosen[k]];
      if (k === 0) {
        tLoArr[0] = p.lo;
        tHiArr[0] = p.hi;
      } else {
        const d = fixedGaps[k - 1];
        const { Lmin, Umax } = edgeExtents(tempo, curC0lo + prefixGap, curC0hi + prefixGap, d);
        tLoArr[k] = Math.max(p.lo, tLoArr[k - 1] + Lmin);
        tHiArr[k] = Math.min(p.hi, tHiArr[k - 1] + Umax);
        prefixGap += d;
      }
      orderArr[k] = chosen[k];
      if (k > 0) gapsArr[k - 1] = fixedGaps[k - 1];
    }
  };

  for (let depth = 0; depth < n; depth++) {
    let candidates: { j: number; mv: Move | null }[];
    if (depth === 0) {
      candidates = seedOrder
        .filter((p) => seedIsOptimal(p.index))
        .map((p) => ({ j: p.index, mv: null }));
    } else {
      candidates = optimalMoves(depth, curLast, curS, curC0lo, curC0hi, curTLo, curTHi, curMask).map(
        (mv) => ({ j: mv.j, mv }),
      );
    }
    candidates.sort((a, b) => compareId(packets[a.j].id, packets[b.j].id));

    let picked: { j: number; mv: Move | null } | null = null;
    for (const cand of candidates) {
      const j = cand.j;
      used.fill(0);
      for (const ix of chosen) used[ix] = 1;
      used[j] = 1;
      replayPrefixWindows();
      orderArr[depth] = j;

      let ok: boolean;
      if (depth === 0) {
        const seed = packets[j];
        const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
        tLoArr[0] = seed.lo;
        tHiArr[0] = seed.hi;
        ok = dfsCfeasible(1, j, 0, seed.baseCount, c0hi0, seed.lo, seed.hi);
      } else {
        const mv = cand.mv!;
        gapsArr[depth - 1] = mv.d;
        tLoArr[depth] = mv.tLo;
        tHiArr[depth] = mv.tHi;
        ok = dfsCfeasible(depth + 1, j, curS + mv.d, mv.c0lo, mv.c0hi, mv.tLo, mv.tHi);
      }
      used[j] = 0;
      if (ok) {
        picked = cand;
        break;
      }
    }

    if (!picked) {
      // Defensive: phases A/B certify a feasible choice at every position.
      throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure reconstructing lex-min order');
    }

    chosen.push(picked.j);
    if (depth === 0) {
      const seed = packets[picked.j];
      curC0lo = seed.baseCount;
      curC0hi = Math.min(seed.topCount, countUpper - n + 1);
      curTLo = seed.lo;
      curTHi = seed.hi;
    } else {
      const mv = picked.mv!;
      fixedGaps.push(mv.d);
      curS += mv.d;
      curC0lo = mv.c0lo;
      curC0hi = mv.c0hi;
      curTLo = mv.tLo;
      curTHi = mv.tHi;
    }
    curLast = picked.j;
    curMask |= 1 << picked.j;
  }

  // Assemble the certified solution: exact seed count and optimal times.
  const finalOrder = chosen.slice();
  const finalGaps = fixedGaps.slice();
  const sol = evaluateFixedOrder(finalOrder, finalGaps, curC0lo, curC0hi);
  if (!sol) {
    throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure tightening final windows');
  }
  let gapSum = 0;
  for (const d of finalGaps) gapSum += d;

  return buildResult(
    packets,
    {
      gapSum,
      deviation2: sol.deviation2,
      times: sol.times,
      order: finalOrder,
      c0: sol.c0,
      gaps: finalGaps,
    },
    modulus,
    tempo,
  );
}

function buildResult(
  packets: Packet[],
  cand: { gapSum: number; deviation2: number; times: number[]; order: number[]; c0: number; gaps: number[] },
  modulus: number,
  tempo: Tempo,
): SolveResult {
  const n = cand.order.length;
  const order = cand.order.map((ix) => packets[ix].id);
  const assignments: AssignedPacket[] = [];
  const adjacency: AdjacencyEvidence[] = [];
  const missingSegments: MissingSegment[] = [];

  let count = cand.c0;
  for (let k = 0; k < n; k++) {
    const p = packets[cand.order[k]];
    assignments.push({
      position: k,
      id: p.id,
      absoluteCount: count,
      time: cand.times[k],
      remainder: p.remainder,
      timeInterval: { lower: p.lo, upper: p.hi },
    });
    if (k > 0) {
      const d = cand.gaps[k - 1];
      const prevCount = count - d;
      if (d > 1) {
        missingSegments.push({ fromCount: prevCount + 1, toCount: count - 1, length: d - 1 });
      }
      const tGap = cand.times[k] - cand.times[k - 1];
      const prevP = packets[cand.order[k - 1]];
      const split = splitSteps(tempo, prevCount, d);
      const allowedMin = split.old * tempo.minInterval + split.new * tempo.newMinInterval;
      const allowedMax = split.old * tempo.maxInterval + split.new * tempo.newMaxInterval;
      adjacency.push({
        index: k - 1,
        fromId: prevP.id,
        toId: p.id,
        fromCount: prevCount,
        toCount: count,
        countGap: d,
        oldSteps: split.old,
        newSteps: split.new,
        tempoSwitchAt: tempo.switchAt,
        fromTime: cand.times[k - 1],
        toTime: cand.times[k],
        timeGap: tGap,
        allowedTimeGap: { min: allowedMin, max: allowedMax },
        missingBetween: d - 1,
        congruence: { remainder: p.remainder, modulus },
        absoluteCountCongruent: modNonNeg(count, modulus) === p.remainder,
        timeWithinInterval: {
          from: { lower: prevP.lo, upper: prevP.hi },
          to: { lower: p.lo, upper: p.hi },
        },
        satisfied:
          tGap >= allowedMin &&
          tGap <= allowedMax &&
          cand.times[k - 1] >= prevP.lo &&
          cand.times[k - 1] <= prevP.hi &&
          cand.times[k] >= p.lo &&
          cand.times[k] <= p.hi &&
          modNonNeg(prevCount, modulus) === prevP.remainder &&
          modNonNeg(count, modulus) === p.remainder,
      });
    }
    if (k < n - 1) count += cand.gaps[k];
  }

  return {
    order,
    assignments,
    missingSegments,
    missingCountTotal: cand.gapSum - (n - 1),
    adjacency,
    observedCountRange: { first: cand.c0, last: cand.c0 + cand.gapSum },
  };
}

function buildFailureEvidence(
  packets: Packet[],
  pair: PairFeas[][],
  bestDead: DeadState | null,
  modulus: number,
  countUpper: number,
  tempo: Tempo,
): SolveError {
  const make = (evidence: ConstraintFailureEvidence): SolveError =>
    new SolveError(
      'NO_CONSISTENT_INTERPRETATION',
      'no globally consistent interpretation exists within the search window',
      evidence,
    );

  if (bestDead === null) {
    return make({
      stage: 'seed',
      partialLength: 0,
      partialOrder: [],
      candidateId: packets[0].id,
      reason: 'no packet can be seeded inside the absolute count search window',
    });
  }

  const n = packets.length;
  const { depth, placed, last, S, c0lo, c0hi, tLo, tHi } = bestDead;
  const partialOrder = placed.map((ix) => packets[ix].id);
  const usedNow = new Set(placed);
  const slotsAfter = n - 1 - depth;
  const aLo = S + c0lo;
  const aHi = S + c0hi;

  // Reproduce the canonical successor scan at the deepest dead end. For each
  // unused successor derive the feasible counter-gap range implied by each
  // constraint class independently:
  //   time:  [Tlo, Thi] from the tightened timestamp windows (loosest tempo)
  //   count: [Clo, Chi] from the c0 window and remaining absolute slots
  // plus the intrinsic ceiling pair.dHi and the congruence residue. Their
  // intersection is empty at a dead end; the first blocker in canonical
  // order (cause, gap, id) is reported, including the absolute-count range
  // and an old/new tempo step decomposition.
  type Blocker = {
    j: number;
    cause: 'TIME_GAP' | 'COUNT_WINDOW' | 'CONGRUENCE';
    dStar: number;
    delta: number;
    timeRange: { min: number; max: number };
    countRange: { min: number; max: number };
    intrinsicCeiling: number;
    achievable: { min: number; max: number };
    representative: {
      fromLo: number;
      fromHi: number;
      from: number;
      allowed: { min: number; max: number };
      oldSteps: number;
      newSteps: number;
    } | null;
    /** Attainable from-count range [aLo,aHi] for the whole successor set. */
    fromRange: { min: number; max: number };
  };
  const blockers: Blocker[] = [];

  for (let j = 0; j < n; j++) {
    if (usedNow.has(j)) continue;
    const pj = packets[j];
    const pf = pair[last][j];
    const d0 = pf.delta === 0 ? modulus : pf.delta;

    // --- Count-only admissibility (independent of the tempo model) --------
    const Clo = Math.max(d0, pj.baseCount - S - c0hi);
    const Chi = Math.min(
      pf.dHi,
      pj.topCount - S - c0lo,
      countUpper - slotsAfter - S - c0lo,
    );
    const dCount =
      Clo <= Chi
        ? (() => {
            const d = ceilResidue(Clo, pf.delta, modulus);
            return d <= Chi ? d : Infinity;
          })()
        : Infinity;

    // --- Tempo-exact time feasibility over attainable congruent starts ----
    // The edge start count a is congruent to the last packet's remainder and
    // lies in [aLo, aHi]; synthesized edge bounds are probed exactly for
    // each congruent gap. This error path is visited at most once per
    // failing request, and the gap sequence is bounded by the <= 1e6 wide
    // search window, so a direct scan stays exact and simple.
    const aResidue = modNonNeg(packets[last].remainder, modulus);
    const achMin = pj.lo - tHi;
    const achMax = pj.hi - tLo;

    const fromWindowFor = (d: number): { lo: number; hi: number } => ({
      lo: Math.max(aLo, pj.baseCount - d),
      hi: Math.min(aHi, pj.topCount - d, countUpper - slotsAfter - d),
    });

    let dTime = Infinity;
    let dTimeHi = -Infinity;
    for (let d = ceilResidue(d0, pf.delta, modulus); d <= pf.dHi; d += modulus) {
      const { lo, hi } = fromWindowFor(d);
      if (lo > hi) continue;
      const aFirst = ceilResidue(lo, aResidue, modulus);
      if (aFirst > hi) continue;
      const aLast = floorResidue(hi, aResidue, modulus);
      const probes = new Set<number>([aFirst, aLast]);
      if (tempo.switchAt !== null) {
        // The only non-linearity is the switch kink; probe the congruent
        // starts bracketing it within this edge's start-count window.
        const s = lastOldEndpoint(tempo)!;
        const k1 = floorResidue(Math.min(hi, s), aResidue, modulus);
        const k2 = ceilResidue(Math.max(lo, s - d + 1), aResidue, modulus);
        if (k1 >= lo) probes.add(k1);
        if (k2 <= hi) probes.add(k2);
      }
      let ok = false;
      for (const a of probes) {
        if (a < lo || a > hi) continue;
        const b = edgeBounds(tempo, a, d);
        if (b.L <= achMax && b.U >= achMin) {
          ok = true;
          break;
        }
      }
      if (ok) {
        if (dTime === Infinity) dTime = d;
        dTimeHi = d;
      }
    }

    let dBoth = Infinity;
    if (dCount !== Infinity && dTime !== Infinity) {
      const loB = Math.max(Clo, dTime);
      const hiB = Math.min(Chi, dTimeHi);
      if (loB <= hiB) {
        const d = ceilResidue(loB, pf.delta, modulus);
        if (d <= hiB) dBoth = d;
      }
    }

    let cause: Blocker['cause'];
    let dStar: number;
    if (dBoth !== Infinity) continue; // extendable; cannot occur at a dead end
    if (dCount !== Infinity) {
      // The count window admits a congruent gap but the tempo envelope does
      // not: a missing-packet / tempo-switch TIME conflict.
      cause = 'TIME_GAP';
      dStar = dCount;
    } else if (dTime !== Infinity) {
      cause = 'COUNT_WINDOW';
      dStar = dTime;
    } else {
      cause = 'CONGRUENCE';
      dStar = Infinity;
    }

    let representative: Blocker['representative'] = null;
    if (Number.isFinite(dStar)) {
      const d = dStar;
      const { lo, hi } = fromWindowFor(d);
      const cand = new Set<number>([ceilResidue(lo, aResidue, modulus)]);
      if (tempo.switchAt !== null) {
        const s = lastOldEndpoint(tempo)!;
        cand.add(ceilResidue(Math.max(lo, s - d + 1), aResidue, modulus));
      }
      let repFrom = Infinity;
      for (const a of cand) {
        if (a >= lo && a <= hi && modNonNeg(a, modulus) === aResidue && a < repFrom) repFrom = a;
      }
      if (Number.isFinite(repFrom)) {
        const sp = splitSteps(tempo, repFrom, d);
        const eb = edgeBounds(tempo, repFrom, d);
        representative = {
          fromLo: lo,
          fromHi: hi,
          from: repFrom,
          allowed: { min: eb.L, max: eb.U },
          oldSteps: sp.old,
          newSteps: sp.new,
        };
      }
    }

    blockers.push({
      j,
      cause,
      dStar,
      delta: pf.delta,
      timeRange: { min: dTime, max: dTimeHi },
      countRange: { min: Clo, max: Chi },
      intrinsicCeiling: pf.dHi,
      achievable: { min: achMin, max: achMax },
      representative,
      fromRange: { min: aLo, max: aHi },
    });
  }

  const causeRank = { TIME_GAP: 0, COUNT_WINDOW: 1, CONGRUENCE: 2 } as const;
  blockers.sort(
    (a, b) =>
      causeRank[a.cause] - causeRank[b.cause] ||
      a.dStar - b.dStar ||
      compareId(packets[a.j].id, packets[b.j].id),
  );

  if (blockers.length > 0) {
    const b = blockers[0];
    const pj = packets[b.j];
    const prevId = String(packets[last].id);
    const finite = (x: number): number | undefined => (Number.isFinite(x) ? x : undefined);
    const d = b.dStar;
    const rep = b.representative;

    const tempoBreakdown = {
      tempoSwitchAt: tempo.switchAt,
      oldSteps: rep?.oldSteps ?? 0,
      newSteps: rep?.newSteps ?? 0,
      oldInterval: { min: tempo.minInterval, max: tempo.maxInterval },
      newInterval: { min: tempo.newMinInterval, max: tempo.newMaxInterval },
      allowedTimeGap: { min: rep?.allowed.min ?? NaN, max: rep?.allowed.max ?? NaN },
      fromCount: rep
        ? { min: rep.fromLo, max: rep.fromHi }
        : { min: b.fromRange.min, max: b.fromRange.max },
      representativeFromCount: rep?.from,
    };
    // Destination (candidate) absolute-count range after the residual
    // prefix-gap and remaining-slots bounds.
    const absoluteCountRange = {
      min: pj.baseCount,
      max: pj.topCount,
      remainder: pj.remainder,
      modulus,
    };
    const switchNote =
      tempo.switchAt === null || rep === null
        ? ''
        : `; tempo switch at count ${tempo.switchAt}: the representative edge from count ${rep.from} ` +
          `uses ${rep.oldSteps} old-tempo and ${rep.newSteps} new-tempo step(s), synthesizing ` +
          `[${rep.allowed.min}, ${rep.allowed.max}] instead of applying one interval to the whole gap`;

    if (b.cause === 'TIME_GAP') {
      return make({
        stage: 'extension',
        partialLength: depth,
        partialOrder,
        candidateId: pj.id,
        reason:
          `cannot append packet ${String(pj.id)} after packet ${prevId}: the tightened closed intervals ` +
          `only admit a time difference in [${b.achievable.min}, ${b.achievable.max}], and under the ` +
          `effective tempo model the tempo-feasible congruent gaps are ` +
          `[${finite(b.timeRange.min) ?? 'none'}, ${finite(b.timeRange.max) ?? 'none'}], but the ` +
          `absolute-count window only permits congruent gaps in ` +
          `[${finite(b.countRange.min) ?? '-∞'}, ${finite(b.countRange.max) ?? '∞'}] ` +
          `(smallest gap satisfying the count window: ${finite(d) ?? 'none'}). No gap satisfies both; ` +
          `this is a time/tempo conflict rather than a missing-packet estimate${switchNote}`,
        detail: {
          cause: 'TIME_GAP',
          minimalCongruentGap: finite(d),
          countGap: finite(d),
          requiredTimeGap: rep ? { min: rep.allowed.min, max: rep.allowed.max } : undefined,
          actualTimeGapRange: b.achievable,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          absoluteCountRange,
          tempoBreakdown,
        },
      });
    }

    if (b.cause === 'COUNT_WINDOW') {
      return make({
        stage: 'extension',
        partialLength: depth,
        partialOrder,
        candidateId: pj.id,
        reason:
          `cannot append packet ${String(pj.id)} after packet ${prevId}: the absolute-count window ` +
          `only admits congruent gaps in [${finite(b.countRange.min) ?? '-∞'}, ${finite(b.countRange.max) ?? '∞'}] ` +
          `(intrinsic ceiling ${b.intrinsicCeiling}), whereas the effective tempo model requires a ` +
          `tempo-feasible congruent gap in [${finite(b.timeRange.min) ?? 'none'}, ${finite(b.timeRange.max) ?? 'none'}] ` +
          `for the achievable time difference [${b.achievable.min}, ${b.achievable.max}]${switchNote}; ` +
          `the two ranges have no admissible value in common`,
        detail: {
          cause: 'COUNT_WINDOW',
          minimalCongruentGap: finite(d),
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          requiredTimeGap: rep ? { min: rep.allowed.min, max: rep.allowed.max } : undefined,
          actualTimeGapRange: b.achievable,
          absoluteCountRange,
          tempoBreakdown,
        },
      });
    }

    return make({
      stage: 'extension',
      partialLength: depth,
      partialOrder,
      candidateId: pj.id,
      reason:
        `cannot append packet ${String(pj.id)} after packet ${prevId}: the tempo-feasible gap range ` +
        `[${finite(b.timeRange.min) ?? 'none'}, ${finite(b.timeRange.max) ?? 'none'}] and the count-feasible ` +
        `range [${finite(b.countRange.min) ?? '-∞'}, ${finite(b.countRange.max) ?? '∞'}] provide no positive ` +
        `counter gap congruent to ${b.delta} modulo ${modulus} for the achievable time difference ` +
        `[${b.achievable.min}, ${b.achievable.max}]${switchNote}`,
      detail: {
        cause: 'CONGRUENCE',
        minimalCongruentGap: finite(d),
        countGapWindow: { min: b.countRange.min, max: b.countRange.max },
        actualTimeGapRange: b.achievable,
        absoluteCountRange,
        tempoBreakdown,
      },
    });
  }

  const candidate = packets[last];
  return make({
    stage: 'extension',
    partialLength: depth,
    partialOrder,
    candidateId: candidate.id,
    reason: `cannot extend from packet ${String(candidate.id)}: no unused packet remains`,
  });
}
