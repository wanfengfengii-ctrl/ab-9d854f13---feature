import type { BeatSwitchInput, PacketInput, SolveRequest } from './types.js';
import { SolveError } from './types.js';

/**
 * Integers may arrive as JSON numbers. The domain is defined over integers
 * (integer closed intervals, integer timestamps), so reject non-integers and
 * unsafe values explicitly rather than silently coercing.
 */
function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function validateRequest(raw: unknown): SolveRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SolveError('INVALID_REQUEST', 'request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  for (const field of ['modulus', 'countLower', 'countUpper', 'minInterval', 'maxInterval'] as const) {
    if (!isSafeInt(obj[field])) {
      throw new SolveError('INVALID_REQUEST', `field "${field}" must be a safe integer`);
    }
  }

  const modulus = obj.modulus as number;
  const countLower = obj.countLower as number;
  const countUpper = obj.countUpper as number;
  const minInterval = obj.minInterval as number;
  const maxInterval = obj.maxInterval as number;

  if (modulus < 2) {
    throw new SolveError('INVALID_REQUEST', 'modulus must be an integer >= 2');
  }
  if (countLower > countUpper) {
    throw new SolveError('INVALID_REQUEST', 'countLower must be <= countUpper');
  }
  if (minInterval <= 0) {
    throw new SolveError('INVALID_REQUEST', 'minInterval must be a positive integer');
  }
  if (maxInterval < minInterval) {
    throw new SolveError('INVALID_REQUEST', 'maxInterval must be >= minInterval');
  }
  if (maxInterval > 1_000_000) {
    throw new SolveError(
      'INVALID_REQUEST',
      'maxInterval must not exceed 1,000,000 to keep gap products integral',
    );
  }

  // Optional in-voyage sampling-beat switch. Omitted => fully compatible with
  // the single-beat request/response contract.
  let beatSwitch: BeatSwitchInput | undefined;
  if (obj.beatSwitch !== undefined && obj.beatSwitch !== null) {
    if (typeof obj.beatSwitch !== 'object' || Array.isArray(obj.beatSwitch)) {
      throw new SolveError('INVALID_REQUEST', 'field "beatSwitch" must be an object');
    }
    const bs = obj.beatSwitch as Record<string, unknown>;
    if (
      !isSafeInt(bs.firstNewBeatCount) ||
      !isSafeInt(bs.newMinInterval) ||
      !isSafeInt(bs.newMaxInterval)
    ) {
      throw new SolveError(
        'INVALID_REQUEST',
        'beatSwitch fields firstNewBeatCount/newMinInterval/newMaxInterval must be safe integers',
      );
    }
    if (bs.newMinInterval <= 0) {
      throw new SolveError('INVALID_REQUEST', 'beatSwitch.newMinInterval must be a positive integer');
    }
    if (bs.newMaxInterval < bs.newMinInterval) {
      throw new SolveError(
        'INVALID_REQUEST',
        'beatSwitch.newMaxInterval must be >= beatSwitch.newMinInterval',
      );
    }
    if (bs.newMaxInterval > 1_000_000) {
      throw new SolveError(
        'INVALID_REQUEST',
        'beatSwitch.newMaxInterval must not exceed 1,000,000 to keep gap products integral',
      );
    }
    beatSwitch = {
      firstNewBeatCount: bs.firstNewBeatCount,
      newMinInterval: bs.newMinInterval,
      newMaxInterval: bs.newMaxInterval,
    };
  }

  // Guard against silent precision loss when multiplying the window width
  // by the largest interval (either beat), and against time coordinates that
  // cannot be combined exactly with gap products.
  const effectiveMaxInterval = Math.max(
    maxInterval,
    beatSwitch ? beatSwitch.newMaxInterval : maxInterval,
  );
  if ((countUpper - countLower) * effectiveMaxInterval > 1e13) {
    throw new SolveError(
      'INVALID_REQUEST',
      '(countUpper - countLower) * maxInterval must not exceed 1e13',
    );
  }
  // Guard against silent overflow when multiplying gap * interval.
  if (countUpper - countLower > 1_000_000) {
    throw new SolveError(
      'INVALID_REQUEST',
      'absolute count search window must not exceed 1,000,000 counters',
    );
  }

  if (!Array.isArray(obj.packets)) {
    throw new SolveError('INVALID_REQUEST', 'field "packets" must be an array');
  }
  const packetsRaw = obj.packets as unknown[];
  if (packetsRaw.length < 6 || packetsRaw.length > 14) {
    throw new SolveError(
      'INVALID_REQUEST',
      'between 6 and 14 unique packets are required',
    );
  }

  const seenIds = new Set<string>();
  const packets: PacketInput[] = packetsRaw.map((p, i) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new SolveError('INVALID_REQUEST', `packets[${i}] must be an object`);
    }
    const po = p as Record<string, unknown>;
    if (
      (typeof po.id !== 'string' && typeof po.id !== 'number') ||
      (typeof po.id === 'number' && !Number.isSafeInteger(po.id))
    ) {
      throw new SolveError('INVALID_REQUEST', `packets[${i}].id must be a string or safe integer`);
    }
    const idKey = String(po.id);
    if (seenIds.has(idKey)) {
      throw new SolveError('INVALID_REQUEST', `duplicate packet id: ${po.id}`);
    }
    seenIds.add(idKey);

    if (!isSafeInt(po.remainder) || !isSafeInt(po.timeLower) || !isSafeInt(po.timeUpper)) {
      throw new SolveError(
        'INVALID_REQUEST',
        `packets[${i}] remainder/timeLower/timeUpper must be safe integers`,
      );
    }
    const remainder = po.remainder as number;
    const timeLower = po.timeLower as number;
    const timeUpper = po.timeUpper as number;
    if (remainder < 0 || remainder >= modulus) {
      throw new SolveError(
        'INVALID_REQUEST',
        `packets[${i}].remainder must satisfy 0 <= remainder < modulus`,
      );
    }
    if (timeLower > timeUpper) {
      throw new SolveError(
        'INVALID_REQUEST',
        `packets[${i}].timeLower must be <= timeUpper`,
      );
    }
    // Midpoint doubling and gap-shifted sums must stay exact integers.
    if (
      !Number.isSafeInteger(timeLower + timeUpper) ||
      Math.abs(timeLower) > 1e12 ||
      Math.abs(timeUpper) > 1e12
    ) {
      throw new SolveError(
        'INVALID_REQUEST',
        `packets[${i}] time interval values are out of the supported integer range`,
      );
    }
    return { id: po.id as string | number, remainder, timeLower, timeUpper };
  });

  return { packets, modulus, countLower, countUpper, minInterval, maxInterval, beatSwitch };
}
