import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_TUNING,
  decideDriftCorrection,
  resolveSyncTuning,
  steadyDriftMs,
} from '../src/drift';

const tuning = (over: Partial<typeof DEFAULT_SYNC_TUNING> = {}) => ({
  ...DEFAULT_SYNC_TUNING,
  ...over,
});

describe('steadyDriftMs', () => {
  it('takes the median, so one scattered reading cannot trigger a correction', () => {
    // Signage panels scatter ±50ms reading to reading. The 400 here is noise.
    expect(steadyDriftMs([30, 40, 400, 35, 45])).toBe(40);
  });

  it('averages the middle two on an even count', () => {
    expect(steadyDriftMs([10, 20, 30, 40])).toBe(25);
  });

  it('is NaN with nothing to go on', () => {
    expect(Number.isNaN(steadyDriftMs([]))).toBe(true);
  });
});

describe('decideDriftCorrection — defaults', () => {
  it('does nothing inside the tolerance', () => {
    expect(decideDriftCorrection(80, tuning(), false)).toEqual({ kind: 'none' });
    expect(decideDriftCorrection(-80, tuning(), false)).toEqual({ kind: 'none' });
  });

  it('seeks past it, in either direction', () => {
    expect(decideDriftCorrection(150, tuning(), false)).toEqual({ kind: 'seek-now' });
    expect(decideDriftCorrection(-150, tuning(), false)).toEqual({ kind: 'seek-now' });
  });

  it('treats the tolerance as inclusive', () => {
    expect(decideDriftCorrection(100, tuning(), false)).toEqual({ kind: 'none' });
    expect(decideDriftCorrection(101, tuning(), false)).toEqual({ kind: 'seek-now' });
  });
});

describe('decideDriftCorrection — rate correction', () => {
  const rate = tuning({ rateCorrection: true });

  it('slows a stream that is ahead and speeds up one that is behind', () => {
    expect(decideDriftCorrection(300, rate, false)).toEqual({ kind: 'rate', rate: 0.98 });
    expect(decideDriftCorrection(-300, rate, false)).toEqual({ kind: 'rate', rate: 1.02 });
  });

  it('seeks rather than rate-corrects past seekAboveMs', () => {
    expect(decideDriftCorrection(1500, rate, false)).toEqual({ kind: 'seek-now' });
  });

  it('has hysteresis: it runs until HALF the tolerance, not until the tolerance', () => {
    // Otherwise a stream sitting near the threshold toggles its rate on every
    // check, which on a hardware pipeline is audible.
    expect(decideDriftCorrection(80, rate, true)).toEqual({ kind: 'rate', rate: 0.98 });
    expect(decideDriftCorrection(40, rate, true)).toEqual({ kind: 'rate-reset' });
  });

  it('returns to 1x when rate correction is switched off mid-flight', () => {
    expect(decideDriftCorrection(300, tuning(), true)).toEqual({ kind: 'rate-reset' });
  });
});

describe('decideDriftCorrection — boundary seek', () => {
  const boundary = tuning({ boundarySeek: true });

  it('waits for the clip cut to hide a modest jump', () => {
    expect(decideDriftCorrection(500, boundary, false)).toEqual({ kind: 'seek-at-boundary' });
  });

  it('seeks immediately once the drift is visible enough', () => {
    expect(decideDriftCorrection(2500, boundary, false)).toEqual({ kind: 'seek-now' });
  });
});

describe('resolveSyncTuning', () => {
  it('is the defaults with nothing supplied', () => {
    const { tuning: t, source } = resolveSyncTuning();
    expect(t).toEqual(DEFAULT_SYNC_TUNING);
    expect(source).toBe('default');
  });

  it('layers server over defaults, and device over server', () => {
    const { tuning: t, source } = resolveSyncTuning({ toleranceMs: 200 }, { toleranceMs: 300 });
    expect(t.toleranceMs).toBe(300);
    expect(source).toBe('device-override');
  });

  it('clamps a value that would break a whole group', () => {
    // A tolerance of 0 would seek every stream on every check, and on a TV each
    // seek can flash black.
    expect(resolveSyncTuning({ toleranceMs: 0 }).tuning.toleranceMs).toBe(40);
    expect(resolveSyncTuning({ toleranceMs: 99_999 }).tuning.toleranceMs).toBe(2000);
    expect(resolveSyncTuning({ maxRateAdjust: 0.9 }).tuning.maxRateAdjust).toBe(0.05);
  });

  it('ignores junk off the wire instead of adopting it', () => {
    const { tuning: t, source } = resolveSyncTuning({ toleranceMs: 'fast', nonsense: 1 });
    expect(t).toEqual(DEFAULT_SYNC_TUNING);
    expect(source).toBe('default');
    expect(resolveSyncTuning(null, 'nope').tuning).toEqual(DEFAULT_SYNC_TUNING);
  });

  it('never leaves a seek threshold inside the tolerance', () => {
    // It would mean rate correction never engages at all.
    const { tuning: t } = resolveSyncTuning({ toleranceMs: 800, seekAboveMs: 100 });
    expect(t.seekAboveMs).toBe(800);
  });

  it('reports a server layer distinctly from a device override', () => {
    expect(resolveSyncTuning({ toleranceMs: 200 }).source).toBe('server');
  });
});
