import { describe, expect, it } from 'vitest';
import { planFrom, slotsFrom } from '../src/author';
import { receivePlan, resolveCyclePosition } from '../src/cycle';

describe('slotsFrom', () => {
  it('lays positions end to end and sums the cycle', () => {
    expect(slotsFrom([10, 20, 30])).toEqual({
      slots: [
        { index: 0, startOffsetSeconds: 0, durationSeconds: 10 },
        { index: 1, startOffsetSeconds: 10, durationSeconds: 20 },
        { index: 2, startOffsetSeconds: 30, durationSeconds: 30 },
      ],
      cycleSeconds: 60,
    });
  });

  it('keeps the running offset clean to the millisecond', () => {
    // Adding floats as they come leaves binary noise
    // (25.1 + 12.433 + 20.02 + 20.02 = 77.57300000000001) in every later
    // position and in the cycle.
    const { slots, cycleSeconds } = slotsFrom([25.1, 12.433, 20.02, 20.02]);
    expect(slots.map((s) => s.startOffsetSeconds)).toEqual([0, 25.1, 37.533, 57.553]);
    expect(cycleSeconds).toBe(77.573);
  });

  it('handles an empty cycle without inventing one', () => {
    expect(slotsFrom([])).toEqual({ slots: [], cycleSeconds: 0 });
  });
});

describe('planFrom', () => {
  const NOW = 1_755_676_800_000;

  it('starts a lead ahead of now, so every client has time to be ready', () => {
    const p = planFrom({ durations: [10, 20], serverNowMs: NOW, startLeadSeconds: 6 });
    expect(p.startAtMs).toBe(NOW + 6000);
    expect(p.cycleSeconds).toBe(30);
  });

  it('round-trips through receivePlan into a resolvable plan', () => {
    // The whole server → wire → client path, which is the seam most likely to
    // be got wrong: the server cannot stamp when the client received it.
    const spec = planFrom({ durations: [10, 20], serverNowMs: NOW });
    const onTheWire = JSON.parse(JSON.stringify(spec));
    const plan = receivePlan(onTheWire, { requestedAtMs: NOW - 40, receivedAtMs: NOW });

    const res = resolveCyclePosition(plan, plan.startAtMs + 15_000);
    expect(res?.phase).toBe('running');
    if (res?.phase === 'running') {
      expect(res.position.index).toBe(1);
      expect(res.position.elapsedInPositionMs).toBe(5000);
    }
  });

  it('takes an explicit start instant when the caller has one', () => {
    const p = planFrom({ durations: [10], serverNowMs: NOW, startAtMs: NOW + 60_000 });
    expect(p.startAtMs).toBe(NOW + 60_000);
  });
});
