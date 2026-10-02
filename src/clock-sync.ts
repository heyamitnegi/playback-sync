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
   * trigger the backoff. **Throw** when the request genuinely failed.
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
};

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
      const done = (failed: boolean): void => {
        // Restarted (or stopped) while this sample was on the network.
        if (generation !== this.generation) return;
        if (failed) {
          this.burstLeft = 0;
          this.lastBurstLandedAtMs = null;
          // Jittered: without it, an outage parks the whole fleet on the same
          // timer and they all come back in the same instant — the retry storm
          // arriving exactly as the server is trying to recover.
          this.scheduleNext(jitteredInterval(this.o.backoffMs, this.o.jitterSpread, this.o.random));
          return;
        }
        if (this.burstLeft > 0) {
          this.burstLeft -= 1;
          if (this.burstLeft === 0) this.lastBurstLandedAtMs = this.o.monotonicNowMs();
        }
        // The startup burst keeps its exact spacing — that gap is a measurement
        // decision (settling the clock quickly at boot), not a load-shaping one,
        // and it is over in a couple of seconds. Only the steady-state sample is
        // spread.
        this.scheduleNext(
          this.burstLeft > 0
            ? this.o.startupBurstGapMs
            : jitteredInterval(this.o.sampleIntervalMs, this.o.jitterSpread, this.o.random),
        );
      };
      void this.sample().then(done, () => done(true));
    }, delayMs);
  }

  /**
   * One measurement. Resolves to `true` when it failed — the caller only needs
   * to know whether to back off.
   */
  private async sample(): Promise<boolean> {
    try {
      const rt = await this.o.measure();
      // Nothing to measure against yet. Not a failure: no backoff.
      if (rt === null) return false;
      this.o.clock.observe(rt, 'clock-sync');
      return false;
    } catch (err) {
      this.o.onEvent('debug', 'clock sample failed, backing off', {
        error: err instanceof Error ? err.message : String(err),
        backoffMs: this.o.backoffMs,
      });
      return true;
    }
  }
}
