/**
 * The reverse index. A direct-importer count understates risk, and a test that
 * executes nothing passes while asserting nothing — both are pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildUsage } from "../dist/modules.js";

const ex = (...ids) => ids.map((value, sequence) => ({ command: "execute", value, sequence }));
const step = (command = "click", target = "#a") => ({ command, target });

const tests = [
  { _id: "A", name: "mod A", importOnly: true },
  { _id: "B", name: "mod B", importOnly: true },
  { _id: "C", name: "imported non-module", importOnly: false },
  { _id: "D", name: "orphan mod", importOnly: true },
  { _id: "t1", name: "t1" },
  { _id: "t2", name: "t2" },
  { _id: "t3", name: "t3" },
  { _id: "t4", name: "t4 broken ref" },
  { _id: "X", name: "cycle X", importOnly: true },
  { _id: "Y", name: "cycle Y", importOnly: true },
];
const steps = new Map([
  ["t1", ex("A")],
  ["t2", ex("A")],
  ["t3", ex("C")],
  ["A", ex("B")],
  ["B", [step()]],
  ["C", [step()]],
  ["D", [step()]],
  ["X", ex("Y")],
  ["Y", ex("X")],
  ["t4", ex("does-not-exist")],
]);

const report = buildUsage(tests, steps);
const mod = (name) => report.modules.find((m) => m.name === name);

test("direct importers are counted from the steps that name the module", () => {
  assert.equal(mod("mod A").directImporters, 2);
});

test("the transitive blast radius exceeds the direct count", () => {
  // The trap: reading "1 importer" on mod B would call it safe to edit.
  assert.equal(mod("mod B").directImporters, 1);
  assert.equal(mod("mod B").allImporters, 3);
  assert.equal(mod("mod B").maxDepth, 2);
});

test("a module lists what it imports itself", () => {
  assert.deepEqual(mod("mod A").imports, ["mod B"]);
});

test("an imported test missing the import-only flag is surfaced", () => {
  assert.equal(mod("imported non-module").importOnly, false);
  assert.equal(report.totals.importedNonModules, 1);
  assert.ok(report.notes.some((n) => n.includes("NOT flagged import-only")));
});

test("a module nobody imports is reported as unused", () => {
  assert.deepEqual(report.unusedModules, ["orphan mod"]);
  assert.ok(report.notes.some((n) => n.includes("imported by nothing")));
});

test("a broken execute reference is reported, not silently dropped", () => {
  assert.deepEqual(report.brokenReferences, [{ test: "t4 broken ref", missingId: "does-not-exist" }]);
});

test("a cycle is flagged as a defect and excluded from its own count", () => {
  assert.equal(mod("cycle X").inCycle, true);
  assert.equal(mod("cycle Y").inCycle, true);
  assert.equal(report.totals.cycles, 2);
  // Self-reach would inflate the blast radius by one and read as a dependency.
  assert.deepEqual(mod("cycle X").importers.map((i) => i.name), ["cycle Y"]);
  assert.equal(mod("cycle X").allImporters, 1);
});

test("an acyclic module is not flagged", () => {
  assert.equal(mod("mod A").inCycle, false);
  assert.equal(mod("mod B").inCycle, false);
});

test("modules are sorted by blast radius, widest first", () => {
  const radii = report.modules.map((m) => m.allImporters);
  assert.deepEqual(radii, [...radii].sort((a, b) => b - a));
});

test("the pure function does not trim its own lists", () => {
  // Trimming is presentation, applied at the boundary, so an omission count
  // here would be one this function did not cause.
  const many = Array.from({ length: 40 }, (_, i) => ({ _id: `w${i}`, name: `w${i}` }));
  const wide = buildUsage(
    [{ _id: "M", name: "M", importOnly: true }, ...many],
    new Map([["M", [step()]], ...many.map((m) => [m._id, ex("M")])]),
  );
  const target = wide.modules.find((m) => m.name === "M");
  assert.equal(target.importers.length, 40);
  assert.equal(target.omittedImporters, 0);
});

test("scanned counts a definition that could not be read", () => {
  const partial = buildUsage(tests, new Map([...steps].slice(0, 5)));
  assert.equal(partial.scanned.tests, tests.length);
  assert.equal(partial.scanned.stepRequests, 5);
  assert.equal(partial.scanned.unreadable, tests.length - 5);
});

// --- tests that pass while asserting nothing -------------------------------

const vacuousTests = [
  { _id: "EMPTY", name: "empty mod", importOnly: true },
  { _id: "MID", name: "mod of only executes", importOnly: true },
  { _id: "REAL", name: "real mod", importOnly: true },
  { _id: "v1", name: "vacuous direct" },
  { _id: "v2", name: "vacuous through a chain" },
  { _id: "ok1", name: "has its own step" },
  { _id: "ok2", name: "acts through a module" },
];
const vacuousSteps = new Map([
  ["EMPTY", []],
  ["MID", ex("EMPTY")],
  ["REAL", [step()]],
  ["v1", ex("EMPTY")],
  ["v2", ex("MID")],
  ["ok1", [step("assertTextPresent", "body")]],
  ["ok2", ex("REAL")],
]);
const vacuous = buildUsage(vacuousTests, vacuousSteps);

test("a test whose chain bottoms out in empty modules is vacuous", () => {
  assert.ok(vacuous.vacuousTests.includes("vacuous direct"));
  assert.ok(vacuous.vacuousTests.includes("vacuous through a chain"));
  assert.equal(vacuous.totals.vacuousTests, 2);
});

test("a test that does anything at all is not vacuous", () => {
  assert.ok(!vacuous.vacuousTests.includes("has its own step"));
  assert.ok(!vacuous.vacuousTests.includes("acts through a module"));
});

test("modules are never listed as vacuous tests", () => {
  assert.ok(!vacuous.vacuousTests.some((n) => n.startsWith("mod") || n.includes("mod")));
});

test("a no-op module is measured through its chain, not by literal emptiness", () => {
  // MID holds one step, so it is not empty — but it contributes nothing.
  assert.ok(vacuous.noOpModules.includes("empty mod"));
  assert.ok(vacuous.noOpModules.includes("mod of only executes"));
  assert.ok(!vacuous.noOpModules.includes("real mod"));
  assert.equal(vacuous.totals.noOpModules, 2);
});

test("the vacuous finding is spelled out in the notes", () => {
  assert.ok(vacuous.notes.some((n) => n.includes("execute NO steps at all")));
  assert.ok(vacuous.notes.some((n) => n.includes("contribute no real step")));
});

test("importers come back with their ids", () => {
  assert.ok(mod("mod A").importers.every((i) => typeof i.id === "string" && typeof i.name === "string"));
});
