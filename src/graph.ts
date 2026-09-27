// Work declared up front as a directed acyclic graph, then run as a queue of discrete tasks.
//
// A node is one step. It names the nodes whose output it needs, and those edges are the only way data moves between
// steps. Once everything a node needs has been handed off, the node is queued as a task that carries those handoffs,
// and a worker turns the task into data. That data is copied and frozen into a handoff for the nodes downstream, so
// workers share no state: each sees only its own inputs, and nothing it hands on can change afterwards.
//
//   Task     { node, kind, inputs }   inputs maps each node this one needs to that node's handoff
//   Handoff  { from, kind, data }     data is plain data (objects, arrays, strings, numbers, booleans, null)

// The data in a handoff is plain data whose shape depends on its kind (see the kinds in core.ts), so it's left open
// here, and readers say what they expect of it.
export type HandoffData = any;

export interface Handoff {
  readonly from: string;
  readonly kind: string;
  readonly data: HandoffData;
}

export type Handoffs = Record<string, Handoff>;

export interface Task {
  readonly node: string;
  readonly kind: string;
  readonly inputs: Readonly<Handoffs>;
}

export interface NodeSpec {
  id: string;
  kind?: string;
  needs?: string[];
}

export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly needs: readonly string[];
  readonly feeds: readonly string[];
}

export interface GraphDef {
  readonly nodes: Readonly<Record<string, GraphNode>>;
  readonly order: readonly string[];
}

export interface RunOptions {
  done?: Handoffs;
  work: (task: Task) => unknown;
  live?: () => boolean;
  onHandoff?: (h: Handoff) => void;
}

export interface RunResult {
  done: Handoffs;
  failed: Record<string, unknown>;
}

export const Graph = (function () {
  "use strict";

  // A frozen deep copy of plain data. Functions, class instances and the like can't cross between workers.
  function seal(v: unknown, path: string): unknown {
    if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return Object.freeze(v.map((x, i) => seal(x, path + "[" + i + "]")));
    const proto = typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
    if (proto === null || (proto && Object.getPrototypeOf(proto) === null)) {
      const src = v as Record<string, unknown>, o: Record<string, unknown> = {};
      Object.keys(src).forEach(k => { o[k] = seal(src[k], path + "." + k); });
      return Object.freeze(o);
    }
    throw new TypeError("Only plain data can be handed off, and " + path + " isn't.");
  }

  function handoff(from: string, kind: string, data: unknown): Handoff {
    return Object.freeze({ from, kind, data: seal(data, from) });
  }

  // Checks the graph once, before anything runs: every node has a unique id, needs only nodes that exist, and
  // can't reach itself. `order` lists the nodes so each comes after everything it needs, in declaration order
  // where the edges allow.
  function define(list: NodeSpec[]): GraphDef {
    const nodes: Record<string, { id: string, kind: string, needs: string[], feeds: string[] }> = {}, ids: string[] = [];
    list.forEach(n => {
      const id = n && n.id;
      if (typeof id !== "string" || !id) throw new Error("Every node needs an id.");
      if (nodes[id]) throw new Error("Node " + id + " is declared twice.");
      const needs = (n.needs || []).filter((d, i, all) => all.indexOf(d) === i);
      nodes[id] = { id, kind: n.kind || id, needs, feeds: [] };
      ids.push(id);
    });
    ids.forEach(id => nodes[id].needs.forEach(d => {
      if (!nodes[d]) throw new Error(id + " needs " + d + ", which isn't in the graph.");
      nodes[d].feeds.push(id);
    }));
    const waiting: Record<string, number> = {}, order: string[] = [];
    ids.forEach(id => { waiting[id] = nodes[id].needs.length; });
    const next = ids.filter(id => !waiting[id]);
    while (next.length) {
      const id = next.shift() as string;
      order.push(id);
      nodes[id].feeds.forEach(f => { if (--waiting[f] === 0) next.push(f); });
    }
    if (order.length < ids.length) {
      throw new Error("The graph has a cycle, so these nodes could never run: " + ids.filter(id => waiting[id] > 0).join(", ") + ".");
    }
    return seal({ nodes, order }, "graph") as GraphDef;
  }

  // The nodes that can start: not handed off yet, and everything they need has been.
  function ready(graph: GraphDef, done: Handoffs): string[] {
    return graph.order.filter(id => !done[id] && graph.nodes[id].needs.every(d => done[d]));
  }

  // Runs the graph onward from o.done, the handoffs already made. Every node that becomes ready is queued as a task
  // and started at once, so independent nodes run side by side. If a worker throws, its node fails and nothing that
  // needs it starts, but everything else carries on. Resolves { done, failed } once nothing more can start.
  //   o.work(task)     returns the node's data, or a promise of it
  //   o.live()         checked before starting anything; once it returns false, nothing new starts
  //   o.onHandoff(h)   hears each handoff before the nodes that need it start
  function run(graph: GraphDef, o: RunOptions): Promise<RunResult> {
    const done: Handoffs = Object.assign({}, o.done), failed: Record<string, unknown> = {}, started: Record<string, boolean> = {};
    let active = 0;
    return new Promise((resolve, reject) => {
      function pump() {
        if (!o.live || o.live()) ready(graph, done).filter(id => !started[id]).forEach(start);
        if (!active) resolve({ done, failed });
      }
      function start(id: string) {
        const node = graph.nodes[id];
        const inputs: Handoffs = {};
        node.needs.forEach(d => { inputs[d] = done[d]; });
        const task = Object.freeze({ node: id, kind: node.kind, inputs: Object.freeze(inputs) });
        started[id] = true;
        active += 1;
        Promise.resolve(task)
          .then(o.work)
          .then(data => handoff(id, node.kind, data))
          .then(h => {
            done[id] = h;
            if (o.onHandoff) o.onHandoff(h);
          }, (e: unknown) => { failed[id] = e; })
          .then(() => {
            active -= 1;
            pump();
          })
          .catch(reject);
      }
      try { pump(); } catch (e) { reject(e); }
    });
  }

  return { define, handoff, ready, run };
})();
