import { resolveCyclePosition } from './cycle';
import type { Positioned, SyncPlan } from './types';

/**
 * The cycle expressed in the terms an ORDINARY renderer already works in — a
 * sequence to step through, a cursor, a cap, a seek — so that one renderer can
 * drive both synchronised and independent playback instead of two renderers
 * drifting apart.
 *
 * Pure: no timers, no `Date.now()`, no DOM. The caller reads the clock and
 * passes it in, which is what makes "a client joining an hour late lands where
 * the group is" a unit test rather than something only two devices could show.
 *
 * ── Why this shape, and not a boundary per position ───────────────────────
 *
 * The first design gave the clock every position boundary: each position was a
 * hand-over, re-derived from `startAtMs` and a modulo. That is exact, and on
 * real hardware it is unwatchable. A hand-over between two HLS videos rebuilds
 * the decoder — an MSE SourceBuffer, a whole pipeline — and on a single-decoder
 * panel the incoming one takes the video plane away from the clip still on
 * screen, which then has nothing to present. It shows as a black screen between
 * every video item and again at the end of every lap.
 *
 * Independent playback never has that hand-over: consecutive clips are joined
 * into ONE stream, so clip→clip inside a run rebuilds nothing. The fix is
 * therefore not a better hand-over but FEWER of them — join the run here too,
 * and let the clock SUPERVISE the stream instead of driving it:
 *
 * - The cursor and the cap still come from the clock, so a run starts and ends
 *   on the group's instants.
 * - Inside a run, the transitions come from the stream. A decoder plays at 1x by
 *   its own media clock, so those land where the schedule says they should;
 *   {@link syncAlignment} is what catches the case where they do not.
 *
 * The trade, stated plainly: alignment inside a run is as good as the stream's
 * own timing plus a correction threshold, where before it was re-derived at
 * every boundary. In exchange there is no rebuild, and therefore nothing black.
 */

/**
 * One entry per authored position — this client's item there, or `null` for a
 * gap it must hold blank through.
 *
 * A gap is a first-class entry rather than an omission, for the same reason
 * every client gets the whole slot list: a client that did not know the position
 * existed would slide its next item forward and drift off the group. It also
 * breaks a run, which is correct — a stream cannot span a hole.
 */
export type SyncSequence<T extends Positioned> = Array<T | null>;

export function syncSequence<T extends Positioned>(
  plan: SyncPlan,
  items: readonly T[],
): SyncSequence<T> {
  return plan.slots.map((slot) => items.find((item) => item.orderIndex === slot.index) ?? null);
}

/** Where the group is, as a cursor into {@link syncSequence}. */
export interface SyncCursor {
  /** Index into the sequence — the position, not an index into your items. */
  index: number;
  /** How far into that position the group already is. */
  elapsedInPositionMs: number;
  /** Which lap of the cycle this is; part of a position's identity so a
   * one-position cycle still restarts rather than looking unchanged. */
  cycleCount: number;
  /** Absolute (server-clock) instant this position began. */
  startedAtMs: number;
  /** How far into the whole cycle the group is — the alignment target for a run
   * that spans the entire cycle, and the number to compare between two clients. */
  elapsedInCycleMs: number;
}

export type SyncPhase =
  /** Before this client's join instant (see {@link syncJoinAtMs}): hold, and
   * prime `firstIndex`, the position it joins on — an index into the sequence,
   * like the running cursor's. */
  | { phase: 'waiting'; startsInMs: number; firstIndex: number }
  | { phase: 'running'; cursor: SyncCursor };

/**
 * Where the group is now, for a client that joins it at `joinAtMs` — the plan's
 * own instant unless the caller says otherwise. `null` for a degenerate plan —
 * fall back to independent playback rather than divide by it.
 */
