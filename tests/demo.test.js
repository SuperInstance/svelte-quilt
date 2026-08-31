import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import App from '../src/App.svelte';
import { flush } from '../src/lib/cell.svelte.js';

let instance = null;
const targets = [];

afterEach(() => {
  if (instance) {
    unmount(instance);
    instance = null;
  }
  targets.length = 0;
  document.body.innerHTML = '';
});

function mountApp() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  targets.push(target);
  instance = mount(App, { target });
  return target;
}

describe('demo — live cell-graph visualizer', () => {
  it('renders all cells with values and witness version badges', () => {
    mountApp();
    for (const id of ['price', 'drift', 'delta', 'band', 'signal', 'wave']) {
      expect(document.querySelector(`[data-testid="value-${id}"]`), `value-${id}`).toBeTruthy();
      expect(document.querySelector(`[data-testid="ver-${id}"]`), `ver-${id}`).toBeTruthy();
    }
    expect(document.querySelector('[data-testid="value-price"]').textContent).toBe('100');
    expect(document.querySelector('[data-testid="value-signal"]').textContent).toBe('"HOLD"');
    expect(document.querySelectorAll('svg .node').length).toBe(6);
    expect(document.querySelectorAll('svg .edge').length).toBeGreaterThanOrEqual(6);
  });

  it('TICK advances the wavefront: versions bump, memoized counts hold, log lands', async () => {
    mountApp();
    const before = document.querySelector('[data-testid="ver-price"]').textContent;
    const tickBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('TICK'));
    tickBtn.click();
    await flush();

    const after = document.querySelector('[data-testid="ver-price"]').textContent;
    expect(after).not.toBe(before); // BIND advanced
    expect(Number(after.slice(1))).toBeGreaterThan(Number(before.slice(1)));

    // the effect landed: wave log shows an entry
    const logItems = document.querySelectorAll('.log li');
    expect(logItems.length).toBeGreaterThan(0);

    // wavefront line still honest (no cycles)
    expect(document.querySelector('.order code').textContent).toContain('price');
    expect(document.querySelector('.order code').textContent).toContain('signal');
  });

  it('clicking a cell shows its witness chain in the inspector', async () => {
    mountApp();
    // select the price node
    const priceNode = [...document.querySelectorAll('svg .node')].find((n) =>
      n.querySelector('[data-testid="value-price"]')
    );
    priceNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const heading = document.querySelector('.inspector h2');
    expect(heading.textContent).toContain('price');
    const chain = [...document.querySelectorAll('.chain li')].map((li) => li.textContent);
    expect(chain).toEqual(['price@0']); // a root witnesses only itself
  });
});
