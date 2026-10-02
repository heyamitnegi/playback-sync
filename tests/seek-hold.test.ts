import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEEK_PROFILE,
  HOLD_MAX_MS,
  LEAD_MAX_MS,
  LEAD_MIN_MS,
  afterPlainSeekMissed,
  learnLead,
  learnPlayDelay,
  planHold,
  readSeekProfile,
} from '../src/seek-hold';

describe('afterPlainSeekMissed', () => {
  it('switches to hold mode once a seek has landed late', () => {
    // Measured on commercial signage panels: a seek issued while the stream
    // plays lands 0.36–1.1s behind its target, every time.
    const p = afterPlainSeekMissed(DEFAULT_SEEK_PROFILE, -900, 100);
    expect(p.holdMode).toBe(true);
    expect(p.leadMs).toBe(1500); // max(default 1500, 900 + margin 500)
  });

  it('raises the lead when the miss was worse than the default covers', () => {
    expect(afterPlainSeekMissed(DEFAULT_SEEK_PROFILE, -1800, 100).leadMs).toBe(2300);
  });

  it('leaves a device whose seeks land fine alone', () => {
    expect(afterPlainSeekMissed(DEFAULT_SEEK_PROFILE, -80, 100)).toEqual(DEFAULT_SEEK_PROFILE);
  });

  it('ignores a miss too large to be a late landing', () => {
    // Beyond this the drift has some other cause and holding would not fix it.
    expect(afterPlainSeekMissed(DEFAULT_SEEK_PROFILE, -5000, 100)).toEqual(DEFAULT_SEEK_PROFILE);
  });

  it('does not re-decide once hold mode is on', () => {
    const held = { ...DEFAULT_SEEK_PROFILE, holdMode: true, leadMs: 900 };
    expect(afterPlainSeekMissed(held, -2000, 100)).toBe(held);
  });
});

describe('learnLead', () => {
  const held = { ...DEFAULT_SEEK_PROFILE, holdMode: true, leadMs: 1000 };

  it('rises at once when a seek landed behind', () => {
    // The next one would otherwise land behind too.
    expect(learnLead(held, 1000, -400).leadMs).toBe(1900);
  });

  it('falls only slowly when a seek was quick', () => {
    // The one after may be slow again, so one quick seek only nudges it down.
    const next = learnLead(held, 1000, 800);
    expect(next.leadMs).toBeGreaterThan(700);
    expect(next.leadMs).toBeLessThan(1000);
  });

  it('stays inside its bounds', () => {
    expect(learnLead(held, 10_000, -10_000).leadMs).toBe(LEAD_MAX_MS);
    expect(learnLead({ ...held, leadMs: LEAD_MIN_MS }, 300, 3000).leadMs).toBe(LEAD_MIN_MS);
  });

  it('ignores a reading that is not a number', () => {
    expect(learnLead(held, 1000, Number.NaN)).toBe(held);
  });
});

describe('learnPlayDelay', () => {
  it('allows more start-up time when the stream came in behind', () => {
    expect(learnPlayDelay(DEFAULT_SEEK_PROFILE, -200).playDelayMs).toBe(100);
  });

  it('takes half of each error so one noisy reading cannot swing it', () => {
    const once = learnPlayDelay(DEFAULT_SEEK_PROFILE, -400);
    expect(once.playDelayMs).toBe(200);
    expect(learnPlayDelay(once, -400).playDelayMs).toBe(400);
  });

  it('never goes negative', () => {
    expect(learnPlayDelay(DEFAULT_SEEK_PROFILE, 500).playDelayMs).toBe(0);
  });

  it('ignores an implausible reading', () => {
    expect(learnPlayDelay(DEFAULT_SEEK_PROFILE, 9999)).toEqual(DEFAULT_SEEK_PROFILE);
  });
});

describe('planHold', () => {
  it('holds the frame until the group catches up, less the start-up time', () => {
    expect(planHold(800, 120)).toEqual({ kind: 'hold', waitMs: 680 });
  });

  it('plays on when the seek landed behind after all', () => {
    expect(planHold(-50, 0)).toEqual({ kind: 'behind' });
  });

  it('plays on rather than freeze for seconds when a decoder snapped far ahead', () => {
    // A multi-second freeze on one display of a group is worse than the drift.
    expect(planHold(HOLD_MAX_MS + 1, 0)).toEqual({ kind: 'too-far' });
  });
});

describe('readSeekProfile', () => {
  it('reads a stored profile back', () => {
    expect(readSeekProfile({ holdMode: true, leadMs: 1200, playDelayMs: 90 })).toEqual({
      holdMode: true,
      leadMs: 1200,
      playDelayMs: 90,
    });
  });

  it('falls back to the default for anything it cannot use', () => {
    expect(readSeekProfile(null)).toEqual(DEFAULT_SEEK_PROFILE);
    expect(readSeekProfile('nonsense')).toEqual(DEFAULT_SEEK_PROFILE);
    expect(readSeekProfile({ leadMs: 'fast' })).toEqual(DEFAULT_SEEK_PROFILE);
  });

  it('clamps a stored value that is out of range', () => {
    expect(readSeekProfile({ leadMs: 99_999 }).leadMs).toBe(LEAD_MAX_MS);
  });
});
