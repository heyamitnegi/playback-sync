import { describe, expect, it } from 'vitest';
import {
  SYNC_JOIN_GRACE_MS,
  syncAlignment,
  syncCursorInRun,
  syncJoinAtMs,
  syncJoinOutOfReach,
  syncPhaseAt,
  syncRunEndsAtMs,
  syncSequence,
  syncStreamDrift,
} from '../src/schedule';
import type { SyncPlan } from '../src/types';

const START = 1_755_676_806_000;

/** Three 300s positions, a 900s cycle. */
function plan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
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

function cursorAt(p: SyncPlan, nowServerMs: number) {
  const phase = syncPhaseAt(p, nowServerMs, p.startAtMs);
  if (!phase || phase.phase !== 'running') throw new Error('expected a running cursor');
  return phase.cursor;
}

describe('syncSequence', () => {
  it('puts this client`s item at each position and null in its gaps', () => {
    const items = [{ orderIndex: 0, id: 'a' }, { orderIndex: 2, id: 'c' }];
    expect(syncSequence(plan(), items).map((i) => i?.id ?? null)).toEqual(['a', null, 'c']);
  });

  it('is one entry per authored position, never compacted', () => {
    // Compacting would slide the next item forward into the gap, which is
    // exactly the drift the whole library prevents.
    expect(syncSequence(plan(), []).length).toBe(3);
  });
});

describe('syncPhaseAt', () => {
  it('holds before the join instant and names the position it will join on', () => {
    const p = plan();
    const phase = syncPhaseAt(p, START - 4000, START);
    expect(phase).toEqual({ phase: 'waiting', startsInMs: 4000, firstIndex: 0 });
  });

  it('gives a cursor into the sequence, not into the caller`s items', () => {
    const c = cursorAt(plan(), START + 320_000);
    expect(c.index).toBe(1);
    expect(c.elapsedInPositionMs).toBe(20_000);
    expect(c.elapsedInCycleMs).toBe(320_000);
    expect(c.startedAtMs).toBe(START + 300_000);
  });

  it('refuses a degenerate plan', () => {
    expect(syncPhaseAt(plan({ slots: [] }), START + 1000)).toBeNull();
  });
});

describe('syncJoinAtMs', () => {
  it('is the plan`s own instant while the plan has not started', () => {
    expect(syncJoinAtMs(plan(), START - 3000)).toBe(START);
  });

  it('joins the lap in progress inside the grace, seeking the little it missed', () => {
    // A client a few seconds late to a publish should not sit out the whole
    // first item.
    expect(syncJoinAtMs(plan(), START + 5000)).toBe(START);
    expect(syncJoinAtMs(plan(), START + SYNC_JOIN_GRACE_MS)).toBe(START);
  });

  it('holds for the NEXT position past the grace, not the next lap', () => {
    // Holding for the next lap means a client rebooting mid-playlist sits blank
    // for up to the whole playlist while its neighbours play on.
    expect(syncJoinAtMs(plan(), START + 30_000)).toBe(START + 300_000);
    expect(syncJoinAtMs(plan(), START + 350_000)).toBe(START + 600_000);
  });

  it('rolls into the next lap when it arrives during the last position', () => {
    expect(syncJoinAtMs(plan(), START + 700_000)).toBe(START + 900_000);
  });

  it('always lands on the group`s own grid, so every client crosses it together', () => {
    const p = plan();
    for (const at of [12_000, 301_000, 455_000, 899_000, 1_000_000, 3_400_000]) {
      const join = syncJoinAtMs(p, START + at);
      const intoCycle = (join - START) % 900_000;
      expect(p.slots.some((s) => Math.round(s.startOffsetSeconds * 1000) === intoCycle)).toBe(true);
    }
  });

  it('caps the grace at position 0`s own duration', () => {
    // Past that the top of the lap is genuinely over, and joining it would put
    // the client on position 1 while calling it position 0.
    const short = plan({
      cycleSeconds: 30,
      slots: [
        { index: 0, startOffsetSeconds: 0, durationSeconds: 10 },
        { index: 1, startOffsetSeconds: 10, durationSeconds: 20 },
      ],
    });
    expect(syncJoinAtMs(short, START + 9000)).toBe(START);
    expect(syncJoinAtMs(short, START + 11_000)).toBe(START + 30_000);
  });
});

