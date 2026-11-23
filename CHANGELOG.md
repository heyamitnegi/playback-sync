# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Documented that `toleranceMs` and `rateCorrection` are **coupled**. How tight
  the tolerance may go is set by what a device can land: a seek-and-hold on
  commercial signage panels settles at 105–144ms, so a tolerance below that asks
  for a correction the device cannot complete. With rate correction on there is
  no seek to land and the same panels run at 70. Defaults are unchanged.


## [0.2.0] - 2026-11-24

Brings the package up to the sync logic running in the player it was extracted
from. Four behaviour changes, each measured on hardware before it was made.

### Added

- **`afterPinnedMisses`** — an escape from a seek lead that has ratcheted to
  `LEAD_MAX_MS` and cannot come back down. `learnLead` only decays when the lead
  it wants is no larger than the one it has, so a device whose seeks genuinely
  cost more than the ceiling pins there permanently — and a larger lead lands on
  a worse keyframe, reads as a slower seek, and asks for a larger lead again.
  After `PINNED_MISS_LIMIT` (3) consecutive missed holds at the ceiling, the
  learned pair is relearned from the default; `holdMode` is kept.
- **`JoinAlignment`** — one seek-and-hold alignment after a client joins its
  group. A join that starts its stream directly can sit ~150ms off on the glass
  while reporting ~20ms of drift, inside the tolerance, so it is never
  corrected.
- **`SYNC_JOIN_GRACE_MAX_CYCLE_SHARE`** — the join grace is now capped at half
  the cycle as well as at position 0's own duration.
- **`ClockSyncOptions.settleWindowMs` / `settleSampleMs`** — a window after
  `start()` in which samples come every 10s and each replaces the held estimate
  outright. A device that slews its clock to NTP after boot fires no jump, so a
  pristine boot reading could otherwise never be displaced.
- **`ClockSyncOptions.bootRetryMs` / `bootRetryWindowMs`** — a failure before
  the first successful measurement retries in seconds rather than standing down
  for the whole backoff.
- **`ClockSyncOptions.isUnsupported`** — tells "this server has no time
  endpoint" (straight to the backoff) apart from "this link is not up yet" (the
  boot retry). Defaults to never, so every failure gets the fast retry first.

### Changed

- **Documented what tuning actually buys.** `drift.ts` said the effect of
  `playbackRate` on display hardware "has not been" measured. It has: on a
  four-display group, turning rate correction on took missed corrections from
  41% to 0.7% of checks, while moving `toleranceMs` barely registered. A
  tolerance much below ~105ms asks for a correction the device cannot land. The
  default stays `rateCorrection: false` — a fleet-wide rate change is not a
  library's call — but the guidance is now "turn this on first", not "this is
  unproven".
- **A one-position playlist now holds for the next lap.** The join grace was
  capped at position 0's own duration, which on a single-position cycle *is* the
  cycle — the cap could never bite, so the group never held and every rejoin
  seeked into the middle of the clip, on exactly the devices whose seeks land
  late. A short opener inside a long cycle is unaffected.
- **A `null` measurement no longer spends a sample of the startup burst.**
  "Nothing to measure against yet" keeps the burst, so a client that is about to
  sign in still has all three samples at the moment it does. It also comes back
  on the routine (or settling) cadence rather than the 700ms burst gap.
- **`ClockSync` samples every 10s for the first two minutes** rather than going
  straight to the routine minute.


## [0.1.0] - 2026-10-03

First release.

### Added

- **Clock** — `estimateClockOffset` and `shouldAdopt`: NTP-style four-timestamp
  offset estimation, keeping the sample with the shortest round trip.
- **`ServerClock`** — holds the estimate on a monotonic base, so setting the
  local clock does not move playback. Detects both a clock being set and a
  device waking from sleep.
- **`ClockSync`** — the measurement schedule: a burst at startup, once a minute
  after, backing off on failure, re-measuring after a wake, and coalescing the
  several signals one wake fires.
- **Position** — `resolveCyclePosition`, `itemAt`, `nextPositionIndex`,
  `receivePlan`, and the plan-derived fallback offset.
- **Schedule** — `syncSequence`, `syncPhaseAt`, `syncJoinAtMs`,
  `syncJoinOutOfReach`, and joined-stream supervision via `syncRunEndsAtMs`,
  `syncAlignment`, `syncStreamDrift` and `syncCursorInRun`.
- **Drift** — `steadyDriftMs`, `decideDriftCorrection` and `resolveSyncTuning`,
  with rate correction and boundary seeking behind flags.
- **Seek compensation** — `afterPlainSeekMissed`, `learnLead`, `learnPlayDelay`,
  `planHold` and `readSeekProfile`, for devices whose seeks land late.
- **Authoring** — `planFrom` and `slotsFrom` for the server side.
- **Jitter** — `jitteredInterval` and `jitteredDelay`, to stop a fleet that
  booted together from hitting the server in the same instant.
- A two-window demo under `examples/two-screens`.

[Unreleased]: https://github.com/heyamitnegi/playback-sync/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/heyamitnegi/playback-sync/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/heyamitnegi/playback-sync/releases/tag/v0.1.0
