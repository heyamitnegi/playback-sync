import { jitteredDelay, jitteredInterval } from './jitter';
import { monotonicNowMs as defaultMonotonicNowMs } from './server-clock';
import type { ServerClock } from './server-clock';
import type { ClockRoundTrip, EventSink } from './types';

/**
 * Keeps a {@link ServerClock}'s estimate fresh, by timing cheap round trips
 * against your server on a schedule.
 *
 * Split from the clock itself because they fail differently: the estimate has to
 * keep working (on whatever it last measured) while the sampling is failing, and
 * a client that cannot reach the server for an hour must not stop playing — it
 * must keep playing on a known-stale clock and say so.
 *
 * Nothing here is on the critical path. If it never runs at all, a client falls
 * back to the offset carried in the plan itself (`clockOffsetFromPlan`) and is
 * correct to within one fetch's network delay — which is the error this removes.
 *
 * You supply `measure`: it does whatever HTTP your app does and returns the four
 * timestamps. This class decides *when*.
 *
 * ```ts
 * const clock = new ServerClock();
 * const sync = new ClockSync({
 *   clock,
 *   measure: async () => {
 *     const requestedAtMs = Date.now();
 *     const r = await fetch('/time').then((r) => r.json());
 *     return {
 *       requestedAtMs,
 *       serverReceivedAtMs: r.serverReceivedAtMs,
 *       serverSentAtMs: r.serverSentAtMs,
 *       receivedAtMs: Date.now(),
 *     };
 *   },
 * });
 * sync.start();
 *
 * // and wherever your app learns something happened:
 * window.addEventListener('online', () => sync.remeasure('network-online'));
 * document.addEventListener('visibilitychange', () => {
 *   if (!document.hidden) sync.remeasure('page-visible');
 * });
 * ```
 */