describe('syncJoinOutOfReach', () => {
  it('passes a join decided on a sane clock', () => {
    const p = plan();
    expect(syncJoinOutOfReach(p, syncJoinAtMs(p, START + 30_000), START + 30_000)).toBe(false);
  });

  it('catches a join decided on a clock that was 28 years fast', () => {
    // After a power cut reset a device's clock, its join was decided once on a
    // nonsense reading; the measured clock that replaced it seconds later
    // changed nothing, and the client held "starting in 895248963s".
    const p = plan();
    const absurd = START + 28 * 365 * 24 * 3600_000;
    expect(syncJoinOutOfReach(p, absurd, START + 30_000)).toBe(true);
  });

  it('tolerates the clock`s own re-measures, which move it by tens of ms', () => {
    const p = plan();
    expect(syncJoinOutOfReach(p, START + 900_000, START + 300)).toBe(false);
  });
});

describe('syncRunEndsAtMs', () => {
  it('ends a run at the instant the position AFTER it begins', () => {
    const p = plan();
    const c = cursorAt(p, START + 10_000);
    expect(syncRunEndsAtMs(p, c, { start: 0, length: 2 })).toBe(START + 600_000);
  });

  it('counts from where the RUN began, not from the cursor', () => {
    // A client joining a group can enter a run part-way. Counting the run's
    // whole length from the cursor puts the end one position late for every
    // position in, so the next item is never prepared ahead.
    const p = plan();
    const c = cursorAt(p, START + 320_000); // inside position 1
    expect(syncRunEndsAtMs(p, c, { start: 0, length: 2 })).toBe(START + 600_000);
  });

  it('wraps a run that spans the end of the cycle into the next lap', () => {
    const p = plan();
    const c = cursorAt(p, START + 650_000); // position 2
    expect(syncRunEndsAtMs(p, c, { start: 2, length: 2 })).toBe(START + 900_000 + 300_000);
  });

  it('still gives a position`s own end for a cursor the run does not hold', () => {
    const p = plan();
    const c = cursorAt(p, START + 650_000);
    expect(syncRunEndsAtMs(p, c, { start: 0, length: 1 })).toBeGreaterThan(START + 650_000);
  });
});

describe('syncAlignment', () => {
  it('is null without a run — there is nothing to hold to', () => {
    expect(syncAlignment(plan(), cursorAt(plan(), START + 1000), null, START + 1000)).toBeNull();
  });

  it('treats a run spanning the whole cycle as a loop of it', () => {
    const p = plan();
    const at = START + 320_000;
    const a = syncAlignment(p, cursorAt(p, at), { start: 0, length: 3 }, at);
    expect(a).toEqual({ seconds: 320, periodSeconds: 900 });
  });

  it('gives stream-local seconds for a partial run', () => {
    const p = plan();
    const at = START + 320_000;
    // A run of positions 0–1: the group is 320s into it.
    expect(syncAlignment(p, cursorAt(p, at), { start: 0, length: 2 }, at)).toEqual({ seconds: 320 });
  });

  it('is null once the group is past the run`s end', () => {
    // The cap is about to fire, and seeking a stream on its way out would flush
    // a pipeline for a frame nobody sees.
    const p = plan();
    const at = START + 650_000;
    expect(syncAlignment(p, cursorAt(p, at), { start: 0, length: 2 }, at)).toBeNull();
  });
});

describe('syncStreamDrift', () => {
  it('reports how far ahead the stream is', () => {
    expect(syncStreamDrift({ currentTimeSeconds: 12.4, alignToSeconds: 12 })).toEqual({
      driftSeconds: expect.closeTo(0.4, 5),
      targetSeconds: 12,
    });
  });

  it('picks the nearest repetition on a looping run, not the first one', () => {
    // Otherwise a stream 3 laps into a looped cycle is dragged back to lap 0.
    const r = syncStreamDrift({
      currentTimeSeconds: 2700.5,
      alignToSeconds: 0.5,
      periodSeconds: 900,
    });
    expect(r.targetSeconds).toBe(2700.5);
    expect(r.driftSeconds).toBeCloseTo(0, 5);
  });
});

describe('syncCursorInRun', () => {
  it('knows a position the active stream already holds', () => {
    // The clock moving inside a joined run is NOT a hand-over — rebuilding the
    // pipeline for content it is already playing is what black-flashes a panel.
    expect(syncCursorInRun(3, { start: 0, length: 2 }, 1)).toBe(true);
    expect(syncCursorInRun(3, { start: 0, length: 2 }, 2)).toBe(false);
  });

  it('wraps at the end of the sequence', () => {
    expect(syncCursorInRun(3, { start: 2, length: 2 }, 0)).toBe(true);
  });

  it('is false without a run', () => {
    expect(syncCursorInRun(3, null, 0)).toBe(false);
  });
});
