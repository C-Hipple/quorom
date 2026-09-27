// Tests for src/graph.js: declaring the graph, sealing handoffs, and running tasks through it.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "src", "graph.js"), "utf8");
const ctx = {}; vm.createContext(ctx);
const Graph = vm.runInContext(src + "\nGraph;", ctx);
const J = v => JSON.parse(JSON.stringify(v));
const deq = (a, b) => assert.deepStrictEqual(J(a), J(b));
const tick = () => new Promise(r => setTimeout(r, 0));

// Declared out of order on purpose: a feeds b and c, and d needs both.
const diamond = () => Graph.define([
  { id: "d", needs: ["b", "c"] },
  { id: "b", needs: ["a"] },
  { id: "c", kind: "twin", needs: ["a", "a"] },
  { id: "a" },
]);

// A worker that finishes each node when the test says so, and remembers what it was given.
function controlled() {
  const tasks = {}, finish = {}, events = [];
  return {
    tasks, events,
    work: task => new Promise((resolve, reject) => {
      tasks[task.node] = task;
      events.push("start " + task.node);
      finish[task.node] = { resolve, reject };
    }),
    done: (id, data) => finish[id].resolve(data === undefined ? { id } : data),
    fail: (id, e) => finish[id].reject(e),
  };
}

// A run that never resolves leaves nothing for Node to wait on, and it would exit quietly with success.
let finished = false;
process.on("exit", () => {
  if (finished) return;
  console.error("FAIL: the graph tests stopped before the end, most likely waiting on a run that never resolved.");
  process.exitCode = 1;
});