export interface ClockSyncOptions {
  /** The clock this loop keeps fresh. */
  clock: ServerClock;
  /**
   * One measurement. Do your request, return the four timestamps.
   *
   * Return `null` when there is nothing to measure against right now (not
   * signed in yet, no endpoint configured) — that is not a failure and does not
   * trigger the backoff — and does not spend a sample of the startup burst,
   * because a client that is about to sign in needs those samples at the
   * moment it does. **Throw** when the request genuinely failed; see
   * {@link ClockSyncOptions.isUnsupported} for how a failure is classified.
   */
  measure: () => Promise<ClockRoundTrip | null>;
  /**
   * Routine cadence. One small request a minute against an endpoint that should
   * touch no database.
   *
   * Sized against drift rather than against the network: what happens between
   * samples is the local oscillator running fast or slow relative to the
   * server's, which on commodity hardware is single-digit ms a minute. A longer
   * interval lets that accumulate into the misalignment the library exists to
   * remove; a shorter one buys nothing measurable.
   */
  sampleIntervalMs?: number;
  /**
   * Samples taken back-to-back at startup, and the gap between them.
   *
   * A single measurement can be unlucky — one retransmit, one garbage-collection
   * pause, one burst of contention on a TV's wifi — and until a second arrives
   * there is no way to tell an unlucky sample from a slow link. Three closely
   * spaced samples means the fastest of three decides where this client sits for
   * its first minute, which is the minute it is most likely to be watched.
   */
  startupBurst?: number;
  startupBurstGapMs?: number;
  /**
   * How long after `start()` this client's OWN clock is still treated as
   * unsettled, and every fresh sample is allowed to replace the held estimate.
   *
   * The boot estimate is the most protected and the least trustworthy. A sample
   * taken seconds after start can have an excellent round trip and still be
   * stale minutes later, because what moved was not the network — it was this
   * device's calendar. A TV or an embedded board corrects its clock by NTP
   * shortly after boot, and when it does so by SLEWING rather than stepping,
   * {@link ServerClock.checkForClockJump} never fires: there is no discontinuity
   * to catch, only a held offset quietly going wrong by however far the clock
   * was walked.
   *
   * Measured on a four-display group. Two devices restarted from the remote;
   * their offsets moved by 894ms and 554ms across the reboot while their
   * untouched neighbours moved by 29ms and 17ms. Round trips throughout were
   * 60–83ms, which bounds the error from network asymmetry at about ±40ms — two
   * orders off what was seen, so the network cannot explain it. The estimates
   * then sat frozen for 397s, because `shouldAdopt` keeps the fastest round trip
   * it has seen and the drift was just under the step threshold, so nothing
   * could displace them. The group came back only when the staleness window
   * finally expired, six minutes later.
   *
   * So for this window the newest reading wins outright rather than the fastest.
   * While the calendar is still being walked, recency beats round trip: a
   * slightly noisier sample taken now describes the clock the client is actually
   * playing on, and the pristine one from boot does not.
   *
   * Set to 0 to switch it off.
   */
  settleWindowMs?: number;
  /**
   * Sampling cadence inside {@link ClockSyncOptions.settleWindowMs}. A dozen
   * extra requests per boot buys recovery in seconds instead of minutes.
   */
  settleSampleMs?: number;
  /**
   * Retry cadence while this client has NEVER successfully measured the clock.
   *
   * A panel is not on the network the instant the process starts: the link
   * takes a few seconds to come up. If the first sample lands in that window it
   * fails, and the long {@link ClockSyncOptions.backoffMs} — written for a
   * server with no time endpoint — catches a device that is merely still
   * booting.
   *
   * What that costs is not a missing measurement, it is a WRONG one that
   * nothing can see. The client joins its group on the coarse single-stamp
   * estimate from the plan (see `clockOffsetFromPlan`), and because the join and
   * the drift check both read that same clock, it reports itself healthy —
   * ~20ms drift — while being visibly out of step on the glass. It stays that
   * way until the backoff expires.
   *
   * Measured on a display that restarted at 10:13: the first sample failed, the
   * held offset sat frozen at exactly -475ms for ten minutes reporting -17 to
   * -27ms of drift, then jumped +505ms the moment the backoff ended and the
   * display snapped into sync on its own. A restart whose first sample happened
   * to succeed came back in sync immediately — which is why it only went wrong
   * "sometimes".
   *
   * So before the first success, retry in seconds. The burst is kept rather
   * than discarded: the point of those samples is to settle the clock at boot,
   * and boot is exactly when this is failing.
   */
  bootRetryMs?: number;
  /**
   * How long the fast retry above keeps going before giving up and falling back
   * to {@link ClockSyncOptions.backoffMs}.
   *
   * Bounds the cost for the case the backoff was written for: a server with no
   * time endpoint answers 404 rather than failing, so with
   * {@link ClockSyncOptions.isUnsupported} it is recognised immediately and
   * never reaches the fast path at all. This window is for the failure that
   * cannot be told apart from a slow boot — a link that never comes up — and it
   * caps that at a few dozen extra requests per boot, once.
   */
  bootRetryWindowMs?: number;
  /**
   * Whether a thrown measurement failure means the server has no time endpoint
   * and never will until it is upgraded, as opposed to a link that is not up
   * YET.
   *
   * They are not the same failure and they do not want the same answer. An
   * unsupported endpoint wants the long {@link ClockSyncOptions.backoffMs}
   * immediately; a link still coming up wants {@link ClockSyncOptions.bootRetryMs}.
   * Only the caller can tell them apart, because only the caller sees the
   * status — typically `status === 404 || status === 501`.
   *
   * Defaults to never: every failure gets the fast boot retry first, which is
   * the safe way round. A client that mis-reports a real outage as unsupported
   * would sit on a stale clock for the whole backoff.
   */
  isUnsupported?: (err: unknown) => boolean;
  /**
   * How long to stand down after a failure, instead of the routine cadence.
   *
   * The realistic failure is a server that has no time endpoint and answers 404
   * forever. Backing off keeps that case from spending a request a minute for
   * the life of the device, while still recovering on its own once the server is
   * upgraded — no reboot, no site visit.
   */
  backoffMs?: number;
  /**
   * The spread before a triggered re-measure starts.
   *
   * Small on purpose. The client is running on a clock it has just stopped
   * trusting, so every second of delay is a second out of step. The spread only
   * has to stop a fleet that wakes on one schedule from arriving in the same
   * instant.
   */
  remeasureJitterMs?: number;
  /**
   * How long after a burst lands a further trigger is treated as the same event
   * rather than a new one.
   *
   * One wake typically fires several signals within seconds: the page becoming
   * visible, the socket reconnecting, the first request getting through, and the
   * clock-jump check. Each is a good reason to measure; all of them together are
   * one reason, and without this a single wake costs several bursts.
   */
  remeasureCoalesceMs?: number;
  /**
   * How often the calendar and the monotonic counter are compared for a jump. A
   * clock-free comparison, so the cost is nothing; the interval is simply how
   * late a wake can be noticed when no platform event reported it.
   */
  jumpCheckMs?: number;
  /** ±spread applied to the routine interval and the backoff. */
  jitterSpread?: number;
  /** Told about every re-measure that actually starts a burst (not the ones
   * folded into another) — for your own diagnostics. */
  onRemeasure?: (reason: string) => void;
  /** Optional diagnostics. No-op by default. */
  onEvent?: EventSink;
  /** Injectable for tests. */
  random?: () => number;
  /** Injectable for tests. */
  monotonicNowMs?: () => number;
}

