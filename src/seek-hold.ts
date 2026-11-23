/**
 * Drift correction for a device whose seeks land late — pure policy, no timers,
 * no media element. Your player applies it.
 *
 * Measured on commercial signage panels (Tizen 7): a seek issued while the
 * stream plays lands 0.36–1.1s BEHIND its target, every time, never ahead. The
 * pipeline takes most of a second to seek and the stream stands still meanwhile,
 * so the seek's own duration is lost — and it differs from seek to seek, so two
 * devices started in step drift apart BECAUSE of their corrections. Consumer
 * TVs and desktops seek at once and never show it.
 *
 * So on a device seen to land late, a correction is done differently:
 *
 *   1. pause, and seek AHEAD of the group by `leadMs` — more than the seek takes;
 *   2. once it has landed, read where it actually is (paused, the reading is
 *      stable), which is some distance ahead of the group;
 *   3. hold that frame until the group's clock reaches it, then play —
 *      `playDelayMs` early, because a paused pipeline takes a moment to start.
 *
 * The seek's duration no longer matters, only how precisely `play()` starts —
 * which on these panels is consistent (two devices started together play in
 * step; only their seeks scatter). Both figures are learned per device from
 * what each hold actually did, and are worth persisting across restarts.
 *
 * The cost is a held frame of about {@link HOLD_MARGIN_MS} (bounded by
 * {@link HOLD_MAX_MS}) instead of a visible jump that lands somewhere wrong —
 * and on a healthy stream a correction is needed once after start, not every
 * minute.
 */

export interface SeekProfile {
  /** A plain seek has been seen to land late here: correct by holding. */
  holdMode: boolean;
  /** How far ahead of the group to seek, so the seek lands ahead of it. */
  leadMs: number;
  /** How long this device takes from `play()` to a moving picture. */
  playDelayMs: number;
}

export const DEFAULT_SEEK_PROFILE: SeekProfile = {
  holdMode: false,
  leadMs: 1500,
  playDelayMs: 0,
};

/**
 * Held beyond the seek's own duration. The seeks measured varied by ~0.7s, so a
 * lead that only just covered the last one would land behind the next; this
 * much spare lands ahead nearly every time, and it is also roughly how long the
 * frame is held.
 */
export const HOLD_MARGIN_MS = 500;

/** The range a learned lead is kept in. */
export const LEAD_MIN_MS = 300;
export const LEAD_MAX_MS = 3000;

/**
 * Longest a frame is ever held. A landing further ahead than this (a decoder
 * that snaps to a far keyframe) plays on instead, and is judged a miss — a
 * multi-second freeze on one display of a group is worse than the drift.
 */
export const HOLD_MAX_MS = 2500;

export const PLAY_DELAY_MAX_MS = 1000;

/**
 * A plain seek that settled this far behind is the late-landing case, not a
 * keyframe snap or a stall: beyond it the drift has some other cause, and
 * holding would not fix it.
 */
export const LATE_LANDING_MAX_MS = 3000;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * A plain seek settled `driftAfterMs` off the group (negative = behind).
 * Returns the profile to correct with from now on: hold mode once a seek has
 * landed late, with a first lead covering how late it was.
 */
export function afterPlainSeekMissed(
  profile: SeekProfile,
  driftAfterMs: number,
  toleranceMs: number,
): SeekProfile {
  if (profile.holdMode) return profile;
  const lateByMs = -driftAfterMs;
  if (lateByMs <= toleranceMs || lateByMs > LATE_LANDING_MAX_MS) return profile;
  return {
    ...profile,
    holdMode: true,
    leadMs: clamp(Math.max(profile.leadMs, lateByMs + HOLD_MARGIN_MS), LEAD_MIN_MS, LEAD_MAX_MS),
  };
}

/**
 * Consecutive missed holds, with the lead already at {@link LEAD_MAX_MS},
 * before the learned profile is thrown away and relearned from the default.
 *
 * Three rather than one: a single miss is ordinary (a rebuffer, a stray
 * keyframe) and the lead is supposed to absorb it. Three in a row with the lead
 * already as large as it may ever be is not noise — it is the device saying
 * this profile cannot land, however much lead it is given.
 */
export const PINNED_MISS_LIMIT = 3;

