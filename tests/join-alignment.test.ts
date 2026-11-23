import { describe, expect, it } from 'vitest';
import { JoinAlignment } from '../src/join-alignment';

/** A monotonic reading the test moves by hand. */
function harness() {
  let monotonicMs = 10_000;
  return {
    align: new JoinAlignment({ monotonicNowMs: () => monotonicMs }),
    now: () => monotonicMs,
    advance(ms: number) {
      monotonicMs += ms;
    },
  };
}

describe('JoinAlignment', () => {
  it('asks for nothing until a join is decided', () => {
    const h = harness();
    expect(h.align.pending).toBe(false);
    expect(h.align.pendingFor(h.now())).toBe(false);
  });

  it('is taken by a drift check that started after the join', () => {
    // The point: a client that joins and starts its stream directly can sit
    // ~150ms off on the glass while reporting ~20ms of drift — inside the
    // tolerance, so it is never corrected. The alignment forces one
    // seek-and-hold, which lands right.
    const h = harness();
    h.align.request();
    h.advance(500);
    expect(h.align.pendingFor(h.now())).toBe(true);
  });

  it('leaves a check that started before the join alone', () => {
    // That check belongs to the stream the join replaces. Aligning it would
    // correct the outgoing stream and let the incoming one start unaligned —
    // exactly backwards.
    const h = harness();
    const checkStartedMs = h.now();
    h.advance(500);
    h.align.request();
    expect(h.align.pendingFor(checkStartedMs)).toBe(false);
  });

  it('takes a check that started in the same instant as the join', () => {
    const h = harness();
    h.align.request();
    expect(h.align.pendingFor(h.now())).toBe(true);
  });

  it('aligns once, not on every check after the join', () => {
    const h = harness();
    h.align.request();
    h.advance(500);
    expect(h.align.pendingFor(h.now())).toBe(true);
    h.align.settle();
    h.advance(500);
    expect(h.align.pendingFor(h.now())).toBe(false);
    expect(h.align.pending).toBe(false);
  });

  it('is settled by a correction that went through the same path anyway', () => {
    // Any seek or hold the run makes on its own already lands right, so there
    // is nothing left to align.
    const h = harness();
    h.align.request();
    h.align.settle();
    expect(h.align.pending).toBe(false);
  });

  it('asks again on the next join', () => {
    const h = harness();
    h.align.request();
    h.align.settle();
    h.advance(60_000);
    h.align.request();
    expect(h.align.pendingFor(h.now())).toBe(true);
  });

  it('keeps two clients on one page from sharing a request', () => {
    // Why this is an instance and not module state.
    const h = harness();
    const other = new JoinAlignment({ monotonicNowMs: h.now });
    h.align.request();
    expect(other.pending).toBe(false);
    expect(h.align.pending).toBe(true);
  });
});
