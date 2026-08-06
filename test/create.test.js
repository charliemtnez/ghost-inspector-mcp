/**
 * Bringing suites and tests into existence.
 *
 * Both operations are additive, so the risk is not an overwrite — it is a mess
 * nobody can clean up. Suites cannot be deleted through this server and folders
 * cannot be deleted through the API at all, and a copy that inherits a schedule
 * starts running on its own. Those two are what these tests pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { nameClashes, plannedChanges } from "../dist/create.js";

test("a copy is silenced unless the caller insists otherwise", async () => {
  // Not verified whether duplicate inherits testFrequency, and confirming it
  // would mean letting a scheduled clone exist in an account whose tests submit
  // real forms to production. Pinned to the safe direction instead: if this
  // ever regresses, a copy starts posting live data unattended.
  const changes = plannedChanges({ sourceTestId: "x" });
  assert.equal(changes.testFrequency, 0);
  assert.deepEqual(changes.testFrequencyAdvanced, []);
});

test("keepSchedule is the only thing that leaves a schedule alone", async () => {
  const kept = plannedChanges({ sourceTestId: "x", keepSchedule: true });
  assert.ok(!("testFrequency" in kept), "an explicit opt-in must not be overridden");

  // Anything short of true is not consent. A model that sets keepSchedule to a
  // truthy string must not silently arm a clone.
  for (const value of [false, undefined, "true", 1, null]) {
    const changes = plannedChanges({ sourceTestId: "x", keepSchedule: value });
    assert.equal(changes.testFrequency, 0, `keepSchedule=${JSON.stringify(value)} must not keep the schedule`);
  }
});

test("placing and renaming travel in the same update as the silencing", async () => {
  // Two round trips would leave a window where the copy is schedulable and
  // sitting in the wrong suite under the source's name.
  const changes = plannedChanges({ sourceTestId: "x", name: "Checkout v2", suiteId: "s".repeat(24) });
  assert.equal(changes.name, "Checkout v2");
  assert.equal(changes.suite, "s".repeat(24));
  assert.equal(changes.testFrequency, 0);
});

test("a blank name does not overwrite the copy's name with nothing", async () => {
  const changes = plannedChanges({ sourceTestId: "x", name: "   " });
  assert.ok(!("name" in changes), "whitespace is not a rename");
});

test("a near-duplicate suite name is caught before it is created", async () => {
  // Ghost Inspector allows two suites with one name and nothing tells them
  // apart afterwards — and neither can be deleted through this server.
  const existing = [
    { _id: "1", name: "Checkout Tests", folder: "f1" },
    { _id: "2", name: "Signup Tests", folder: "f1" },
  ];
  assert.equal(nameClashes(existing, "Checkout Tests").length, 1);
  assert.equal(nameClashes(existing, "  checkout tests  ").length, 1, "case and padding are not a distinction");
  assert.equal(nameClashes(existing, "Checkout Tests v2").length, 0);
});

test("the duplicate check respects the folder it was asked about", async () => {
  const existing = [
    { _id: "1", name: "Smoke", folder: "f1" },
    { _id: "2", name: "Smoke", folder: "f2" },
  ];
  assert.equal(nameClashes(existing, "Smoke", "f1").length, 1, "same name elsewhere is not a clash");
  assert.equal(nameClashes(existing, "Smoke").length, 2, "with no folder, the whole account is the scope");
  assert.equal(nameClashes(existing, "Smoke", "f3").length, 0);
});

test("a suite with no folder is comparable without throwing", async () => {
  const existing = [{ _id: "1", name: "Loose" }];
  assert.equal(nameClashes(existing, "Loose", "f1").length, 0);
  assert.equal(nameClashes(existing, "Loose", "").length, 1, "unfiled reads as the empty folder");
});
