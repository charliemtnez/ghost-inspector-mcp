/**
 * Stale versus genuinely broken. Reporting a stale test as broken invites
 * someone to overwrite a colleague's fix against a system with no version
 * history, so the direction of every uncertain case is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStaleReport } from "../dist/stale.js";

const NOW = Date.parse("2026-08-05T12:00:00Z");
const iso = (s) => new Date(Date.parse(s)).toISOString();
const RUN = iso("2026-08-01T00:00:00Z");
const BEFORE = iso("2026-01-01T00:00:00Z");
const AFTER = iso("2026-08-03T00:00:00Z");
const EPOCH = iso("1970-01-01T00:00:00Z");

const suite = { _id: "s", name: "S" };
const ex = (...ids) => ids.map((value, sequence) => ({ command: "execute", value, sequence }));

const tests = [
  { _id: "M", name: "module edited after the run", importOnly: true, dateUpdated: AFTER, dateExecutionFinished: EPOCH, passing: null },
  { _id: "N", name: "module untouched", importOnly: true, dateUpdated: BEFORE, dateExecutionFinished: EPOCH, passing: null },
  { _id: "t1", name: "red, stale via its module", suite, passing: false, dateUpdated: BEFORE, dateExecutionFinished: RUN },
  { _id: "t2", name: "red, genuinely broken", suite, passing: false, dateUpdated: BEFORE, dateExecutionFinished: iso("2026-08-02T00:00:00Z") },
  { _id: "t3", name: "red, stale via itself", suite, passing: false, dateUpdated: AFTER, dateExecutionFinished: RUN },
  { _id: "t4", name: "green but unverified", suite, passing: true, dateUpdated: BEFORE, dateExecutionFinished: RUN },
  { _id: "t5", name: "green and current", suite, passing: true, dateUpdated: BEFORE, dateExecutionFinished: iso("2026-08-02T00:00:00Z") },
  { _id: "t6", name: "never run", suite, passing: null, dateUpdated: BEFORE, dateExecutionFinished: EPOCH },
  { _id: "t7", name: "in flight", suite, passing: null, dateUpdated: BEFORE, dateExecutionFinished: iso("2026-08-04T00:00:00Z") },
];
const steps = new Map([
  ["t1", ex("M")], ["t2", ex("N")], ["t3", []], ["t4", ex("M")], ["t5", ex("N")],
  ["t6", []], ["t7", []], ["M", []], ["N", []],
]);

const report = buildStaleReport(tests, steps, NOW);
const stale = (fragment) => report.staleFailures.find((f) => f.name.includes(fragment));

test("a red test whose module changed after the run is stale, not broken", () => {
  const finding = stale("via its module");
  assert.ok(finding);
  assert.deepEqual(finding.changedModules, ["module edited after the run"]);
  assert.equal(finding.selfChanged, false);
});

test("a red test edited itself after its run is stale too", () => {
  const finding = stale("via itself");
  assert.ok(finding);
  assert.equal(finding.selfChanged, true);
});

test("only the test with nothing changed since the run is genuinely broken", () => {
  assert.equal(report.genuineFailures.length, 1);
  assert.equal(report.genuineFailures[0].name, "red, genuinely broken");
});

test("the red pile splits exactly, with nothing lost", () => {
  const t = report.totals;
  assert.equal(t.failing, 3);
  assert.equal(t.failingStale + t.failingGenuine, t.failing);
  assert.equal(t.failingStale, 2);
});

test("a green test whose chain changed is reported as unverified", () => {
  assert.equal(report.totals.passingUnverified, 1);
  assert.equal(report.unverifiedPasses[0].name, "green but unverified");
});

test("a green test with nothing changed is not reported at all", () => {
  assert.ok(!report.unverifiedPasses.some((f) => f.name.includes("current")));
});

test("modules are excluded rather than evaluated", () => {
  // Import-only deletes results, so a module has no run to compare against and
  // would read as stale — burying the real findings under the shared layer.
  assert.equal(report.totals.modulesExcluded, 2);
  const named = [...report.staleFailures, ...report.genuineFailures, ...report.unverifiedPasses];
  assert.ok(!named.some((f) => f.name.startsWith("module")));
  assert.ok(!report.neverRun.some((n) => n.startsWith("module")));
});

test("a test that never ran goes to its own bucket, not to stale", () => {
  assert.deepEqual(report.neverRun, ["never run"]);
  assert.equal(report.totals.neverRun, 1);
});

test("a test mid-flight is not classified", () => {
  assert.equal(report.totals.inFlight, 1);
});

test("an unparseable dateUpdated counts as changed", () => {
  const odd = [{ _id: "x", name: "x", suite, passing: false, dateUpdated: "nonsense", dateExecutionFinished: RUN }];
  const r = buildStaleReport(odd, new Map([["x", []]]), NOW);
  assert.equal(r.totals.failingStale, 1, "unknown must not read as current");
  assert.equal(r.totals.failingGenuine, 0);
});

test("an absent dateUpdated counts as changed", () => {
  const odd = [{ _id: "x", name: "x", suite, passing: false, dateExecutionFinished: RUN }];
  const r = buildStaleReport(odd, new Map([["x", []]]), NOW);
  assert.equal(r.totals.failingStale, 1);
});

test("age is measured against the supplied clock, not the real one", () => {
  assert.equal(stale("via its module").daysSinceLastRun, 4);
});

test("genuine failures are ordered oldest first", () => {
  const many = [
    { _id: "a", name: "a", suite, passing: false, dateUpdated: BEFORE, dateExecutionFinished: iso("2026-07-01T00:00:00Z") },
    { _id: "b", name: "b", suite, passing: false, dateUpdated: BEFORE, dateExecutionFinished: iso("2026-08-04T00:00:00Z") },
  ];
  const r = buildStaleReport(many, new Map([["a", []], ["b", []]]), NOW);
  assert.deepEqual(r.genuineFailures.map((f) => f.name), ["a", "b"]);
});

test("the notes carry the two warnings that matter", () => {
  assert.ok(report.notes.some((n) => n.includes("real forms against production")));
  assert.ok(report.notes.some((n) => n.includes("excluded, not evaluated")));
});

test("the pure function does not trim its own lists", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    _id: `g${i}`, name: `g${i}`, suite, passing: true,
    dateUpdated: AFTER, dateExecutionFinished: RUN,
  }));
  const r = buildStaleReport(many, new Map(many.map((m) => [m._id, []])), NOW);
  assert.equal(r.unverifiedPasses.length, 30);
  assert.equal(r.unverifiedPassesOmitted, 0);
  assert.equal(r.totals.passingUnverified, 30);
});

test("a scoped stale report evaluates only the scope", () => {
  const target = tests.find((t) => !t.importOnly && t.passing === false);
  const scoped = buildStaleReport(tests, steps, NOW, new Set([target._id]));
  assert.equal(scoped.totals.evaluated, 1);
  assert.equal(scoped.scanned.tests, 1, "the scope, not the account");
  assert.equal(scoped.scanned.unreadable, 0, "a test outside the scope is not unreadable, only unread");
  assert.ok(report.totals.evaluated > 1);
});
