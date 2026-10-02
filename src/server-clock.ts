import { DEFAULT_CLOCK_OPTIONS, estimateClockOffset, shouldAdopt } from './clock';
import type { ClockOptions } from './clock';
import type { ClockRoundTrip, EventSink, HeldEstimate } from './types';

/**
 * A monotonic millisecond reading — elapsed time, with no relation to any
 * calendar.
 *
 * `performance.now()` where it exists (browsers, Chromium on Tizen, Android
 * WebView, Node ≥ 16), `Date.now()` where it somehow does not — which degrades
 * {@link ServerClock} to the naive behaviour rather than breaking it.
 */
export function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface ServerClockOptions extends ClockOptions {
  /**
   * How far the client's own calendar may disagree with where the monotonic
   * base says it should be before the held estimate is treated as stale.
   *
   * The two are read from different places (a monotonic counter vs the
   * calendar) so they drift apart by the local oscillator's error, which is
   * single-digit ms over a sampling interval. A jump of a second is not drift,
   * and it has two causes this class cannot tell apart:
   *
   * - The local clock was SET (NTP landing after a cold boot). `nowMs()`
   *   deliberately does not follow it — that is the whole point of the
   *   monotonic base — and the next measurement's offset moves by the step,
   *   which `shouldAdopt` already adopts on sight.
   * - The device SLEPT. On Linux the monotonic counter does not advance through
   *   a suspend, so after a wake `nowMs()` is behind by however long the device
   *   was down. The calendar is right this time, so the next measurement's
   *   offset is unchanged, `shouldAdopt` sees nothing to adopt, and the estimate
   *   stays wrong until it ages out.
   *
   * Either way the held estimate can no longer be trusted, so crossing this
   * makes the next usable measurement authoritative whatever its round trip.
   */
  clockStepNoticeMs?: number;
  /** Override the monotonic source. Injectable for tests and for platforms with
   * a better one than `performance.now()`. */
  monotonicNowMs?: () => number;
  /** Override the calendar source. Injectable for tests. */
  wallNowMs?: () => number;
  /** Optional diagnostics. No-op by default. */
  onEvent?: EventSink;
}

/**
 * The group's clock, as opposed to this client's — one instance per app, fed by
 * every round trip you make against your server and read by anything that has
 * to agree with another client about what time it is.
 *
 * Unattended hardware's own clock is routinely minutes wrong and no two devices
 * are wrong by the same amount, so `Date.now()` is never the question; "what
 * does the group's clock read" is.
 *
 * ── Why the estimate advances on a monotonic counter ──────────────────────
 *
 * The obvious implementation holds an offset and returns `Date.now() + offset`.
 * That reintroduces, between measurements, the exact problem the measurement
 * solves: `Date.now()` is the calendar, and the calendar gets SET. A TV that
 * boots with a wrong clock and picks up NTP a minute later, or an Android box
 * correcting itself on a schedule, moves `Date.now()` under a running cycle —
 * and every reading after the step is out by the step until the next sample
 * happens to land. Across a group that is one client jumping position
 * mid-cycle while its neighbours hold.
 *
 * So an adopted measurement is pinned to a monotonic reading taken at the same
 * instant, and the estimate advances on elapsed time from there. Setting the
 * local clock then has no effect at all; the calendar is consulted only to take
 * a new measurement (`observe`, whose T0/T3 come from it and cancel out) and to
 * notice that it moved.
 *
 * The residual is the local oscillator's rate error against the server's —
 * genuine drift, single-digit ms at commodity-hardware quality over the
 * sampling interval, and corrected by the next adopted sample.
 */
export class ServerClock {
  private held: HeldEstimate | null = null;
  /** The monotonic reading `held` was pinned at. */
  private heldMonotonicMs = 0;
  /** Server time at that same instant — what the estimate counts up from. */
  private heldServerMs = 0;
  private heldSource = '';
  /** Only to notice the calendar being set; never used to advance the clock. */
  private heldWallMs = 0;
  /**
   * The next usable measurement replaces the held one whatever its round trip.
   * Set when the held estimate stops being evidence — see
   * {@link expectDiscontinuity}.
   */
  private forceNextAdoption = false;

  private readonly clockOptions: ClockOptions;
  private readonly clockStepNoticeMs: number;
  private readonly monotonic: () => number;
  private readonly wall: () => number;
  private readonly onEvent: EventSink;

  constructor(options: ServerClockOptions = {}) {
    this.clockOptions = {
      maxUsableRoundTripMs:
        options.maxUsableRoundTripMs ?? DEFAULT_CLOCK_OPTIONS.maxUsableRoundTripMs,
      preferFreshAfterMs:
        options.preferFreshAfterMs ?? DEFAULT_CLOCK_OPTIONS.preferFreshAfterMs,
      stepMs: options.stepMs ?? DEFAULT_CLOCK_OPTIONS.stepMs,
    };
    this.clockStepNoticeMs = options.clockStepNoticeMs ?? 1000;
    this.monotonic = options.monotonicNowMs ?? monotonicNowMs;
    this.wall = options.wallNowMs ?? (() => Date.now());
    this.onEvent = options.onEvent ?? (() => {});
  }

