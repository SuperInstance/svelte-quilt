<script>
  import { bindCell, derivedCell, effectCell, witnessed } from './lib/cell.svelte.js';
  import { createGraph } from './lib/graph.svelte.js';
  import { untrack } from 'svelte';

  // ── BIND ────────────────────────────────────────────── inputs
  const price = bindCell(100, { id: 'price', label: 'price' });
  const drift = bindCell(1.2, { id: 'drift', label: 'drift %' });

  // ── VIEW ────────────────────────────────────────────── the derived chain
  const delta = derivedCell([price, drift], (p, d) => +(p * d) / 100, {
    id: 'delta',
    label: 'Δ band',
    expr: 'price * drift / 100'
  });
  const band = derivedCell([price, delta], (p, d) => ({ hi: +(p + d).toFixed(2), lo: +(p - d).toFixed(2) }), {
    id: 'band',
    label: 'band'
  });
  const signal = witnessed([band, price], (b, p) => (p >= b.hi ? 'SELL' : p <= b.lo ? 'BUY' : 'HOLD'), {
    id: 'signal',
    label: 'signal'
  });

  // ── EFFECT ──────────────────────────────────────────── the wave lands
  // (log is written under untrack so the effect tracks only `signal`)
  let log = $state([]);
  const wave = effectCell((sig) => {
    untrack(() => {
      log = [...log, { tick: g.tickCount, sig }].slice(-14);
    });
  }, [signal], { id: 'wave', label: 'wave log' });

  // ── LINK ────────────────────────────────────────────── the registry
  const g = createGraph({ id: 'rsi-demo', title: 'price → band → signal' });
  g.add(price).add(drift).add(delta).add(band).add(signal).add(wave);

  // fixed layout for the viz
  const pos = {
    price: { x: 60, y: 70 },
    drift: { x: 60, y: 190 },
    delta: { x: 250, y: 70 },
    band: { x: 440, y: 70 },
    signal: { x: 630, y: 70 },
    wave: { x: 440, y: 190 }
  };
  const W = 110;
  const H = 74;

  let selected = $state('signal');
  let showJson = $state(false);
  let auto = $state(false);
  let timer = null;

  $effect(() => {
    if (auto) {
      timer = setInterval(() => doTick(), 1100);
      return () => clearInterval(timer);
    }
  });

  // ── TICK ────────────────────────────────────────────── advance the clock
  async function doTick() {
    const p = price.value;
    const d = drift.value;
    price.set(+(p + (Math.random() - 0.5) * 2 * (p * d) / 100 + p * 0.0002).toFixed(2));
    await g.tick();
  }

  function nodeValue(id) {
    const c = g.get(id);
    if (id === 'band') return `${c.value.hi} / ${c.value.lo}`;
    if (id === 'wave') return `${c.fires} waves`;
    return String(c.value);
  }

  const edges = g.edgesOf();
  const order = g.order().order.join(' → ');
</script>

<div class="wrap">
  <header>
    <h1>svelte-quilt</h1>
    <p class="tag">the compiler IS the wavefront — 5 runes, 5+1 opcodes, one witness layer</p>
    <div class="controls">
      <button class="amber" onclick={doTick}>TICK ({g.tickCount})</button>
      <button class:active={auto} onclick={() => (auto = !auto)}>{auto ? '⏸ auto' : '▶ auto'}</button>
      <label class="slider">
        drift {drift.value.toFixed(1)}%
        <input
          type="range" min="0.2" max="4" step="0.1"
          value={drift.value}
          oninput={(e) => drift.set(+e.target.value)}
        />
      </label>
      <button onclick={() => (showJson = !showJson)}>{showJson ? 'hide' : 'show'} JSON</button>
    </div>
  </header>

  <main>
    <section class="viz">
      <svg viewBox="0 0 800 290" class="graph">
        {#each edges as e (e.from + '>' + e.to)}
          {@const a = pos[e.from]}
          {@const b = pos[e.to]}
          <line
            x1={a.x + W / 2} y1={a.y + H / 2}
            x2={b.x + W / 2} y2={b.y + H / 2}
            class="edge {e.type}" class:hot={e.to === selected || e.from === selected}
          />
        {/each}
        {#each g.cells() as c (c.id)}
          {@const p = pos[c.id]}
          <g
            class="node {c.kind}" class:selected={c.id === selected}
            transform={`translate(${p.x}, ${p.y})`}
            onclick={() => (selected = c.id)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && (selected = c.id)}
          >
            <rect width={W} height={H} rx="10" />
            <text class="kind" x="10" y="18">{c.kind}</text>
            <text class="label" x="10" y="36">{c.label}</text>
            <text class="value" x="10" y="56" data-testid={`value-${c.id}`}>{nodeValue(c.id)}</text>
            <g class="marks" transform={`translate(${W - 10}, 12)`}>
              {#each c.witnessChain.slice(0, 6) as m, i}
                <circle cx={-i * 11} cy="0" r="3.5" class="mark" title={m} />
              {/each}
              <text class="ver" x="4" y="4" data-testid={`ver-${c.id}`}>@{c.version}</text>
            </g>
          </g>
        {/each}
      </svg>
      <p class="order">wavefront (Kahn): <code>{order}</code></p>
    </section>

    <aside class="inspector">
      <h2>receipt · {selected}</h2>
      {#if g.receipt(selected)}
        {@const r = g.receipt(selected)}
        <dl>
          <dt>kind</dt><dd>{r.kind}{r.detached ? ' (detached)' : ''}</dd>
          <dt>value</dt><dd>{JSON.stringify(r.value)}</dd>
          <dt>self</dt><dd class="amber-text">{r.witness}</dd>
          <dt>computes</dt><dd>{r.computes}</dd>
          <dt>deps</dt><dd>{r.deps.join(', ') || '—'}</dd>
        </dl>
        <h3>witness chain — w(out) = w(in) ∪ {{self}}</h3>
        <ol class="chain">
          {#each r.witnesses as w (w)}
            <li class:hot={w === r.witness}>{w}</li>
          {/each}
        </ol>
      {/if}

      <h3>wave log <span class="amber-text">({wave.fires})</span></h3>
      <ul class="log">
        {#each log.slice(-6).reverse() as entry, i (entry.tick + '-' + i)}
          <li><span class="dim">t{entry.tick}</span> {entry.sig}</li>
        {/each}
      </ul>
    </aside>
  </main>

  {#if showJson}
    <section class="json">
      <h2>quilt.cell-graph/1</h2>
      <pre>{JSON.stringify(g.serialize({ timestamp: false }), null, 2)}</pre>
    </section>
  {/if}
</div>
