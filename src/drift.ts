/**
 * How a joined run is steered back into line when it drifts — pure policy, no
 * timers, no media element. Your player measures the drift and applies what
 * this decides.
 *
 * The defaults: nothing within 100ms, a seek (or, on a device whose seeks land
 * late, a seek-and-hold — see `seek-hold.ts`) past it, decided on the median of
 * the last few readings. Everything else is opt-in through {@link SyncTuning}:
 *
 * - how precisely a display reports `currentTime` was measured on real
 *   hardware: commercial signage panels scatter ±50ms reading to reading,
 *   consumer TVs barely at all — hence the median, see DRIFT_WINDOW_SAMPLES;
 * - whether a display changes `playbackRate` smoothly on its hardware pipeline,
 *   or stutters, shifts the audio's pitch, or ignores it, has not been — which
 *   is why rate correction is off by default. Switch it on against a test
 *   device, not a fleet.
 */

export interface SyncTuning {
  /**
   * Drift a running stream may have before anything is done about it. 100ms:
   * side by side during motion a viewer sees 50–100ms. Measured against the
   * median of recent readings (DRIFT_WINDOW_SAMPLES), never one reading — a
   * signage panel's single readings scatter by about half of this.
   */
  toleranceMs: number;
  /** How often the stream is compared with the group's clock. */
  checkIntervalMs: number;
  /**
   * Correct drift under `seekAboveMs` by running slightly fast or slow instead
   * of seeking — no jump on screen, at the cost of a few seconds to converge.
   */
  rateCorrection: boolean;
  /** How far from 1x rate correction runs, as a fraction (0.02 = ±2%). */
  maxRateAdjust: number;
  /** With rate correction on: drift past which it seeks instead. */
  seekAboveMs: number;
  /**
   * Hold a seek for drift under {@link BOUNDARY_SEEK_MAX_MS} until the stream's
   * next clip boundary, where the cut already hides the jump — as long as one
   * comes within {@link BOUNDARY_WAIT_MAX_MS}.
   */
  boundarySeek: boolean;
}

export const DEFAULT_SYNC_TUNING: SyncTuning = {
  toleranceMs: 100,
  checkIntervalMs: 500,
  rateCorrection: false,
  maxRateAdjust: 0.02,
  seekAboveMs: 1000,
  boundarySeek: false,
};

/**
 * The range each setting is clamped into, whatever a server or a device
 * override says. A tuning value is one typo from breaking a whole group — a
 * tolerance of 0 would seek every stream on every check, and on a TV each seek
 * can flash black — so the bounds are the floor of what could be sane, not a
 * suggestion.
 */
export const SYNC_TUNING_LIMITS = {
  toleranceMs: [40, 2000],
  checkIntervalMs: [250, 5000],
  maxRateAdjust: [0.005, 0.05],
  seekAboveMs: [40, 5000],
} as const;

/** Where the settings in force came from — report it, so a forgotten device
 * override on a production display is visible rather than silent. */
export type SyncTuningSource = 'default' | 'server' | 'device-override';

/**
 * How many readings a correction is decided on: their median. On commercial
 * signage panels one reading scatters about ±50ms from the next, so with a
 * 100ms tolerance a single reading past it is as often noise as drift — and
 * there every correction is a visible held frame. At a 500ms check this is 2.5s
 * of readings; a real step (a rebuffer) shows in the median after three of them.
 */
export const DRIFT_WINDOW_SAMPLES = 5;

/** The drift a correction is decided on: the median of recent readings. */
export function steadyDriftMs(readings: readonly number[]): number {
  if (readings.length === 0) return Number.NaN;
  const sorted = [...readings].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Largest drift a boundary seek may hold for; past it the display is visibly
 * out of line. */
export const BOUNDARY_SEEK_MAX_MS = 2000;

/** Longest a boundary seek waits for a clip boundary before seeking anyway. */
export const BOUNDARY_WAIT_MAX_MS = 10_000;

const clamp = (value: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, value));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The valid, clamped fields of one layer of settings; anything else ignored. */
function readLayer(raw: unknown): Partial<SyncTuning> {
  if (!isRecord(raw)) return {};
  const out: Partial<SyncTuning> = {};
  const num = (key: keyof typeof SYNC_TUNING_LIMITS) => {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp(v, SYNC_TUNING_LIMITS[key]);
  };
  num('toleranceMs');
  num('checkIntervalMs');
  num('maxRateAdjust');
  num('seekAboveMs');
  if (typeof raw.rateCorrection === 'boolean') out.rateCorrection = raw.rateCorrection;
  if (typeof raw.boundarySeek === 'boolean') out.boundarySeek = raw.boundarySeek;
  return out;
}

/**
 * The settings in force: the defaults, overlaid by whatever your server sent,
 * overlaid by a device-local override (a test unit). Each field is taken only
 * if it is valid, and clamped into {@link SYNC_TUNING_LIMITS}. Both arguments
 * are `unknown` on purpose — they come off a wire or out of local storage.
 */
export function resolveSyncTuning(
  fromServer?: unknown,
  fromDevice?: unknown,
): { tuning: SyncTuning; source: SyncTuningSource } {
  const server = readLayer(fromServer);
  const device = readLayer(fromDevice);
  const tuning = { ...DEFAULT_SYNC_TUNING, ...server, ...device };
  // A seek threshold inside the tolerance would never rate-correct at all.
  tuning.seekAboveMs = Math.max(tuning.seekAboveMs, tuning.toleranceMs);
  const source: SyncTuningSource =
    Object.keys(device).length > 0
      ? 'device-override'
      : Object.keys(server).length > 0
        ? 'server'
        : 'default';
  return { tuning, source };
}

export type DriftCorrection =
  | { kind: 'none' }
  /** Run at `rate` until back inside half the tolerance. */
  | { kind: 'rate'; rate: number }
  /** Back to 1x: caught up, or rate correction no longer applies. */
  | { kind: 'rate-reset' }
  /** Seek at the stream's next clip boundary. */
  | { kind: 'seek-at-boundary' }
  | { kind: 'seek-now' };

/**
 * What to do about `driftMs` (positive = the stream is ahead of the group).
 *
 * Rate correction has hysteresis: it starts past the tolerance and runs until
 * the drift is inside HALF of it, so a stream sitting near the threshold does
 * not toggle its rate on every check.
 */
export function decideDriftCorrection(
  driftMs: number,
  tuning: SyncTuning,
  rateActive: boolean,
): DriftCorrection {
  const abs = Math.abs(driftMs);
  const rate = driftMs > 0 ? 1 - tuning.maxRateAdjust : 1 + tuning.maxRateAdjust;
  const inRateBand = tuning.rateCorrection && abs <= tuning.seekAboveMs;
  if (rateActive) {
    if (!tuning.rateCorrection || abs <= tuning.toleranceMs / 2) return { kind: 'rate-reset' };
    if (inRateBand) return { kind: 'rate', rate };
  }
  if (abs <= tuning.toleranceMs) return { kind: 'none' };
  if (inRateBand) return { kind: 'rate', rate };
  if (tuning.boundarySeek && abs <= BOUNDARY_SEEK_MAX_MS) return { kind: 'seek-at-boundary' };
  return { kind: 'seek-now' };
}
