# Position, gaps and joining

Everything here is a pure function over a plan and a server-clock reading. No
timers, no `Date.now()`, no DOM — which is what makes "a client joining an hour
late lands where the group is" a unit test rather than something only two
physical devices could show.

---

## Getting a plan onto a client

The server sends a `SyncPlanSpec` — only what the server knows. The client turns
it into a `SyncPlan` by stamping when it arrived, because the server cannot know
that:

```ts
const requestedAtMs = Date.now();
const spec = await fetch('/plan').then((r) => r.json());
const plan = receivePlan(spec, { requestedAtMs, receivedAtMs: Date.now() });
```

They are two types rather than one with optional fields precisely so this cannot
be forgotten: nothing that resolves a position accepts a bare wire plan.

Take `receivedAtMs` on the line right after the response resolves, not further
downstream. Passing `requestedAtMs` too costs one variable and removes a bias —
without it, the plan's fallback offset is late by the entire one-way delay, in
the same direction every time, by an amount that differs per client. (Once
`ServerClock` has a measurement it supersedes this entirely; the fallback only
covers a boot's first frames.)

---

## Never accumulate

The one idea underneath all of it:

> A client **never** derives its position by accumulating item durations from
> where it started. It derives it from an absolute instant and a modulo, every
> single time.

Timer error is one-directional and accumulates. Chaining `setTimeout` off each
item's duration drifts a group apart over a day. Recomputing from `startAtMs`
makes a late timer cost one late frame and nothing more — and makes late arrival
a non-event:

```ts
const at = resolveCyclePosition(plan, clock.nowMs());
// A client joining an hour in computes exactly what one up since the start does.
```

`resolveCyclePosition` returns `null` for a degenerate plan (no positions, or a
zero-length cycle). Fall back to ordinary independent playback rather than divide
by it — a group that is merely unsynchronised is much better than a group showing
nonsense.

---

## Gaps are first-class

Every client in a group receives the **same** slot list, describing the whole
cycle as authored — including positions where that particular client shows
nothing.

```ts
syncSequence(plan, [{ orderIndex: 0 }, { orderIndex: 2 }]);
// → [item0, null, item2]   ← three entries, not two
```

A client that did not know position 1 existed would slide its next item forward
and drift off the group permanently. So a gap holds blank for the position's full
duration, and it is an **entry in the sequence** rather than an omission from it.

It also breaks a run, which is correct — a stream cannot span a hole.

---

## Joining late

A client that reboots mid-cycle should not sit blank, and should not start
wherever the modulo happens to land.

```ts
const joinAt = syncJoinAtMs(plan, clock.nowMs());
const phase = syncPhaseAt(plan, clock.nowMs(), joinAt);
```

`syncJoinAtMs` always returns a position boundary **on the group's own grid**
(`startAtMs + n × cycle + a position's offset`). Every other client crosses that
same instant — they all resolve the same schedule and do the same arithmetic — so
the group changes together from this client's very first frame.

A boundary rather than mid-item, too, so the client starts from the head with
content primed during the hold, instead of seeking into the middle of a clip on a
device whose seeks land late.

Which boundary:

| Situation | Join |
|---|---|
| The plan has not started yet | Its own instant, position 0, with everyone else |
| Within `SYNC_JOIN_GRACE_MS` (20s) of a lap's start | That lap, immediately — seek the little that was missed |
| Otherwise | The **next position**, not the next lap |

That last row matters. Holding for the next lap means a client rebooting
mid-playlist sits blank for up to the *whole playlist* while its neighbours play
on. Joining at the next item bounds the wait to one item.

The grace is capped at position 0's own duration — past that the top of the lap
is genuinely over, and joining it would put the client on position 1 while
calling it position 0.

### When the clock moves under a decided join

```ts
if (syncJoinOutOfReach(plan, joinAt, clock.nowMs())) {
  joinAt = syncJoinAtMs(plan, clock.nowMs());  // decide again
}
```

A join is decided once. If it was decided on a clock that has since been
corrected backwards, the client holds for as long as that correction was. Seen in
the field after a power cut reset a device's clock: its join was decided on a
reading 28 years fast, the measured clock that replaced it seconds later changed
nothing, and the screen held `"starting in 895248963s"`.

Deciding again on the better clock is always safe — same rule, same grid.

---

## Joined runs: don't rebuild the decoder

If you concatenate consecutive clips into one stream (an HLS playlist, an MSE
buffer), **do not** hand the clock every position boundary.

The first design did exactly that: each position was a hand-over, re-derived from
`startAtMs` and a modulo. It is exact, and on real hardware it is unwatchable. A
hand-over between two videos rebuilds the decoder — and on a single-decoder panel
the incoming pipeline takes the video plane away from the clip still on screen,
which then has nothing to present. It shows as a black screen between every video
item and again at the end of every lap.

The fix is not a better hand-over but **fewer of them**: join the run, and let
the clock *supervise* the stream instead of driving it.

```ts
if (syncCursorInRun(sequence.length, run, cursor.index)) {
  // The stream already holds this position. Do not tear anything down.
  const align = syncAlignment(plan, cursor, run, clock.nowMs());
  if (align) {
    const { driftSeconds } = syncStreamDrift({
      currentTimeSeconds: video.currentTime,
      alignToSeconds: align.seconds,
      periodSeconds: align.periodSeconds,
    });
    // → feed driftSeconds * 1000 into decideDriftCorrection (see drift.md)
  }
}

const capAtMs = syncRunEndsAtMs(plan, cursor, run);  // when the run gives way
```

- The cursor and the cap still come from the clock, so a run **starts and ends**
  on the group's instants.
- Inside a run, transitions come from the stream. A decoder plays at 1x by its
  own media clock, so they land where the schedule says — and `syncAlignment` is
  what catches the case where they do not.

`syncAlignment` returns stream-local seconds, because that is the only coordinate
a concatenated run has. For a run spanning the whole cycle it also returns
`periodSeconds`, so the pipeline aligns to whichever repetition it is nearest
rather than being dragged back to the first.

It returns `null` once the group is past the run's end: the cap is about to fire,
and seeking a stream on its way out flushes a pipeline for a frame nobody sees.

**The trade, stated plainly:** alignment inside a run is as good as the stream's
own timing plus a correction threshold, where a per-position hand-over would
re-derive it exactly every time. In exchange there is no rebuild, and therefore
nothing black.

---

## Reading `syncRunEndsAtMs` correctly

It counts from where the **run** began, not from the cursor. A client joining a
group can enter a run part-way; counting the run's whole length from the cursor
puts the end one position late for every position in, so the next item is never
prepared ahead and arrives on a later tick.