export function syncPhaseAt(
  plan: SyncPlan,
  nowServerMs: number,
  joinAtMs: number = plan.startAtMs,
): SyncPhase | null {
  const holding = nowServerMs < joinAtMs;
  // While holding, the position that matters is the one this client joins on,
  // resolved at the join instant itself, where it is at its very start.
  const resolved = resolveCyclePosition(plan, holding ? joinAtMs : nowServerMs);
  if (!resolved) return null;
  if (resolved.phase === 'waiting') {
    // Only for a join instant before the plan's own, which syncJoinAtMs never
    // returns: the plan's first position, from the top.
    return { phase: 'waiting', startsInMs: resolved.startsInMs, firstIndex: 0 };
  }
  const at = plan.slots.findIndex((slot) => slot.index === resolved.position.index);
  // `findIndex` cannot miss — resolveCyclePosition returns a slot from this same
  // list — but a defensive 0 beats an out-of-range cursor reaching a renderer.
  const index = at < 0 ? 0 : at;
  if (holding) return { phase: 'waiting', startsInMs: joinAtMs - nowServerMs, firstIndex: index };
  return {
    phase: 'running',
    cursor: {
      index,
      elapsedInPositionMs: resolved.position.elapsedInPositionMs,
      cycleCount: resolved.position.cycleCount,
      startedAtMs: nowServerMs - resolved.position.elapsedInPositionMs,
      elapsedInCycleMs: resolved.position.elapsedInCycleMs,
    },
  };
}

/**
 * How late a client may be to a lap and still join THAT lap at position 0,
 * seeking the little it missed, instead of holding for the next position.
 *
 * The group's own first lap after a publish is the case this is for: every
 * client is meant to start on position 0 together, and one that misses the
 * instant by a few seconds — a slow link, a cold cache — would otherwise sit out
 * the whole first item. Inside the grace, joining the lap in progress costs it
 * nothing: it seeks the seconds it missed and lands where every client that made
 * the instant already is.
 *
 * Position 0 only. Anywhere else the client holds for the next position and
 * starts that from its head (see {@link syncJoinAtMs}).
 *
 * Sized to cover a push and a fetch (sub-second on a realtime path, seconds on a
 * slow link) plus the server's own start lead, and no more.
 */
export const SYNC_JOIN_GRACE_MS = 20_000;

/**
 * The instant this client joins its group: when it first puts content up,
 * holding a "synchronising" notice until then.
 *
 * Always a position boundary on the GROUP'S OWN grid (`startAtMs + n × cycle + a
 * position's offset`), because every other client crosses that same instant —
 * they all resolve the same schedule and do the same arithmetic — so the group
 * changes together from this client's very first frame. And a boundary rather
 * than wherever the modulo lands, so the client starts its first item from the
 * head, primed during the hold, instead of seeking into the middle of a clip on
 * a device whose seeks land late.
 *
 * Which boundary:
 * - Holding the plan before it starts (inside the server's lead): the plan's own
 *   instant, position 0, with the rest of the group.
 * - Within {@link SYNC_JOIN_GRACE_MS} of a lap's start: that lap, straight away.
 * - Otherwise, the next position. A client back from a power cut while the group
 *   is on item 3 holds for item 4 and joins there; one arriving during the last
 *   item holds for the next lap's first.
 *
 * It used to hold for the next LAP, so that every client started from position
 * 0. A cycle is the sum of every position, though, so a client rebooting
 * mid-playlist sat blank for up to the whole playlist while its neighbours
 * played on. Joining at the next item instead bounds the wait to one item.
 */
