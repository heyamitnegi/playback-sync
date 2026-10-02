/**
 * The shared vocabulary. Everything else in this package is a pure function
 * over these shapes.
 */

/**
 * One position in a cycle. `index` is the position's ordinal — it is what your
 * own content joins to, and a position present here but absent from a client's
 * content is that client's **gap**: it holds blank for `durationSeconds`.
 *
 * Every client in a group receives the SAME slot list, describing the whole
 * cycle as authored. That is deliberate: a client with a gap still has to know
 * the position exists and how long to hold, or it slides its next item forward
 * and drifts away from the rest of the group.
 */
export interface SyncSlot {
  index: number;
  startOffsetSeconds: number;
  durationSeconds: number;
}

/**
 * Lockstep instructions for one cycle, **as the server sends them**. This is
 * what goes on the wire: every field in it is something the server knows.
 *
 * Clients agree because they all do the same arithmetic over identical inputs,
 * not because they coordinate: nothing here is negotiated, no client tells
 * another client anything, and no realtime channel is on the critical path. A
 * client that hears about a change an hour late still lands on the same
 * position, because `startAtMs` is an ABSOLUTE instant rather than a "start
 * now" signal — a broadcast arrives at each client at a different moment, which
 * would bake network jitter into the misalignment permanently.
 */
export interface SyncPlanSpec {
  /** The server's clock as the response carrying this plan was built. */
  serverTimeMs: number;
  /** The absolute instant every client aligns on. */
  startAtMs: number;
  /** Length of one lap. Must be > 0, or the plan is degenerate. */
  cycleSeconds: number;
  /** The cycle's positions, laid end to end. Must be non-empty. */
  slots: SyncSlot[];

  /** Opaque, carried through untouched. Useful for logging which group a
   * client believes it is in. */
  groupId?: string | null;
  /** Opaque, carried through untouched. Useful for noticing the plan changed. */
  revisionId?: string;
}

/**
 * A {@link SyncPlanSpec} once a client has received it, stamped with when that
 * happened. This is what the resolving functions take.
 *
 * The two extra fields are the client's own clock and the server cannot supply
 * them — which is exactly why they are a separate type rather than optional
 * fields on the wire shape. Build one with `receivePlan`.
 */
export interface SyncPlan extends SyncPlanSpec {
  /**
   * The client's own clock the moment the response resolved. The fallback clock
   * offset is only as good as this reading, so take it on the line right after
   * the response and nowhere further downstream.
   */
  receivedAtMs: number;
  /**
   * The client's own clock the moment the request went OUT.
   *
   * The pair is what makes the plan's own offset usable rather than merely
   * present: `serverTimeMs` was stamped somewhere between the two, so their
   * midpoint estimates it and `receivedAtMs` alone does not — that is late by
   * the whole one-way delay, always in the same direction, and by an amount
   * that differs per client. See `clockOffsetFromPlan`, and `clock.ts` for the
   * full four-timestamp form this is the cheap version of.
   *
   * Optional: a transport that does not stamp it still works, and degrades to
   * the uncorrected arrival reading.
   */
  requestedAtMs?: number;
}

/**
 * The minimum this package needs to know about one of your content items: which
 * position it occupies. Everything else about it is yours and is passed through
 * untouched.
 */
export interface Positioned {
  orderIndex: number;
}

/** The four timestamps of one clock measurement — see `clock.ts`. */
export interface ClockRoundTrip {
  /** T0 — this client's clock as the request went out. */
  requestedAtMs: number;
  /** T1 — the server's clock as it took the request. */
  serverReceivedAtMs: number;
  /** T2 — the server's clock as it answered. */
  serverSentAtMs: number;
  /** T3 — this client's clock as the response resolved. */
  receivedAtMs: number;
}

export interface ClockEstimate {
  /** What to add to this client's clock to get the server's. */
  offsetMs: number;
  /**
   * Network time for this measurement, with the server's own processing already
   * taken out. Not a latency stat — it is this estimate's error bar, and the
   * only thing `shouldAdopt` ranks samples by.
   */
  roundTripMs: number;
}

/** A measurement good enough to keep, with the reading it was taken at. */
export interface HeldEstimate extends ClockEstimate {
  /** This client's clock when the sample was taken; only its age is used. */
  takenAtMs: number;
}

/** Optional diagnostics sink. No-op by default — this package never logs on its
 * own, because something running unattended on a panel decides that, not us. */
export type EventSink = (
  level: 'debug' | 'warn',
  message: string,
  meta?: Record<string, unknown>,
) => void;
