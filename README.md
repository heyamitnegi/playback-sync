# playback-sync

Keep many screens playing the same thing at the same moment — without them
talking to each other.

```bash
npm install playback-sync
```

Zero runtime dependencies. ESM + CJS + types. Runs anywhere JavaScript does:
browsers, TV firmware, Node, React Native.

```ts
import { ServerClock, resolveCyclePosition, itemAt } from 'playback-sync';

const clock = new ServerClock();   // learns what the server's clock reads
clock.observe(roundTrip);          // feed it your request timings

const at = resolveCyclePosition(plan, clock.nowMs());
if (at?.phase === 'running') {
  play(itemAt(myItems, at.position.index), at.position.elapsedInPositionMs);
}
```

Every screen running that lands on the same frame at the same moment — whether
it booted an hour ago or five seconds ago.

**This is not a player.** It is the timing logic that keeps your own players in
step. You bring the HTTP, the rendering and the media; it decides *what should be
on screen right now*.

---

## See it work

```bash
git clone https://github.com/heyamitnegi/playback-sync && cd playback-sync
npm install && npm run demo
```

Open http://localhost:8080 in **two browser windows**, side by side. They tick in
step. Then hit **"Skew my clock +45s"** in one — that window's device clock is now
45 seconds wrong, and it *stays in step anyway*, while the naive reading beside it
falls apart. That is the whole library in one screen.

---

## Why not the obvious approaches

- **Start them together and let them run.** Timer error accumulates in one
  direction. Chaining `setTimeout` off each item's duration drifts screens apart
  over a day.
- **Broadcast a "play now" signal.** It reaches each client at a different
  moment, baking network jitter into the misalignment permanently — and a client
  that was offline when it fired never gets it.
- **Trust each device's clock.** Unattended hardware is routinely minutes wrong,
  and no two devices are wrong by the same amount.

This library takes a different line: **nothing is negotiated and no client tells
any other client anything.** Every client resolves the same schedule against the
same clock, so they agree by arithmetic. The schedule is anchored to an absolute
instant, so hearing about it late changes nothing.

---

## Quick start

### Server — author a plan

```ts
import { planFrom } from 'playback-sync';

const plan = planFrom({
  durations: [25.1, 12.433, 20.02],  // seconds, in cycle order
  serverNowMs: Date.now(),
  startLeadSeconds: 6,               // time for every client to get ready
});
```

Send the same `plan` to every client in the group, and expose a time endpoint
that stamps **both** edges:

```js
app.get('/time', (req, res) => {
  const serverReceivedAtMs = Date.now();
  res.json({ serverReceivedAtMs, serverSentAtMs: Date.now() });
});
```

Both stamps matter: it lets clients subtract your server's own processing time
instead of charging it to the network. → [docs/clock.md](docs/clock.md)

### Client — keep a clock, resolve the position

```ts
import {
  ServerClock, ClockSync, receivePlan, resolveCyclePosition, itemAt,
} from 'playback-sync';

const clock = new ServerClock();

// Runs the measurement schedule: burst at startup, then once a minute,
// backing off on failure and re-measuring after a wake.
new ClockSync({
  clock,
  measure: async () => {
    const requestedAtMs = Date.now();
    const r = await fetch('/time').then((r) => r.json());
    return { requestedAtMs, ...r, receivedAtMs: Date.now() };
  },
}).start();

// Stamp the plan with when it arrived — the server cannot know that.
const requestedAtMs = Date.now();
const spec = await fetch('/plan').then((r) => r.json());
const plan = receivePlan(spec, { requestedAtMs, receivedAtMs: Date.now() });

// Then, whenever you need to know what to show:
const at = resolveCyclePosition(plan, clock.nowMs());
if (at?.phase === 'waiting') hold(at.startsInMs);
else if (at?.phase === 'running') {
  const item = itemAt(myItems, at.position.index);
  item ? play(item, at.position.elapsedInPositionMs) : holdBlank();
}
```

That is the core loop. Everything below makes it survive real hardware.

---

## The rest, as you need it