  /**
   * The server's clock, right now, as well as this client can tell.
   *
   * Falls back to this client's own calendar until the first usable measurement
   * lands — see {@link hasEstimate}, and prefer a plan-derived offset over this
   * while that is false.
   */
  nowMs(): number {
    if (this.held === null) return this.wall();
    return this.heldServerMs + (this.monotonic() - this.heldMonotonicMs);
  }

  /** False until a usable round trip has been observed. */
  hasEstimate(): boolean {
    return this.held !== null;
  }

  /**
   * File a completed round trip. Cheap and idempotent-ish: the estimate only
   * moves when the new measurement is better than the one held (see
   * `shouldAdopt`), so every caller can hand over every round trip it makes
   * without coordinating.
   */
  observe(roundTrip: ClockRoundTrip, source = 'unknown'): void {
    const next = estimateClockOffset(roundTrip, this.clockOptions);
    if (next === null) {
      this.onEvent('debug', 'unusable round trip, ignored', { source, ...roundTrip });
      return;
    }

    const nowWallMs = this.wall();
    const forced = this.forceNextAdoption;
    if (!forced && !shouldAdopt(this.held, next, nowWallMs, this.clockOptions)) return;
    this.forceNextAdoption = false;

    const previous = this.held;
    // Pinned to the instant the response resolved, which is what T3 is — so the
    // monotonic anchor is corrected for however long ago that was. Reading both
    // clocks here rather than at T3 keeps the measurement callers simple (they
    // hand over four plain timestamps) at the cost of one subtraction.
    const sinceReceivedMs = Math.max(0, nowWallMs - roundTrip.receivedAtMs);
    this.held = { ...next, takenAtMs: nowWallMs };
    this.heldMonotonicMs = this.monotonic();
    this.heldServerMs = roundTrip.receivedAtMs + next.offsetMs + sinceReceivedMs;
    this.heldSource = source;
    this.heldWallMs = nowWallMs;

    this.onEvent('debug', 'adopted', {
      source,
      offsetMs: Math.round(next.offsetMs),
      roundTripMs: Math.round(next.roundTripMs),
      // How far this measurement moved the group's clock. Large on the first
      // sample of a boot (this client's clock is simply wrong), and near zero
      // after — anything else on a running client is worth explaining, because
      // it is also how far it is about to jump.
      movedByMs: previous === null ? null : Math.round(next.offsetMs - previous.offsetMs),
      previousRoundTripMs: previous === null ? null : Math.round(previous.roundTripMs),
      // Adopted because the held estimate had stopped being evidence, not
      // because this sample was better — see expectDiscontinuity.
      forced,
    });
  }

  /**
   * Stop trusting the held estimate over whatever is measured next: the next
   * usable round trip is adopted even if it is slower. Later ones are ranked
   * against it by the normal rule, so a burst still ends on its fastest sample.
   *
   * For the moments something may have happened to this client's clocks that no
   * measurement ranking can see — a wake from standby, a network coming back
   * after long enough that drift built up unmeasured, a detected jump. The held
   * estimate keeps serving `nowMs()` until the replacement lands, because a
   * slightly stale answer beats none.
   */
  expectDiscontinuity(): void {
    this.forceNextAdoption = true;
  }

  /**
   * Whether the calendar and the monotonic counter have come apart since the
   * last check, as the size of the jump in ms, or `null` if they have not.
   *
   * Meant to be polled: it is the one wake detector that needs no platform
   * event, which matters because whether `visibilitychange` ever reaches code
   * running inside a TV's embedded browser is a firmware property. A detected
   * jump also marks the estimate for replacement
   * ({@link expectDiscontinuity}); getting a measurement to replace it with is
   * the caller's job.
   */
  checkForClockJump(): number | null {
    return this.takeStep();
  }

  /** See {@link checkForClockJump} and `clockStepNoticeMs`. */
  private takeStep(): number | null {
    if (this.held === null) return null;
    const nowWallMs = this.wall();
    // Where the calendar has got to versus where the monotonic base says it
    // should be.
    const wallDriftMs = nowWallMs - this.heldWallMs - (this.monotonic() - this.heldMonotonicMs);
    if (Math.abs(wallDriftMs) <= this.clockStepNoticeMs) return null;
    this.onEvent('warn', 'calendar and monotonic clock came apart (clock set, or device slept)', {
      stepMs: Math.round(wallDriftMs),
      source: this.heldSource,
    });
    // Re-based so one jump is reported once, not on every check after it.
    this.heldWallMs = nowWallMs - (this.monotonic() - this.heldMonotonicMs);
    this.forceNextAdoption = true;
    return wallDriftMs;
  }

  /**
   * What the current estimate is and how much to believe it — for a debug log
   * or an on-screen overlay. `null` before the first measurement.
   *
   * The only way to check alignment on actual hardware: `offsetMs +
   * roundTripMs` read off two clients in one group bounds how far apart they
   * can be.
   */
  estimate(): { offsetMs: number; roundTripMs: number; ageMs: number; source: string } | null {
    if (this.held === null) return null;
    const nowWallMs = this.wall();
    this.takeStep();
    return {
      offsetMs: this.held.offsetMs,
      roundTripMs: this.held.roundTripMs,
      ageMs: nowWallMs - this.held.takenAtMs,
      source: this.heldSource,
    };
  }
}