const DEFAULTS = {
  sampleIntervalMs: 60_000,
  startupBurst: 3,
  startupBurstGapMs: 700,
  backoffMs: 10 * 60_000,
  remeasureJitterMs: 2_000,
  remeasureCoalesceMs: 15_000,
  jumpCheckMs: 5_000,
  settleWindowMs: 120_000,
  settleSampleMs: 10_000,
  bootRetryMs: 3_000,
  bootRetryWindowMs: 120_000,
};

/**
 * How one sample ended, as the scheduler needs to read it.
 *
 * Deliberately not one failure. 'unsupported' is a server that has no time
 * endpoint and never will until it is upgraded, which is what the long backoff
 * is for. 'failed' is a link that is not up YET, which at boot is seconds away
 * — telling them apart is the whole of {@link ClockSyncOptions.bootRetryMs}.
 * 'skipped' never reached the network at all.
 */
type SampleOutcome = 'ok' | 'skipped' | 'failed' | 'unsupported';

export class ClockSync {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private jumpCheck: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private burstLeft = 0;
  /**
   * Bumped whenever the schedule is restarted. A sample already on the network
   * when that happens still files its measurement, but must not reschedule: the
   * restarted chain owns the timer now, and a second chain would double the
   * request rate for the life of the process.
   */
  private generation = 0;
  /**
   * Monotonic reading when the last burst landed in full, or `null` when there
   * is no such burst to lean on (none yet, one in progress, or a sample has
   * failed since). What the coalescing window is measured from.
   */
  private lastBurstLandedAtMs: number | null = null;
  /**
   * Monotonic instant after which this client's clock is treated as settled.
   * `null` before `start()`. See {@link ClockSyncOptions.settleWindowMs}.
   */
  private settledAtMs: number | null = null;
  /**
   * Whether a measurement has EVER landed on this client. Until one has, a
   * failure is read as "still booting" rather than "no endpoint", and is
   * retried in seconds. See {@link ClockSyncOptions.bootRetryMs}.
   */
  private everMeasured = false;
  /**
   * Monotonic instant the fast boot retry stops being used, whether or not it
   * has succeeded. `null` before `start()`.
   */
  private bootRetryUntilMs: number | null = null;
  /** Failed samples on this boot before the first success, so the window can be
   * reported once when it opens and once when it closes rather than on every
   * attempt. */
  private bootRetries = 0;

  private readonly o: Required<Omit<ClockSyncOptions, 'onRemeasure'>> &
    Pick<ClockSyncOptions, 'onRemeasure'>;

