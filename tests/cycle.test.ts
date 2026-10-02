import { describe, expect, it } from 'vitest';
import {
  clockOffsetFromPlan,
  itemAt,
  nextPositionIndex,
  receivePlan,
  resolveCyclePosition,
  serverNowFromPlan,
} from '../src/cycle';
import type { SyncPlan, SyncPlanSpec } from '../src/types';

/** A three-position, 900s cycle starting at a round instant. */
const START = 1_755_676_806_000;

function plan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    groupId: 'g1',
    revisionId: 'v1',
    // Same clock on both sides unless a test says otherwise.
    serverTimeMs: START,
    receivedAtMs: START,
    startAtMs: START,
    cycleSeconds: 900,
    slots: [
      { index: 0, startOffsetSeconds: 0, durationSeconds: 300 },
      { index: 1, startOffsetSeconds: 300, durationSeconds: 300 },
      { index: 2, startOffsetSeconds: 600, durationSeconds: 300 },
    ],
    ...overrides,
  };
}

function running(res: ReturnType<typeof resolveCyclePosition>) {
  if (!res || res.phase !== 'running') {
    throw new Error(`expected a running position, got ${res?.phase}`);
  }
  return res.position;
}

describe('receivePlan', () => {
  const spec: SyncPlanSpec = {
    serverTimeMs: START,
    startAtMs: START,
    cycleSeconds: 900,
    slots: [{ index: 0, startOffsetSeconds: 0, durationSeconds: 900 }],
    groupId: 'g1',
  };

  it('stamps a wire plan with when it arrived', () => {
    const plan = receivePlan(spec, { requestedAtMs: START - 40, receivedAtMs: START });
    expect(plan.receivedAtMs).toBe(START);
    expect(plan.requestedAtMs).toBe(START - 40);
  });

  it('carries the wire fields through untouched', () => {
    const plan = receivePlan(spec, { receivedAtMs: START });
    expect(plan.groupId).toBe('g1');
    expect(plan.slots).toEqual(spec.slots);
    expect(plan.cycleSeconds).toBe(900);
  });

  it('works without a request stamp, degrading to the arrival reading', () => {
    // A transport that does not stamp the outgoing edge still produces a usable
    // plan; it just carries the one-way delay in its fallback offset.
    const plan = receivePlan({ ...spec, serverTimeMs: START + 500 }, { receivedAtMs: START });
    expect(plan.requestedAtMs).toBeUndefined();
    expect(clockOffsetFromPlan(plan)).toBe(500);
  });

  it('does not mutate the spec it was given', () => {
    const before = JSON.stringify(spec);
    receivePlan(spec, { receivedAtMs: START });
    expect(JSON.stringify(spec)).toBe(before);
  });
});

describe('clockOffsetFromPlan / serverNowFromPlan', () => {
  it('corrects a client clock that is minutes behind the server', () => {
    const p = plan({ serverTimeMs: START, receivedAtMs: START - 90_000 });
    expect(clockOffsetFromPlan(p)).toBe(90_000);
    expect(serverNowFromPlan(p, START - 90_000)).toBe(START);
  });

  it('corrects a client clock that is ahead', () => {
    const p = plan({ serverTimeMs: START, receivedAtMs: START + 45_000 });
    expect(clockOffsetFromPlan(p)).toBe(-45_000);
    expect(serverNowFromPlan(p, START + 45_000)).toBe(START);
  });

  it('takes the network delay out, from the midpoint of request and response', () => {
    const p = plan({
      serverTimeMs: START,
      requestedAtMs: START - 90_400,
      receivedAtMs: START - 89_600,
    });
    expect(clockOffsetFromPlan(p)).toBe(90_000);
  });

  // A power cut reset a device's clock to 1970, and the clock was set while its
  // request was out, so the request read 1970 and the response read the
  // present. The midpoint of those put the server 28 years ahead, and the
  // client held "starting in 895248963s".
  it('ignores a request stamp the client clock was set after', () => {
    const p = plan({ serverTimeMs: START, requestedAtMs: 20_000, receivedAtMs: START - 90_000 });
    expect(clockOffsetFromPlan(p)).toBe(90_000);
  });

  it('ignores a request stamp later than the response', () => {
    const p = plan({ serverTimeMs: START, requestedAtMs: START + 5000, receivedAtMs: START });
    expect(clockOffsetFromPlan(p)).toBe(0);
  });
});