export function syncJoinAtMs(plan: SyncPlan, nowServerMs: number): number {
  const cycleMs = Math.round(plan.cycleSeconds * 1000);
  if (cycleMs <= 0 || plan.slots.length === 0) return plan.startAtMs;
  const sinceStart = nowServerMs - plan.startAtMs;
  if (sinceStart <= 0) return plan.startAtMs;

  const lapStartMs = plan.startAtMs + Math.floor(sinceStart / cycleMs) * cycleMs;
  const intoLapMs = nowServerMs - lapStartMs;
  // Capped at position 0's own duration: past that the top of the lap is
  // genuinely over, and joining it would put this client on position 1 while
  // calling it position 0.
  const graceMs = Math.min(SYNC_JOIN_GRACE_MS, Math.round(plan.slots[0].durationSeconds * 1000));
  if (intoLapMs <= graceMs) return lapStartMs;
  for (const slot of plan.slots) {
    const offsetMs = Math.round(slot.startOffsetSeconds * 1000);
    if (offsetMs >= intoLapMs) return lapStartMs + offsetMs;
  }
  return lapStartMs + cycleMs;
}

/**
 * How far past the latest instant a join could fall on this clock one may be
 * before {@link syncJoinOutOfReach} calls it stale. Room for the clock's own
 * re-measures, which move it by tens of ms; anything they cause is harmless.
 */
const SYNC_JOIN_REACH_SLACK_MS = 1000;

/**
 * Whether `joinAtMs` is further ahead than any join decided at `nowServerMs`
 * could be: later than both the plan's own instant and a whole cycle from now.
 * Every join {@link syncJoinAtMs} returns is one of those two, so this means the
 * clock it was decided on has since been corrected backwards — and the client
 * would otherwise hold for as long as that correction was.
 *
 * Seen in the field after a power cut: a device's join was decided on a reading
 * 28 years fast, and the measured clock that replaced it seconds later changed
 * nothing, because a join is decided once. It held "starting in 895248963s".
 * Deciding again on the better clock is always safe: it is the same rule, and
 * lands on the same grid.
 */
export function syncJoinOutOfReach(
  plan: SyncPlan,
  joinAtMs: number,
  nowServerMs: number,
): boolean {
  const cycleMs = Math.round(plan.cycleSeconds * 1000);
  return joinAtMs > Math.max(plan.startAtMs, nowServerMs + cycleMs) + SYNC_JOIN_REACH_SLACK_MS;
}

/** A span of consecutive positions played from one joined stream. Wraps at the
 * end of the cycle. */
export interface SyncRun {
  start: number;
  length: number;
}

/**
 * When the run holding the cursor hands over, as an absolute server-clock
 * instant: the moment the clock reaches the first position after the run.
 *
 * The cap your renderer arms, and the reason a joined run does not cost the
 * clock anything at the run's edges: however the stream chooses to move between
 * its own clips, the run as a whole still ends when the schedule says.
 *
 * Counted from where the RUN began, not from the cursor. The clock walks through
 * a joined run's positions while the stream plays them, and a client joining the
 * group can enter a run part-way; counting the run's whole length from the
 * cursor puts the end one position late for every position in.
 */
export function syncRunEndsAtMs(plan: SyncPlan, cursor: SyncCursor, run: SyncRun): number {
  const n = plan.slots.length;
  const offsetMs = (i: number) => Math.round(plan.slots[i].startOffsetSeconds * 1000);
  const at = Math.min(Math.max(cursor.index, 0), n - 1);
  const intoRun = (at - run.start + n) % n;
  // Positions still to play, this one included. At least one, so a cursor the
  // run does not hold still gets its own position's end.
  const left = Math.max(1, Math.min(run.length, n) - intoRun);
  const cycleStartMs = cursor.startedAtMs - offsetMs(at);
  const after = at + left;
  return (
    cycleStartMs +
    Math.floor(after / n) * Math.round(plan.cycleSeconds * 1000) +
    offsetMs(after % n)
  );
}

/**
 * Where a joined run should be RIGHT NOW, in the run's OWN stream-local seconds
 * — the target the clock holds the stream to.
 *
 * Stream-local because that is the only coordinate a joined run has: its clips
 * are concatenated, so the position `k` entries into the run begins at the sum
 * of the durations before it. Hand this to whatever applies your seeks; it
 * should seek only once the stream has genuinely drifted from it (see
 * `drift.ts`).
 *
 * `periodSeconds` is set only for a run that spans the whole cycle. That run is
 * built as a long LOOP of the cycle, so the same group position recurs every
 * `periodSeconds` of stream — the pipeline picks whichever repetition it is
 * currently nearest instead of being dragged back to the first one.
 *
 * `null` when the group is past the run's end: the cap is about to fire, and
 * seeking a stream on its way out would flush a pipeline for a frame nobody
 * sees.
 */