  constructor(options: ClockSyncOptions) {
    // Field by field rather than a spread over the defaults: a caller forwarding
    // its own optional config (`{ ...opts, monotonicNowMs: maybeUndefined }`)
    // would otherwise overwrite a default with `undefined` and blow up later, at
    // the first timer rather than here.
    this.o = {
      clock: options.clock,
      measure: options.measure,
      sampleIntervalMs: options.sampleIntervalMs ?? DEFAULTS.sampleIntervalMs,
      startupBurst: options.startupBurst ?? DEFAULTS.startupBurst,
      startupBurstGapMs: options.startupBurstGapMs ?? DEFAULTS.startupBurstGapMs,
      backoffMs: options.backoffMs ?? DEFAULTS.backoffMs,
      remeasureJitterMs: options.remeasureJitterMs ?? DEFAULTS.remeasureJitterMs,
      remeasureCoalesceMs: options.remeasureCoalesceMs ?? DEFAULTS.remeasureCoalesceMs,
      jumpCheckMs: options.jumpCheckMs ?? DEFAULTS.jumpCheckMs,
      settleWindowMs: options.settleWindowMs ?? DEFAULTS.settleWindowMs,
      settleSampleMs: options.settleSampleMs ?? DEFAULTS.settleSampleMs,
      bootRetryMs: options.bootRetryMs ?? DEFAULTS.bootRetryMs,
      bootRetryWindowMs: options.bootRetryWindowMs ?? DEFAULTS.bootRetryWindowMs,
      isUnsupported: options.isUnsupported ?? (() => false),
      jitterSpread: options.jitterSpread ?? 0.2,
      random: options.random ?? Math.random,
      monotonicNowMs: options.monotonicNowMs ?? defaultMonotonicNowMs,
      onEvent: options.onEvent ?? (() => {}),
      onRemeasure: options.onRemeasure,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.burstLeft = this.o.startupBurst;
    const startedAtMs = this.o.monotonicNowMs();
    this.settledAtMs = startedAtMs + this.o.settleWindowMs;
    this.bootRetryUntilMs = startedAtMs + this.o.bootRetryWindowMs;
    // Immediately, not after an interval: the first cycle a client resolves runs
    // on whatever the clock knows at that moment, and waiting a minute to find
    // out means the first minute runs on the fallback estimate.
    this.scheduleNext(0);
    // `setInterval` is fine here, unlike the sampling chain: the check is
    // synchronous and cannot pile up.
    this.jumpCheck = setInterval(() => {
      // Never coalesced: a detected jump is direct evidence the estimate is
      // wrong, and the monotonic reading the coalescing window is measured on is
      // the very thing a suspend stops.
      if (this.o.clock.checkForClockJump() !== null) {
        this.remeasure('clock-jump', { coalesce: false });
      }
    }, this.o.jumpCheckMs);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
    if (this.jumpCheck !== null) {
      clearInterval(this.jumpCheck);
      this.jumpCheck = null;
    }
  }

  /**
   * Measure again now, as a fresh burst, instead of waiting out the routine
   * interval — or the backoff, which is where a client sits after its network
   * went down and is the reason this exists: without it a client coming back
   * from an outage keeps its pre-outage clock for the whole backoff.
   *
   * The burst's first usable sample replaces the held estimate whatever its
   * round trip; the rest are ranked normally. Triggers arriving while a burst is
   * queued or running, or within `remeasureCoalesceMs` of one landing, are the
   * same event and are folded into it — pass `{ coalesce: false }` for a trigger
   * that is itself evidence the clock is wrong.
   */
  remeasure(reason: string, opts: { coalesce?: boolean } = {}): void {
    if (this.stopped) return;
    const coalesce = opts.coalesce ?? true;

    if (this.burstLeft > 0) {
      // The burst already coming will answer this; make sure it is believed.
      this.o.clock.expectDiscontinuity();
      this.o.onEvent('debug', 're-measure folded into the burst in progress', { reason });
      return;
    }
    if (
      coalesce &&
      this.lastBurstLandedAtMs !== null &&
      this.o.monotonicNowMs() - this.lastBurstLandedAtMs < this.o.remeasureCoalesceMs
    ) {
      this.o.onEvent('debug', 're-measure skipped, the clock was just measured', { reason });
      return;
    }

    this.o.clock.expectDiscontinuity();
    this.burstLeft = this.o.startupBurst;
    this.lastBurstLandedAtMs = null;
    const delayMs = jitteredDelay(this.o.remeasureJitterMs, this.o.random);
    this.o.onEvent('debug', 're-measuring the clock', { reason, delayMs });
    this.o.onRemeasure?.(reason);
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
    this.generation += 1;
    this.scheduleNext(delayMs);
  }

  /**
   * Self-rescheduling rather than `setInterval`: a request can take a long time
   * to settle, and `setInterval` would pile up concurrent in-flight samples for
   * as long as the link is bad — each one measuring a queue rather than the
   * network.
   */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const generation = this.generation;
    this.handle = setTimeout(() => {
      this.handle = null;
      const done = (outcome: SampleOutcome): void => {
        // Restarted (or stopped) while this sample was on the network.
        if (generation !== this.generation) return;

        if (outcome === 'skipped') {
          // Nothing was measured and nothing failed — there was nothing to
          // measure against. Keep the burst: spending it on requests that never
          // left would leave a client with nothing to settle its clock with at
          // the moment it signs in. Come back on the cadence this client would
          // be using anyway, NOT the burst gap — "nothing to measure against"
          // is a state a device can sit in for days, and a 700ms loop over
          // local storage is a loop, not a measurement.
          this.scheduleNext(
            this.settling()
              ? this.o.settleSampleMs
              : jitteredInterval(this.o.sampleIntervalMs, this.o.jitterSpread, this.o.random),
          );
          return;
        }

        if (outcome !== 'ok') {
          this.lastBurstLandedAtMs = null;
          // Still coming up: the link is not ready, not the endpoint missing.
          // Keep the burst and come back in seconds — joining the group on the
          // coarse plan clock is the failure being prevented.
          if (outcome === 'failed' && this.retryingAtBoot()) {
            this.scheduleNext(jitteredInterval(this.o.bootRetryMs, this.o.jitterSpread, this.o.random));
            return;
          }
          this.burstLeft = 0;
          // Jittered: without it, an outage parks the whole fleet on the same
          // timer and they all come back in the same instant — the retry storm
          // arriving exactly as the server is trying to recover.
          this.scheduleNext(jitteredInterval(this.o.backoffMs, this.o.jitterSpread, this.o.random));
          return;
        }

        if (!this.everMeasured && this.bootRetries > 0) {
          // Closes the window opened when the first boot retry was reported,
          // and is the line that makes this checkable on a device in the field:
          // how long this client went without a measured clock, which is how
          // long it could have been joined to its group on the coarse one.
          this.o.onEvent('debug', 'clock measured, this client is up', {
            attempts: this.bootRetries,
            afterMs: this.bootRetries * this.o.bootRetryMs,
          });
        }
        this.everMeasured = true;
        this.bootRetries = 0;

        if (this.burstLeft > 0) {
          this.burstLeft -= 1;
          if (this.burstLeft === 0) this.lastBurstLandedAtMs = this.o.monotonicNowMs();
        }
        // Still inside the settling window: hand the next sample the right to
        // replace whatever is held, and come back for it sooner. Only once the
        // burst is done — inside a burst the ranking is already doing the right
        // thing, and forcing every one of them would throw away the fastest of
        // the three.
        const settling = this.settling();
        if (settling && this.burstLeft === 0) this.o.clock.expectDiscontinuity();
        // The startup burst keeps its exact spacing — that gap is a measurement
        // decision (settling the clock quickly at boot), not a load-shaping one,
        // and it is over in a couple of seconds. Only the steady-state sample is
        // spread.
        this.scheduleNext(
          this.burstLeft > 0
            ? this.o.startupBurstGapMs
            : settling
              ? this.o.settleSampleMs
              : jitteredInterval(this.o.sampleIntervalMs, this.o.jitterSpread, this.o.random),
        );
      };
      void this.sample().then(done, () => done('failed'));
    }, delayMs);
  }

