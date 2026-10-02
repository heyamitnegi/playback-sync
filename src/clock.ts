import type { ClockEstimate, ClockRoundTrip, HeldEstimate } from './types';

/**
 * Working out what the server's clock reads, from a round trip against it —
 * pure functions, no fetch, no timers, no `Date.now()`. The caller measures the
 * four timestamps and passes them in, which is what makes "a client on a 400ms
 * link and a client on a 20ms link agree on the group's position" a unit test
 * rather than something only two physical devices could show.
 *
 * ── Why the obvious formula is not good enough ────────────────────────────
 *
 * The obvious estimate is `serverTime - localTimeWhenTheResponseArrived`. It is
 * wrong by construction, always in the same direction, and by an amount that
 * differs per client:
 *
 *   The server stamps its clock at some instant. The response then has to be
 *   finished, serialised, pushed across the network and parsed before the
 *   client can read that stamp. By the time it does, the server's clock has
 *   moved on by all of that — so the client concludes the server is EARLIER
 *   than it really is, and therefore that less time has elapsed since the
 *   cycle's `startAtMs` than really has. It plays that far BEHIND the group.
 *
 * The error is the one-way delay, so the client with the slowest link lags the
 * most and the client with the fastest link runs ahead of it. This shows up in
 * the field as "the TVs are perfectly in sync but the laptop is milliseconds
 * ahead" — a TV on wifi parsing JSON on a slow CPU against a laptop on the same
 * LAN. Nothing is treating the platforms differently; the measurement is.
 *
 * ── The four-timestamp form ───────────────────────────────────────────────
 *
 * This is NTP's clock-filter arithmetic, which exists for exactly this problem.
 * Both ends stamp both edges:
 *
 *   T0  client sends            (client clock)
 *   T1  server receives         (server clock)
 *   T2  server answers          (server clock)
 *   T3  client has the answer   (client clock)
 *
 *   offset    = ((T1 - T0) + (T2 - T3)) / 2
 *   roundTrip = (T3 - T0) - (T2 - T1)
 *
 * `T2 - T1` is the server's own processing time, and subtracting it is the
 * whole point of carrying both: it takes the server's work OUT of the
 * measurement instead of charging it to the network. That matters when the
 * endpoint you measure against is authenticated or the server is not idle — a
 * request that spent 40ms inside the server would otherwise be indexed as a
 * 40ms-worse link.
 *
 * What survives is the assumption that the two network legs are symmetric. It
 * is never exactly true, and the residual error is half the asymmetry — tens of
 * ms on a bad link rather than the hundreds the naive formula gives away, and
 * it no longer scales with distance from the server. {@link shouldAdopt} is the
 * second half of the answer: prefer the fastest round trip seen, since a fast
 * round trip has less room to hide asymmetry in.
 */

/**
 * Defaults tuned for commercial display hardware on ordinary networks. Every
 * one is overridable, because they encode assumptions about a fleet — a
 * satellite link or a high-grade oscillator wants different numbers.
 */
export interface ClockOptions {
  /**
   * A round trip past which a measurement is not trusted. Well beyond any real
   * link, including a device on saturated wifi; past this the symmetry
   * assumption has enough room in it to be worse than the estimate already held
   * (and on a first sample, worse than nothing).
   */
  maxUsableRoundTripMs?: number;
  /**
   * How long a held estimate stays authoritative purely on having been the
   * fastest. Past this it is replaced by any usable sample, however slow.
   *
   * Without an expiry the fastest sample of the day wins the day, and the local
   * oscillator's drift accumulates underneath it unmeasured. Five minutes of
   * drift on cheap hardware is single-digit ms; five hours is not.
   */
  preferFreshAfterMs?: number;
  /**
   * A disagreement big enough to be a clock STEP rather than noise, adopted
   * immediately whatever its round trip.
   *
   * The thing being caught: a client whose own clock is corrected while it is
   * running (NTP landing after a cold boot, which is the normal state of a TV
   * for the first minute or two, and routine on Android). Every reading it
   * takes afterwards moves by the step, so holding the pre-step offset because
   * it was measured on a faster link would keep the client exactly one step out
   * for as long as the expiry above. Size it well above any plausible asymmetry
   * so ordinary jitter can never trip it.
   */
  stepMs?: number;
}

export const DEFAULT_CLOCK_OPTIONS: Required<ClockOptions> = {
  maxUsableRoundTripMs: 4000,
  preferFreshAfterMs: 5 * 60_000,
  stepMs: 1000,
};

/**
 * The offset implied by one round trip, or `null` when the measurement is not
 * usable.
 *
 * Refused rather than clamped, deliberately: a bad measurement adopted puts a
 * whole group confidently in the wrong place, while a bad measurement dropped
 * costs one sample out of one a minute.
 */
export function estimateClockOffset(
  rt: ClockRoundTrip,
  options: ClockOptions = {},
): ClockEstimate | null {
  const maxUsableRoundTripMs =
    options.maxUsableRoundTripMs ?? DEFAULT_CLOCK_OPTIONS.maxUsableRoundTripMs;
  const { requestedAtMs, serverReceivedAtMs, serverSentAtMs, receivedAtMs } = rt;
  if (
    !Number.isFinite(requestedAtMs) ||
    !Number.isFinite(serverReceivedAtMs) ||
    !Number.isFinite(serverSentAtMs) ||
    !Number.isFinite(receivedAtMs)
  ) {
    return null;
  }

  const roundTripMs = receivedAtMs - requestedAtMs - (serverSentAtMs - serverReceivedAtMs);
  // A negative round trip is not a slow link, it is a contradiction: either
  // clock moved during the measurement (an NTP step landing mid-request is the
  // realistic way), or the server's two stamps are the wrong way round. Either
  // way the arithmetic below means nothing.
  if (roundTripMs < 0) return null;
  if (roundTripMs > maxUsableRoundTripMs) return null;

  return {
    offsetMs: (serverReceivedAtMs - requestedAtMs + (serverSentAtMs - receivedAtMs)) / 2,
    roundTripMs,
  };
}

/**
 * Whether a fresh measurement should replace the one being used.
 *
 * NTP's rule, and for its reason: between two measurements of the same clock,
 * the one with the shorter round trip is the more trustworthy, because the
 * error left in {@link estimateClockOffset} is the asymmetry between the two
 * legs and a short round trip cannot hide much of it. Averaging samples instead
 * would fold every slow one back in.
 */
export function shouldAdopt(
  current: HeldEstimate | null,
  next: ClockEstimate,
  nowMs: number,
  options: ClockOptions = {},
): boolean {
  const stepMs = options.stepMs ?? DEFAULT_CLOCK_OPTIONS.stepMs;
  const preferFreshAfterMs =
    options.preferFreshAfterMs ?? DEFAULT_CLOCK_OPTIONS.preferFreshAfterMs;

  if (current === null) return true;
  // Cheaper measurement — strictly better information.
  if (next.roundTripMs <= current.roundTripMs) return true;
  // The local clock has been moved under us; see `stepMs`.
  if (Math.abs(next.offsetMs - current.offsetMs) > stepMs) return true;
  // Nothing faster has come along in a long time; stop trusting an old reading
  // over a present one.
  return nowMs - current.takenAtMs > preferFreshAfterMs;
}
