/**
 * playback-sync — lockstep playback across many clients, from an absolute
 * instant and a measured clock.
 *
 * The whole library is pure functions plus one small stateful clock. Nothing
 * here touches the network, a timer, the DOM or a media element: you measure,
 * you decide, you apply. That is what makes "two clients whose clocks are 45
 * seconds apart agree on the position" a unit test.
 */

export type {
  ClockEstimate,
  ClockRoundTrip,
  EventSink,
  HeldEstimate,
  Positioned,
  SyncPlan,
  SyncPlanSpec,
  SyncSlot,
} from './types';

export { DEFAULT_CLOCK_OPTIONS, estimateClockOffset, shouldAdopt } from './clock';
export type { ClockOptions } from './clock';

export { ServerClock, monotonicNowMs } from './server-clock';
export type { ServerClockOptions } from './server-clock';

export { ClockSync } from './clock-sync';
export type { ClockSyncOptions } from './clock-sync';

export { DEFAULT_SPREAD, jitteredDelay, jitteredInterval } from './jitter';

export {
  clockOffsetFromPlan,
  itemAt,
  nextPositionIndex,
  receivePlan,
  resolveCyclePosition,
  serverNowFromPlan,
} from './cycle';
export type { CyclePosition, CycleResolution } from './cycle';

export {
  BOUNDARY_SEEK_MAX_MS,
  BOUNDARY_WAIT_MAX_MS,
  DEFAULT_SYNC_TUNING,
  DRIFT_WINDOW_SAMPLES,
  SYNC_TUNING_LIMITS,
  decideDriftCorrection,
  resolveSyncTuning,
  steadyDriftMs,
} from './drift';
export type { DriftCorrection, SyncTuning, SyncTuningSource } from './drift';

export {
  DEFAULT_SEEK_PROFILE,
  HOLD_MARGIN_MS,
  HOLD_MAX_MS,
  LATE_LANDING_MAX_MS,
  LEAD_MAX_MS,
  LEAD_MIN_MS,
  PLAY_DELAY_MAX_MS,
  afterPlainSeekMissed,
  learnLead,
  learnPlayDelay,
  planHold,
  readSeekProfile,
} from './seek-hold';
export type { HoldPlan, SeekProfile } from './seek-hold';

export {
  SYNC_JOIN_GRACE_MS,
  syncAlignment,
  syncCursorInRun,
  syncJoinAtMs,
  syncJoinOutOfReach,
  syncPhaseAt,
  syncRunEndsAtMs,
  syncSequence,
  syncStreamDrift,
} from './schedule';
export type { SyncCursor, SyncPhase, SyncRun, SyncSequence } from './schedule';

export { planFrom, slotsFrom } from './author';
