# The clock

Two clients agree because they resolve the same schedule against the same clock.
So *how well that clock is known* is exactly how well they agree. This is the
part of the library that earns its keep.

---

## Why your clock reading is wrong

The obvious way to learn the server's clock is
`serverTime - whenTheResponseArrived`. It is wrong **by construction**, always in
the same direction, and by an amount that differs per client:

> The server stamps its clock at some instant. The response then has to be
> finished, serialised, pushed across the network and parsed before the client
> can read that stamp. By the time it does, the server's clock has moved on by
> all of that — so the client concludes the server is *earlier* than it really
> is, and therefore that less time has elapsed since the cycle started than
> really has. It plays that far **behind** the group.

The error is the one-way delay, so the client with the slowest link lags the
most, and the client with the fastest link runs ahead of it.

In the field this shows up as *"the TVs are perfectly in sync but the laptop is
milliseconds ahead"* — a TV on wifi parsing JSON on a slow CPU, against a laptop
on the same LAN. Nothing is treating the platforms differently. The
**measurement** is.

```ts
// Two clients, same server, same schedule. Naive reading:
const tv     = { upMs: 180, downMs: 180 };  // believes server is 180ms earlier
const laptop = { upMs: 8,   downMs: 8   };  // believes server is 8ms earlier
// → 172ms apart on identical inputs, purely from how they are connected.
```

## The four-timestamp form

This is NTP's clock-filter arithmetic, which exists for exactly this problem.
Both ends stamp both edges:

```
T0  client sends            (client clock)
T1  server receives         (server clock)
T2  server answers          (server clock)
T3  client has the answer   (client clock)

offset    = ((T1 - T0) + (T2 - T3)) / 2
roundTrip = (T3 - T0) - (T2 - T1)
```

`T2 - T1` is the server's own processing time, and subtracting it is the whole
point of carrying both stamps: it takes the server's work *out* of the
measurement instead of charging it to the network. A request that spent 40ms
inside your server would otherwise be indexed as a 40ms-worse link — which
matters, because the endpoint is probably authenticated and your server is
probably not idle.

What survives is the assumption that the two network legs are symmetric. It is
never exactly true, and the residual error is **half the asymmetry** — tens of ms
on a bad link rather than the hundreds the naive formula gives away, and it no
longer scales with distance from the server.

Your endpoint:

```js
app.get('/time', (req, res) => {
  const serverReceivedAtMs = Date.now();
  res.json({ serverReceivedAtMs, serverSentAtMs: Date.now() });
});
```

Keep it cheap and unauthenticated-ish: no database, small body. It runs once a
minute per client.

## Which sample to keep

`ServerClock` keeps the measurement with the **shortest round trip**, not the
average. Averaging folds every slow sample back in; a short round trip simply has
less room to hide asymmetry in. That is NTP's rule, and for NTP's reason.

Three things override it:

| Rule | Default | Why |
|---|---|---|
| A disagreement bigger than `stepMs` is adopted immediately, however slow | 1s | The local clock was *set* — NTP landing after a cold boot, routine on Android. Every later reading moves by the step, so holding the pre-step offset keeps the client exactly one step out. |
| A held estimate older than `preferFreshAfterMs` loses to anything usable | 5 min | Otherwise the luckiest sample of the day wins the day, and the oscillator's drift accumulates underneath it unmeasured. |
| A round trip over `maxUsableRoundTripMs` is refused outright | 4s | Past that the symmetry assumption has more room in it than the estimate is worth. **Refused, not clamped** — a bad measurement adopted puts a whole group confidently in the wrong place. |

All three are constructor options. The defaults assume commercial display
hardware on ordinary networks; a satellite link or a high-grade oscillator wants
different numbers.

## Why the estimate advances on a monotonic counter

The obvious implementation holds an offset and returns `Date.now() + offset`.
That reintroduces, between measurements, the exact problem the measurement
solves: **`Date.now()` is the calendar, and the calendar gets set.**

A TV that boots with a wrong clock and picks up NTP a minute later, or an Android
box correcting itself on a schedule, moves `Date.now()` under a running cycle —
and every reading after the step is out by the step until the next sample happens
to land. Across a group that is one screen jumping position mid-cycle while its
neighbours hold.

So an adopted measurement is pinned to a `performance.now()` reading taken at the
same instant, and the estimate advances on *elapsed time* from there. Setting the
local clock then has no effect on playback at all. The calendar is consulted only
to take a new measurement (whose T0/T3 come from it and cancel out) and to notice
that it moved.

The residual is the local oscillator's rate error against the server's — genuine
drift, single-digit ms over a sampling interval, corrected by the next sample.

### Noticing a jump

```ts
clock.checkForClockJump();   // → the jump in ms, or null
clock.expectDiscontinuity(); // → next usable sample wins, however slow
```

`checkForClockJump()` compares the calendar against the monotonic counter. It is
the one wake detector that needs **no platform event**, which matters because
whether `visibilitychange` ever reaches code running inside a TV's embedded
browser is a firmware property.