  /** Whether this client's own clock is still inside the settling window. */
  private settling(): boolean {
    return this.settledAtMs !== null && this.o.monotonicNowMs() < this.settledAtMs;
  }

  /** Whether a failure right now is "still booting" rather than "no endpoint". */
  private retryingAtBoot(): boolean {
    return (
      !this.everMeasured &&
      this.bootRetryUntilMs !== null &&
      this.o.monotonicNowMs() < this.bootRetryUntilMs
    );
  }

  /**
   * One measurement. Resolves to how the scheduler should treat it rather than
   * throwing, which it would have to catch there anyway.
   */
  private async sample(): Promise<SampleOutcome> {
    try {
      const rt = await this.o.measure();
      // Nothing to measure against yet. Not a failure: no backoff.
      if (rt === null) return 'skipped';
      this.o.clock.observe(rt, 'clock-sync');
      return 'ok';
    } catch (err) {
      const unsupported = this.o.isUnsupported(err);
      const retryingAtBoot = !unsupported && this.retryingAtBoot();
      const meta = {
        error: err instanceof Error ? err.message : String(err),
        nextInMs: retryingAtBoot ? this.o.bootRetryMs : this.o.backoffMs,
        everMeasured: this.everMeasured,
      };
      if (retryingAtBoot) {
        this.bootRetries += 1;
        // The FIRST one is the one worth shipping: this retries every few
        // seconds, so reporting them all would put dozens of lines per boot on
        // the wire — and a site-wide power restore would send that from every
        // device at once. One line says the window opened; the matching line
        // when it closes says how long it lasted.
        this.o.onEvent(
          'debug',
          this.bootRetries === 1
            ? 'clock sample failed, retrying while this client comes up'
            : 'clock sample failed, still coming up',
          { ...meta, attempt: this.bootRetries },
        );
      } else {
        this.o.onEvent('debug', 'clock sample failed, backing off', meta);
      }
      return unsupported ? 'unsupported' : 'failed';
    }
  }
}