describe('resolveCyclePosition — before the start', () => {
  it('waits until startAtMs and names the position to buffer', () => {
    expect(resolveCyclePosition(plan(), START - 6000)).toEqual({
      phase: 'waiting',
      startsInMs: 6000,
      firstIndex: 0,
    });
  });

  it('starts position 0 at exactly startAtMs, not a millisecond earlier', () => {
    const p = plan();
    expect(resolveCyclePosition(p, START - 1)?.phase).toBe('waiting');
    const at = running(resolveCyclePosition(p, START));
    expect(at.index).toBe(0);
    expect(at.elapsedInPositionMs).toBe(0);
    expect(at.cycleCount).toBe(0);
  });
});

describe('resolveCyclePosition — inside the cycle', () => {
  it('pins the boundary to the exact millisecond', () => {
    const p = plan();
    expect(running(resolveCyclePosition(p, START + 299_999)).index).toBe(0);
    expect(running(resolveCyclePosition(p, START + 300_000)).index).toBe(1);
  });

  it('reports the absolute instant the position hands over', () => {
    const at = running(resolveCyclePosition(plan(), START + 320_000));
    expect(at.index).toBe(1);
    expect(at.endsAtMs).toBe(START + 600_000);
  });

  it('gives the seek target inside the position', () => {
    const at = running(resolveCyclePosition(plan(), START + 320_000));
    expect(at.elapsedInPositionMs).toBe(20_000);
    expect(at.elapsedInCycleMs).toBe(320_000);
  });
});

describe('resolveCyclePosition — the property that makes a group agree', () => {
  it('lands a client joining an hour late exactly where one up since the start is', () => {
    const p = plan();
    const aLongWayIn = START + 3600_000 + 450_000;
    const fresh = running(resolveCyclePosition(p, aLongWayIn));
    // Position derived from the absolute instant and a modulo — never from
    // accumulating durations since this client happened to boot.
    expect(fresh.index).toBe(1);
    expect(fresh.elapsedInPositionMs).toBe(150_000);
    expect(fresh.cycleCount).toBe(4);
  });

  it('gives two clients whose local clocks differ by 45s the same position', () => {
    // The clocks differ; the SERVER reading they resolve against does not. That
    // is the entire feature.
    const slow = plan({ serverTimeMs: START, receivedAtMs: START - 45_000 });
    const fast = plan({ serverTimeMs: START, receivedAtMs: START + 45_000 });
    const atServer = START + 400_000;
    const slowLocal = atServer - 45_000;
    const fastLocal = atServer + 45_000;

    const a = running(resolveCyclePosition(slow, serverNowFromPlan(slow, slowLocal)));
    const b = running(resolveCyclePosition(fast, serverNowFromPlan(fast, fastLocal)));
    expect(a.index).toBe(b.index);
    expect(a.elapsedInPositionMs).toBe(b.elapsedInPositionMs);
  });

  it('counts laps so a one-position cycle still restarts each lap', () => {
    const p = plan({
      cycleSeconds: 30,
      slots: [{ index: 0, startOffsetSeconds: 0, durationSeconds: 30 }],
    });
    expect(running(resolveCyclePosition(p, START + 10_000)).cycleCount).toBe(0);
    expect(running(resolveCyclePosition(p, START + 40_000)).cycleCount).toBe(1);
    expect(running(resolveCyclePosition(p, START + 70_000)).cycleCount).toBe(2);
  });
});

describe('resolveCyclePosition — degenerate plans', () => {
  it('refuses a plan with no positions rather than dividing by it', () => {
    expect(resolveCyclePosition(plan({ slots: [] }), START + 1000)).toBeNull();
  });

  it('refuses a zero-length cycle', () => {
    expect(resolveCyclePosition(plan({ cycleSeconds: 0 }), START + 1000)).toBeNull();
  });

  it('caps a position that would overrun the cycle, rather than ending in the past', () => {
    const p = plan({
      cycleSeconds: 100,
      slots: [{ index: 0, startOffsetSeconds: 0, durationSeconds: 500 }],
    });
    expect(running(resolveCyclePosition(p, START + 10_000)).endsAtMs).toBe(START + 100_000);
  });
});

describe('itemAt / nextPositionIndex', () => {
  const items = [{ orderIndex: 0, id: 'a' }, { orderIndex: 2, id: 'c' }];

  it('finds this client`s item at a position', () => {
    expect(itemAt(items, 2)?.id).toBe('c');
  });

  it('reports a gap as undefined so the caller holds blank instead of sliding', () => {
    expect(itemAt(items, 1)).toBeUndefined();
  });

  it('wraps at the end of the cycle', () => {
    const p = plan();
    expect(nextPositionIndex(p, 0)).toBe(1);
    expect(nextPositionIndex(p, 2)).toBe(0);
  });

  it('falls back to the first position for an index it does not know', () => {
    expect(nextPositionIndex(plan(), 99)).toBe(0);
  });
});
