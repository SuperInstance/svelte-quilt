/**
 * cell.svelte.js — the quilt substrate, in pure Svelte 5 runes.
 *
 * The 5+1 opcodes map 1:1 onto runes:
 *
 *   BIND   = $state      (make a thing)
 *   VIEW   = $derived    (read-as-a-projection; memoized by the compiler's dep graph)
 *   EFFECT = $effect     (change, with automatic dependency tracking)
 *   LINK   = dep edges   (the compiler computes the topological wavefront)
 *   TICK   = tick()      (Svelte's microtask flush)
 *   FORGET = teardown    (unsubscribe / stop propagation)
 *
 * The one thing Svelte doesn't give you is the W13 witness layer:
 *   w(out) = w(in) ∪ {cell@ver}
 * Every cell here carries a witness mark (`id@version`) and a witness
 * chain (the union of its inputs' chains plus itself). Facts with
 * different witnesses are different facts.
 *
 * Notes on Svelte 5 mechanics we rely on (adapted honestly):
 *  - `$derived.by` is pull-based: it only recomputes when read after a
 *    dependency changed. That IS witness-keyed memoization.
 *  - Writing runes inside a `$derived` body is forbidden, so derived
 *    cells track `version`/`computes` as plain closure vars, bumped
 *    synchronously inside the derived body. They are always fresh when
 *    read *after* reading `.value` (which the getters here enforce).
 *  - `$effect` only works inside an effect root (component init or
 *    `$effect.root`). `effectCell` tries the ambient root first and
 *    falls back to `$effect.root` so it also works in plain modules
 *    and tests. `forget()` tears that root down — FORGET.
 */

export { tick as flush } from 'svelte';
import { tick as flushMicrotask, untrack } from 'svelte';

let nextId = 0;

/** BIND — make a thing. `$state` under the hood. */
export function bindCell(initial, opts = {}) {
  const id = opts.id ?? `bind-${nextId++}`;
  let value = $state(initial);
  let version = $state(opts.version ?? 0);
  const listeners = new Set();

  const cell = {
    id,
    kind: 'bind',
    label: opts.label ?? id,
    deps: [],
    get value() {
      return value;
    },
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      version += 1;
      for (const fn of listeners) fn(value, cell);
      return cell;
    },
    update(fn) {
      return cell.set(fn);
    },
    get version() {
      return version;
    },
    /** W13 mark: this cell, at this version. */
    get witness() {
      return `${id}@${version}`;
    },
    /** A bind's chain is just itself. Roots are their own witnesses. */
    get witnessChain() {
      return [cell.witness];
    },
    get computes() {
      return 0;
    },
    /** Subscribe outside Svelte. Returns the unsubscribe (FORGET). */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get listeners() {
      return listeners.size;
    },
    snapshot() {
      return {
        id,
        kind: 'bind',
        label: cell.label,
        deps: [],
        version,
        witness: cell.witness,
        witnessChain: cell.witnessChain,
        computes: 0,
        value: jsonSafe(value)
      };
    }
  };
  return cell;
}

/** VIEW — read as a projection. `$derived.by` under the hood: memoized. */
export function derivedCell(deps, fn, opts = {}) {
  const id = opts.id ?? `derived-${nextId++}`;
  deps = deps ?? [];
  // Plain vars on purpose: runes can't be written inside a derived body.
  // They are bumped synchronously when the derived body runs, so they are
  // fresh as long as you read `.value` first — which every getter here does.
  let computes = 0;
  let version = opts.version ?? 0;

  const inner = $derived.by(() => {
    computes += 1;
    version += 1;
    return fn(...deps.map((d) => d.value));
  });

  const cell = {
    id,
    kind: opts.kind ?? 'derived',
    label: opts.label ?? id,
    deps,
    expr: opts.expr ?? null,
    get value() {
      return inner;
    },
    get computes() {
      return computes;
    },
    get version() {
      // version only advances when the body ran; force freshness.
      void inner;
      return version;
    },
    get witness() {
      return `${id}@${cell.version}`;
    },
    /**
     * W13: w(out) = w(in) ∪ {self@ver}. Union is per-cell-id (a cell
     * appearing on several paths collapses to its latest mark), self last.
     */
    get witnessChain() {
      void inner; // pull, so downstream marks are current
      return untrack(() => unionOf(deps.map((d) => d.witnessChain), cell.witness));
    },
    snapshot() {
      void inner;
      return {
        id,
        kind: cell.kind,
        label: cell.label,
        deps: deps.map((d) => d.id),
        version,
        witness: cell.witness,
        witnessChain: cell.witnessChain,
        computes,
        expr: cell.expr,
        value: jsonSafe(inner)
      };
    }
  };
  return cell;
}

