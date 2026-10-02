import { describe, expect, it } from 'vitest';
import { ServerClock } from '../src/server-clock';
import type { ClockRoundTrip } from '../src/types';

/**
 * Both clocks are driven by hand, because the whole point of the class is that
 * it treats them as two different things.
 */
function harness(startWallMs = 1_700_000_000_000) {
  let wallMs = startWallMs;
  let monotonicMs = 10_000;
  const events: Array<{ level: string; message: string }> = [];
  const clock = new ServerClock({
    wallNowMs: () => wallMs,
    monotonicNowMs: () => monotonicMs,
    onEvent: (level, message) => events.push({ level, message }),
  });
  return {
    clock,
    events,
    /** Both clocks advance together — ordinary time passing. */
    tick(ms: number) {
      wallMs += ms;
      monotonicMs += ms;
    },
    /** The calendar is SET, leaving the monotonic counter where it was. */
    setWallClock(byMs: number) {
      wallMs += byMs;
    },
    /** The device slept: the calendar advanced, the monotonic counter did not. */
    sleep(ms: number) {
      wallMs += ms;
    },
    wall: () => wallMs,
    /**
     * A symmetric round trip against a server `offsetMs` ahead, which has just
     * completed: it went out `2 × oneWayMs` ago and the response is in hand now.
     */
    rt(offsetMs: number, oneWayMs = 50): ClockRoundTrip {
      const t3 = wallMs;
      const t0 = t3 - 2 * oneWayMs;
      return {
        requestedAtMs: t0,
        serverReceivedAtMs: t0 + oneWayMs + offsetMs,
        serverSentAtMs: t0 + oneWayMs + offsetMs,
        receivedAtMs: t3,
      };
    },
  };
}

describe('ServerClock', () => {
  it('falls back to the local calendar until the first measurement lands', () => {
    const h = harness();
    expect(h.clock.hasEstimate()).toBe(false);
    expect(h.clock.nowMs()).toBe(h.wall());
    expect(h.clock.estimate()).toBeNull();
  });

  it('reads the server clock once a round trip has been observed', () => {
    const h = harness();
    h.clock.observe(h.rt(90_000), 'test');
    expect(h.clock.hasEstimate()).toBe(true);
    // The device is 90s behind the server, so the group's clock reads 90s ahead
    // of this device's calendar.
    expect(h.clock.nowMs()).toBe(h.wall() + 90_000);
  });

  it('advances on elapsed time, not on the calendar', () => {
    const h = harness();
    h.clock.observe(h.rt(0), 'test');
    const before = h.clock.nowMs();
    h.tick(30_000);
    expect(h.clock.nowMs() - before).toBe(30_000);
  });

  it('IGNORES the local clock being set, which is the whole design', () => {
    // A TV picking up NTP a minute after boot moves Date.now() under a running
    // cycle. An implementation holding `Date.now() + offset` would jump the
    // picture by the step; this one must not move at all.
    const h = harness();
    h.clock.observe(h.rt(0), 'test');
    const before = h.clock.nowMs();
    h.setWallClock(45_000);
    expect(h.clock.nowMs()).toBe(before);
  });

  it('ranks a later sample by round trip, like shouldAdopt', () => {
    // Offsets kept well inside the step threshold, so only the ranking decides.
    const h = harness();
    h.clock.observe(h.rt(0, 20), 'fast'); // 40ms round trip
    h.tick(1000);
    h.clock.observe(h.rt(200, 400), 'slow'); // 800ms round trip, ignored
    expect(h.clock.estimate()?.source).toBe('fast');
    h.tick(1000);
    h.clock.observe(h.rt(300, 5), 'faster'); // 10ms round trip, adopted
    expect(h.clock.estimate()?.source).toBe('faster');
    expect(h.clock.estimate()?.offsetMs).toBe(300);
  });

  it('follows a clock STEP even from a much slower sample', () => {
    // A TV picking up NTP a minute after boot. Holding the pre-step offset
    // because it was measured on a faster link would leave this client exactly
    // one step out of position until the freshness expiry.
    const h = harness();
    h.clock.observe(h.rt(0, 20), 'fast');
    h.tick(1000);
    h.clock.observe(h.rt(30_000, 400), 'stepped');
    expect(h.clock.estimate()?.source).toBe('stepped');
    expect(h.clock.estimate()?.offsetMs).toBe(30_000);
  });

  it('drops an unusable round trip without disturbing the held estimate', () => {
    const h = harness();
    h.clock.observe(h.rt(1234, 20), 'good');
    const held = h.clock.estimate();
    h.clock.observe({ ...h.rt(0), serverSentAtMs: Number.NaN }, 'junk');
    expect(h.clock.estimate()?.offsetMs).toBe(held?.offsetMs);
    expect(h.events.some((e) => e.message.includes('unusable'))).toBe(true);
  });

  it('notices the calendar and the monotonic counter coming apart', () => {
    const h = harness();
    h.clock.observe(h.rt(0), 'test');
    expect(h.clock.checkForClockJump()).toBeNull();
    h.setWallClock(60_000);
    expect(h.clock.checkForClockJump()).toBe(60_000);
    // Reported once, not on every check after it.
    expect(h.clock.checkForClockJump()).toBeNull();
  });

  it('notices a sleep, where the calendar is right and the monotonic base is not', () => {
    const h = harness();
    h.clock.observe(h.rt(0, 10), 'test');
    h.sleep(4 * 60_000);
    expect(h.clock.checkForClockJump()).toBe(4 * 60_000);
    // Nothing in the measurement ranking could see this: the next sample has
    // the same offset as the one held, so only the forced adoption rescues it.
    h.clock.observe(h.rt(0, 500), 'after-wake');
    expect(h.clock.estimate()?.source).toBe('after-wake');
  });

  it('adopts the next usable sample after expectDiscontinuity, however slow', () => {
    const h = harness();
    h.clock.observe(h.rt(0, 10), 'fast');
    h.tick(1000);
    // Without the hint this 600ms sample loses to the 20ms one held.
    h.clock.expectDiscontinuity();
    h.clock.observe(h.rt(0, 300), 'slow-but-forced');
    expect(h.clock.estimate()?.source).toBe('slow-but-forced');
    // And the normal rule resumes immediately after.
    h.tick(1000);
    h.clock.observe(h.rt(0, 400), 'slower');
    expect(h.clock.estimate()?.source).toBe('slow-but-forced');
  });

  it('reports the age of the held estimate', () => {
    const h = harness();
    h.clock.observe(h.rt(0), 'test');
    h.tick(7000);
    expect(h.clock.estimate()?.ageMs).toBe(7000);
  });
});
