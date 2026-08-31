/**
 * graph.svelte.js — the registry: cells, edges, receipts, and the
 * quilt cell-graph JSON interchange format.
 *
 * serialize() emits `quilt.cell-graph/1`: aligned with quilt-core's
 * SheetDef/CellDef (id / kind / deps) and extended with the W13
 * witness fields (version / witness / witnessChain). Any quilt engine
 * that reads cell defs can read the structure; the witness columns are
 * what this substrate adds.
 *
 * load() rebuilds a graph from JSON. Functions don't survive JSON, so
 * derived/effect cells load as *detached* snapshots (value frozen at
 * its last witnessed version) unless you hand `load` the live cell via
 * `attach: { id: cell }` — in which case the live reactive cell is
 * re-bound into the new registry. Honest limitation, stated in the README.
 */

import { bindCell } from './cell.svelte.js';
import { tick as flushMicrotask } from 'svelte';

const FORMAT = 'quilt.cell-graph/1';

export function createGraph(opts = {}) {
  const nodes = new Map(); // id -> cell (live or detached)
  const edges = []; // { from, to, type }

  const graph = {
    id: opts.id ?? `graph-${Math.random().toString(36).slice(2, 8)}`,
    title: opts.title ?? '',

    /** Register a cell. Derived/effect cells auto-LINK to their deps. */
    add(cell, meta = {}) {
      if (nodes.has(cell.id)) throw new Error(`duplicate cell id: ${cell.id}`);
      nodes.set(cell.id, cell);
      if (cell.kind !== 'bind') {
        for (const dep of cell.deps ?? []) {
          if (nodes.has(dep.id)) edges.push(edge(dep.id, cell.id, cell.kind === 'effect' ? 'effect' : 'view'));
        }
      }
      if (meta.links) for (const [from, type] of meta.links) edges.push(edge(from, cell.id, type));
      return graph;
    },

    /** LINK, explicit. */
    link(from, to, type = 'link') {
      if (!nodes.has(from) || !nodes.has(to)) throw new Error(`link: unknown endpoint (${from} → ${to})`);
      edges.push(edge(from, to, type));
      return graph;
    },

    get(id) {
      return nodes.get(id) ?? null;
    },

    cells() {
      return [...nodes.values()];
    },

    edgesOf() {
      return [...edges];
    },

    /** FORGET at the registry level: remove a node and its incident edges. */
    forget(id) {
      const had = nodes.delete(id);
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i].from === id || edges[i].to === id) edges.splice(i, 1);
      }
      return had;
    },

    /**
     * LINK exposed as order: Kahn's topological sort over the edges.
     * This is the same wavefront Svelte's compiler computes to know
     * what to recompute in what order — rendered here for humans.
     * Returns { order, cyclic } (cyclic graphs refuse to lie).
     */
    order() {
      const indeg = new Map(nodes.keys().map((k) => [k, 0]));
      const out = new Map([...nodes.keys()].map((k) => [k, []]));
      for (const e of edges) {
        if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
        indeg.set(e.to, indeg.get(e.to) + 1);
        out.get(e.from).push(e.to);
      }
      const ready = [...nodes.keys()].filter((k) => indeg.get(k) === 0);
      const order = [];
      while (ready.length) {
        const id = ready.shift();
        order.push(id);
        for (const nxt of out.get(id)) {
          indeg.set(nxt, indeg.get(nxt) - 1);
          if (indeg.get(nxt) === 0) ready.push(nxt);
        }
      }
      return { order, cyclic: order.length !== nodes.size };
    },

    /** W13 receipt for a node: what it is, and everything it stands on. */
    receipt(id) {
      const cell = nodes.get(id);
      if (!cell) return null;
      const snap = cell.snapshot();
      return {
        id,
        kind: snap.kind,
        label: snap.label,
        value: snap.value,
        version: snap.version,
        witness: snap.witness,
        witnesses: snap.witnessChain,
        computes: snap.computes,
        deps: snap.deps,
        detached: cell.detached === true
      };
    },

    /**
     * TICK: advance the clock. Bumps the counter, then flushes Svelte's
     * microtask queue so the wave lands before you look.
     */
    async tick() {
      tickCount += 1;
      await flushMicrotask();
      return tickCount;
    },
    get tickCount() {
      return tickCount;
    },

    stats() {
      const cells = [...nodes.values()];
      return {
        nodes: cells.length,
        edges: edges.length,
        bind: cells.filter((c) => c.kind === 'bind').length,
        derived: cells.filter((c) => ['derived', 'witnessed'].includes(c.kind)).length,
        effect: cells.filter((c) => c.kind === 'effect').length,
        witnessMarks: cells.reduce((n, c) => n + c.snapshot().witnessChain.length, 0),
        ticks: tickCount
      };
    },

    /**
     * Serialize to the quilt cell-graph JSON interchange format.
     * Pass { timestamp: false } for stable round-trips.
     */
    serialize(sopts = {}) {
      return {
        format: FORMAT,
        id: graph.id,
        title: graph.title,
        ...(sopts.timestamp === false ? {} : { generatedAt: new Date().toISOString() }),
        cells: [...nodes.values()].map((c) => {
          const s = c.snapshot();
          return { ...s, detached: c.detached === true };
        }),
        edges: edges.map((e) => ({ ...e }))
      };
    },

    /**
     * Rebuild from JSON. Live cells can be re-bound by id:
     *   load(json, { attach: { price: livePriceCell } })
     * Cells not attached load as detached snapshots (values frozen at
     * their witnessed versions — the receipt survives, the motor doesn't).
     */
    load(json, lopts = {}) {
      if (json.format !== FORMAT) throw new Error(`unknown format: ${json.format}`);
      nodes.clear();
      edges.length = 0;
      graph.id = json.id;
      graph.title = json.title ?? '';
      for (const def of json.cells ?? []) {
        const live = lopts.attach?.[def.id];
        if (live) {
          nodes.set(def.id, live);
          continue;
        }
        nodes.set(def.id, detachedFrom(def));
      }
      for (const e of json.edges ?? []) edges.push(edge(e.from, e.to, e.type));
      return graph;
    }
  };

  let tickCount = $state(0);

  function edge(from, to, type) {
    return { from, to, type };
  }

  return graph;
}

/** A frozen cell restored from JSON: carries its last witness, runs nothing. */
function detachedFrom(def) {
  const cell = {
    id: def.id,
    kind: def.kind,
    label: def.label ?? def.id,
    deps: def.deps ?? [],
    detached: true,
    get value() {
      return def.value;
    },
    get version() {
      return def.version ?? 0;
    },
    get witness() {
      return def.witness ?? `${def.id}@${def.version ?? 0}`;
    },
    get witnessChain() {
      return def.witnessChain ?? [cell.witness];
    },
    get computes() {
      return def.computes ?? 0;
    },
    snapshot() {
      return {
        id: def.id,
        kind: def.kind,
        label: cell.label,
        deps: cell.deps,
        version: cell.version,
        witness: cell.witness,
        witnessChain: cell.witnessChain,
        computes: cell.computes,
        value: jsonSafe(def.value)
      };
    }
  };
  return cell;
}

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