/**
 * Escape from a lead that has ratcheted to its ceiling and cannot come back.
 *
 * {@link learnLead} only decays when `wanted <= profile.leadMs`. Once a device's
 * seeks genuinely cost more than {@link LEAD_MAX_MS}, `wanted` is larger on
 * EVERY reading, so the rising branch is taken every time and the falling one
 * becomes unreachable. The lead pins at the ceiling permanently — and if you
 * persist the profile (which is the point of learning it), it survives reloads
 * and power cuts too.
 *
 * It is worse than a stuck number. A larger lead seeks further ahead, which on
 * a keyframe-bound stream lands on a worse keyframe, which reads as a slower
 * seek, which asks for a larger lead. The learner feeds its own failure.
 *
 * Measured on a four-display group: every device pinned at `leadMs: 3000` with
 * nothing held — holds landing BEHIND the group and playing on immediately —
 * and drift p95 ≈ 3000 ms on all four. Clearing the stored profile by hand put
 * two of them back to a p95 of 60–95 ms needing no corrections at all, which is
 * what this does automatically.
 *
 * Resets the learned pair but KEEPS `holdMode`: the device does still need
 * holds (the two that recovered use them), it needed different numbers.
 *
 * It is not a cure for a device whose seeks are genuinely that slow — two of
 * the four re-pinned within four minutes of a clear. It makes a pinned profile
 * impossible to get permanently stuck in.
 */
export function afterPinnedMisses(profile: SeekProfile, consecutiveMisses: number): SeekProfile {
  if (!profile.holdMode) return profile;
  if (profile.leadMs < LEAD_MAX_MS) return profile;
  if (consecutiveMisses < PINNED_MISS_LIMIT) return profile;
  return {
    ...profile,
    leadMs: DEFAULT_SEEK_PROFILE.leadMs,
    playDelayMs: DEFAULT_SEEK_PROFILE.playDelayMs,
  };
}

/**
 * A hold seek, issued `leadUsedMs` ahead of the group, landed `aheadMs` ahead
 * of it (negative = behind). The lead that would have landed exactly on target
 * was `leadUsedMs - aheadMs`; the next lead covers that plus the margin.
 *
 * Rises at once and falls slowly: one slow seek raises the lead immediately
 * (the next would otherwise land behind), while one quick seek only nudges it
 * down (the one after may be slow again).
 *
 * Note what this CANNOT do on its own: come back down once `wanted` is pinned
 * above the clamp. See {@link afterPinnedMisses}, which is the way out.
 */
export function learnLead(profile: SeekProfile, leadUsedMs: number, aheadMs: number): SeekProfile {
  if (!Number.isFinite(aheadMs)) return profile;
  const wanted = leadUsedMs - aheadMs + HOLD_MARGIN_MS;
  const leadMs = wanted > profile.leadMs ? wanted : profile.leadMs * 0.8 + wanted * 0.2;
  return { ...profile, leadMs: Math.round(clamp(leadMs, LEAD_MIN_MS, LEAD_MAX_MS)) };
}

/**
 * The stream was `residualMs` off the group once it had been playing a moment
 * after a hold (positive = ahead). Behind means `play()` took longer to start
 * than allowed for: allow more next time. Half of each error is taken, so one
 * noisy reading cannot swing it.
 */
export function learnPlayDelay(profile: SeekProfile, residualMs: number): SeekProfile {
  if (!Number.isFinite(residualMs) || Math.abs(residualMs) > PLAY_DELAY_MAX_MS) return profile;
  const playDelayMs = clamp(profile.playDelayMs - residualMs * 0.5, 0, PLAY_DELAY_MAX_MS);
  return { ...profile, playDelayMs: Math.round(playDelayMs) };
}

export type HoldPlan =
  /** Hold the frame this long, then play. */
  | { kind: 'hold'; waitMs: number }
  /** Landed behind (or too close to allow for starting): play now. */
  | { kind: 'behind' }
  /** Landed further ahead than a frame may be held: play now. */
  | { kind: 'too-far' };

/** What to do with a hold seek that landed `aheadMs` ahead of the group. */
export function planHold(aheadMs: number, playDelayMs: number): HoldPlan {
  const waitMs = aheadMs - playDelayMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) return { kind: 'behind' };
  if (waitMs > HOLD_MAX_MS) return { kind: 'too-far' };
  return { kind: 'hold', waitMs };
}

/** Only the fields and ranges above, whatever was stored. For reading a profile
 * back out of local storage, where anything could be. */
export function readSeekProfile(raw: unknown): SeekProfile {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SEEK_PROFILE;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
  return {
    holdMode: r.holdMode === true,
    leadMs: num(r.leadMs, DEFAULT_SEEK_PROFILE.leadMs, LEAD_MIN_MS, LEAD_MAX_MS),
    playDelayMs: num(r.playDelayMs, DEFAULT_SEEK_PROFILE.playDelayMs, 0, PLAY_DELAY_MAX_MS),
  };
}
