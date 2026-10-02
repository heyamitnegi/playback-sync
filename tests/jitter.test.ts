import { describe, expect, it } from 'vitest';
import { DEFAULT_SPREAD, jitteredDelay, jitteredInterval } from '../src/jitter';

describe('jitteredInterval', () => {
  it('keeps the nominal value at the middle of the range', () => {
    expect(jitteredInterval(60_000, DEFAULT_SPREAD, () => 0.5)).toBe(60_000);
  });

  it('spans ±spread at the extremes', () => {
    expect(jitteredInterval(60_000, 0.2, () => 0)).toBe(48_000);
    expect(jitteredInterval(60_000, 0.2, () => 1)).toBe(72_000);
  });

  it('averages out to the nominal rate, so throttle budgets still hold', () => {
    let total = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) total += jitteredInterval(60_000);
    expect(total / n).toBeGreaterThan(59_000);
    expect(total / n).toBeLessThan(61_000);
  });

  it('never returns a delay that would busy-loop', () => {
    // A 0ms timer on slow hardware is a busy loop, and some of these callbacks
    // re-enter their own scheduler.
    expect(jitteredInterval(1, 1, () => 0)).toBe(1);
  });

  it('passes a non-positive interval straight through', () => {
    expect(jitteredInterval(0)).toBe(0);
  });

  it('de-phases a fleet that booted together', () => {
    // The actual point: 50 clients on the same nominal interval must not stay
    // in step. After one cycle their next wake-ups should be spread out.
    const fleet = Array.from({ length: 50 }, () => jitteredInterval(60_000));
    expect(new Set(fleet).size).toBeGreaterThan(40);
  });
});

describe('jitteredDelay', () => {
  it('spreads uniformly across the window', () => {
    expect(jitteredDelay(2000, () => 0)).toBe(0);
    expect(jitteredDelay(2000, () => 0.5)).toBe(1000);
    expect(jitteredDelay(2000, () => 1)).toBe(2000);
  });

  it('has no lower bound — some clients should react immediately', () => {
    expect(jitteredDelay(2000, () => 0)).toBe(0);
  });

  it('is zero for a non-positive window', () => {
    expect(jitteredDelay(0)).toBe(0);
  });
});
