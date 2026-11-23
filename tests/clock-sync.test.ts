import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockSync } from '../src/clock-sync';
import { ServerClock } from '../src/server-clock';
import type { ClockRoundTrip } from '../src/types';

/** A usable four-timestamp sample, for fixtures that only care that one landed. */
const roundTrip = (): ClockRoundTrip => ({
  requestedAtMs: 1_000,
  serverReceivedAtMs: 1_050,
  serverSentAtMs: 1_050,
  receivedAtMs: 1_100,
});

/** Let every pending microtask settle between timer steps. */
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/**
 * A loop whose timers, randomness, wall clock and monotonic reading are all
 * under the test's control, so cadence is asserted rather than waited for.
 *
 * `advance` moves all of them together, which is what actually happens: the
 * monotonic counter does not stand still while timers fire.
 */
function harness(
  over: {
    measure?: () => Promise<ClockRoundTrip | null>;
    isUnsupported?: (err: unknown) => boolean;
    settleWindowMs?: number;
  } = {},
) {
  let wallMs = 1_700_000_000_000;
  let monotonicMs = 10_000;
  const calls: number[] = [];
  const clock = new ServerClock({
    wallNowMs: () => wallMs,
    monotonicNowMs: () => monotonicMs,
  });

  const measure =
    over.measure ??
    (async () => {
      calls.push(wallMs);
      return {
        requestedAtMs: wallMs - 100,
        serverReceivedAtMs: wallMs - 50,
        serverSentAtMs: wallMs - 50,
        receivedAtMs: wallMs,
      };
    });

  const sync = new ClockSync({
    clock,
    measure,
    random: () => 0.5, // jitter sits exactly on the nominal value
    monotonicNowMs: () => monotonicMs,
    ...(over.isUnsupported ? { isUnsupported: over.isUnsupported } : {}),
    ...(over.settleWindowMs !== undefined ? { settleWindowMs: over.settleWindowMs } : {}),
  });

  return {
    sync,
    clock,
    calls,
    async advance(ms: number) {
      wallMs += ms;
      monotonicMs += ms;
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
    /** Past the coalescing window, so the next trigger is treated as new. */
    async settle() {
      await this.advance(16_000);
    },
  };
}

describe('ClockSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('measures immediately on start, not after an interval', async () => {
    // The first cycle a client resolves runs on whatever the clock knows at that
    // moment; waiting a minute means the first minute runs on the fallback.
    const h = harness();
    h.sync.start();
    await h.advance(0);
    expect(h.calls.length).toBe(1);
    expect(h.clock.hasEstimate()).toBe(true);
    h.sync.stop();
  });

  it('takes a burst of three at startup, closely spaced', async () => {
    // One sample can be unlucky — a retransmit, a GC pause. The fastest of three
    // decides where this client sits for its first minute.
    const h = harness();
    h.sync.start();
    await h.advance(0);
    expect(h.calls.length).toBe(1);
    await h.advance(700);
    expect(h.calls.length).toBe(2);
    await h.advance(700);
    expect(h.calls.length).toBe(3);
    // Then it settles to the routine cadence, not another 700ms.
    await h.advance(700);
    expect(h.calls.length).toBe(3);
    h.sync.stop();
  });

  it('samples on the settling cadence after the burst, while the clock may still be walked', async () => {
    // Inside settleWindowMs the device's own calendar may still be corrected by
    // NTP, so it comes back every 10s rather than every minute.
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    const afterBurst = h.calls.length;
    await h.advance(10_000);
    expect(h.calls.length).toBe(afterBurst + 1);
    await h.advance(10_000);
    expect(h.calls.length).toBe(afterBurst + 2);
    h.sync.stop();
  });

  it('settles into the routine interval once the settling window is over', async () => {
    const h = harness({ settleWindowMs: 0 });
    h.sync.start();
    await h.advance(1401);
    const afterBurst = h.calls.length;
    await h.advance(10_000);
    expect(h.calls.length).toBe(afterBurst); // not the settling cadence
    await h.advance(50_000);
    expect(h.calls.length).toBe(afterBurst + 1);
    await h.advance(60_000);
    expect(h.calls.length).toBe(afterBurst + 2);
    h.sync.stop();
  });

  it('backs off after a failure instead of retrying every minute', async () => {
    // The realistic failure is a server with no time endpoint answering 404
    // forever. A request a minute for the life of the device is the thing to
    // avoid; recovering on its own once the server is fixed is the thing to keep.
    let fail = true;
    const calls: number[] = [];
    const h = harness({
      // A 404 is the server saying it has no such endpoint — recognised at
      // once, so it never takes the boot retry meant for a link still coming up.
      isUnsupported: () => true,
      measure: async () => {
        calls.push(0);
        if (fail) throw new Error('404');
        return roundTrip();
      },
    });
    h.sync.start();
    await h.advance(0);
    expect(calls.length).toBe(1);

    // Not the routine minute.
    await h.advance(60_000);
    expect(calls.length).toBe(1);

    // The backoff: 10 minutes after the failure, t = 600s.
    await h.advance(540_000);
    expect(calls.length).toBe(2);

    // That one failed too, so it backed off again rather than speeding up.
    fail = false;
    await h.advance(600_000); // t = 1200s, the second backoff fires
    expect(calls.length).toBe(3);

    // And now that a sample has succeeded it is back on a routine cadence —
    // the settling window is long over by t = 1200s.
    await h.advance(60_000);
    expect(calls.length).toBe(4);
    h.sync.stop();
  });

  it('treats a null measurement as "nothing to measure yet", not a failure', async () => {
    // Not signed in yet. It must stay on a routine cadence so it picks up as
    // soon as credentials arrive — never the 10-minute backoff.
    let signedIn = false;
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        return signedIn ? roundTrip() : null;
      },
    });
    h.sync.start();
    await h.advance(0);
    expect(calls.length).toBe(1);

    // NOT the 700ms burst gap: "nothing to measure against" is a state a device
    // can sit in for days, and a 700ms loop over local storage is a loop, not a
    // measurement. The settling cadence, because this is still boot.
    await h.advance(700);
    expect(calls.length).toBe(1);
    await h.advance(9300);
    expect(calls.length).toBe(2);

    // The burst was KEPT rather than spent on requests that never left: the
    // moment there is something to measure, all three samples are still there.
    signedIn = true;
    await h.advance(10_000);
    expect(calls.length).toBe(3);
    await h.advance(700);
    expect(calls.length).toBe(4);
    await h.advance(700);
    expect(calls.length).toBe(5);
    h.sync.stop();
  });

  it('re-measures on demand rather than waiting out a backoff', async () => {
    // A client coming back from an outage would otherwise keep its pre-outage
    // clock for the whole backoff.
    let fail = false;
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        if (fail) throw new Error('offline');
        return roundTrip();
      },
    });
    // Up and measured, then the link goes down and it lands on the backoff.
    // (Before the first success a failure is a boot retry instead — see below.)
    h.sync.start();
    await h.advance(1401);
    fail = true;
    await h.advance(600_000);
    const afterOutage = calls.length;

    fail = false;
    h.sync.remeasure('network-online');
    await h.advance(1001); // the small re-measure jitter
    expect(calls.length).toBe(afterOutage + 1);
    h.sync.stop();
  });

  it('folds several triggers from one wake into a single burst', async () => {
    // A wake fires visibility, reconnect and heartbeat signals within seconds.
    // Each is a good reason to measure; all of them together are one reason.
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    await h.settle();
    const base = h.calls.length;

    h.sync.remeasure('page-visible');
    h.sync.remeasure('socket-reconnected');
    h.sync.remeasure('heartbeat-recovered');
    await h.advance(1001);
    await h.advance(700);
    await h.advance(700);
    // One burst of three, not three bursts.
    expect(h.calls.length).toBe(base + 3);
    h.sync.stop();
  });

  it('skips a trigger arriving just after a burst landed', async () => {
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    const base = h.calls.length;

    await h.advance(2000); // well inside the coalescing window
    h.sync.remeasure('page-visible');
    await h.advance(5000);
    expect(h.calls.length).toBe(base);
    h.sync.stop();
  });

  it('honours a trigger that is itself evidence the clock is wrong', async () => {
    // coalesce: false — a detected jump must never be folded away, because the
    // monotonic reading the window is measured on is what a suspend stops.
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    const base = h.calls.length;

    await h.advance(2000); // inside the window, which would skip a normal trigger
    h.sync.remeasure('clock-jump', { coalesce: false });
    await h.advance(1001);
    expect(h.calls.length).toBe(base + 1);
    h.sync.stop();
  });

  it('makes the next sample authoritative after a re-measure', async () => {
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    await h.settle();
    const spy = vi.spyOn(h.clock, 'expectDiscontinuity');
    h.sync.remeasure('network-online');
    expect(spy).toHaveBeenCalled();
    h.sync.stop();
  });

  it('re-measures by itself when the clock jumps, with no platform event', async () => {
    // The one wake detector that needs no platform event — whether
    // `visibilitychange` reaches code inside a TV's embedded browser is a
    // firmware property.
    const reasons: string[] = [];
    const h = harness();
    const sync = new ClockSync({
      clock: h.clock,
      measure: async () => roundTrip(),
      random: () => 0.5,
      onRemeasure: (r) => reasons.push(r),
    });
    vi.spyOn(h.clock, 'checkForClockJump').mockReturnValue(45_000);
    sync.start();
    // Past the startup burst first: a trigger arriving while a burst is still
    // coming is folded into it by design, and files no reason.
    await vi.advanceTimersByTimeAsync(1401);
    await flush();
    await vi.advanceTimersByTimeAsync(5001);
    await flush();
    expect(reasons).toContain('clock-jump');
    sync.stop();
  });

  it('stops cleanly and schedules nothing more', async () => {
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    const base = h.calls.length;
    h.sync.stop();
    await h.advance(10 * 60_000);
    expect(h.calls.length).toBe(base);
  });

  it('ignores a re-measure after stop', async () => {
    const h = harness();
    h.sync.start();
    await h.advance(0);
    h.sync.stop();
    const base = h.calls.length;
    h.sync.remeasure('network-online');
    await h.advance(60_000);
    expect(h.calls.length).toBe(base);
  });

  it('does not start a second chain when started twice', async () => {
    // Two chains would double the request rate for the life of the process.
    const h = harness();
    h.sync.start();
    h.sync.start();
    await h.advance(1401);
    expect(h.calls.length).toBe(3);
    h.sync.stop();
  });
  it('lets a fresh sample replace the held estimate while the clock is still settling', async () => {
    // The boot estimate is the most protected and the least trustworthy: a TV
    // that SLEWS its clock to NTP after boot fires no jump, so nothing can
    // displace a pristine boot reading. Inside the window, recency wins.
    const h = harness();
    const spy = vi.spyOn(h.clock, 'expectDiscontinuity');
    h.sync.start();

    // Not for the samples INSIDE the burst: the ranking is already doing the
    // right thing there, and forcing every one of the three would throw away
    // the fastest of them.
    await h.advance(0);
    expect(spy).not.toHaveBeenCalled();
    await h.advance(700);
    expect(spy).not.toHaveBeenCalled();

    // The burst has landed in full: the sample it arms next is the authoritative
    // one, and it stays that way for the rest of the window.
    await h.advance(700);
    expect(spy).toHaveBeenCalledTimes(1);
    await h.advance(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
    h.sync.stop();
  });

  it('stops replacing the held estimate once the settling window is over', async () => {
    const h = harness({ settleWindowMs: 0 });
    const spy = vi.spyOn(h.clock, 'expectDiscontinuity');
    h.sync.start();
    await h.advance(1401);
    await h.advance(60_000);
    await h.advance(60_000);
    expect(spy).not.toHaveBeenCalled();
    h.sync.stop();
  });

  it('retries in seconds while it has never measured, instead of standing down', async () => {
    // A panel is not on the network the instant the process starts. If the
    // first sample lands in that window, the long backoff catches a device that
    // is merely still booting — and it then plays on the coarse plan clock
    // while REPORTING itself healthy, which is the failure being prevented.
    let fail = true;
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        if (fail) throw new Error('link not up');
        return roundTrip();
      },
    });
    h.sync.start();
    await h.advance(0);
    expect(calls.length).toBe(1);

    // Seconds, not ten minutes.
    await h.advance(3000);
    expect(calls.length).toBe(2);
    await h.advance(3000);
    expect(calls.length).toBe(3);

    // The burst is kept rather than discarded: the point of those samples is to
    // settle the clock at boot, and boot is exactly when this is failing.
    fail = false;
    await h.advance(3000);
    expect(calls.length).toBe(4);
    await h.advance(700);
    expect(calls.length).toBe(5);
    h.sync.stop();
  });

  it('gives up the fast retry after the boot window and falls back to the backoff', async () => {
    // Bounds the cost for a link that never comes up: a few dozen extra
    // requests once, not one every three seconds for the life of the device.
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        throw new Error('link never came up');
      },
    });
    h.sync.start();
    await h.advance(0);

    // Stepped, not one jump: the harness moves its monotonic reading with the
    // timers, and a single 120s step would land past the window before the
    // first retry inside it had fired.
    for (let i = 0; i < 40; i += 1) await h.advance(3000);
    const duringWindow = calls.length;
    expect(duringWindow).toBeGreaterThan(30);

    // Past it: the routine minute does not bring one, the backoff does.
    await h.advance(60_000);
    expect(calls.length).toBe(duringWindow);
    await h.advance(540_000);
    expect(calls.length).toBe(duringWindow + 1);
    h.sync.stop();
  });

  it('sends an unsupported endpoint straight to the backoff, with no boot retry', async () => {
    // A server with no time endpoint answers rather than failing, so it is
    // recognised immediately and never spends the boot window on a 404.
    const calls: number[] = [];
    const h = harness({
      isUnsupported: () => true,
      measure: async () => {
        calls.push(0);
        throw new Error('404');
      },
    });
    h.sync.start();
    await h.advance(0);
    expect(calls.length).toBe(1);
    await h.advance(3000);
    expect(calls.length).toBe(1);
    await h.advance(60_000);
    expect(calls.length).toBe(1);
    await h.advance(540_000);
    expect(calls.length).toBe(2);
    h.sync.stop();
  });

  it('uses the backoff, not the boot retry, for a failure after the first success', async () => {
    let fail = false;
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        if (fail) throw new Error('offline');
        return roundTrip();
      },
    });
    h.sync.start();
    await h.advance(1401); // measured: this device is up
    fail = true;
    await h.advance(10_000); // the settling sample fails
    const afterFailure = calls.length;

    await h.advance(3000);
    expect(calls.length).toBe(afterFailure); // not the boot retry
    await h.advance(600_000);
    expect(calls.length).toBe(afterFailure + 1);
    h.sync.stop();
  });
});
