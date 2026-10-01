import type {
  AdjacencyEvidence,
  AssignedPacket,
  MissingSegment,
  PacketInput,
  BeatSwitchInput,
  ConstraintFailureEvidence,
  BeatBlockerDetail,
  SolveResult,
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
 * Beat configuration. The step c -> c+1 uses the OLD interval when its
 * endpoint count c+1 is strictly earlier than the switch point
 * (`switchAt` = the submitted firstNewBeatCount), and the NEW interval
 * otherwise (endpoint >= switchAt). An adjacency starting at absolute count
 * a with gap d therefore splits into
 *   oldSteps = clamp(switchAt - 1 - a, 0, d)
 *   newSteps = d - oldSteps
 * and its admissible time difference is the SUM of the per-beat ranges, so a
 * gap straddling the switch is never judged under a single beat.
 *
 * At most one edge of a strictly increasing chain can straddle the switch.
 * When the request does not enable a switch, enabled=false and every
 * beat-aware formula reduces to the single-beat model.
 */
interface BeatConfig {
  enabled: boolean;
  switchAt: number;
  oldLo: number;
  oldHi: number;
  newLo: number;
  newHi: number;
}

function makeBeatConfig(
  bs: BeatSwitchInput | undefined,
  oldLo: number,
  oldHi: number,
): BeatConfig {
  if (!bs) {
    return { enabled: false, switchAt: Number.POSITIVE_INFINITY, oldLo, oldHi, newLo: oldLo, newHi: oldHi };
  }
  return {
    enabled: true,
    switchAt: bs.firstNewBeatCount,
    oldLo,
    oldHi,
    newLo: bs.newMinInterval,
    newHi: bs.newMaxInterval,
  };
}

/** {oldSteps, newSteps} of the edge starting at absolute count `a`. */
function splitSteps(beat: BeatConfig, a: number, d: number): { oldSteps: number; newSteps: number } {
  const o = beat.switchAt - 1 - a;
  const oldSteps = o <= 0 ? 0 : o >= d ? d : o;
  return { oldSteps, newSteps: d - oldSteps };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v <= lo ? lo : v >= hi ? hi : v;
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

/** Minimum |2t - mid2| for an integer t inside [lo, hi]. */
function minDeviation2(lo: number, hi: number, mid2: number): number {
  const low = Math.floor(mid2 / 2);
  const high = mid2 % 2 === 0 ? low : low + 1;
  const t = high < lo ? lo : low > hi ? hi : Math.max(low, lo);
  return Math.abs(2 * t - mid2);
}

/**
 * Tighten timestamp windows for a fixed complete order with per-edge lower
 * and upper admissible time differences. The forward pass intersects
 * [t_prev + L_e, t_prev + U_e]; the backward pass intersects
 * [t_next - U_e, t_next - L_e]. Nonempty forward windows already imply
 * global feasibility of the difference-constraint chain; the backward pass
 * only shrinks domains for the deviation optimizer. Null = infeasible.
 */
function tightenWindows(
  packets: Packet[],
  order: number[],
  L: number[],
  U: number[],
): { lo: number; hi: number }[] | null {
  const n = order.length;
  const win = new Array<{ lo: number; hi: number }>(n);
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
 * Minimize Σ |2 t_k - mid2_k| over integer timestamps subject to
 * t_k ∈ window_k and L_e ≤ t_{e+1} - t_e ≤ U_e, for a FIXED order with
 * per-edge bounds. Without a beat switch every edge carries
 * (d·minInterval, d·maxInterval); with a switch a straddling edge carries
 * its composed old+new bounds.
 *
 * Exported for direct differential testing against a full-domain DP.
 *
 * Difference-constraint L1 program on a path. At an integral optimum every
 * variable is pinned — directly or through a chain of tight lower/upper edge
 * constraints — to a pivot: an interval bound or one of the two integers
 * adjacent to its midpoint. Propagating every pivot along every lower/upper
 * pin chain gives the candidate values per position (n ≤ 14). A backward
 * shortest-path DP with a monotone sliding-window minimum computes the
 * optimum; the forward greedy reconstruction returns the lexicographically
 * smallest optimal timestamp vector.
 */
export function optimalTimes(
  packets: Packet[],
  order: number[],
  windows: { lo: number; hi: number }[],
  bounds: { L: number[]; U: number[] },
): { times: number[]; deviation2: number } {
  const n = order.length;
  const { L, U } = bounds;

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

  // suffix[k][c] = minimal cost on positions k..n-1 with t_k = cand[k][c].
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

  const globalBest = Math.min(...suffix[0]);
  // Lexicographically smallest optimal vector: smallest t keeping the
  // remaining optimum attainable at every position.
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
  return { times, deviation2: globalBest };
}

interface Move {
  j: number;
  d: number;
  c0lo: number;
  c0hi: number;
  tLo: number;
  tHi: number;
}

interface DeadState {
  depth: number;
  placed: number[];
  gaps: number[];
  last: number;
  S: number;
  c0lo: number;
  c0hi: number;
  tLo: number;
  tHi: number;
}

/** Certified leaf interpretation under a beat switch (or single beat). */
interface CertifiedLeaf {
  c0: number;
  L: number[];
  U: number[];
  times: number[];
  deviation2: number;
}

/**
 * Jointly recover transmission order, wrap-crossing absolute counters and
 * transmit timestamps, optionally across an in-voyage sampling-beat switch.
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
 * Beat-switch soundness: search propagates a relaxed existential box over
 * the first absolute count (its edge bounds depend on where the unique
 * straddling edge lands) and every leaf is certified EXACTLY: candidate
 * first counts come from (i) the all-old/all-new regions and (ii)
 * tight-chain pivots solved for the straddling edge's old/new step split, so
 * no infeasible interpretation is ever accepted.
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
  beatSwitchInput?: BeatSwitchInput,
): SolveResult {
  const n = inputs.length;
  const W = countUpper - countLower;
  const beat = makeBeatConfig(beatSwitchInput, minInterval, maxInterval);
  const minBeatLo = Math.min(beat.oldLo, beat.newLo);
  const maxBeatHi = Math.max(beat.oldHi, beat.newHi);

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

  // Intrinsic adjacency feasibility from the absolute-count side:
  // congruent d in [dLo, dHi] with both endpoints in the search window.
  //   base_j - top_i <= d <= top_j - base_i.
  // In the single-beat model the RAW interval bounds are also position-
  // independent, so they are folded into the intrinsic table exactly as
  // before (keeping adjudication and evidence byte-compatible). With a beat
  // switch timing depends on the edge's absolute position, so it is enforced
  // per move instead.
  const pair: { delta: number; dLo: number; dHi: number }[][] = packets.map((pi) =>
    packets.map((pj) => {
      const delta = modNonNeg(pj.remainder - pi.remainder, modulus);
      const d0 = pi.index === pj.index ? Infinity : delta === 0 ? modulus : delta;
      let dLo = Math.max(d0, pj.baseCount - pi.topCount);
      let dHi = Math.min(W, pj.topCount - pi.baseCount);
      if (!beat.enabled) {
        dLo = Math.max(dLo, Math.ceil((pj.lo - pi.hi) / beat.oldHi));
        dHi = Math.min(dHi, Math.floor((pj.hi - pi.lo) / beat.oldLo));
      }
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
  // nodes of `mask` (j not in mask). A relaxed (count/congruence only) but
  // admissible completion lower bound, O(2^n n^2).
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
          `room for ${n - 1} further strictly increasing absolute counters` +
          (beat.enabled
            ? ` (beat switch at count ${beat.switchAt}: old interval [${beat.oldLo}, ${beat.oldHi}], ` +
              `new interval [${beat.newLo}, ${beat.newHi}])`
            : ''),
        // Extra detail only accompanies a beat-switch request; the
        // single-beat response stays exactly as before.
        ...(beat.enabled
          ? {
              detail: {
                cause: 'COUNT_WINDOW' as const,
                absoluteCountRange: {
                  from: { min: countLower, max: countUpper - n + 1 },
                  to: { min: countLower + n - 1, max: countUpper },
                },
              },
            }
          : {}),
      },
    );
  }
  const globalPrimaryLB = Math.min(
    ...seedOrder.map((p) => cont[full ^ (1 << p.index)][p.index]),
  );

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

  /**
   * Full-prefix signature. Required for sound memoization with a beat
   * switch: edge bounds depend on the edge's absolute start count, so two
   * paths sharing (used set, last, frontier boxes) but differing in packet
   * order / gaps are NOT interchangeable. In single-beat mode the short
   * frontier key is sufficient and preserves the original memo granularity.
   */
  const prefixSignature = (
    depth: number,
    last: number,
    S: number,
    c0lo: number,
    c0hi: number,
    tLo: number,
    tHi: number,
  ): string => {
    let s = `${depth}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}`;
    for (let k = 0; k < depth; k++) {
      s += `>${orderArr[k]}:${k > 0 ? gapsArr[k - 1] : 0}:${tLoArr[k]},${tHiArr[k]}`;
    }
    return s;
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

  /**
   * Relaxed existential bounds of the edge with gap d from the current
   * frontier over the first-count box [c0lo, c0hi]. Returns the smallest /
   * largest admissible time difference attainable by SOME first count in the
   * box. Sound for pruning (a necessary condition); leaf certification is
   * exact. Without a beat switch these are simply d times the old interval.
   */
  const edgeEnvelope = (
    d: number,
    S: number,
    c0lo: number,
    c0hi: number,
  ): { lMin: number; uMax: number; sMin: number; sMax: number } => {
    if (!beat.enabled) {
      return { lMin: d * beat.oldLo, uMax: d * beat.oldHi, sMin: d, sMax: d };
    }
    // oldSteps = clamp(switchAt - 1 - S - c0, 0, d), decreasing in c0.
    const sMax = clampInt(beat.switchAt - 1 - S - c0lo, 0, d);
    const sMin = clampInt(beat.switchAt - 1 - S - c0hi, 0, d);
    const lAt = (s: number): number => s * beat.oldLo + (d - s) * beat.newLo;
    const uAt = (s: number): number => s * beat.oldHi + (d - s) * beat.newHi;
    return {
      lMin: Math.min(lAt(sMin), lAt(sMax)),
      uMax: Math.max(uAt(sMin), uAt(sMax)),
      sMin,
      sMax,
    };
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
    const cap = countUpper - slotsAfter;
    const moves: Move[] = [];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if (!isSymmetryAllowed(j, mask)) continue;
      const pj = packets[j];
      const pf = pair[last][j];
      // Coarse scalar time floor/ceiling using the extreme beat bounds; the
      // composed envelope below decides each concrete gap.
      const dLo = Math.max(
        pf.dLo,
        pj.baseCount - S - c0hi,
        Math.ceil((pj.lo - tHi) / maxBeatHi),
      );
      const dHi0 = Math.min(
        pf.dHi,
        pj.topCount - S - c0lo,
        cap - S - c0lo,
        Math.floor((pj.hi - tLo) / minBeatLo),
      );
      if (dLo > dHi0) continue;
      const dMin = ceilResidue(dLo, pf.delta, modulus);
      if (dMin > dHi0) continue;

      const consider = (d: number): Move | null => {
        const njLo = Math.max(c0lo, pj.baseCount - S - d);
        const njHi = Math.min(c0hi, pj.topCount - S - d, cap - S - d);
        if (njLo > njHi) return null;
        const env = edgeEnvelope(d, S, njLo, njHi);
        const ntLo = Math.max(pj.lo, tLo + env.lMin);
        const ntHi = Math.min(pj.hi, tHi + env.uMax);
        if (ntLo > ntHi) return null;
        return { j, d, c0lo: njLo, c0hi: njHi, tLo: ntLo, tHi: ntHi };
      };

      for (let d = dMin; d <= dHi0; d += modulus) {
        // The composed rising lower bound is monotone in d; once it passes
        // j's interval no larger gap can work.
        const njLo0 = Math.max(c0lo, pj.baseCount - S - d);
        const njHi0 = Math.min(c0hi, pj.topCount - S - d, cap - S - d);
        if (njLo0 <= njHi0) {
          const env = edgeEnvelope(d, S, njLo0, njHi0);
          if (env.lMin > pj.hi - tLo) break;
        }
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
      bestDead = {
        depth,
        placed: orderArr.slice(0, depth),
        gaps: gapsArr.slice(0, Math.max(0, depth - 1)),
        last,
        S,
        c0lo,
        c0hi,
        tLo,
        tHi,
      };
    }
  };

  // ------------------------------------------------------- leaf certification
  /**
   * Certify a complete (order, gaps, first-count box) EXACTLY and return the
   * best (minimum midpoint deviation) first count / timestamps, or null when
   * the relaxed search reached a leaf that no concrete first count satisfies.
   *
   * The edge bounds are constants once the old/new step split of the unique
   * straddling edge is fixed. Candidate first counts come from:
   *   - the all-old region (last edge ending before the switch),
   *   - the all-new region (first edge starting at/after switchAt - 1),
   *   - for each possible straddling edge e and each old-step count s,
   *     c0 = switchAt - 1 - S_e - s; feasible/optimal integer s values are
   *     enumerated via tight-chain pivots (an affine-in-s relation pinned to
   *     an interval/midpoint pivot), exactly as in optimalTimes.
   */
  const certCache = new Map<string, CertifiedLeaf | null>();

  interface Aff {
    /** coefficient of s */
    a: number;
    b: number;
  }

  const certifyLeaf = (
    order: number[],
    gaps: number[],
    c0lo: number,
    c0hi: number,
  ): CertifiedLeaf | null => {
    const key = `${order.join(',')}|${gaps.join(',')}|${c0lo}|${c0hi}`;
    const cached = certCache.get(key);
    if (cached !== undefined) return cached;

    let Ssum = 0;
    for (const d of gaps) Ssum += d;
    const r0 = packets[order[0]].remainder;

    const evaluate = (c0: number, L: number[], U: number[]): CertifiedLeaf | null => {
      if (c0 < c0lo || c0 > c0hi) return null;
      if (modNonNeg(c0, modulus) !== r0) return null;
      if (c0 < countLower || c0 + Ssum > countUpper) return null;
      // Defensive congruence/window check on every assigned count.
      let cc = c0;
      for (let k = 0; k < n; k++) {
        if (modNonNeg(cc, modulus) !== packets[order[k]].remainder) return null;
        if (cc < countLower || cc > countUpper) return null;
        if (k < n - 1) cc += gaps[k];
      }
      const windows = tightenWindows(packets, order, L, U);
      if (windows === null) return null;
      const { times, deviation2 } = optimalTimes(packets, order, windows, { L, U });
      return { c0, L: L.slice(), U: U.slice(), times, deviation2 };
    };

    let best: CertifiedLeaf | null = null;
    const consider = (leaf: CertifiedLeaf | null): void => {
      if (leaf && (best === null || leaf.deviation2 < best.deviation2 ||
        (leaf.deviation2 === best.deviation2 && leaf.c0 < best.c0))) {
        best = leaf;
      }
    };

    if (!beat.enabled) {
      const L = gaps.map((d) => d * beat.oldLo);
      const U = gaps.map((d) => d * beat.oldHi);
      const c0 = ceilResidue(c0lo, r0, modulus);
      if (c0 <= c0hi) consider(evaluate(c0, L, U));
      certCache.set(key, best);
      return best;
    }

    const T = beat.switchAt;

    // (1) All-old region: the final edge ends at a count <= T - 1.
    {
      const hi = Math.min(c0hi, T - 1 - Ssum);
      const c0 = ceilResidue(c0lo, r0, modulus);
      if (c0 <= hi) {
        const L = gaps.map((d) => d * beat.oldLo);
        const U = gaps.map((d) => d * beat.oldHi);
        consider(evaluate(c0, L, U));
      }
    }

    // (2) All-new region: the first edge starts at a count >= T - 1.
    {
      const lo = Math.max(c0lo, T - 1);
      const c0 = ceilResidue(lo, r0, modulus);
      if (c0 <= c0hi) {
        const L = gaps.map((d) => d * beat.newLo);
        const U = gaps.map((d) => d * beat.newHi);
        consider(evaluate(c0, L, U));
      }
    }

    // (2b) The switch boundary lands EXACTLY on an observed vertex:
    // c_v = T - 1 for some internal vertex v, so edges 0..v-1 are entirely
    // old (they end at or before T - 1) and edges v..n-2 entirely new (they
    // start at or after T - 1), with no straddling edge.
    let Sv = 0;
    for (let v = 1; v < n - 1; v++) {
      Sv += gaps[v - 1];
      const c0 = T - 1 - Sv;
      if (c0 < c0lo || c0 > c0hi) continue;
      if (modNonNeg(c0, modulus) !== r0) continue;
      const L = gaps.map((dd, k) => (k < v ? dd * beat.oldLo : dd * beat.newLo));
      const U = gaps.map((dd, k) => (k < v ? dd * beat.oldHi : dd * beat.newHi));
      consider(evaluate(c0, L, U));
    }

    // (3) A single edge e straddles the switch: enumerate old-step counts s.
    const rawS = new Set<number>();
    let Sprefix = 0;
    for (let e = 0; e < n - 1; e++) {
      const d = gaps[e];
      if (d < 2) {
        Sprefix += d;
        continue;
      }
      // Edge bounds as affine functions of s (old-step count on edge e):
      //   L_e(s) = s*oldLo + (d-s)*newLo = d*newLo + s*(oldLo-newLo)
      //   U_e(s) = d*newHi + s*(oldHi-newHi)
      const edgeL = (k: number): Aff => {
        if (k < e) return { a: 0, b: gaps[k] * beat.oldLo };
        if (k > e) return { a: 0, b: gaps[k] * beat.newLo };
        return { a: beat.oldLo - beat.newLo, b: d * beat.newLo };
      };
      const edgeU = (k: number): Aff => {
        if (k < e) return { a: 0, b: gaps[k] * beat.oldHi };
        if (k > e) return { a: 0, b: gaps[k] * beat.newHi };
        return { a: beat.oldHi - beat.newHi, b: d * beat.newHi };
      };

      // Affine tight-chain values reachable at every position, starting from
      // each position's own pivots (interval bounds + midpoint neighbours).
      const seenSig: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
      const affAt: Aff[][] = Array.from({ length: n }, () => []);
      const putAff = (k: number, v: Aff): void => {
        const sig = `${v.a}/${v.b}`;
        if (!seenSig[k].has(sig)) {
          seenSig[k].add(sig);
          affAt[k].push(v);
        }
      };
      const pivots = (k: number): number[] => {
        const p = packets[order[k]];
        const f = Math.floor(p.mid2 / 2);
        const c = p.mid2 % 2 === 0 ? f : f + 1;
        return [p.lo, p.hi, f, c];
      };

      const goFwd = (pos: number, v: Aff): void => {
        putAff(pos, v);
        if (pos < n - 1) {
          const l = edgeL(pos);
          const u = edgeU(pos);
          goFwd(pos + 1, { a: v.a + l.a, b: v.b + l.b });
          goFwd(pos + 1, { a: v.a + u.a, b: v.b + u.b });
        }
      };
      const goBwd = (pos: number, v: Aff): void => {
        putAff(pos, v);
        if (pos > 0) {
          const l = edgeL(pos - 1);
          const u = edgeU(pos - 1);
          goBwd(pos - 1, { a: v.a - l.a, b: v.b - l.b });
          goBwd(pos - 1, { a: v.a - u.a, b: v.b - u.b });
        }
      };
      for (let j = 0; j < n; j++) {
        for (const pv of pivots(j)) {
          putAff(j, { a: 0, b: pv });
          if (j < n - 1) {
            const l = edgeL(j);
            const u = edgeU(j);
            goFwd(j + 1, { a: l.a, b: pv + l.b });
            goFwd(j + 1, { a: u.a, b: pv + u.b });
          }
          if (j > 0) {
            const l = edgeL(j - 1);
            const u = edgeU(j - 1);
            goBwd(j - 1, { a: -l.a, b: pv - l.b });
            goBwd(j - 1, { a: -u.a, b: pv - u.b });
          }
        }
      }

      // Pin every reachable affine value to every pivot of its position:
      // a*s + b = pivot  =>  s = (pivot - b) / a.
      const addRational = (num: number, den: number): void => {
        if (den === 0) return;
        // Exact floor/ceil with BigInt to stay exact around integers.
        const N = BigInt(num);
        const D = BigInt(den);
        const f = N / D; // truncates toward zero
        const floor = f - (N % D !== 0n && (N < 0n) !== (D < 0n) ? 1n : 0n);
        const ceil = floor + (N % D !== 0n ? 1n : 0n);
        rawS.add(Number(floor));
        rawS.add(Number(ceil));
      };
      for (let k = 0; k < n; k++) {
        for (const v of affAt[k]) {
          if (v.a === 0) continue;
          for (const pv of pivots(k)) addRational(pv - v.b, v.a);
        }
      }
      rawS.add(1);
      rawS.add(d - 1);

      // c0 = T - 1 - Sprefix - s must be congruent to r0 modulo modulus:
      // s ≡ T - 1 - Sprefix - r0 (mod modulus).
      const sResidue = modNonNeg(T - 1 - Sprefix - r0, modulus);
      // c0 box restricts s to [T-1-Sprefix-c0hi, T-1-Sprefix-c0lo].
      const sLoBox = Math.max(1, T - 1 - Sprefix - c0hi);
      const sHiBox = Math.min(d - 1, T - 1 - Sprefix - c0lo);
      const tryS = new Set<number>();
      for (const rs of rawS) {
        // Valid residue-grid neighbours on both sides of the breakpoint.
        const up = ceilResidue(Math.max(rs - 1, sLoBox), sResidue, modulus);
        const down = floorResidue(Math.min(rs + 1, sHiBox), sResidue, modulus);
        tryS.add(up);
        tryS.add(down);
      }
      tryS.add(ceilResidue(sLoBox, sResidue, modulus));
      tryS.add(floorResidue(sHiBox, sResidue, modulus));
      for (const cand of tryS) {
        if (cand < sLoBox || cand > sHiBox) continue;
        const c0 = T - 1 - Sprefix - cand;
        const L = gaps.map((dd, k) => {
          if (k < e) return dd * beat.oldLo;
          if (k > e) return dd * beat.newLo;
          return cand * beat.oldLo + (dd - cand) * beat.newLo;
        });
        const U = gaps.map((dd, k) => {
          if (k < e) return dd * beat.oldHi;
          if (k > e) return dd * beat.newHi;
          return cand * beat.oldHi + (dd - cand) * beat.newHi;
        });
        consider(evaluate(c0, L, U));
      }
      Sprefix += d;
    }

    certCache.set(key, best);
    return best;
  };

  // ------------------------------------------------------------------ Phase A
  // Minimum total counter gap. A state memo caches the best completion gap
  // sum (Infinity = dead); state = (used set, last packet, fixed prefix gap
  // sum, tightened c0 and last-timestamp windows).
  const memoA = new Map<string, number>();
  let bestA = Infinity;
  let stopA = false;

  const dfsA = (depth: number, last: number, S: number, c0lo: number, c0hi: number, tLo: number, tHi: number): number => {
    if (stopA) return Infinity;
    if (depth === n) {
      // Relaxed propagation is exact for the single-beat model; with a beat
      // switch certify a concrete first count before accepting the leaf.
      if (beat.enabled && certifyLeaf(orderArr.slice(), gapsArr.slice(), c0lo, c0hi) === null) {
        recordDead(depth, last, S, c0lo, c0hi, tLo, tHi);
        return Infinity;
      }
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

    const key = beat.enabled
      ? `A|${prefixSignature(depth, last, S, c0lo, c0hi, tLo, tHi)}`
      : `A|${mask}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}`;
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
    throw buildFailureEvidence(
      packets,
      pair,
      bestDead,
      modulus,
      countLower,
      countUpper,
      beat,
    );
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
   * completion of the CURRENT state reaches total gap Pstar with a concrete
   * certifiable first count. The state is Markovian in (used mask, last
   * packet, fixed gap sum S, tightened c0 window and last timestamp window).
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
    if (depth === n) {
      if (S !== Pstar) return false;
      if (beat.enabled && certifyLeaf(orderArr.slice(), gapsArr.slice(), c0lo, c0hi) === null) {
        return false;
      }
      return true;
    }
    const key = beat.enabled
      ? `O|${prefixSignature(depth, last, S, c0lo, c0hi, tLo, tHi)}|${mask}`
      : `O|${mask}|${last}|${S}|${c0lo}|${c0hi}|${tLo}|${tHi}`;
    const cached = memoOpt.get(key);
    if (cached !== undefined) return cached;

    const remaining = full ^ mask;
    const moves = enumerateMoves(depth, last, S, c0lo, c0hi, tLo, tHi, mask);
    let ok = false;
    for (const mv of moves) {
      // Necessary bound for reaching Pstar; exact feasibility checked below.
      if (S + mv.d + cont[remaining ^ (1 << mv.j)][mv.j] > Pstar) continue;
      used[mv.j] = 1;
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
      // The beat-aware oracle key is a full-prefix signature, so the shared
      // prefix arrays must describe exactly this candidate move while the
      // oracle runs. (In single-beat mode these slots are not read.)
      used[mv.j] = 1;
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
      used[mv.j] = 0;
      return v;
    });
  };

  /** Whether a seed packet can begin any primary-optimal completion. */
  const seedIsOptimal = (seedIndex: number): boolean => {
    const seed = packets[seedIndex];
    const c0hi0 = Math.min(seed.topCount, countUpper - n + 1);
    if (seed.baseCount > c0hi0) return false;
    // Establish shared-array state exactly like the phase A/B/C seed loops:
    // the oracle's prefix signature and leaf certification read orderArr, so
    // a stale slot from a previous probe would certify the wrong packet.
    used.fill(0);
    used[seedIndex] = 1;
    orderArr[0] = seedIndex;
    tLoArr[0] = seed.lo;
    tHiArr[0] = seed.hi;
    return optimalFromState(1, seedIndex, 0, seed.baseCount, c0hi0, seed.lo, seed.hi, 1 << seedIndex);
  };

  const leafDeviation = (c0lo: number, c0hi: number): number => {
    const cert = certifyLeaf(orderArr.slice(), gapsArr.slice(), c0lo, c0hi);
    return cert === null ? Infinity : cert.deviation2;
  };

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
  /** Forward-tightened timestamp windows of every fixed prefix position. */
  const fixedWin: { lo: number; hi: number }[] = [];
  let curLast = -1;
  let curS = 0;
  let curC0lo = 0;
  let curC0hi = 0;
  let curTLo = 0;
  let curTHi = 0;
  let curMask = 0;

  /** Restore the fixed prefix into the shared arrays so the oracle's
   * memoization keys and leaf certification see exactly the frontier state
   * recorded when each position was fixed. */
  const replayPrefixWindows = (): void => {
    for (let k = 0; k < chosen.length; k++) {
      orderArr[k] = chosen[k];
      tLoArr[k] = fixedWin[k].lo;
      tHiArr[k] = fixedWin[k].hi;
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
      fixedWin.push({ lo: seed.lo, hi: seed.hi });
    } else {
      const mv = picked.mv!;
      fixedGaps.push(mv.d);
      curS += mv.d;
      curC0lo = mv.c0lo;
      curC0hi = mv.c0hi;
      curTLo = mv.tLo;
      curTHi = mv.tHi;
      fixedWin.push({ lo: mv.tLo, hi: mv.tHi });
    }
    curLast = picked.j;
    curMask |= 1 << picked.j;
  }

  // Assemble the certified solution: exact first count, composed per-edge
  // bounds and optimal integer timestamps.
  const finalOrder = chosen.slice();
  const finalGaps = fixedGaps.slice();
  const certified = certifyLeaf(finalOrder, finalGaps, curC0lo, curC0hi);
  if (!certified) {
    throw new SolveError('NO_CONSISTENT_INTERPRETATION', 'internal failure certifying final interpretation');
  }
  let gapSum = 0;
  for (const d of finalGaps) gapSum += d;

  return buildResult(
    packets,
    {
      gapSum,
      deviation2: certified.deviation2,
      times: certified.times,
      order: finalOrder,
      c0: certified.c0,
      gaps: finalGaps,
    },
    modulus,
    beat,
  );
}

function buildResult(
  packets: Packet[],
  cand: { gapSum: number; deviation2: number; times: number[]; order: number[]; c0: number; gaps: number[] },
  modulus: number,
  beat: BeatConfig,
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
      // Without a beat switch these are simply d old steps and 0 new ones,
      // and the added fields are omitted so the legacy response is unchanged.
      const split = splitSteps(beat, prevCount, d);
      const oldSteps = split.oldSteps;
      const newSteps = split.newSteps;
      const oldMinGap = oldSteps * beat.oldLo;
      const oldMaxGap = oldSteps * beat.oldHi;
      const newMinGap = newSteps * beat.newLo;
      const newMaxGap = newSteps * beat.newHi;
      const allowedMin = oldMinGap + newMinGap;
      const allowedMax = oldMaxGap + newMaxGap;
      const evidence: AdjacencyEvidence = {
        index: k - 1,
        fromId: prevP.id,
        toId: p.id,
        fromCount: prevCount,
        toCount: count,
        countGap: d,
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
      };
      if (beat.enabled) {
        evidence.oldSteps = oldSteps;
        evidence.newSteps = newSteps;
        evidence.beatBreakdown = {
          switchAtCount: beat.switchAt,
          old: {
            steps: oldSteps,
            minInterval: beat.oldLo,
            maxInterval: beat.oldHi,
            minTimeGap: oldMinGap,
            maxTimeGap: oldMaxGap,
          },
          next: {
            steps: newSteps,
            minInterval: beat.newLo,
            maxInterval: beat.newHi,
            minTimeGap: newMinGap,
            maxTimeGap: newMaxGap,
          },
        };
      }
      adjacency.push(evidence);
    }
    if (k < n - 1) count += cand.gaps[k];
  }

  const result: SolveResult = {
    order,
    assignments,
    missingSegments,
    missingCountTotal: cand.gapSum - (n - 1),
    adjacency,
    observedCountRange: { first: cand.c0, last: cand.c0 + cand.gapSum },
  };
  if (beat.enabled) {
    result.beatSwitch = {
      firstNewBeatCount: beat.switchAt,
      oldMinInterval: beat.oldLo,
      oldMaxInterval: beat.oldHi,
      newMinInterval: beat.newLo,
      newMaxInterval: beat.newHi,
    };
  }
  return result;
}

/** Beat-aware decomposition detail for one candidate extension gap. */
function beatBlockerDetail(
  beat: BeatConfig,
  d: number,
  S: number,
  c0lo: number,
  c0hi: number,
  actualTimeGap: { min: number; max: number },
): BeatBlockerDetail {
  const sMax = clampInt(beat.switchAt - 1 - S - c0lo, 0, d);
  const sMin = clampInt(beat.switchAt - 1 - S - c0hi, 0, d);
  const lAt = (s: number): number => s * beat.oldLo + (d - s) * beat.newLo;
  const uAt = (s: number): number => s * beat.oldHi + (d - s) * beat.newHi;
  return {
    switchAtCount: beat.switchAt,
    countGap: d,
    oldBeat: {
      steps: { min: sMin, max: sMax },
      minInterval: beat.oldLo,
      maxInterval: beat.oldHi,
    },
    newBeat: {
      steps: { min: d - sMax, max: d - sMin },
      minInterval: beat.newLo,
      maxInterval: beat.newHi,
    },
    composedTimeGap: {
      min: Math.min(lAt(sMin), lAt(sMax)),
      max: Math.max(uAt(sMin), uAt(sMax)),
    },
    actualTimeGap,
  };
}

/**
 * Analyze a complete chain that could not be certified under a beat switch:
 * find the first edge for which, over the c0 box, every admissible old/new
 * step split still contradicts the tightened timestamp windows. The
 * returned evidence carries the absolute-count range of both endpoints and
 * the beat decomposition, so a beat conflict is distinguishable from a
 * missing packet. Returns null if no single edge is conclusive.
 */
function analyzeBeatLeafConflict(
  packets: Packet[],
  dead: DeadState,
  modulus: number,
  countLower: number,
  countUpper: number,
  beat: BeatConfig,
): ConstraintFailureEvidence | null {
  const order = dead.placed;
  const gaps = dead.gaps;
  const n = order.length;
  const partialOrder = order.map((ix) => packets[ix].id);
  const firstResidue = packets[order[0]].remainder;

  const edgeEvidence = (
    k: number,
    Sprefix: number,
    c0BoxLo: number,
    c0BoxHi: number,
    fwdPrev: { lo: number; hi: number },
  ): ConstraintFailureEvidence => {
    const d = gaps[k - 1];
    const p = packets[order[k]];
    const actual = { min: p.lo - fwdPrev.hi, max: p.hi - fwdPrev.lo };
    // The caller passes either the full existential c0 box or a single
    // concrete first count (lo === hi) for an exact witness.
    const detailBeat = beatBlockerDetail(beat, d, Sprefix, c0BoxLo, c0BoxHi, actual);
    const fromLo = Sprefix + c0BoxLo;
    const fromHi = Sprefix + c0BoxHi;
    const splitKind =
      detailBeat.oldBeat.steps.max === 0
        ? 'runs entirely on the new beat'
        : detailBeat.newBeat.steps.max === 0
          ? 'runs entirely on the old beat'
          : 'straddles the beat switch';
    return {
      stage: 'extension',
      partialLength: n,
      partialOrder,
      candidateId: p.id,
      reason:
        `the full order ${partialOrder.map(String).join(' -> ')} fixes every packet, but the adjacency ` +
        `${String(packets[order[k - 1]].id)} -> ${String(p.id)} (gap ${d}) ${splitKind} at count ` +
        `${beat.switchAt}: its old/new step split ranges over ` +
        `${detailBeat.oldBeat.steps.min}..${detailBeat.oldBeat.steps.max} old + ` +
        `${detailBeat.newBeat.steps.min}..${detailBeat.newBeat.steps.max} new steps, composing an ` +
        `allowed time difference of [${detailBeat.composedTimeGap.min}, ${detailBeat.composedTimeGap.max}], ` +
        `while the tightened closed intervals only admit [${actual.min}, ${actual.max}]. Absolute ` +
        `counts: last observed packet in [${fromLo}, ${fromHi}], candidate ${String(p.id)} in ` +
        `[${fromLo + d}, ${fromHi + d}] (search window [${countLower}, ${countUpper}]). This is a ` +
        `beat-switch conflict, not a missing packet`,
      detail: {
        cause: 'TIME_GAP',
        countGap: d,
        actualTimeGapRange: actual,
        absoluteCountRange: {
          from: { min: fromLo, max: fromHi },
          to: { min: fromLo + d, max: fromHi + d },
        },
        beatBreakdown: detailBeat,
      },
    };
  };

  // Pass 1: cheap existential forward tightening over the whole c0 box.
  const fwd: { lo: number; hi: number }[] = new Array(n);
  fwd[0] = { lo: packets[order[0]].lo, hi: packets[order[0]].hi };
  let Sprefix = 0;
  for (let k = 1; k < n; k++) {
    const d = gaps[k - 1];
    const p = packets[order[k]];
    const sMax = clampInt(beat.switchAt - 1 - Sprefix - dead.c0lo, 0, d);
    const sMin = clampInt(beat.switchAt - 1 - Sprefix - dead.c0hi, 0, d);
    const lAt = (s: number): number => s * beat.oldLo + (d - s) * beat.newLo;
    const uAt = (s: number): number => s * beat.oldHi + (d - s) * beat.newHi;
    const lMin = Math.min(lAt(sMin), lAt(sMax));
    const uMax = Math.max(uAt(sMin), uAt(sMax));
    const lo = Math.max(p.lo, fwd[k - 1].lo + lMin);
    const hi = Math.min(p.hi, fwd[k - 1].hi + uMax);
    if (lo > hi) {
      return edgeEvidence(k, Sprefix, dead.c0lo, dead.c0hi, fwd[k - 1]);
    }
    fwd[k] = { lo, hi };
    Sprefix += d;
  }

  // Pass 2: the relaxed box survived, so test concrete congruent first
  // counts exactly (c0 is pinned to the first packet's residue). The first
  // failing witness pinpoints the blocking edge and beat split.
  let totalGap = 0;
  for (const d of gaps) totalGap += d;
  for (let c0 = ceilResidue(dead.c0lo, firstResidue, modulus); c0 <= dead.c0hi; c0 += modulus) {
    if (c0 < countLower || c0 + totalGap > countUpper) continue;
    const w: { lo: number; hi: number }[] = new Array(n);
    w[0] = { lo: packets[order[0]].lo, hi: packets[order[0]].hi };
    let pref = 0;
    let bad: number | null = null;
    for (let k = 1; k < n; k++) {
      const d = gaps[k - 1];
      const p = packets[order[k]];
      const split = splitSteps(beat, pref + c0, d);
      const L = split.oldSteps * beat.oldLo + split.newSteps * beat.newLo;
      const U = split.oldSteps * beat.oldHi + split.newSteps * beat.newHi;
      const lo = Math.max(p.lo, w[k - 1].lo + L);
      const hi = Math.min(p.hi, w[k - 1].hi + U);
      if (lo > hi) {
        bad = k;
        break;
      }
      w[k] = { lo, hi };
      pref += d;
    }
    if (bad !== null) {
      let prefBad = 0;
      for (let k = 1; k < bad; k++) prefBad += gaps[k - 1];
      return edgeEvidence(bad, prefBad, c0, c0, w[bad - 1]);
    }
  }
  return null;
}


function buildFailureEvidence(
  packets: Packet[],
  pair: { delta: number; dLo: number; dHi: number }[][],
  bestDead: DeadState | null,
  modulus: number,
  countLower: number,
  countUpper: number,
  beat: BeatConfig,
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
      reason:
        'no packet can be seeded inside the absolute count search window' +
        (beat.enabled ? ` (beat switch at count ${beat.switchAt})` : ''),
    });
  }

  // A complete order reached the leaf but no concrete first absolute count
  // certifies it under the beat switch. Analyze the fixed chain exactly: the
  // first edge whose composed old/new range contradicts the tightened time
  // windows is the blocking beat-switch conflict (distinct from a genuine
  // missing packet, which would have failed earlier with a count gap).
  if (bestDead.depth === packets.length && beat.enabled) {
    const leaf = analyzeBeatLeafConflict(packets, bestDead, modulus, countLower, countUpper, beat);
    if (leaf) return make(leaf);
  }

  const n = packets.length;
  const { depth, placed, last, S, c0lo, c0hi, tLo, tHi } = bestDead;
  const partialOrder = placed.map((ix) => packets[ix].id);
  const usedNow = new Set(placed);
  const slotsAfter = n - 1 - depth;
  const cap = countUpper - slotsAfter;

  type Blocker = {
    j: number;
    cause: 'TIME_GAP' | 'COUNT_WINDOW' | 'CONGRUENCE';
    dStar: number;
    delta: number;
    timeRange: { min: number; max: number };
    countRange: { min: number; max: number };
    intrinsicCeiling: number;
    achievable: { min: number; max: number };
    c0Box: { lo: number; hi: number };
  };
  const blockers: Blocker[] = [];

  for (let j = 0; j < n; j++) {
    if (usedNow.has(j)) continue;
    const pj = packets[j];
    const pf = pair[last][j];
    const d0 = pf.delta === 0 ? modulus : pf.delta;

    // Count-window side (identical in both models): congruent gaps whose
    // endpoints land in the search window and leave room for the rest.
    const Clo = Math.max(d0, pj.baseCount - S - c0hi);
    const Chi = Math.min(pf.dHi, pj.topCount - S - c0lo, cap - S - c0lo);
    const snapOrInf = (lo: number, hi: number): number => {
      if (lo > hi) return Infinity;
      const d = ceilResidue(lo, pf.delta, modulus);
      return d <= hi ? d : Infinity;
    };
    const dCount = snapOrInf(Clo, Chi);

    if (beat.enabled) {
      // Exact scan mirroring enumerateMoves: test every congruent gap in the
      // count-admissible range against the narrowed first-count box and the
      // composed old/new time envelope. A dead end admits none.
      let feasibleGap = Infinity;
      let firstCountGap = Infinity;
      if (dCount !== Infinity) {
        firstCountGap = dCount;
        for (let d = dCount; d <= Chi; d += modulus) {
          const njLo = Math.max(c0lo, pj.baseCount - S - d);
          const njHi = Math.min(c0hi, pj.topCount - S - d, cap - S - d);
          if (njLo > njHi) continue;
          const sMax = clampInt(beat.switchAt - 1 - S - njLo, 0, d);
          const sMin = clampInt(beat.switchAt - 1 - S - njHi, 0, d);
          const lAt = (s: number): number => s * beat.oldLo + (d - s) * beat.newLo;
          const uAt = (s: number): number => s * beat.oldHi + (d - s) * beat.newHi;
          const lMin = Math.min(lAt(sMin), lAt(sMax));
          const uMax = Math.max(uAt(sMin), uAt(sMax));
          const ntLo = Math.max(pj.lo, tLo + lMin);
          const ntHi = Math.min(pj.hi, tHi + uMax);
          if (ntLo <= ntHi) {
            feasibleGap = d;
            break;
          }
        }
      }
      if (feasibleGap !== Infinity) continue; // genuinely extendable
      blockers.push({
        j,
        cause: dCount !== Infinity ? 'TIME_GAP' : Clo > Chi ? 'COUNT_WINDOW' : 'CONGRUENCE',
        dStar: firstCountGap,
        delta: pf.delta,
        timeRange: { min: Math.ceil((pj.lo - tHi) / Math.max(beat.oldHi, beat.newHi)), max: Math.floor((pj.hi - tLo) / Math.min(beat.oldLo, beat.newLo)) },
        countRange: { min: Clo, max: Chi },
        intrinsicCeiling: pf.dHi,
        achievable: { min: pj.lo - tHi, max: pj.hi - tLo },
        c0Box: { lo: c0lo, hi: c0hi },
      });
      continue;
    }

    // Single-beat model: exact scalar gap ranges from the tightened boxes.
    const Tlo = Math.ceil((pj.lo - tHi) / beat.oldHi);
    const Thi = Math.floor((pj.hi - tLo) / beat.oldLo);
    const dTime = snapOrInf(Math.max(d0, Tlo), Thi);
    const loAll = Math.max(d0, Tlo, Clo);
    const hiAll = Math.min(pf.dHi, Thi, Chi);
    const dBoth = snapOrInf(loAll, hiAll);

    let cause: Blocker['cause'];
    let dStar: number;
    if (dBoth !== Infinity) continue; // extendable; cannot occur at a dead end
    if (dCount !== Infinity) {
      // Smallest congruent gap satisfying the count window exists; the
      // extension fails on the time-difference range.
      cause = 'TIME_GAP';
      dStar = dCount;
    } else if (dTime !== Infinity) {
      cause = 'COUNT_WINDOW';
      dStar = dTime;
    } else {
      cause = Tlo > Thi ? 'TIME_GAP' : 'CONGRUENCE';
      dStar = Infinity;
    }

    blockers.push({
      j,
      cause,
      dStar,
      delta: pf.delta,
      timeRange: { min: Tlo, max: Thi },
      countRange: { min: Clo, max: Chi },
      intrinsicCeiling: pf.dHi,
      achievable: { min: pj.lo - tHi, max: pj.hi - tLo },
      c0Box: { lo: c0lo, hi: c0hi },
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
    const finite = (x: number): number => (Number.isFinite(x) ? x : -1);
    const d = b.dStar;
    const achievable = b.achievable;

    // Representative extension gap for count ranges / beat decomposition:
    // prefer the smallest congruent gap the count window admits.
    const repD = Number.isFinite(d)
      ? d
      : (() => {
          const lo = Math.max(1, b.countRange.min);
          const dd = ceilResidue(lo, b.delta, modulus);
          return dd <= Math.max(b.countRange.max, lo - 1) ? dd : Math.max(1, lo);
        })();
    const repA = Math.max(b.c0Box.lo, pj.baseCount - S - repD);
    const repB = Math.min(b.c0Box.hi, pj.topCount - S - repD, cap - S - repD);
    const absRange = {
      from: { min: S + Math.max(b.c0Box.lo, repA), max: S + Math.min(b.c0Box.hi, repB) },
      to: {
        min: S + repD + Math.max(b.c0Box.lo, repA),
        max: S + repD + Math.min(b.c0Box.hi, repB),
      },
    };

    if (!beat.enabled) {
      if (b.cause === 'TIME_GAP') {
        const firstPositive = b.delta === 0 ? modulus : b.delta;
        const dTiming = (() => {
          const lo = Math.max(firstPositive, b.timeRange.min);
          if (lo > b.timeRange.max) return Infinity;
          const v = ceilResidue(lo, b.delta, modulus);
          return v <= b.timeRange.max ? v : Infinity;
        })();
        const dCountVal = b.dStar;
        return make({
          stage: 'extension',
          partialLength: depth,
          partialOrder,
          candidateId: pj.id,
          reason:
            `cannot append packet ${String(pj.id)} after packet ${prevId}: the time-difference ` +
            `constraint needs a counter gap in [${b.timeRange.min}, ${b.timeRange.max}] but the ` +
            `absolute-count window only permits [${b.countRange.min}, ${b.countRange.max}] ` +
            `(smallest congruent gap satisfying the count window: ${finite(dCountVal)}; satisfying ` +
            `the time range: ${finite(dTiming)}). The tightened closed intervals only admit time ` +
            `differences in [${achievable.min}, ${achievable.max}], so no single gap satisfies ` +
            `both constraints`,
          detail: {
            cause: 'TIME_GAP',
            minimalCongruentGap: Number.isFinite(dCountVal) ? dCountVal : undefined,
            countGap: Number.isFinite(dCountVal) ? dCountVal : undefined,
            requiredTimeGap: Number.isFinite(dTiming)
              ? { min: dTiming * beat.oldLo, max: dTiming * beat.oldHi }
              : undefined,
            actualTimeGapRange: achievable,
            countGapWindow: { min: b.countRange.min, max: b.countRange.max },
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
            `cannot append packet ${String(pj.id)} after packet ${prevId}: the absolute-count ` +
            `window only admits a counter gap in [${b.countRange.min}, ${b.countRange.max}] (intrinsic ` +
            `ceiling ${b.intrinsicCeiling}), but the time-difference constraint needs a gap in ` +
            `[${b.timeRange.min}, ${b.timeRange.max}]; the two ranges have no congruent value in common`,
          detail: {
            cause: 'COUNT_WINDOW',
            minimalCongruentGap: Number.isFinite(d) ? d : undefined,
            countGapWindow: { min: b.countRange.min, max: b.countRange.max },
            requiredTimeGap: Number.isFinite(d)
              ? { min: d * beat.oldLo, max: d * beat.oldHi }
              : undefined,
            actualTimeGapRange: achievable,
          },
        });
      }

      return make({
        stage: 'extension',
        partialLength: depth,
        partialOrder,
        candidateId: pj.id,
        reason:
          `cannot append packet ${String(pj.id)} after packet ${prevId}: the time-feasible gap range ` +
          `[${b.timeRange.min}, ${b.timeRange.max}] and count-feasible gap range ` +
          `[${b.countRange.min}, ${b.countRange.max}] overlap but contain no positive counter gap ` +
          `congruent to ${pair[last][b.j].delta} modulo ${modulus}`,
        detail: {
          cause: 'CONGRUENCE',
          minimalCongruentGap: Number.isFinite(d) ? d : undefined,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          actualTimeGapRange: achievable,
        },
      });
    }

    // Beat-switch evidence: always carry the absolute-count range and the
    // old/new beat decomposition so engineers can tell a genuine missing
    // packet apart from a beat-switch conflict.
    const detailBeat = beatBlockerDetail(beat, repD, S, b.c0Box.lo, b.c0Box.hi, achievable);
    const composed = detailBeat.composedTimeGap;
    const beatNote =
      `beat switch at count ${beat.switchAt}: old interval ` +
      `[${beat.oldLo}, ${beat.oldHi}], new interval [${beat.newLo}, ${beat.newHi}]; for gap ${repD} ` +
      `the old/new step split ranges over ${detailBeat.oldBeat.steps.min}..${detailBeat.oldBeat.steps.max} ` +
      `old + ${detailBeat.newBeat.steps.min}..${detailBeat.newBeat.steps.max} new steps, composing an ` +
      `allowed time difference of [${composed.min}, ${composed.max}] while the closed intervals only ` +
      `admit [${achievable.min}, ${achievable.max}]`;
    const countNote =
      `absolute counts: last observed packet in [${absRange.from.min}, ${absRange.from.max}], ` +
      `candidate ${String(pj.id)} would be in [${absRange.to.min}, ${absRange.to.max}] ` +
      `(search window [${countLower}, ${countUpper}])`;

    if (b.cause === 'TIME_GAP') {
      return make({
        stage: 'extension',
        partialLength: depth,
        partialOrder,
        candidateId: pj.id,
        reason:
          `cannot append packet ${String(pj.id)} after packet ${prevId}: no old/new beat step split ` +
          `satisfies the timing. ${beatNote}; ${countNote}. This is a beat-switch timing conflict ` +
          `rather than a missing-packet gap`,
        detail: {
          cause: 'TIME_GAP',
          minimalCongruentGap: Number.isFinite(b.dStar) ? b.dStar : undefined,
          countGap: repD,
          actualTimeGapRange: achievable,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          absoluteCountRange: absRange,
          beatBreakdown: detailBeat,
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
          `only permits a counter gap in [${b.countRange.min}, ${b.countRange.max}] (intrinsic ceiling ` +
          `${b.intrinsicCeiling}); ${beatNote}; ${countNote}`,
        detail: {
          cause: 'COUNT_WINDOW',
          minimalCongruentGap: Number.isFinite(b.dStar) ? b.dStar : undefined,
          countGap: repD,
          actualTimeGapRange: achievable,
          countGapWindow: { min: b.countRange.min, max: b.countRange.max },
          absoluteCountRange: absRange,
          beatBreakdown: detailBeat,
        },
      });
    }
    return make({
      stage: 'extension',
      partialLength: depth,
      partialOrder,
      candidateId: pj.id,
      reason:
        `cannot append packet ${String(pj.id)} after packet ${prevId}: no positive counter gap ` +
        `congruent to ${b.delta} modulo ${modulus} lies in both the time-feasible range ` +
        `[${b.timeRange.min}, ${b.timeRange.max}] and the count-feasible range ` +
        `[${b.countRange.min}, ${b.countRange.max}]; ${beatNote}; ${countNote}`,
      detail: {
        cause: 'CONGRUENCE',
        minimalCongruentGap: Number.isFinite(b.dStar) ? b.dStar : undefined,
        countGap: repD,
        actualTimeGapRange: achievable,
        countGapWindow: { min: b.countRange.min, max: b.countRange.max },
        absoluteCountRange: absRange,
        beatBreakdown: detailBeat,
      },
    });
  }

  const candidate = packets[last];
  return make({
    stage: 'extension',
    partialLength: depth,
    partialOrder,
    candidateId: candidate.id,
    reason:
      `cannot extend from packet ${String(candidate.id)}: no unused packet remains` +
      (beat.enabled ? ` (beat switch at count ${beat.switchAt})` : ''),
  });
}
