import { validateRequest } from '../core/validation.js';
import { solve } from '../core/solver.js';
import { SolveError } from '../core/types.js';
import type { SolveResult } from '../core/types.js';

export interface ApiResponse {
  status: 'ok';
  data: SolveResult;
}

export interface ApiError {
  status: 'error';
  error: {
    code: string;
    message: string;
    evidence?: unknown;
  };
}

/**
 * Pure request handler so it can be exercised directly by unit tests without
 * spinning up the HTTP server.
 */
export function handleSolve(rawBody: unknown): ApiResponse | ApiError {
  try {
    const req = validateRequest(rawBody);
    const result = solve(
      req.packets,
      req.modulus,
      req.countLower,
      req.countUpper,
      req.minInterval,
      req.maxInterval,
    );
    return { status: 'ok', data: result };
  } catch (err) {
    if (err instanceof SolveError) {
      return {
        status: 'error',
        error: { code: err.code, message: err.message, evidence: err.evidence },
      };
    }
    throw err;
  }
}
