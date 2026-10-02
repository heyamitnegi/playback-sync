import { DEFAULT_CLOCK_OPTIONS } from './clock';
import type { Positioned, SyncPlan, SyncPlanSpec, SyncSlot } from './types';

/**
 * The whole timing decision for a cycle, as pure functions — no timers, no
 * `Date.now()`, no DOM. The caller reads the clock and passes it in, which is
 * what makes "two clients whose clocks are 45 seconds apart agree on the
 * position" a unit test rather than something only two physical devices could
 * show.
 *
 * The one idea underneath all of it: a client NEVER derives its position by
 * accumulating item durations from where it started. It derives it from an
 * absolute instant (`plan.startAtMs`) and a modulo, every single time. Timer
 * error is one-directional and accumulates — chaining `setTimeout`s off each
 * item's duration drifts a group apart over a day, while recomputing from
 * `startAtMs` makes a late timer cost one late frame and nothing more.
 */

/**
 * Stamp a plan off the wire with when it arrived, giving the {@link SyncPlan}
 * the resolving functions take.
 *
 * ```ts
 * const requestedAtMs = Date.now();
 * const spec = await fetch('/plan').then((r) => r.json());
 * const plan = receivePlan(spec, { requestedAtMs, receivedAtMs: Date.now() });
 * ```
 *
 * Take `receivedAtMs` on the line right after the response resolves. Passing
 * `requestedAtMs` as well is worth the one extra variable: without it the
 * fallback offset is late by the whole one-way delay, always in the same
 * direction, and by an amount that differs per client — see
 * {@link clockOffsetFromPlan}.
 */
export function receivePlan(
  spec: SyncPlanSpec,
  stamps: { receivedAtMs: number; requestedAtMs?: number },
): SyncPlan {
  return { ...spec, receivedAtMs: stamps.receivedAtMs, requestedAtMs: stamps.requestedAtMs };
}

/**
 * What to add to this client's own clock to get server time, from the plan
 * alone. Unattended hardware's clock is routinely minutes wrong, and every
 * client being wrong by a *different* amount is exactly the misalignment this
 * exists to prevent — so no reading of `Date.now()` is ever trusted raw.
 *
 * This is the FALLBACK estimate, used until a {@link ServerClock} has a
 * measurement of its own (a boot's first frames, or a server with no time
 * endpoint). It is one sample, taken once per plan fetch, so it tracks a clock
 * that is *wrong* but not one that is stepped or drifting in between. Prefer
 * the measured clock wherever there is a choice; `clock.ts` says why at length.
 *
 * `serverTimeMs` was stamped somewhere between the request leaving and the
 * response arriving, so the midpoint of those two estimates it. The arrival
 * instant alone is late by the entire one-way delay, which is how a group of
 * identical clients on different links ends up spread out in time. Falls back
 * to the arrival instant when the request stamp is missing.
 *
 * Also when the two stamps cannot be one round trip — the response before the
 * request, or longer apart than any usable measurement would be. That is this
 * client's clock being SET between them. Seen in the field after a power cut
 * reset a device's clock to 1970: the request read 1970, the response read the
 * present, and their midpoint put the server 28 years ahead, so the client held
 * "starting in 895248963s" forever. The arrival instant was read on the
 * corrected clock, so it is the one to trust.
 */
export function clockOffsetFromPlan(plan: SyncPlan): number {
  const roundTripMs =
    plan.requestedAtMs === undefined ? 0 : plan.receivedAtMs - plan.requestedAtMs;
  const sentAtMs =
    roundTripMs >= 0 && roundTripMs <= DEFAULT_CLOCK_OPTIONS.maxUsableRoundTripMs
      ? (plan.requestedAtMs ?? plan.receivedAtMs)
      : plan.receivedAtMs;
  return plan.serverTimeMs - (sentAtMs + plan.receivedAtMs) / 2;
}

/** Server-clock reading for a local `Date.now()` value, via the fallback
 * estimate above. */
export function serverNowFromPlan(plan: SyncPlan, localNowMs: number): number {
  return localNowMs + clockOffsetFromPlan(plan);
}

