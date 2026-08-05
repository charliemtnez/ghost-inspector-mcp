/**
 * The `execute` dependency graph. Every question asked of it — blast radius,
 * staleness, what a validation would run — gets *safer looking* when an edge
 * goes missing, so the walks are pinned against cycles and depth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DOCUMENTED_MAX_DEPTH, buildEdges, collectChainIds, executedIds, walk } from "../dist/graph.js";

const ex = (...ids) => ids.map((value, sequence) => ({ command: "execute", value, sequence }));

test("executedIds picks up execute steps in order, deduped", () => {
  assert.deepEqual(executedIds(ex("a", "b", "a", "c")), ["a", "b", "c"]);
});

test("executedIds ignores everything that is not an execute", () => {
  const steps = [{ command: "click", target: "#a", value: "not-an-id" }, ...ex("m")];
  assert.deepEqual(executedIds(steps), ["m"]);
});

test("executedIds skips an execute with no usable value", () => {
  assert.deepEqual(executedIds([{ command: "execute", value: "" }, { command: "execute" }]), []);
});

test("buildEdges reports a reference to a test that does not exist", () => {
  const tests = [{ _id: "t1", name: "caller" }];
  const { forward, broken } = buildEdges(tests, new Map([["t1", ex("ghost")]]));
  assert.equal(forward.size, 0, "an unresolvable target is not an edge");
  assert.deepEqual(broken, [{ test: "caller", missingId: "ghost" }]);
});

test("buildEdges builds both directions", () => {
  const tests = [{ _id: "t1", name: "t1" }, { _id: "m", name: "m" }];
  const { forward, reverse } = buildEdges(tests, new Map([["t1", ex("m")], ["m", []]]));
  assert.deepEqual(forward.get("t1"), ["m"]);
  assert.deepEqual([...(reverse.get("m") ?? [])], ["t1"]);
});

test("walk finds direct neighbours at depth 1", () => {
  const edges = new Map([["a", ["b", "c"]]]);
  const { ids, depth, truncated } = walk("a", edges);
  assert.deepEqual([...ids].sort(), ["b", "c"]);
  assert.equal(depth, 1);
  assert.equal(truncated, false);
});

test("walk follows a chain and reports its depth", () => {
  const edges = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["d"]]]);
  const { ids, depth } = walk("a", edges);
  assert.deepEqual([...ids].sort(), ["b", "c", "d"]);
  assert.equal(depth, 3);
});

test("walk does not inflate depth on a level that adds nobody", () => {
  // Two paths converging: b and c both reach d, which must not count twice.
  const edges = new Map([["a", ["b", "c"]], ["b", ["d"]], ["c", ["d"]], ["d", []]]);
  assert.equal(walk("a", edges).depth, 2);
});

test("walk terminates on a cycle instead of hanging", () => {
  const edges = new Map([["a", ["b"]], ["b", ["a"]]]);
  const { ids } = walk("a", edges);
  assert.ok(ids.has("b"));
  assert.ok(ids.has("a"), "a cycle genuinely reaches its own start");
});

test("walk stops at the documented nesting limit and says so", () => {
  // A chain one level deeper than Ghost Inspector executes.
  const edges = new Map();
  for (let i = 0; i < DOCUMENTED_MAX_DEPTH + 3; i += 1) edges.set(`n${i}`, [`n${i + 1}`]);
  const { depth, truncated } = walk("n0", edges);
  assert.equal(depth, DOCUMENTED_MAX_DEPTH);
  assert.equal(truncated, true, "a blast radius past the limit is a floor, not a total");
});

test("walk on an unknown start is empty rather than an error", () => {
  const { ids, depth, truncated } = walk("nope", new Map());
  assert.equal(ids.size, 0);
  assert.equal(depth, 0);
  assert.equal(truncated, false);
});

test("collectChainIds loads only what the chain touches", async () => {
  const steps = new Map([["root", ex("m1")], ["m1", ex("m2")], ["m2", []], ["unrelated", ex("m1")]]);
  const asked = [];
  const load = async (id) => {
    asked.push(id);
    return steps.get(id) ?? [];
  };
  const { ids, truncated } = await collectChainIds("root", load);
  assert.deepEqual(ids.sort(), ["m1", "m2"]);
  assert.equal(truncated, false);
  assert.ok(!asked.includes("unrelated"), "must not pay for tests outside the chain");
});

test("collectChainIds reports a cycle rather than looping forever", async () => {
  const steps = new Map([["a", ex("b")], ["b", ex("a")]]);
  const { ids, truncated } = await collectChainIds("a", async (id) => steps.get(id) ?? []);
  assert.ok(ids.includes("b"));
  assert.equal(truncated, true, "an unresolvable loop makes the answer incomplete");
});

test("collectChainIds reports hitting the depth limit", async () => {
  const steps = new Map();
  for (let i = 0; i < DOCUMENTED_MAX_DEPTH + 3; i += 1) steps.set(`n${i}`, ex(`n${i + 1}`));
  const { truncated } = await collectChainIds("n0", async (id) => steps.get(id) ?? []);
  assert.equal(truncated, true);
});
