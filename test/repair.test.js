/**
 * Proposing a repair.
 *
 * The risk here is not a missed fix — it is a confident wrong one. This server
 * cannot see the page, so every assertion below is about staying inside what
 * the contract actually guarantees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { missingReturn, proposeForStep } from "../dist/repair.js";

const kinds = (proposals) => proposals.map((p) => p.kind);

test("a text assertion with no target is rewritten, because that always fails", async () => {
  // Verified live: with an empty target it fails as "Text not contained" even
  // when the text is on the page, so the error blames the content.
  const [p] = proposeForStep({ command: "assertTextPresent", target: "", value: "Thank you" }, 3);
  assert.equal(p.kind, "applicable");
  assert.equal(p.after.target, "body");
  assert.equal(p.after.value, "Thank you", "the assertion itself must survive untouched");
  assert.equal(p.sequence, 3);
});

test("a scoped text assertion is left alone", async () => {
  assert.deepEqual(proposeForStep({ command: "assertTextPresent", target: "#main", value: "x" }, 0), []);
});

test("an eval with no return is rewritten, since it can never pass", async () => {
  // Without `return` the body is undefined, which is falsy, so the assertion
  // always fails and reads as a product bug.
  const [p] = proposeForStep({ command: "assertEval", value: "window.dataLayer.length > 0" }, 1);
  assert.equal(p.kind, "applicable");
  assert.match(p.after.value, /^return \(window\.dataLayer\.length > 0\);$/);
});

test("an eval that already returns is not rewritten twice", async () => {
  assert.deepEqual(proposeForStep({ command: "eval", value: "return document.title;" }, 0), []);
  assert.equal(missingReturn("eval", "return 1;"), false);
  assert.equal(missingReturn("eval", "1"), true);
  assert.equal(missingReturn("click", "1"), false, "the rule is only about JavaScript steps");
});

test("a fragile selector is named but never rewritten", async () => {
  // Inventing a replacement would mean guessing at a DOM this server has not
  // seen. A confident wrong selector is worse than no proposal.
  for (const target of ["#list li:nth-of-type(3)", 'xpath=//button[contains(text(), "Continue")]', ".a .b .c .d"]) {
    const proposals = proposeForStep({ command: "click", target }, 0);
    assert.ok(proposals.length > 0, `${target} should be flagged`);
    assert.deepEqual(kinds(proposals), ["advisory"], `${target} must not be auto-rewritten`);
    assert.equal(proposals[0].after, undefined, "an advisory carries no replacement step");
  }
});

test("a stable selector raises nothing", async () => {
  assert.deepEqual(proposeForStep({ command: "click", target: '#checkout [name="submit"]' }, 0), []);
});

test("a one-entry fallback array is flagged as misleading", async () => {
  // It reads as though it has fallbacks and has none, so the next reader
  // believes the step is more robust than it is.
  const [p] = proposeForStep({ command: "click", target: [{ selector: "#go" }] }, 2);
  assert.equal(p.kind, "advisory");
  assert.match(p.rationale, /has none/);
});

test("a genuine fallback array is not flagged", async () => {
  assert.deepEqual(proposeForStep({ command: "click", target: [{ selector: "#go" }, { selector: "[name=go]" }] }, 0), []);
});
