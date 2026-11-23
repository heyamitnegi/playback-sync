import { monotonicNowMs as defaultMonotonicNowMs } from './server-clock';

/**
 * One alignment through seek-and-hold after a client joins its group.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * A client that joins and starts its stream directly, without a seek-and-hold,
 * can sit ~150ms off ON THE GLASS while its own drift reading (`currentTime`
 * against the clock) shows ~20ms — well inside the tolerance, so it is never
 * corrected. It reports itself healthy and is visibly early. A join that goes
 * through seek-and-hold lands right: the hold releases on time, `playDelayMs`
 * early, from a frame it has already shown.
 *
 * Measured on a four-display group, filmed at 30fps:
 *   - One display restarted, came up online, measured its clock normally, and
 *     took no correction at all. On the glass it switched 4–5 frames
 *     (~130–170ms) before the other three at every cut, while reporting
 *     +12..+27ms of drift.
 *   - A playlist change took that display through two seek-and-holds. The group
 *     was in step afterwards, and its clock offset had not moved
 *     (-49/-55/-45ms): the clock was not the cause.
 *   - All 21 restarts in one session that had a seek-and-hold within 90s of
 *     boot came back in step. The only restart without one was the one off.
 *
 * Where a joining stream gets a head start (a run primed before it is shown),
 * almost every join is forced through a correction anyway, which hides this.
 * Without that head start every join takes the direct path, so the alignment is
 * made explicit here rather than left to chance.
 *
 * ── How ───────────────────────────────────────────────────────────────────
 *
 * Your renderer calls {@link request} when it decides a join (a new plan
 * version, a boot, a re-decided join). The first drift check that STARTED after
 * that request takes it: once it has a full window of readings it aligns
 * through seek-and-hold even if the drift is inside the tolerance. Any seek or
 * hold the stream makes on its own settles it too — that path already lands
 * right. A check that started before the request belongs to the stream the join
 * replaces, and is left alone.
 *
 * Only worth doing on a device that corrects by seek-and-hold
 * (`SeekProfile.holdMode`). A device whose seeks land has no hold to align
 * with; there the request should simply be dropped — this class does not know
 * about profiles, so that check belongs to the caller.
 *
 * An instance rather than module state, so two players on one page do not share
 * one request between them.
 */
export class JoinAlignment {
  private requestedAtMs: number | null = null;
  private readonly now: () => number;

  constructor(options: { monotonicNowMs?: () => number } = {}) {
    this.now = options.monotonicNowMs ?? defaultMonotonicNowMs;
  }

  /** A join was decided: align once after it. */
  request(): void {
    this.requestedAtMs = this.now();
  }

  /**
   * Whether a drift check that started at `checkStartedMs` (a monotonic
   * reading) should still align once. Only a check started after the request:
   * an older one is the stream the join replaces.
   */
  pendingFor(checkStartedMs: number): boolean {
    return this.requestedAtMs !== null && checkStartedMs >= this.requestedAtMs;
  }

  /** Done: aligned, or a correction already went through the same path. */
  settle(): void {
    this.requestedAtMs = null;
  }

  /** Whether an alignment is outstanding at all, regardless of which check. */
  get pending(): boolean {
    return this.requestedAtMs !== null;
  }
}
