# Contributing

Thanks for taking a look.

## Getting set up

```bash
npm install
npm test        # 139 tests, ~0.5s
npm run demo    # two-window demo on :8080
```

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

CI runs all three on Node 18, 20 and 22.

## How this library is written

Two rules keep it testable, and they are worth knowing before you add anything:

**Timing decisions are pure functions.** Nothing in `src/` reads `Date.now()`,
sets a timer, or touches the DOM — the caller measures and passes values in. That
is what makes *"two clients whose clocks are 45 seconds apart agree on the
position"* a unit test rather than something only two physical devices could
show. `ClockSync` is the one deliberate exception, and even its tests drive fake
timers and a hand-cranked monotonic clock.

**Comments explain why, not what.** Much of the value here is hardware behaviour
that is not obvious and not written down anywhere else — panels whose seeks land
a second late, clocks that reset to 1970 after a power cut, the one-way delay
that makes a device on slow wifi lag a device on a LAN. If you fix something that
only reproduces on real hardware, please say so in a comment. The next person
will not have your panel.

## Tests

Every behaviour change needs a test, and the test should state the *reason* it
exists, not just the assertion. Compare:

```ts
// bad
it('returns 4000', ...)

// good
it('refuses a measurement it cannot trust rather than clamping it', ...)
```

## Reporting a hardware quirk

Issues describing real device behaviour are especially welcome, even without a
fix. Please include the device, OS version, and what you measured — numbers are
what make a quirk actionable.