It catches both causes of a divergence, which cannot be told apart from inside:

- **The clock was set.** `nowMs()` deliberately does not follow it. The next
  measurement's offset moves by the step, which the step rule adopts on sight.
- **The device slept.** On Linux the monotonic counter does not advance through a
  suspend, so after a wake `nowMs()` is behind by however long it was down. The
  calendar is right this time, so the next measurement's offset is *unchanged* —
  nothing in the ranking can see the problem, and only the forced adoption
  rescues it.

## Keeping it fresh

Measuring once at boot is the common mistake. `ClockSync` runs the schedule; you
supply the request.

```ts
const sync = new ClockSync({
  clock,
  measure: async () => {
    const requestedAtMs = Date.now();
    const r = await fetch('/time').then((r) => r.json());
    return { requestedAtMs, ...r, receivedAtMs: Date.now() };
  },
});
sync.start();

window.addEventListener('online', () => sync.remeasure('network-online'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) sync.remeasure('page-visible');
});
socket.on('reconnect', () => sync.remeasure('socket-reconnected'));
```

| | |
|---|---|
| **Burst of 3 at startup** | One sample can be unlucky — a retransmit, a GC pause, a burst of wifi contention. The fastest of three decides where the client sits for its first minute, which is the minute it is most likely to be watched. |
| **One sample a minute after that** | Sized against *drift*, not the network. A longer interval lets drift accumulate; a shorter one buys nothing measurable. |
| **A 2-minute settling window** | For `settleWindowMs` after `start()`, samples come every 10s and each one **replaces** the held estimate rather than competing with it on round trip. See below. |
| **3-second retry before the first success** | A device whose very first sample fails is usually still bringing its link up, not talking to a server without a time endpoint. See below. |
| **10-minute backoff on failure** | A server with no time endpoint answers 404 forever. Backing off stops a request a minute for the life of the device, while still recovering on its own once the server is fixed — no reboot, no site visit. Tell this case apart with `isUnsupported`. |
| **Jump check every 5s** | Self-detected wakes, per above. |
| **Coalescing** | One wake fires visibility + reconnect + heartbeat within seconds. All of them together are one reason, not four bursts. A detected jump is never coalesced — it is direct evidence, and the monotonic reading the window is measured on is the very thing a suspend stops. |

`measure` returns `null` for "nothing to measure against yet" (not signed in, no
endpoint configured) — not a failure, no backoff, and it does not spend a sample
of the startup burst either, because a client that is about to sign in needs
those samples at the moment it does. **Throw** when the request genuinely
failed.

### The settling window

The boot estimate is the most protected and the least trustworthy. A sample
taken seconds after start can have an excellent round trip and still be stale
minutes later, because what moved was not the network — it was the device's own
calendar. A TV or embedded board corrects its clock by NTP shortly after boot,
and when it does so by **slewing** rather than stepping, `checkForClockJump`
never fires: there is no discontinuity to catch, only a held offset quietly
going wrong by however far the clock was walked.

Measured on a four-display group: two devices restarted from the remote, and
their offsets moved by 894ms and 554ms across the reboot while their untouched
neighbours moved by 29ms and 17ms. Round trips throughout were 60–83ms, which
bounds the error from network asymmetry at about ±40ms — two orders off what was
seen. The estimates then sat frozen for 397s, because `shouldAdopt` keeps the
fastest round trip it has seen and nothing could displace them.

So inside the window the newest reading wins outright rather than the fastest:
while the calendar is still being walked, recency beats round trip. Samples
inside the startup burst are exempt — the ranking is already doing the right
thing there, and forcing all three would throw away the fastest of them. Set
`settleWindowMs: 0` to switch it off.

### Before the first measurement

A panel is not on the network the instant the process starts. If the first
sample lands in that window it fails, and the long backoff — written for a
server with no time endpoint — catches a device that is merely still booting.

What that costs is not a missing measurement, it is a **wrong one that nothing
can see**. The client joins its group on the coarse single-stamp estimate from
the plan, and because the join and the drift check both read that same clock, it
reports itself healthy (~20ms of drift) while being visibly out of step on the
glass. Measured on a display that restarted at 10:13: the held offset sat frozen
at exactly -475ms for ten minutes reporting -17 to -27ms of drift, then jumped
+505ms the moment the backoff ended and the display snapped into sync on its
own. A restart whose first sample happened to succeed came back in sync
immediately — which is why it only went wrong "sometimes".

So before the first success, failures retry every `bootRetryMs` for
`bootRetryWindowMs`, keeping the burst. A server that has no endpoint answers
rather than fails, so give it `isUnsupported` and it goes straight to the
backoff instead:

```ts
new ClockSync({
  clock,
  measure,
  isUnsupported: (err) => (err as { status?: number }).status === 404,
});
```

## Checking it on real hardware

```ts
clock.estimate();  // → { offsetMs, roundTripMs, ageMs, source }
```

`offsetMs + roundTripMs` read off two clients in one group **bounds how far apart
they can be**. It is the only honest way to check alignment without a camera.
