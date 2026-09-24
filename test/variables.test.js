/** Resolving {{variables}} before an on-demand run, which ignores custom variables and silently turns a missing one into "". */
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectVariables, resolveDefinition } from "../dist/variables.js";

/**
 * An expanded step as the resolver receives it.
 * @param {object} over
 */
const step = (over = {}) => ({
  command: "click", target: "", authoredTarget: "", value: "", variableName: "", condition: null,
  optional: false, fromModule: null, ownerId: "root", ownerName: "Root", indexInOwner: 0, rootIndex: 0, ...over,
});
/** Suite variables from [name, value, private] tuples. */
const suiteVars = (entries) => collectVariables({ suite: entries.map(([name, value, isPrivate = false]) => ({ name, value, private: isPrivate })) });

test("a suite variable reaches the start URL, or the run goes to https://.example.com", () => {
  // On-demand turns an unknown {{x}} into "", and the run can still pass.
  const out = resolveDefinition("https://{{subdomain}}.example.com/path", [], suiteVars([["subdomain", "www"]]));
  assert.equal(out.startUrl, "https://www.example.com/path");
  assert.deepEqual(out.resolved, [{ name: "subdomain", source: "suite" }]);
  assert.deepEqual(out.unresolved, []);
});

test("a variable set by an earlier step is left for the browser", () => {
  const steps = [
    step({ command: "extractEval", value: "return '#lead';", variableName: "formSelector" }),
    step({ target: "{{formSelector}} button", authoredTarget: "{{formSelector}} button" }),
  ];
  const out = resolveDefinition("https://example.com/", steps, suiteVars([["formSelector", "#suite-value"]]));
  assert.equal(out.steps[1].target, "{{formSelector}} button", "the redefinition wins from that step on");
  assert.deepEqual(out.runtime, ["formSelector"]);
  assert.deepEqual(out.unresolved, []);
});

test("a variable used before the step that sets it is unresolved", () => {
  const steps = [
    step({ target: "{{late}}", authoredTarget: "{{late}}" }),
    step({ command: "extract", target: "#x", authoredTarget: "#x", variableName: "late" }),
  ];
  const out = resolveDefinition("https://example.com/", steps, suiteVars([]));
  assert.deepEqual(out.unresolved.map((u) => u.name), ["late"]);
  assert.match(out.unresolved[0].where, /step 0/);
});

test("dotted and built-in names are not refused", () => {
  const steps = [step({ command: "assign", value: "{{timestamp}}-{{alphanumeric}} {{name.firstName}} {{result.id}} {{ lastStep.value }}" })];
  const out = resolveDefinition("https://example.com/", steps, suiteVars([]));
  assert.deepEqual(out.unresolved, []);
  assert.equal(out.steps[0].value, steps[0].value, "left for Ghost Inspector to fill");
});

test("a private variable with no value is unresolved", () => {
  const out = resolveDefinition("https://example.com/{{token}}", [], suiteVars([["token", "", true]]));
  assert.deepEqual(out.unresolved.map((u) => u.name), ["token"]);
  assert.equal(out.unresolved[0].where, "startUrl");
});

test("caller overrides suite overrides organization", () => {
  const vars = collectVariables({
    org: [{ name: "a", value: "org" }, { name: "b", value: "org" }, { name: "c", value: "org" }],
    suite: [{ name: "a", value: "suite" }, { name: "b", value: "suite" }],
    caller: { a: "caller" },
  });
  assert.deepEqual(
    ["a", "b", "c"].map((name) => [vars.get(name).value, vars.get(name).source]),
    [["caller", "caller"], ["suite", "suite"], ["org", "organization"]],
  );
});

test("a fallback array is substituted selector by selector, keeping its shape", () => {
  const authoredTarget = [{ selector: "#{{id}}" }, { selector: "[name={{id}}]" }];
  const out = resolveDefinition("https://example.com/", [step({ target: JSON.stringify(authoredTarget), authoredTarget })], suiteVars([["id", "go"]]));
  assert.deepEqual(out.steps[0].authoredTarget, [{ selector: "#go" }, { selector: "[name=go]" }]);
  assert.equal(out.steps[0].target, JSON.stringify([{ selector: "#go" }, { selector: "[name=go]" }]));
});

test("conditions are resolved too", () => {
  const out = resolveDefinition("https://example.com/", [step({ condition: "return location.host === '{{host}}';" })], suiteVars([["host", "example.com"]]));
  assert.equal(out.steps[0].condition, "return location.host === 'example.com';");
});
