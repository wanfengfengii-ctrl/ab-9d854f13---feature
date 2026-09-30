import { describe, expect, it } from 'vitest';
import { handleSolve } from '../src/api/handler.js';
import { sampleRequest, sampleExpected } from './fixtures/sample.js';

describe('handleSolve', () => {
  it('returns the recovered order for the canonical sample', () => {
    const res = handleSolve(sampleRequest);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.data.order).toEqual(sampleExpected.order);
    expect(res.data.missingCountTotal).toBe(sampleExpected.missingTotal);
    for (const ev of res.data.adjacency) expect(ev.satisfied).toBe(true);
  });

  it('maps validation failures to INVALID_REQUEST errors', () => {
    const res = handleSolve({ ...sampleRequest, modulus: 1 });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_REQUEST');
  });

  it('maps infeasible instances to the stable business error code with evidence', () => {
    const packets = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      remainder: i % 5,
      timeLower: i === 3 ? 9000 : 0,
      timeUpper: i === 3 ? 9001 : 100,
    }));
    const res = handleSolve({ packets, modulus: 5, countLower: 0, countUpper: 200, minInterval: 1, maxInterval: 20 });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(res.error.evidence).toBeTruthy();
    expect(['seed', 'extension']).toContain((res.error.evidence as { stage: string }).stage);
  });

  it('ignores download order: shuffling input packets yields the same solution', () => {
    const shuffled = {
      ...sampleRequest,
      packets: [...sampleRequest.packets].reverse(),
    };
    const a = handleSolve(sampleRequest);
    const b = handleSolve(shuffled);
    expect(a).toEqual(b);
  });
});
