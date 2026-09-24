/**
 * The account overview. The counts are the product here: a module folded into a
 * failure count invents breakage and aims cleanup at shared steps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarize } from "../dist/inventory.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
const RECENT = "2026-08-04T10:00:00.000Z";

const folders = [{ _id: "f1", name: "Beta" }, { _id: "f2", name: "Alpha" }];
const suites = [
  { _id: "s1", name: "Forms", folder: "f1" },
  { _id: "s2", name: "Empty", folder: "f2" },
  { _id: "s3", name: "Unfiled" },
];
const T = (id, name, suite, extra = {}) => ({
  _id: id,
  name,
  ...(suite ? { suite: { _id: suite, name: "x" } } : {}),
  ...extra,
});
const tests = [
  T("t1", "ok", "s1", { passing: true }),
  T("t2", "red A", "s1", { passing: false }),
  T("t3", "red B", "s1", { passing: false }),
  T("t4", "shared", "s1", { importOnly: true, passing: null, dateExecutionFinished: EPOCH }),
  T("t5", "queued", "s1", { passing: null, dateExecutionFinished: RECENT }),
  T("t6", "abandoned", "s3", { passing: null, dateExecutionFinished: EPOCH }),
];

const report = summarize(folders, suites, tests, ["Acme"]);
const folder = (name) => report.folders.find((f) => f.name === name);
const suite = (folderName, suiteName) =>
  folder(folderName).suites.find((s) => s.name === suiteName);

test("every test lands in exactly one bucket", () => {
  const t = report.totals;
  assert.equal(t.passing + t.failing + t.modules + t.notRun, t.tests);
  assert.deepEqual(
    { passing: t.passing, failing: t.failing, modules: t.modules, notRun: t.notRun },
    { passing: 1, failing: 2, modules: 1, notRun: 2 },
  );
});

test("a module is never counted as failing", () => {
  assert.equal(suite("Beta", "Forms").failing, 2, "only the two genuinely red tests");
  assert.equal(suite("Beta", "Forms").modules, 1);
});

test("neverExecuted excludes tests that report a pass or a fail", () => {
  // A boolean `passing` proves the test ran, whatever its date field says.
  assert.equal(report.totals.neverExecuted, 1, "only the abandoned one");
});

test("failing tests come back with their ids, sorted by name", () => {
  assert.deepEqual(suite("Beta", "Forms").failingTests.map((t) => t.name), ["red A", "red B"]);
  assert.ok(suite("Beta", "Forms").failingTests.every((t) => typeof t.id === "string" && t.id));
});

test("failingTests is omitted when a suite is green", () => {
  assert.equal(suite("Alpha", "Empty").failingTests, undefined);
});

test("a suite with no tests still appears", () => {
  // Seeded from the suite list: an empty suite is a finding, not a gap.
  assert.equal(suite("Alpha", "Empty").tests, 0);
});

test("a suite with no folder is grouped rather than dropped", () => {
  assert.ok(folder("(no folder)"), "an unfiled suite must still be visible");
  assert.equal(suite("(no folder)", "Unfiled").tests, 1);
});

test("folders and suites are sorted by name", () => {
  assert.deepEqual(report.folders.map((f) => f.name), ["(no folder)", "Alpha", "Beta"]);
});

test("the notes explain the module exclusion before any conclusion is drawn", () => {
  assert.ok(report.notes.some((n) => n.includes("import-only")));
  assert.ok(report.notes.some((n) => n.includes("never completed a run")));
});

test("a multi-organization key is called out", () => {
  const multi = summarize(folders, suites, tests, ["Acme", "Other"]);
  assert.ok(multi.notes.some((n) => n.includes("2 organizations")));
});

test("totals count folders and suites from the source lists", () => {
  assert.equal(report.totals.folders, 2);
  assert.equal(report.totals.suites, 3);
});