| Guide | Covers |
|---|---|
| **[docs/clock.md](docs/clock.md)** | Why the naive clock reading is wrong by construction, the four-timestamp fix, which sample to keep, and why the estimate must advance on a monotonic counter |
| **[docs/playback.md](docs/playback.md)** | Gaps, joining late without sitting blank, and supervising a joined stream instead of rebuilding the decoder at every boundary |
| **[docs/drift.md](docs/drift.md)** | Deciding on a median not a reading, rate correction vs seeking, and devices whose seeks land a second late |

---

## API

### Clock

| | |
|---|---|
| `ServerClock` | The group's clock: `nowMs`, `hasEstimate`, `observe`, `estimate`, `expectDiscontinuity`, `checkForClockJump` |
| `ClockSync` | The measurement schedule: `start`, `stop`, `remeasure(reason)` |
| `estimateClockOffset(rt, opts?)` | Four timestamps → `{ offsetMs, roundTripMs }`, or `null` if untrustworthy |
| `shouldAdopt(current, next, nowMs, opts?)` | Whether a fresh measurement beats the held one |
| `monotonicNowMs()` | `performance.now()` with a `Date.now()` fallback |

### Position

| | |
|---|---|
| `receivePlan(spec, stamps)` | Stamp a plan off the wire with when it arrived |
| `resolveCyclePosition(plan, nowServerMs)` | The playhead: `waiting`, or `running` with index, seek target, end instant, lap count |
| `itemAt(items, index)` | Your item at a position, or `undefined` for a gap |
| `nextPositionIndex(plan, index)` | The next position, wrapping — for preloading |
| `clockOffsetFromPlan` / `serverNowFromPlan` | Fallback offset from the plan alone, until the clock has measured |

### Schedule

| | |
|---|---|
| `syncSequence(plan, items)` | One entry per position; `null` for this client's gaps |
| `syncPhaseAt(plan, nowServerMs, joinAtMs?)` | Where the group is, as a cursor into the sequence |
| `syncJoinAtMs(plan, nowServerMs)` | When this client should put content up |
| `syncJoinOutOfReach(...)` | Whether a join was decided on a clock since corrected |
| `syncRunEndsAtMs` · `syncAlignment` · `syncStreamDrift` · `syncCursorInRun` | Joined-stream supervision |

### Drift & seek

| | |
|---|---|
| `steadyDriftMs(readings)` | Median — always decide on this, never one reading |
| `decideDriftCorrection(driftMs, tuning, rateActive)` | `none` / `rate` / `rate-reset` / `seek-at-boundary` / `seek-now` |
| `resolveSyncTuning(fromServer?, fromDevice?)` | Validated, clamped, layered settings |
| `afterPlainSeekMissed` · `learnLead` · `learnPlayDelay` · `planHold` · `readSeekProfile` | Late-landing seek handling |

### Authoring & utilities

| | |
|---|---|
| `planFrom({ durations, serverNowMs, startLeadSeconds })` | A complete plan |
| `slotsFrom(durations)` | Positions laid end to end, offsets clean to the millisecond |
| `jitteredInterval` / `jitteredDelay` | Keep a fleet from beating in phase |

---

## Design rules

**Never accumulate.** Position comes from an absolute instant and a modulo, every
time — never from adding up durations since this client started. A late timer
then costs one late frame instead of permanent drift.

**Refuse, don't clamp.** An untrustworthy measurement is dropped, not squeezed
into range. A bad measurement adopted puts a whole group confidently in the wrong
place; a bad measurement dropped costs one sample.

**Validate what comes off the wire.** Tuning values, stored profiles and plans
all arrive from somewhere you do not control. One typo in a tolerance is one
broken wall.

**Degrade to independent playback.** `resolveCyclePosition` returns `null` for a
degenerate plan rather than dividing by it. A group that is merely unsynchronised
beats a group showing nonsense.

---

## Development

```bash
npm install
npm test          # 135 tests, no DOM, no network, no real clocks
npm run typecheck
npm run build
npm run demo      # two-window demo on :8080
```

Every timing *decision* is a pure function over values the caller supplies, so
the library is testable without hardware. `ClockSync` is the one stateful
scheduler, and its tests drive fake timers and a hand-cranked monotonic clock, so
even cadence and backoff are asserted rather than waited for.

## License

MIT
