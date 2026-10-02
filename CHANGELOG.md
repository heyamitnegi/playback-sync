# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/heyamitnegi/playback-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/heyamitnegi/playback-sync/releases/tag/v0.1.0