export function syncAlignment(
  plan: SyncPlan,
  cursor: SyncCursor,
  run: SyncRun | null,
  nowServerMs: number,
): { seconds: number; periodSeconds?: number } | null {
  if (!run) return null;
  const msOf = (seconds: number) => Math.round(seconds * 1000);
  const cycleMs = msOf(plan.cycleSeconds);
  // A run covering every position IS the cycle, and loops with it.
  if (run.length >= plan.slots.length) {
    return { seconds: cursor.elapsedInCycleMs / 1000, periodSeconds: cycleMs / 1000 };
  }
  const n = plan.slots.length;
  const at = Math.min(Math.max(cursor.index, 0), n - 1);
  const start = Math.min(Math.max(run.start, 0), n - 1);
  // The instant the run's first position began, from the cursor's own position —
  // both are offsets inside the same cycle. In this lap, unless the run spans the
  // cycle's end and the clock is already past it: then it began in the lap
  // before, and this lap's instant is still to come.
  const cycleStartMs = cursor.startedAtMs - msOf(plan.slots[at].startOffsetSeconds);
  const runStartMs =
    cycleStartMs + msOf(plan.slots[start].startOffsetSeconds) - (start > at ? cycleMs : 0);
  const intoRunMs = nowServerMs - runStartMs;
  if (intoRunMs < 0) return null;
  let spanMs = 0;
  for (let k = 0; k < Math.min(run.length, n); k += 1) {
    spanMs += msOf(plan.slots[(start + k) % n].durationSeconds);
  }
  if (intoRunMs >= Math.min(spanMs, cycleMs)) return null;
  return { seconds: intoRunMs / 1000 };
}

/**
 * How far a running stream is from the group, in seconds — positive ahead — and
 * the stream-local second it would have to seek to.
 *
 * `alignToSeconds` has to be where the group is at the instant `currentTime` was
 * read. Computing it on a render tick and comparing it after the render lands
 * biases every reading by the render time, which on a TV is tens of ms: ask for
 * it at the moment you read the stream.
 *
 * With `periodSeconds` (a run looping the whole cycle) the target is whichever
 * repetition of the group's position the stream is nearest.
 */
export function syncStreamDrift(input: {
  currentTimeSeconds: number;
  alignToSeconds: number;
  periodSeconds?: number;
}): { driftSeconds: number; targetSeconds: number } {
  const { currentTimeSeconds, alignToSeconds, periodSeconds } = input;
  const targetSeconds =
    periodSeconds && periodSeconds > 0
      ? alignToSeconds +
        Math.round((currentTimeSeconds - alignToSeconds) / periodSeconds) * periodSeconds
      : alignToSeconds;
  return { driftSeconds: currentTimeSeconds - targetSeconds, targetSeconds };
}

/**
 * Whether the group's current position is still inside the run the active layer
 * is already playing.
 *
 * The granularity everything above turns on. A joined run plays SEVERAL
 * positions from one stream, so the clock moving from one of them to the next is
 * not a hand-over — the stream already has it, and tearing the pipeline down to
 * "advance" to content it is currently playing is exactly the rebuild that
 * black-flashes the panel. What the clock still owns is when the run as a whole
 * gives way, and (through {@link syncAlignment}) where inside it the stream
 * should be.
 */
export function syncCursorInRun(
  sequenceLength: number,
  run: SyncRun | null,
  index: number,
): boolean {
  if (!run || sequenceLength <= 0) return false;
  for (let k = 0; k < run.length; k += 1) {
    if ((run.start + k) % sequenceLength === index) return true;
  }
  return false;
}