/** Where in the cycle the group is, in server-clock terms. */
export interface CyclePosition {
  /** Position in the cycle — joins to your item's `orderIndex`. */
  index: number;
  slot: SyncSlot;
  /** How far into this position we already are — the seek target. */
  elapsedInPositionMs: number;
  /** Absolute instant (server clock) this position hands over. */
  endsAtMs: number;
  /** Diagnostic: two clients in one group should agree to a few hundred ms. */
  elapsedInCycleMs: number;
  /**
   * Which repetition of the cycle this is (0 = the first pass after
   * `startAtMs`). Part of a position's identity so a one-position cycle, or a
   * cycle that loops back to the same item, still restarts on each lap instead
   * of being mistaken for "already showing that".
   */
  cycleCount: number;
}

export type CycleResolution =
  /** Before `startAtMs`: buffer position 0 and hold, so the whole group's first
   * frame lands together rather than each client starting on arrival. */
  | { phase: 'waiting'; startsInMs: number; firstIndex: number }
  | { phase: 'running'; position: CyclePosition };

const msOf = (seconds: number): number => Math.round(seconds * 1000);

/**
 * The playhead for `plan` at **server time** `nowServerMs`.
 *
 * The caller supplies the group's clock rather than this device's, and the
 * distinction is the entire feature: two clients agree because they resolve the
 * same schedule against the same clock, so how well that clock is known is
 * exactly how well they agree. Read it from a {@link ServerClock} — which
 * measures it — and fall back to `serverNowFromPlan(plan, Date.now())` only
 * until that has a measurement.
 *
 * `null` for a degenerate plan (no positions, or a zero-length cycle) — the
 * caller must fall back to ordinary independent playback rather than divide by
 * it. Validate on the wire too; a nonsense playhead across a group is worse
 * than a group that is merely unsynchronised.
 */
export function resolveCyclePosition(plan: SyncPlan, nowServerMs: number): CycleResolution | null {
  const cycleMs = msOf(plan.cycleSeconds);
  if (plan.slots.length === 0 || cycleMs <= 0) return null;

  const now = nowServerMs;
  if (now < plan.startAtMs) {
    return {
      phase: 'waiting',
      startsInMs: plan.startAtMs - now,
      firstIndex: plan.slots[0].index,
    };
  }

  // The modulo is what makes late arrival a non-event: a client joining an hour
  // in computes the same answer as one that has been up since the start.
  const sinceStart = now - plan.startAtMs;
  const cycleCount = Math.floor(sinceStart / cycleMs);
  const cycleStartAtMs = plan.startAtMs + cycleCount * cycleMs;
  const elapsedInCycleMs = sinceStart - cycleCount * cycleMs;

  // The last position whose start offset has already passed. A plain scan —
  // `slots` is one entry per authored position, so this is a handful of
  // comparisons on hardware that would rather not run anything clever.
  let at = 0;
  for (let i = 0; i < plan.slots.length; i += 1) {
    if (msOf(plan.slots[i].startOffsetSeconds) > elapsedInCycleMs) break;
    at = i;
  }
  const slot = plan.slots[at];
  const slotStartMs = msOf(slot.startOffsetSeconds);

  return {
    phase: 'running',
    position: {
      index: slot.index,
      slot,
      elapsedInPositionMs: elapsedInCycleMs - slotStartMs,
      // Capped at the end of the cycle. Slots that tile the cycle exactly give
      // the same number — but a plan whose durations overrun would otherwise
      // hand back a boundary in the past and spin the caller's timer.
      endsAtMs: Math.min(
        cycleStartAtMs + slotStartMs + msOf(slot.durationSeconds),
        cycleStartAtMs + cycleMs,
      ),
      elapsedInCycleMs,
      cycleCount,
    },
  };
}

/**
 * This client's item at a position, or `undefined` when it has none — a gap,
 * which holds blank for the position's full duration. Sliding the next item
 * forward to fill it is precisely the drift this prevents.
 */
export function itemAt<T extends Positioned>(items: readonly T[], index: number): T | undefined {
  return items.find((item) => item.orderIndex === index);
}

/** The position after `index`, wrapping at the end of the cycle. Use it to
 * preload underneath the current position, so a boundary is a swap rather than
 * a load. */
export function nextPositionIndex(plan: SyncPlan, index: number): number {
  const at = plan.slots.findIndex((slot) => slot.index === index);
  if (plan.slots.length === 0) return index;
  const nextAt = at < 0 ? 0 : (at + 1) % plan.slots.length;
  return plan.slots[nextAt].index;
}
