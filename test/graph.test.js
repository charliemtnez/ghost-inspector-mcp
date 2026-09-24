/**
 * The `execute` dependency graph. Every question asked of it — blast radius,
 * staleness, what a validation would run — gets *safer looking* when an edge
 * goes missing, so the walks are pinned against cycles and depth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOCUMENTED_MAX_DEPTH,
  buildEdges,
  collectChainIds,
  executedIds,
  fetchDefinitionsClosure,
  walk,
} from "../dist/graph.js";
import { resolveScope } from "../dist/scope.js";

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

test("collectChainIds expands a shared module once, not once per importer", async () => {
  // A diamond: two branches converge on one module. Expanding it per path is
  // what makes a wide chain cost exponentially many loads, and the whole walk
  // runs before every write.
  const steps = new Map([
    ["root", ex("a", "b")],
    ["a", ex("shared")],
    ["b", ex("shared")],
    ["shared", ex("leaf")],
    ["leaf", []],
  ]);
  const loads = [];
  const { ids, truncated } = await collectChainIds("root", async (id) => {
    loads.push(id);
    return steps.get(id) ?? [];
  });
  assert.deepEqual(ids.sort(), ["a", "b", "leaf", "shared"], "converging paths lose no id");
  assert.equal(truncated, false, "a diamond is not a cycle");
  assert.equal(loads.filter((id) => id === "shared").length, 1);
  assert.equal(loads.filter((id) => id === "leaf").length, 1, "the subtree below it is not re-walked either");
});

test("collectChainIds reports a cycle reached through an already-expanded module", async () => {
  // Going around a loop only increases depth, so its return edge always lands
  // on a node the depth memo skips. That is why the cycle verdict is decided
  // from the recorded edges rather than from whichever path was walked.
  const steps = new Map([
    ["root", ex("a", "loop")],
    ["a", ex("loop")],
    ["loop", ex("back")],
    ["back", ex("loop")],
  ]);
  const { truncated } = await collectChainIds("root", async (id) => steps.get(id) ?? []);
  assert.equal(truncated, true, "a loop is unbounded, so the chain was not fully enumerated");
});

test("collectChainIds reports hitting the depth limit", async () => {
  const steps = new Map();
  for (let i = 0; i < DOCUMENTED_MAX_DEPTH + 3; i += 1) steps.set(`n${i}`, ex(`n${i + 1}`));
  const { truncated } = await collectChainIds("n0", async (id) => steps.get(id) ?? []);
  assert.equal(truncated, true);
});

// --- scoping a scan -----------------------------------------------------------

test("a scoped scan still loads every module its tests import", async () => {
  // Evaluating a folder's tests without their modules reads every import as
  // empty, which is exactly how an emptied module looked.
  const defs = {
    t1: [{ command: "execute", value: "m1" }],
    m1: [{ command: "execute", value: "m2" }, { command: "assign" }],
    m2: [{ command: "click" }],
    other: [{ command: "click" }],
  };
  const loaded = [];
  const { steps, unreadable } = await fetchDefinitionsClosure(["t1", "gone"], async (id) => {
    loaded.push(id);
    return defs[id] ?? null;
  });
  assert.deepEqual([...steps.keys()].sort(), ["m1", "m2", "t1"]);
  assert.equal(unreadable, 1, "a definition that could not be read is counted");
  assert.ok(!loaded.includes("other"), "nothing outside the closure is fetched");
});

test("a folder or suite filter matches by id or by name, case-insensitively", () => {
  const folders = [{ _id: "f1", name: "Checkout Flows" }, { _id: "f2", name: "Blog" }];
  const suites = [{ _id: "s1", name: "Cart", folder: "f1" }, { _id: "s2", name: "Payment", folder: "f1" }, { _id: "s3", name: "Posts", folder: "f2" }];
  const tests = [{ _id: "t1", suite: { _id: "s1" } }, { _id: "t2", suite: { _id: "s2" } }, { _id: "t3", suite: { _id: "s3" } }];
  assert.deepEqual([...resolveScope({ folder: "checkout" }, folders, suites, tests).ids].sort(), ["t1", "t2"]);
  assert.deepEqual([...resolveScope({ suite: "s3" }, folders, suites, tests).ids], ["t3"]);
  assert.deepEqual([...resolveScope({ folder: "f1", suite: "pay" }, folders, suites, tests).ids], ["t2"]);
  assert.equal(resolveScope({ folder: "nothing" }, folders, suites, tests).ids.size, 0);
  assert.equal(resolveScope({}, folders, suites, tests), null, "no filter is the whole account");
});
