/**
 * Spreading repeating work out across a fleet.
 *
 * Every timer in a client starts when the client starts, so a fleet that boots
 * together beats together — and because a fixed interval never drifts, they stay
 * in phase indefinitely. A site-wide power restore, a server restart, or simply
 * installing the same build everywhere is enough to line them up. The server
 * then sees its whole estate arrive inside the same few milliseconds and has to
 * be sized for that spike rather than for the average, even though the total
 * request count is identical either way.
 *
 * Jitter is the standard fix: keep the same average rate, randomise each
 * individual wait a little, and the fleet smears itself out within a cycle or
 * two and stays that way.
 */

/**
 * ±20%: enough to fully de-phase a fleet within a couple of cycles, small enough
 * that no interval's *meaning* changes (a 15s heartbeat stays 12–18s, which is
 * still comfortably inside a 5-minute offline threshold).
 */
export const DEFAULT_SPREAD = 0.2;

/**
 * A repeating interval, randomised by ±`spread` around its nominal value.
 *
 * The average stays exactly `intervalMs`, so nothing that reasons about the
 * long-run rate (offline thresholds, throttle budgets, expected row counts)
 * needs to change.
 */
export function jitteredInterval(
  intervalMs: number,
  spread: number = DEFAULT_SPREAD,
  random: () => number = Math.random,
): number {
  if (intervalMs <= 0) return intervalMs;
  const offset = (random() * 2 - 1) * spread;
  // Never return a negative or zero delay: a 0ms timer on slow hardware is a
  // busy loop, and some of these callbacks re-enter their own scheduler.
  return Math.max(1, Math.round(intervalMs * (1 + offset)));
}

/**
 * A one-shot delay uniformly spread across `0..maxMs`, for reacting to a push
 * that every client receives at once.
 *
 * Unlike {@link jitteredInterval} this deliberately has no lower bound — some
 * clients should react immediately, and the point is only that they do not *all*
 * react immediately.
 */
export function jitteredDelay(maxMs: number, random: () => number = Math.random): number {
  if (maxMs <= 0) return 0;
  return Math.round(random() * maxMs);
}
