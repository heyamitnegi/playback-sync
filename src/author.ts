import type { SyncPlanSpec, SyncSlot } from './types';

/**
 * The server half: a cycle's positions, laid end to end — each position's start
 * inside the cycle, and the cycle's length.
 *
 * Durations are to the millisecond — a video position runs for the clip's
 * measured length, and a player that joins a cycle's videos into one looped
 * stream repeats it at exactly their sum. So the running offset is kept to the
 * millisecond too: adding floats as they come leaves binary noise
 * (25.1 + 12.433 + 20.02 + 20.02 = 77.57300000000001) in every later position
 * and in the cycle.
 *
 * `index` is each position's ordinal in the cycle, and is what a client's item
 * `orderIndex` joins to — pass durations in that order.
 */
export function slotsFrom(durations: readonly number[]): {
  slots: SyncSlot[];
  cycleSeconds: number;
} {
  let offset = 0;
  const slots = durations.map((durationSeconds, index) => {
    const startOffsetSeconds = offset;
    offset = Math.round((offset + durationSeconds) * 1000) / 1000;
    return { index, startOffsetSeconds, durationSeconds };
  });
  return { slots, cycleSeconds: offset };
}

/**
 * A plan for a group, ready to send — from the cycle's durations and the
 * instant it should start.
 *
 * Returns a {@link SyncPlanSpec}: the wire shape, holding only what the server
 * knows. A client turns it into a resolvable `SyncPlan` with `receivePlan`,
 * which stamps when it arrived.
 *
 * `startLeadSeconds` is the gap between "now" and `startAtMs`: time for every
 * client to receive the plan, fetch what it needs and have a first frame ready,
 * so the group's first frame lands together instead of trickling in. Give slow
 * links and cold caches room — it costs nothing but a short hold, and too small
 * a lead means the stragglers miss the first lap entirely.
 */
export function planFrom(input: {
  durations: readonly number[];
  serverNowMs: number;
  startLeadSeconds?: number;
  /** Override the start instant outright; otherwise `serverNowMs` + the lead. */
  startAtMs?: number;
  groupId?: string | null;
  revisionId?: string;
}): SyncPlanSpec {
  const { slots, cycleSeconds } = slotsFrom(input.durations);
  const leadSeconds = input.startLeadSeconds ?? 6;
  return {
    serverTimeMs: input.serverNowMs,
    startAtMs: input.startAtMs ?? input.serverNowMs + Math.round(leadSeconds * 1000),
    cycleSeconds,
    slots,
    groupId: input.groupId,
    revisionId: input.revisionId,
  };
}
