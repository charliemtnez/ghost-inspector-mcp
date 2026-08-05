/**
 * The module predicates. Getting these wrong is the most destructive wrong
 * answer this server can give, so they are pinned case by case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasNeverExecuted, isModule } from "../dist/client.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

test("isModule is true only for an exact importOnly true", () => {
  assert.equal(isModule({ _id: "a", importOnly: true }), true);
  assert.equal(isModule({ _id: "a", importOnly: false }), false);
  assert.equal(isModule({ _id: "a" }), false, "absent means not a module");
  // Truthy is not true: a string would silently reclassify a live test.
  assert.equal(isModule({ _id: "a", importOnly: "yes" }), false);
  assert.equal(isModule({ _id: "a", importOnly: 1 }), false);
});

test("the epoch sentinel counts as never executed", () => {
  assert.equal(hasNeverExecuted({ _id: "a", dateExecutionFinished: EPOCH }), true);
  assert.equal(hasNeverExecuted({ _id: "a", dateExecutionTriggered: EPOCH }), true);
});

test("a real completion date counts as executed", () => {
  assert.equal(
    hasNeverExecuted({ _id: "a", dateExecutionFinished: "2026-08-04T10:00:00.000Z" }),
    false,
  );
});

test("dateExecutionFinished wins, with Triggered as the fallback", () => {
  assert.equal(
    hasNeverExecuted({
      _id: "a",
      dateExecutionFinished: "2026-08-04T10:00:00.000Z",
      dateExecutionTriggered: EPOCH,
    }),
    false,
  );
  assert.equal(
    hasNeverExecuted({ _id: "a", dateExecutionTriggered: "2026-08-04T10:00:00.000Z" }),
    false,
    "falls back when Finished is absent",
  );
});

test("an absent or unreadable date counts as never executed", () => {
  // Erring this way keeps an unknown value from masquerading as a recent run,
  // which would slip a module into a prune list.
  assert.equal(hasNeverExecuted({ _id: "a" }), true);
  assert.equal(hasNeverExecuted({ _id: "a", dateExecutionFinished: null }), true);
  assert.equal(hasNeverExecuted({ _id: "a", dateExecutionFinished: "not-a-date" }), true);
});

test("the guarded ranking keeps live modules out of a prune list", () => {
  // The failure this pair exists to prevent, end to end.
  const account = [
    { _id: "m1", name: "shared success assertions", importOnly: true, dateExecutionFinished: EPOCH },
    { _id: "m2", name: "shared login", importOnly: true, dateExecutionFinished: EPOCH },
    { _id: "t1", name: "live test", dateExecutionFinished: "2026-08-04T10:00:00.000Z" },
    { _id: "t2", name: "truly abandoned", dateExecutionFinished: EPOCH },
  ];

  const naive = account.filter(hasNeverExecuted).map((t) => t.name);
  assert.equal(naive.length, 3, "ranking on dates alone sweeps up both live modules");

  const guarded = account.filter((t) => !isModule(t) && hasNeverExecuted(t)).map((t) => t.name);
  assert.deepEqual(guarded, ["truly abandoned"]);
});
