# Drift correction

A stream that has been running for a while will not stay exactly where the clock
says it should be. This is policy only — no media element, no timers. You
measure, this decides, you apply.

---

## Always decide on the median

```ts
const drift = steadyDriftMs(recentReadings);   // median of the last 5
const action = decideDriftCorrection(drift, tuning, rateActive);
```

Commercial signage panels scatter **±50ms reading to reading** on
`video.currentTime`. Consumer TVs barely at all. With a 100ms tolerance, a single
reading past it is as often noise as drift — and on those panels every correction
is a visible artifact.

At a 500ms check interval, five samples is 2.5s of readings. A real step (a
rebuffer) shows in the median after three of them, which is fast enough.

---

## What it decides

| Action | Apply |
|---|---|
| `none` | Nothing. |
| `seek-now` | `video.currentTime = target` |
| `seek-at-boundary` | Queue the seek for the next clip cut, which already hides the jump |
| `rate` | `video.playbackRate = action.rate` |
| `rate-reset` | `video.playbackRate = 1` |

Defaults: nothing within 100ms, seek past it. Everything else is opt-in.

| Setting | Default | Note |
|---|---|---|
| `toleranceMs` | 100 | Side by side during motion, a viewer sees 50–100ms |
| `checkIntervalMs` | 500 | |
| `rateCorrection` | `false` | Whether a display changes `playbackRate` smoothly on its hardware pipeline — or stutters, shifts the audio's pitch, or ignores it — is per-device. Test on one unit before enabling on a fleet. |
| `maxRateAdjust` | 0.02 | ±2% |
| `seekAboveMs` | 1000 | With rate correction on, drift past which it seeks instead |
| `boundarySeek` | `false` | Hold the seek for the next cut |

Rate correction has **hysteresis**: it engages past the tolerance and runs until
the drift is inside *half* of it, so a stream sitting near the threshold does not
toggle its rate on every check.

### Turn on rate correction before you touch the tolerance

Measured on a four-display group, one setting changed at a time:

| Change | Effect |
|---|---|
| `rateCorrection: false` → `true` | Missed corrections **41% → 0.7%** of checks |
| Moving `toleranceMs` | Barely registered |

This is the opposite of where tuning effort naturally goes. A tighter tolerance
*feels* like the alignment knob and is not: holds settle at 105–144ms against a
100ms tolerance, so a tolerance much below that asks for a correction the device
cannot land — more visible corrections, not tighter sync. Past that point what
remains is the devices' own clocks, which nothing in this file reaches.

The default stays `false` because a fleet-wide rate change is not something a
library should switch on for you, and the stutter/pitch behaviour genuinely is
per-device. Measure it on one unit, then roll it out — a real deployment running
this looks like:

```ts
{ toleranceMs: 70, checkIntervalMs: 500, rateCorrection: true,
  maxRateAdjust: 0.02, seekAboveMs: 1000, boundarySeek: true }
```

---

## Validating settings off the wire

```ts
const { tuning, source } = resolveSyncTuning(fromServer, fromDevice);
```

Layers defaults ← server ← device override. Both arguments are `unknown` on
purpose: they come off a wire or out of local storage.

Every field is taken only if valid, and clamped. A tolerance of `0` would seek
every stream on every check, and on a TV each seek can flash black — so the
bounds are the floor of what could be sane, not a suggestion. One typo in a
tuning value is one broken wall.

`source` tells you which layer won (`default` / `server` / `device-override`).
Report it: a forgotten override on a production display should be visible, not
silent.

---

## Devices whose seeks land late

Measured on commercial signage panels (Tizen 7):

> A seek issued while the stream plays lands **0.36–1.1s behind** its target,
> every time, never ahead.

The pipeline takes most of a second to seek and the stream stands still
meanwhile, so the seek's own duration is lost. Worse, it varies seek to seek — so
two devices started in step **drift apart because of their corrections**.
Consumer TVs and desktops seek at once and never show this.

The fix inverts the correction:

1. **Pause, and seek *ahead*** of the group by `leadMs` — more than the seek takes.
2. Once it lands, read where it actually is. Paused, the reading is stable.
3. **Hold that frame** until the group's clock catches up, then play —
   `playDelayMs` early, because a paused pipeline takes a moment to start moving.

The seek's duration no longer matters, only how precisely `play()` starts — which
on these panels is consistent. Two devices started together play in step; only
their seeks scatter.

```ts
// Detect it once from a plain seek that settled behind:
profile = afterPlainSeekMissed(profile, driftAfterSeekMs, tuning.toleranceMs);

// Then every hold teaches it:
profile = learnLead(profile, leadUsedMs, aheadMs);
profile = learnPlayDelay(profile, residualMs);

// And each correction asks what to do:
const plan = planHold(aheadMs, profile.playDelayMs);
// → { kind: 'hold', waitMs } | { kind: 'behind' } | { kind: 'too-far' }
```

Both figures are learned per device and worth persisting across restarts —
`readSeekProfile(raw)` validates whatever comes back out of storage.

`learnLead` **rises at once and falls slowly**: one slow seek raises the lead
immediately, because the next would otherwise land behind; one quick seek only
nudges it down, because the one after may be slow again.

### When the lead pins at its ceiling

`learnLead` only decays when the lead it wants is no larger than the one it has.
Once a device's seeks genuinely cost more than `LEAD_MAX_MS` (3s), the wanted
lead is larger on *every* reading — so the rising branch wins every time and the
falling one is unreachable. The lead pins at the ceiling permanently, and
because the profile is persisted, it survives reloads and power cuts.

It is worse than a stuck number. A larger lead seeks further ahead, which on a
keyframe-bound stream lands on a worse keyframe, which reads as a slower seek,
which asks for a larger lead. **The learner feeds its own failure.**

Measured on a four-display group: every device pinned at `leadMs: 3000` with
nothing held — holds landing *behind* the group and playing on immediately — and
drift p95 ≈ 3000ms on all four. Clearing the stored profile by hand put two of
them back to a p95 of 60–95ms needing no corrections at all.

```ts
// Count holds that missed in a row, and hand the count over:
profile = afterPinnedMisses(profile, consecutiveMisses);
```

After `PINNED_MISS_LIMIT` (3) consecutive misses with the lead already at the
ceiling, the learned pair is relearned from the default. Three rather than one:
a single miss is ordinary and the lead is supposed to absorb it. `holdMode` is
**kept** — the device does still need holds, it needed different numbers.

It is not a cure for a device whose seeks are genuinely that slow; two of the
four re-pinned within four minutes of a clear. It makes a pinned profile
impossible to get permanently stuck in, which is what the group was stuck in.

The cost is a held frame of about 500ms instead of a visible jump landing
somewhere wrong. A landing further ahead than `HOLD_MAX_MS` (2.5s) plays on
instead and is judged a miss — a multi-second freeze on one screen of a group is
worse than the drift.

On a healthy stream a correction is needed once after start, not every minute.
