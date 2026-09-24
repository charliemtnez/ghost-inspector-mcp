/** Finding tests by name, place or step, with the ids every other tool needs. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeFound, matchListing, matchSteps } from "../dist/find.js";

const folders = [{ _id: "f1", name: "Checkout" }];
const suites = [{ _id: "s1", name: "Cart", folder: "f1" }, { _id: "s2", name: "Blog" }];
const tests = [
  { _id: "t1", name: "Cart: add item", suite: { _id: "s1", name: "Cart" }, passing: true },
  { _id: "t2", name: "Blog: read post", suite: { _id: "s2", name: "Blog" }, passing: false },
  { _id: "m1", name: "Login module", suite: { _id: "s1", name: "Cart" }, importOnly: true, passing: null },
];

test("a step search matches fallback selectors too", () => {
  const steps = [
    { command: "click", target: [{ selector: "#buy" }, { selector: "[data-test=checkout]" }] },
    { command: "assign", target: "#email", value: "jane@example.com" },
  ];
  assert.deepEqual(matchSteps(steps, { target: "data-test=checkout" }).map((m) => m.index), [0]);
  assert.deepEqual(matchSteps(steps, { command: "ASSIGN", value: "example.com" }).map((m) => m.index), [1]);
  assert.deepEqual(matchSteps(steps, { command: "click", value: "x" }), [], "every given field must match");
});

test("results carry ids", () => {
  const found = matchListing(tests, suites, folders, { folder: "checkout" }).map((t) => describeFound(t, suites, folders));
  assert.deepEqual(found.map((f) => f.id), ["t1", "m1"]);
  assert.deepEqual(found[0].suite, { id: "s1", name: "Cart" });
  assert.deepEqual(found[0].folder, { id: "f1", name: "Checkout" });
  assert.equal(found[1].importOnly, true);
});

test("a name matches case-insensitively, and filters combine", () => {
  assert.deepEqual(matchListing(tests, suites, folders, { name: "blog" }).map((t) => t._id), ["t2"]);
  assert.deepEqual(matchListing(tests, suites, folders, { name: "cart", suite: "blog" }), []);
  assert.equal(matchListing(tests, suites, folders, {}).length, 3, "no filter lists everything");
});