/**
 * W13 wrapper — a derived whose every output carries its receipt:
 * w(out) = w(in) ∪ {cell@ver}, attached, not asserted.
 */
export function witnessed(deps, fn, opts = {}) {
  const cell = derivedCell(deps, fn, { ...opts, kind: 'witnessed' });
  return {
    get id() { return cell.id; },
    get kind() { return 'witnessed'; },
    get label() { return cell.label; },
    get deps() { return cell.deps; },
    get expr() { return cell.expr; },
    get value() { return cell.value; },
    get computes() { return cell.computes; },
    get version() { return cell.version; },
    get witness() { return cell.witness; },
    get witnessChain() { return cell.witnessChain; },
    snapshot() { return cell.snapshot(); },
    /** The receipt: what came out, and everything it stands on. */
    get receipt() {
      return untrack(() => {
        const value = cell.value;
        return {
          id: cell.id,
          value,
          self: cell.witness,
          witnesses: cell.witnessChain
        };
      });
    }
  };
}

/** EFFECT — change, tracked. `$effect` under the hood, root-safe. */
export function effectCell(fn, deps, opts = {}) {
  const id = opts.id ?? `effect-${nextId++}`;
  deps = deps ?? [];
  let alive = $state(true);
  let fires = $state(0);
  let last = $state(undefined);
  let teardown = null;

  const run = () => {
    $effect(() => {
      if (!alive) return;
      // untrack: `fires += 1` would otherwise read+write the same state
      // in one effect — an update loop. Untracked writes still notify
      // outside readers (the demo's inspector), they just don't self-track.
      untrack(() => {
        fires += 1;
        last = fn(...deps.map((d) => d.value));
      });
    });
  };

  try {
    run(); // ambient root (component init) — lifecycle tied to the owner
  } catch {
    // No ambient root (plain module / test): own it ourselves.
    teardown = $effect.root(() => {
      run();
      return () => {
        alive = false;
      };
    });
  }

  return {
    id,
    kind: 'effect',
    label: opts.label ?? id,
    deps,
    get fires() {
      return fires;
    },
    get last() {
      return last;
    },
    get alive() {
      return alive;
    },
    /** FORGET — stop propagation and tear down any owned root. */
    forget() {
      const was = alive;
      alive = false;
      teardown?.();
      return was;
    },
    snapshot() {
      return {
        id,
        kind: 'effect',
        label: this.label,
        deps: deps.map((d) => d.id),
        version: fires,
        witness: `${id}@${fires}`,
        witnessChain: unionOf(deps.map((d) => d.witnessChain), `${id}@${fires}`),
        computes: fires,
        value: jsonSafe(last)
      };
    }
  };
}

/** Union of witness chains: per-cell-id, latest mark wins, self last. */
function unionOf(chains, self) {
  const order = [];
  const byId = new Map();
  const put = (mark) => {
    const at = mark.lastIndexOf('@');
    const cid = mark.slice(0, at);
    if (!byId.has(cid)) order.push(cid);
    byId.set(cid, mark);
  };
  for (const chain of chains) for (const mark of chain) put(mark);
  if (self) put(self);
  return order.map((cid) => byId.get(cid));
}

/** JSON-safe value snapshot for serialization. */
function jsonSafe(v) {
  try {
    return structuredClone(v);
  } catch {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return '[unserializable]';
    }
  }
}
