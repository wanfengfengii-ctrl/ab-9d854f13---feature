import { describe, expect, it } from 'vitest';
import { validateRequest } from '../src/core/validation.js';
import { SolveError } from '../src/core/types.js';
import { sampleRequest } from './fixtures/sample.js';

const valid = (): typeof sampleRequest => JSON.parse(JSON.stringify(sampleRequest));

describe('validateRequest', () => {
  it('accepts the canonical sample', () => {
    expect(() => validateRequest(valid())).not.toThrow();
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['missing modulus', { ...valid(), modulus: undefined }],
    ['non-integer interval', { ...valid(), minInterval: 1.5 }],
  ])('rejects %s', (_label, body) => {
    expect(() => validateRequest(body)).toThrow(SolveError);
  });

  it('rejects modulus below 2', () => {
    const b = valid();
    b.modulus = 1;
    try {
      validateRequest(b);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SolveError).code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects inverted count window', () => {
    const b = valid();
    b.countLower = 100;
    b.countUpper = 0;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects negative or inverted sample interval', () => {
    const b1 = valid();
    b1.minInterval = 0;
    expect(() => validateRequest(b1)).toThrow(SolveError);
    const b2 = valid();
    b2.maxInterval = 1;
    b2.minInterval = 5;
    expect(() => validateRequest(b2)).toThrow(SolveError);
  });

  it('rejects packet counts outside 6..14', () => {
    const b = valid();
    b.packets = b.packets.slice(0, 5);
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects duplicate packet ids', () => {
    const b = valid();
    b.packets[1] = { ...b.packets[0] };
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects remainder outside [0, modulus)', () => {
    const b = valid();
    b.packets[0].remainder = 10;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects inverted time intervals', () => {
    const b = valid();
    b.packets[0].timeLower = 100;
    b.packets[0].timeUpper = 0;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects excessively large count search windows', () => {
    const b = valid();
    b.countUpper = b.countLower + 2_000_000;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  describe('beatSwitch', () => {
    const withBeat = (beat: unknown) => ({ ...valid(), beatSwitch: beat });

    it('accepts a well-formed beat switch', () => {
      const r = validateRequest(withBeat({ firstNewBeatCount: 20, newMinInterval: 19, newMaxInterval: 21 }));
      expect(r.beatSwitch).toEqual({ firstNewBeatCount: 20, newMinInterval: 19, newMaxInterval: 21 });
    });

    it('leaves beatSwitch undefined when omitted (backwards compatible)', () => {
      expect(validateRequest(valid()).beatSwitch).toBeUndefined();
    });

    it.each([
      ['not an object', []],
      ['null is treated as absent', null],
    ])('handles beatSwitch %s', (label, value) => {
      if (label === 'null is treated as absent') {
        expect(validateRequest(withBeat(value)).beatSwitch).toBeUndefined();
      } else {
        expect(() => validateRequest(withBeat(value))).toThrow(SolveError);
      }
    });

    it.each([
      ['non-integer first count', { firstNewBeatCount: 2.5, newMinInterval: 1, newMaxInterval: 2 }],
      ['missing new bounds', { firstNewBeatCount: 20 }],
      ['zero new minimum', { firstNewBeatCount: 20, newMinInterval: 0, newMaxInterval: 2 }],
      ['inverted new interval', { firstNewBeatCount: 20, newMinInterval: 9, newMaxInterval: 3 }],
    ])('rejects %s with INVALID_REQUEST', (_label, beat) => {
      try {
        validateRequest(withBeat(beat));
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as SolveError).code).toBe('INVALID_REQUEST');
      }
    });

    it('rejects a new interval exceeding the precision guard', () => {
      expect(() =>
        validateRequest(withBeat({ firstNewBeatCount: 20, newMinInterval: 1, newMaxInterval: 2_000_000 })),
      ).toThrow(SolveError);
    });
  });
});
