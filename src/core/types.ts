/**
 * Domain types for the buoy telemetry recovery problem.
 *
 * Each observed packet carries:
 *  - a unique caller-assigned id (download order is meaningless)
 *  - a counter remainder modulo `modulus` (the rotation/wrap counter)
 *  - an integer closed time interval [timeLower, timeUpper] during which
 *    the packet was actually transmitted
 *
 * The service jointly assigns every packet:
 *  - a distinct absolute counter, congruent to its remainder modulo modulus,
 *    inside the absolute-count search window
 *  - an integer transmit timestamp inside its closed interval
 * such that for every pair of adjacent observed packets (in recovered order),
 * the observed time difference lies inside the sampling window implied by
 * their counter difference.
 */

export interface PacketInput {
  /** Caller-assigned unique packet identifier (string or number). */
  id: string | number;
  /** Observed counter remainder r, required: 0 <= r < modulus. */
  remainder: number;
  /** Inclusive integer lower bound of the transmit time interval. */
  timeLower: number;
  /** Inclusive integer upper bound of the transmit time interval. */
  timeUpper: number;
}

export interface TempoSwitchInput {
  /**
   * First absolute counter sampled under the NEW tempo. A unit step from
   * count c to c + 1 uses the old interval when c + 1 < firstNewCount and
   * the new interval from c + 1 >= firstNewCount onward. In other words the
   * step arriving at this counter is the first new-tempo beat.
   */
  firstNewCount: number;
  /** New sampling-interval lower bound (inclusive), positive integer. */
  newMinInterval: number;
  /** New sampling-interval upper bound (inclusive), >= newMinInterval. */
  newMaxInterval: number;
}

export interface SolveRequest {
  packets: PacketInput[];
  /** Counter modulus M (rotation period), integer >= 2. */
  modulus: number;
  /** Inclusive absolute-counter search window lower bound. */
  countLower: number;
  /** Inclusive absolute-counter search window upper bound. */
  countUpper: number;
  /** Minimum interval (inclusive) between adjacent samples (old tempo). */
  minInterval: number;
  /** Maximum interval (inclusive) between adjacent samples (old tempo). */
  maxInterval: number;
  /**
   * Optional in-voyage sampling-tempo switch. When omitted the request, the
   * three-stage adjudication and the response behave exactly as before.
   */
  tempoSwitch?: TempoSwitchInput;
}

/** Per-adjacent-pair constraint check evidence. */
export interface AdjacencyEvidence {
  /** Position in the recovered order, 0-based (evidence[i] joins slot i -> i+1). */
  index: number;
  fromId: string | number;
  toId: string | number;
  fromCount: number;
  toCount: number;
  /** toCount - fromCount (always >= 1; observed packets are distinct). */
  countGap: number;
  /** Unit steps under the old tempo: fromCount .. min(toCount, switchCount). */
  oldSteps: number;
  /** Unit steps under the new tempo; 0 when the edge precedes the switch. */
  newSteps: number;
  /** Absolute count at which the new tempo starts (first new beat). */
  tempoSwitchAt: number | null;
  fromTime: number;
  toTime: number;
  /** toTime - fromTime (always positive for a consistent solution). */
  timeGap: number;
  /** Inclusive feasible time-difference range for this counter gap. */
  allowedTimeGap: { min: number; max: number };
  /** Number of unobserved absolute counters strictly between the pair. */
  missingBetween: number;
  /** Congruence note for the destination packet. */
  congruence: { remainder: number; modulus: number };
  /** toCount mod modulus equals the destination packet's remainder. */
  absoluteCountCongruent: boolean;
  /** Closed-interval containment for the chosen timestamps. */
  timeWithinInterval: {
    from: { lower: number; upper: number };
    to: { lower: number; upper: number };
  };
  satisfied: boolean;
}

export interface MissingSegment {
  /** Inclusive first missing absolute counter. */
  fromCount: number;
  /** Inclusive last missing absolute counter. */
  toCount: number;
  /** Number of counters in the segment (toCount - fromCount + 1). */
  length: number;
}

export interface AssignedPacket {
  /** 0-based position in the recovered transmission order. */
  position: number;
  id: string | number;
  absoluteCount: number;
  time: number;
  remainder: number;
  timeInterval: { lower: number; upper: number };
}

export interface SolveResult {
  order: (string | number)[];
  assignments: AssignedPacket[];
  /** Absolute counters inside [firstCount, lastCount] not assigned to a packet. */
  missingSegments: MissingSegment[];
  missingCountTotal: number;
  adjacency: AdjacencyEvidence[];
  /** Counts of the first/last observed packets. */
  observedCountRange: { first: number; last: number };
}

/** Stable business error codes. */
export type SolveErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_CONSISTENT_INTERPRETATION';

export interface ConstraintFailureEvidence {
  /** Recovery stage at which extension failed. */
  stage: 'seed' | 'extension';
  /** Number of packets already fixed in the partial order (0 for seed failure). */
  partialLength: number;
  /** Packet ids already fixed, in partial order. */
  partialOrder: (string | number)[];
  /** The packet that could not be appended / could not be seeded. */
  candidateId: string | number;
  /**
   * Human-readable, stable description of the first constraint that could
   * not be extended.
   */
  reason: string;
  /**
   * Numeric detail:
   *  - for 'extension' adjacency failures: the count gap that was rejected,
   *  - absent when no admissible candidate count exists at all.
   */
  detail?: {
    /** Which constraint class prevents the extension. */
    cause: 'TIME_GAP' | 'COUNT_WINDOW' | 'CONGRUENCE';
    /** Smallest congruent counter gap considered. */
    minimalCongruentGap?: number;
    countGap?: number;
    requiredTimeGap?: { min: number; max: number };
    actualTimeGapRange?: { min: number; max: number };
    /** Residual gap range allowed by the absolute-count search window. */
    countGapWindow?: { min: number; max: number };
    /**
     * Absolute-count range scanned for the blocked successor, after applying
     * the count window and remaining slots. Present so engineers can see
     * which counters were tested.
     */
    absoluteCountRange?: {
      min: number;
      max: number;
      /** Congruence residue each candidate absolute count must match. */
      remainder: number;
      modulus: number;
    };
    /**
     * Tempo decomposition of the blocked edge. Without a switch oldSteps is
     * the whole gap and newSteps is 0; a spanning edge shows both. Lets the
     * engineer distinguish a missing-packet conflict from a tempo-switch
     * conflict.
     */
    tempoBreakdown?: {
      tempoSwitchAt: number | null;
      oldSteps: number;
      newSteps: number;
      oldInterval: { min: number; max: number };
      newInterval: { min: number; max: number };
      /** Synthesized allowed time-difference range for this split. */
      allowedTimeGap: { min: number; max: number };
      /** Possible start (from-) counts of the blocked edge given the state. */
      fromCount: { min: number; max: number };
      /** Concrete representative start count used for the split, when known. */
      representativeFromCount?: number;
    };
  };
}

export class SolveError extends Error {
  readonly code: SolveErrorCode;
  readonly evidence?: ConstraintFailureEvidence;

  constructor(code: SolveErrorCode, message: string, evidence?: ConstraintFailureEvidence) {
    super(message);
    this.name = 'SolveError';
    this.code = code;
    this.evidence = evidence;
  }
}
