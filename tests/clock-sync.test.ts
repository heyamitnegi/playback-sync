import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockSync } from '../src/clock-sync';
import { ServerClock } from '../src/server-clock';
import type { ClockRoundTrip } from '../src/types';

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
function harness(over: { measure?: () => Promise<ClockRoundTrip | null> } = {}) {
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

  it('settles into the routine interval after the burst', async () => {
    const h = harness();
    h.sync.start();
    await h.advance(1401);
    const afterBurst = h.calls.length;
    await h.advance(60_000);
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
      measure: async () => {
        calls.push(0);
        if (fail) throw new Error('404');
        return null;
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

    // And now that a sample has succeeded it is back on the routine cadence.
    await h.advance(60_000);
    expect(calls.length).toBe(4);
    h.sync.stop();
  });

  it('treats a null measurement as "nothing to measure yet", not a failure', async () => {
    // Not signed in yet. It must stay on the routine cadence so it picks up as
    // soon as credentials arrive.
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        return null;
      },
    });
    h.sync.start();
    await h.advance(0);
    await h.advance(700);
    await h.advance(700);
    expect(calls.length).toBe(3);
    // Routine interval, not the 10-minute backoff.
    await h.advance(60_000);
    expect(calls.length).toBe(4);
    h.sync.stop();
  });

  it('re-measures on demand rather than waiting out a backoff', async () => {
    // A client coming back from an outage would otherwise keep its pre-outage
    // clock for the whole backoff.
    let fail = true;
    const calls: number[] = [];
    const h = harness({
      measure: async () => {
        calls.push(0);
        if (fail) throw new Error('offline');
        return null;
      },
    });
    h.sync.start();
    await h.advance(0);
    expect(calls.length).toBe(1);

    fail = false;
    h.sync.remeasure('network-online');
    await h.advance(1001); // the small re-measure jitter
    expect(calls.length).toBe(2);
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
    const clock = new ServerClock();
    const sync = new ClockSync({
      clock,
      measure: async () => null,
      random: () => 0.5,
      onRemeasure: (r) => reasons.push(r),
    });
    vi.spyOn(clock, 'checkForClockJump').mockReturnValue(45_000);
    sync.start();
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
});