(async () => {
  let passed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; } catch (e) { console.error("FAIL:", name, "\n", e.stack); process.exitCode = 1; }
  };

  // ---------- Declaring ----------
  await t("orders nodes so each comes after what it needs", () => {
    const g = diamond();
    deq(g.order, ["a", "b", "c", "d"]);
    deq(g.nodes.a.feeds, ["b", "c"]);
    deq(g.nodes.c.needs, ["a"]);
    assert.strictEqual(g.nodes.b.kind, "b", "kind defaults to the id");
    assert.strictEqual(g.nodes.c.kind, "twin");
  });
  await t("the graph is frozen", () => {
    const g = diamond();
    assert.ok(Object.isFrozen(g) && Object.isFrozen(g.nodes) && Object.isFrozen(g.nodes.a.feeds) && Object.isFrozen(g.order));
  });
  await t("rejects a missing id", () => assert.throws(() => Graph.define([{ needs: [] }]), /Every node needs an id/));
  await t("rejects a duplicate", () => assert.throws(() => Graph.define([{ id: "a" }, { id: "a" }]), /Node a is declared twice/));
  await t("rejects an unknown need", () => assert.throws(() => Graph.define([{ id: "a", needs: ["ghost"] }]), /a needs ghost, which isn't in the graph/));
  await t("rejects a cycle, naming what could never run", () => {
    assert.throws(() => Graph.define([{ id: "a" }, { id: "b", needs: ["a", "c"] }, { id: "c", needs: ["b"] }, { id: "d", needs: ["c"] }]),
      /cycle, so these nodes could never run: b, c, d\./);
  });
  await t("rejects a node that needs itself", () => assert.throws(() => Graph.define([{ id: "a", needs: ["a"] }]), /cycle/));
  await t("ready lists what can start", () => {
    const g = diamond();
    const h = id => Graph.handoff(id, id, {});
    deq(Graph.ready(g, {}), ["a"]);
    deq(Graph.ready(g, { a: h("a") }), ["b", "c"]);
    deq(Graph.ready(g, { a: h("a"), b: h("b") }), ["c"]);
    deq(Graph.ready(g, { a: h("a"), b: h("b"), c: h("c") }), ["d"]);
  });

  // ---------- Handoffs ----------
  await t("a handoff is a frozen copy", () => {
    const data = { text: "x", list: [1, { n: 2 }], none: null };
    const h = Graph.handoff("a", "note", data);
    deq(h, { from: "a", kind: "note", data: { text: "x", list: [1, { n: 2 }], none: null } });
    data.list[1].n = 99;
    data.text = "changed";
    assert.strictEqual(h.data.list[1].n, 2, "the worker's own objects don't reach the handoff");
    assert.strictEqual(h.data.text, "x");
    assert.ok([h, h.data, h.data.list, h.data.list[1]].every(o => Object.isFrozen(o)));
    assert.throws(() => { "use strict"; h.data.list[1].n = 3; }, TypeError);
  });
  await t("a handoff takes objects without a prototype", () => {
    const o = Object.create(null);
    o.k = "v";
    assert.strictEqual(Graph.handoff("a", "k", o).data.k, "v");
  });
  await t("a handoff refuses anything but plain data", () => {
    assert.throws(() => Graph.handoff("a", "k", { when: new Date() }), /a\.when isn't/);
    assert.throws(() => Graph.handoff("a", "k", { list: [() => 1] }), /a\.list\[0\] isn't/);
    assert.throws(() => Graph.handoff("a", "k", new Map()), /Only plain data/);
    class Thing {}
    assert.throws(() => Graph.handoff("a", "k", { x: new Thing() }), /a\.x isn't/);
  });

  // ---------- Running ----------
  await t("runs each node once its needs are handed off, side by side where it can", async () => {
    const g = diamond(), w = controlled(), heard = [];
    const run = Graph.run(g, { work: w.work, onHandoff: h => { heard.push(h.from); w.events.push("handoff " + h.from); } });
    await tick();
    deq(w.events, ["start a"]);
    w.done("a", { n: 1 });
    await tick();
    deq(w.events, ["start a", "handoff a", "start b", "start c"]);
    w.done("c");
    await tick();
    assert.ok(!w.tasks.d, "d waits for b");
    w.done("b");
    await tick();
    w.done("d");
    const res = await run;
    deq(Object.keys(res.done).sort(), ["a", "b", "c", "d"]);
    deq(res.failed, {});
    deq(heard, ["a", "c", "b", "d"]);
    // a task holds exactly the handoffs its node needs
    const d = w.tasks.d;
    deq(Object.keys(d.inputs).sort(), ["b", "c"]);
    assert.strictEqual(d.inputs.c.kind, "twin");
    assert.strictEqual(d.inputs.b, res.done.b, "inputs are the handoffs themselves");
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.inputs));
    deq(w.tasks.b.inputs, { a: { from: "a", kind: "a", data: { n: 1 } } });
    deq(w.tasks.a.inputs, {});
  });
  await t("picks up from handoffs already made", async () => {
    const g = diamond(), w = controlled();
    const a = Graph.handoff("a", "a", { n: 1 }), b = Graph.handoff("b", "b", { n: 2 });
    const run = Graph.run(g, { done: { a, b }, work: w.work });
    await tick();
    deq(w.events, ["start c"]);
    w.done("c");
    await tick();
    w.done("d");
    const res = await run;
    assert.strictEqual(res.done.a, a);
    assert.strictEqual(w.tasks.d.inputs.b, b);
  });
  await t("a failure stops what needs it, and nothing else", async () => {
    const g = diamond(), w = controlled();
    const run = Graph.run(g, { work: w.work });
    await tick();
    w.done("a");
    await tick();
    const boom = { code: "upstream_error" };
    w.fail("b", boom);
    await tick();
    w.done("c");
    const res = await run;
    deq(Object.keys(res.done).sort(), ["a", "c"]);
    assert.strictEqual(res.failed.b, boom);
    assert.ok(!w.tasks.d, "d never starts");
  });
  await t("nothing new starts once it isn't live", async () => {
    const g = diamond(), w = controlled();
    let live = true;
    const run = Graph.run(g, { work: w.work, live: () => live });
    await tick();
    live = false;
    w.done("a");
    const res = await run;
    deq(w.events, ["start a"]);
    deq(Object.keys(res.done), ["a"]);
  });
  await t("workers can be plain functions, and their throws fail the node", async () => {
    const g = Graph.define([{ id: "a" }, { id: "b", needs: ["a"] }, { id: "c" }]);
    const res = await Graph.run(g, {
      work: task => {
        if (task.node === "c") throw new Error("no");
        return task.node === "a" ? { n: 1 } : { n: task.inputs.a.data.n + 1 };
      },
    });
    assert.strictEqual(res.done.b.data.n, 2);
    assert.strictEqual(res.failed.c.message, "no");
  });
  await t("a worker that returns more than plain data fails its node", async () => {
    const g = Graph.define([{ id: "a" }]);
    const res = await Graph.run(g, { work: () => ({ at: new Date() }) });
    assert.strictEqual(res.failed.a.name, "TypeError");
    deq(res.done, {});
  });
  await t("a listener that throws stops the run", async () => {
    const g = Graph.define([{ id: "a" }, { id: "b", needs: ["a"] }]);
    await assert.rejects(Graph.run(g, { work: () => ({}), onHandoff: () => { throw new Error("listener"); } }), /listener/);
  });
  await t("nothing to do resolves at once", async () => {
    const g = Graph.define([{ id: "a" }]);
    const a = Graph.handoff("a", "a", {});
    const res = await Graph.run(g, { done: { a }, work: () => { throw new Error("not called"); } });
    assert.strictEqual(res.done.a, a);
  });

  finished = true;
  console.log(passed + " graph tests passed" + (process.exitCode ? " (with failures)" : ""));
})();
