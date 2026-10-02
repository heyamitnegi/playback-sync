import { describe, expect, it } from 'vitest';
import { estimateClockOffset, shouldAdopt } from '../src/clock';
import type { ClockRoundTrip, HeldEstimate } from '../src/types';

/** A round trip against a server whose clock is `offsetMs` ahead of this
 * client's, spending `upMs` on the way there, `serverMs` inside the server and
 * `downMs` on the way back. */
function roundTrip(spec: {
  offsetMs: number;
  upMs: number;
  serverMs: number;
  downMs: number;
  atMs?: number;
}): ClockRoundTrip {
  const t0 = spec.atMs ?? 1_755_678_925_000;
  const serverReceivedAtMs = t0 + spec.upMs + spec.offsetMs;
  return {
    requestedAtMs: t0,
    serverReceivedAtMs,
    serverSentAtMs: serverReceivedAtMs + spec.serverMs,
    receivedAtMs: t0 + spec.upMs + spec.serverMs + spec.downMs,
  };
}

describe('estimateClockOffset', () => {
  it('recovers the offset exactly when the two network legs match', () => {
    const rt = roundTrip({ offsetMs: 90_000, upMs: 60, serverMs: 25, downMs: 60 });
    expect(estimateClockOffset(rt)).toEqual({ offsetMs: 90_000, roundTripMs: 120 });
  });

  it("takes the server's own processing time out of the measurement", () => {
    // Without both server stamps, 400ms spent inside the server is
    // indistinguishable from a 400ms slower link — it would be charged to the
    // network, halved, and subtracted from the offset as if it were delay on
    // the way back.
    const quick = roundTrip({ offsetMs: 0, upMs: 40, serverMs: 5, downMs: 40 });
    const busy = roundTrip({ offsetMs: 0, upMs: 40, serverMs: 400, downMs: 40 });
    expect(estimateClockOffset(quick)).toEqual({ offsetMs: 0, roundTripMs: 80 });
    expect(estimateClockOffset(busy)).toEqual({ offsetMs: 0, roundTripMs: 80 });
  });

  it('leaves only half the leg asymmetry as error, whatever the distance', () => {
    // The residual, and the reason `shouldAdopt` ranks by round trip: a
    // symmetric 2s link is measured perfectly, while a 100ms link with 40ms of
    // asymmetry is out by 20. Distance is not the problem; imbalance is.
    const far = roundTrip({ offsetMs: 0, upMs: 1000, serverMs: 10, downMs: 1000 });
    expect(estimateClockOffset(far)?.offsetMs).toBe(0);

    const lopsided = roundTrip({ offsetMs: 0, upMs: 70, serverMs: 10, downMs: 30 });
    expect(estimateClockOffset(lopsided)?.offsetMs).toBe(20);
  });

  it('is what the naive single-stamp reading gets wrong, and by how much', () => {
    // The bug this module exists for, stated as arithmetic. Two clients, same
    // server, same schedule — a TV on slow wifi and a laptop on the LAN.
    // `serverTime - arrivalTime` makes each believe the server is earlier than
    // it is by its own one-way delay, so each plays that far behind and the
    // fast one leads the slow one by the difference.
    const tv = roundTrip({ offsetMs: 0, upMs: 180, serverMs: 20, downMs: 180 });
    const laptop = roundTrip({ offsetMs: 0, upMs: 8, serverMs: 20, downMs: 8 });

    const naive = (rt: ClockRoundTrip) => rt.serverSentAtMs - rt.receivedAtMs;
    expect(naive(tv)).toBe(-180);
    expect(naive(laptop)).toBe(-8);
    // 172ms apart on identical inputs, purely from how they are connected.
    expect(naive(laptop) - naive(tv)).toBe(172);

    // Measured properly, both land on the same answer.
    expect(estimateClockOffset(tv)?.offsetMs).toBe(0);
    expect(estimateClockOffset(laptop)?.offsetMs).toBe(0);
  });

  it('refuses a measurement it cannot trust rather than clamping it', () => {
    const base = roundTrip({ offsetMs: 0, upMs: 20, serverMs: 5, downMs: 20 });
    // A clock moved mid-request: the server claims to have spent longer inside
    // than the whole round trip took.
    expect(
      estimateClockOffset({ ...base, serverSentAtMs: base.serverReceivedAtMs + 5000 }),
    ).toBeNull();
    // Beyond any real link — too much room for asymmetry to be worth adopting.
    expect(
      estimateClockOffset(roundTrip({ offsetMs: 0, upMs: 3000, serverMs: 5, downMs: 3000 })),
    ).toBeNull();
    // Nothing usable on the wire.
    expect(estimateClockOffset({ ...base, serverSentAtMs: Number.NaN })).toBeNull();
  });

  it('honours a raised round-trip ceiling for a slow link', () => {
    const slow = roundTrip({ offsetMs: 0, upMs: 3000, serverMs: 5, downMs: 3000 });
    expect(estimateClockOffset(slow)).toBeNull();
    expect(estimateClockOffset(slow, { maxUsableRoundTripMs: 10_000 })).toEqual({
      offsetMs: 0,
      roundTripMs: 6000,
    });
  });
});

describe('shouldAdopt', () => {
  const held = (over: Partial<HeldEstimate> = {}): HeldEstimate => ({
    offsetMs: 500,
    roundTripMs: 100,
    takenAtMs: 1_000_000,
    ...over,
  });

  it('takes the first measurement there is', () => {
    expect(shouldAdopt(null, { offsetMs: 0, roundTripMs: 3000 }, 1_000_000)).toBe(true);
  });

  it('prefers the shorter round trip, which is the whole selection rule', () => {
    expect(shouldAdopt(held(), { offsetMs: 480, roundTripMs: 40 }, 1_000_100)).toBe(true);
    expect(shouldAdopt(held(), { offsetMs: 480, roundTripMs: 400 }, 1_000_100)).toBe(false);
  });

  it('follows a local clock STEP immediately, however slow the sample', () => {
    // A TV picking up NTP a minute after boot, or Android correcting itself.
    // Holding the pre-step offset because it was measured on a faster link
    // would leave this client exactly one step out of position until the
    // freshness expiry — which is minutes of a group being visibly wrong.
    expect(shouldAdopt(held(), { offsetMs: 500 - 30_000, roundTripMs: 900 }, 1_000_100)).toBe(true);
    // Ordinary jitter is not a step and must not trip it.
    expect(shouldAdopt(held(), { offsetMs: 520, roundTripMs: 900 }, 1_000_100)).toBe(false);
  });

  it('stops preferring a fast old reading once it is stale', () => {
    // Otherwise the luckiest sample of the day wins the day, and the local
    // oscillator's drift accumulates underneath it unmeasured.
    expect(shouldAdopt(held(), { offsetMs: 505, roundTripMs: 800 }, 1_000_000 + 60_000)).toBe(false);
    expect(shouldAdopt(held(), { offsetMs: 505, roundTripMs: 800 }, 1_000_000 + 6 * 60_000)).toBe(
      true,
    );
  });

  it('honours a tightened step threshold', () => {
    const next = { offsetMs: 500 + 200, roundTripMs: 900 };
    expect(shouldAdopt(held(), next, 1_000_100)).toBe(false);
    expect(shouldAdopt(held(), next, 1_000_100, { stepMs: 100 })).toBe(true);
  });
});
