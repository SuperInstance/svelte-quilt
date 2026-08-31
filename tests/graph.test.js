import { describe, it, expect } from 'vitest';
import { bindCell, derivedCell, witnessed, effectCell, flush } from '../src/lib/cell.svelte.js';
import { createGraph } from '../src/lib/graph.svelte.js';

function demoGraph() {
  const price = bindCell(100, { id: 'price' });
  const drift = bindCell(1.2, { id: 'drift' });
  const delta = derivedCell([price, drift], (p, d) => (p * d) / 100, {
    id: 'delta',
    expr: 'price * drift / 100'
  });
  const band = derivedCell([price, delta], (p, d) => ({ hi: p + d, lo: p - d }), { id: 'band' });
  const signal = witnessed([band, price], (b, p) => (p >= b.hi ? 'SELL' : 'HOLD'), { id: 'signal' });

  const g = createGraph({ id: 'demo', title: 'round-trip' });
  g.add(price).add(drift).add(delta).add(band).add(signal);
  return { g, price, drift, delta, band, signal };
}

describe('registry — LINK as edges', () => {
  it('auto-links derived deps and exposes a Kahn wavefront order', () => {
    const { g } = demoGraph();
    const ids = g.edgesOf().map((e) => `${e.from}→${e.to}`);
    expect(ids).toContain('price→delta');
    expect(ids).toContain('delta→band');
    expect(ids).toContain('band→signal');

    const { order, cyclic } = g.order();
    expect(cyclic).toBe(false);
    // topological: every edge's from appears before its to
    for (const e of g.edgesOf()) {
      expect(order.indexOf(e.from)).toBeLessThan(order.indexOf(e.to));
    }
    expect(order[0]).toBe('price');
    expect(order.at(-1)).toBe('signal');
  });

  it('forget(id) removes the node and its incident edges', () => {
    const { g } = demoGraph();
    expect(g.forget('delta')).toBe(true);
    expect(g.get('delta')).toBeNull();
    const ids = g.edgesOf().map((e) => `${e.from}→${e.to}`);
    expect(ids).not.toContain('price→delta');
    expect(ids).not.toContain('delta→band');
    expect(g.stats().nodes).toBe(4);
  });

  it('receipt(id) returns the W13 provenance of a node', () => {
    const { g, signal } = demoGraph();
    void signal.value;
    const r = g.receipt('signal');
    expect(r.kind).toBe('witnessed');
    expect(r.witness).toBe(signal.witness);
    expect(r.witnesses).toEqual(signal.witnessChain);
    expect(r.deps).toEqual(['band', 'price']);
    expect(r.detached).toBe(false);
  });
});

describe('quilt.cell-graph/1 — interchange', () => {
  it('round-trips: serialize → load(attach live cells) → serialize is identical', () => {
    const { g, price, drift, delta, band, signal } = demoGraph();
    // advance the world so versions are non-trivial
    price.set(104);
    drift.set(2);
    void signal.value;

    const json1 = g.serialize({ timestamp: false });
    const g2 = createGraph({ id: 'copy' });
    g2.load(json1, { attach: { price, drift, delta, band, signal } });
    const json2 = g2.serialize({ timestamp: false });

    expect(json2).toEqual(json1);

    // and the attached cells are LIVE: advancing the original wavefront
    // is visible through the loaded registry
    price.set(110);
    expect(g2.get('signal').value).toBe('SELL');
  });

  it('loads a static snapshot without attach: witnesses survive, motors frozen', () => {
    const { g, price } = demoGraph();
    price.set(104);
    const json = g.serialize({ timestamp: false });

    const g2 = createGraph({ id: 'static' });
    g2.load(json);

    const price2 = g2.get('price');
    expect(price2.value).toBe(104);
    expect(price2.witness).toBe('price@1');
    expect(price2.detached).toBe(true);

    const signal2 = g2.get('signal');
    expect(signal2.witnessChain).toEqual(g.get('signal').witnessChain); // receipt intact
    expect(g2.receipt('signal').detached).toBe(true);
    // edges preserved
    expect(g2.edgesOf().length).toBe(g.edgesOf().length);
    expect(g2.order().cyclic).toBe(false);
  });

  it('refuses JSON that is not the interchange format', () => {
    const g = createGraph({ id: 'x' });
    expect(() => g.load({ format: 'something.else' })).toThrow(/format/);
  });
});

describe('graph TICK', () => {
  it('tick() advances the counter and flushes the wave', async () => {
    const g = createGraph({ id: 't' });
    const price = bindCell(1, { id: 'price' });
    g.add(price);
    let fires = 0;
    const w = effectCell(() => {
      fires += 1;
    }, [price], { id: 'w' });
    g.add(w);

    price.set(2);
    const n = await g.tick();
    expect(n).toBe(1);
    expect(g.tickCount).toBe(1);
    expect(fires).toBe(2); // initial + one wave
    w.forget();
  });
});
