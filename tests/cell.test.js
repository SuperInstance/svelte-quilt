import { describe, it, expect } from 'vitest';
import { bindCell, derivedCell, effectCell, witnessed, flush } from '../src/lib/cell.svelte.js';

describe('BIND — $state', () => {
  it('creates a cell; set bumps version and witness; subscribe/unsubscribe (FORGET) works', () => {
    const price = bindCell(100, { id: 'price' });
    expect(price.value).toBe(100);
    expect(price.version).toBe(0);
    expect(price.witness).toBe('price@0');

    const seen = [];
    const off = price.subscribe((v) => seen.push(v));

    price.set(101.5);
    expect(price.value).toBe(101.5);
    expect(price.version).toBe(1);
    expect(price.witness).toBe('price@1');

    price.update((v) => v + 1);
    expect(price.version).toBe(2);

    // FORGET at the listener level: unsubscribe stops notification
    off();
    price.set(200);
    expect(seen).toEqual([101.5, 102.5]);
  });
});

describe('VIEW — $derived', () => {
  it('memoizes: multiple reads compute once; recomputes only when a dep changes', () => {
    const price = bindCell(100, { id: 'price' });
    const drift = bindCell(1.2, { id: 'drift' });
    const delta = derivedCell([price, drift], (p, d) => (p * d) / 100, { id: 'delta' });

    expect(delta.value).toBe(1.2);
    expect(delta.value).toBe(1.2);
    expect(delta.value).toBe(1.2);
    expect(delta.computes).toBe(1); // memoized across reads

    drift.set(2.4);
    expect(delta.value).toBe(2.4);
    expect(delta.computes).toBe(2); // one recompute for one changed input

    price.set(50); // drift unchanged
    expect(delta.value).toBe(1.2);
    expect(delta.computes).toBe(3);
  });

  it('auto-tracks when no deps array is given (the compiler finds the LINKs)', () => {
    const a = bindCell(2, { id: 'a' });
    const b = bindCell(3, { id: 'b' });
    const sum = derivedCell(null, () => a.value + b.value, { id: 'sum' });

    expect(sum.value).toBe(5);
    expect(sum.computes).toBe(1);
    b.set(4);
    expect(sum.value).toBe(6);
    expect(sum.computes).toBe(2);
  });
});

describe('W13 — witness arithmetic', () => {
  it('w(out) = w(in) ∪ {cell@ver} through a 3-cell chain, latest marks win', () => {
    const c1 = bindCell(1, { id: 'c1' });
    const c2 = derivedCell([c1], (x) => x + 1, { id: 'c2' });
    const c3 = derivedCell([c2], (x) => x * 10, { id: 'c3' });

    expect(c3.value).toBe(20);
    expect(c3.witnessChain).toEqual(['c1@0', 'c2@1', 'c3@1']);

    c1.set(5); // c1 advances to @1, c2/c3 recompute
    expect(c3.value).toBe(60);
    expect(c3.witnessChain).toEqual(['c1@1', 'c2@2', 'c3@2']);

    // memoization ⇒ no version creep without change
    const before = c3.witnessChain;
    void c3.value;
    expect(c3.witnessChain).toEqual(before);
  });

  it('witnessed() attaches the receipt to the output', () => {
    const price = bindCell(100, { id: 'price' });
    const threshold = bindCell(105, { id: 'threshold' });
    const signal = witnessed(
      [price, threshold],
      (p, t) => (p >= t ? 'SELL' : 'HOLD'),
      { id: 'signal' }
    );

    expect(signal.receipt.value).toBe('HOLD');
    expect(signal.receipt.self).toBe('signal@1');
    expect(signal.receipt.witnesses).toEqual(['price@0', 'threshold@0', 'signal@1']);

    price.set(106);
    expect(signal.receipt.value).toBe('SELL');
    expect(signal.receipt.witnesses).toEqual(['price@1', 'threshold@0', 'signal@2']);
  });
});

describe('EFFECT — $effect', () => {
  it('fires only when a dep actually changes (standalone root fallback works)', async () => {
    const price = bindCell(100, { id: 'price' });
    const noise = bindCell(0, { id: 'noise' });
    let fires = 0;
    const watch = effectCell((p) => {
      fires += 1;
      return p * 2;
    }, [price], { id: 'watch' });

    await flush();
    expect(fires).toBe(1); // initial run

    price.set(100); // same value: no wave
    await flush();
    expect(fires).toBe(1);

    noise.set(9); // unrelated: no wave
    await flush();
    expect(fires).toBe(1);

    price.set(101);
    await flush();
    expect(fires).toBe(2);
    expect(watch.last).toBe(202);
    expect(watch.alive).toBe(true);
  });

  it('FORGET stops propagation', async () => {
    const price = bindCell(100, { id: 'price' });
    let fires = 0;
    const watch = effectCell(() => {
      fires += 1;
    }, [price], { id: 'watch' });

    await flush();
    expect(fires).toBe(1);

    const wasAlive = watch.forget();
    expect(wasAlive).toBe(true);
    expect(watch.alive).toBe(false);

    price.set(300);
    await flush();
    await flush();
    expect(fires).toBe(1); // the wave stops here
  });

  it('TICK — tick() flushes the microtask queue', async () => {
    const cell = bindCell('a', { id: 'cell' });
    const seen = [];
    const watch = effectCell((v) => {
      seen.push(v);
    }, [cell], { id: 'watch' });

    // not yet flushed
    cell.set('b');
    expect(seen).toEqual(['a']); // only the initial run so far

    await flush(); // TICK
    expect(seen).toEqual(['a', 'b']);
    watch.forget();
  });
});
