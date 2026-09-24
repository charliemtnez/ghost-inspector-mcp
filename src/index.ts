#!/usr/bin/env node
/**
 * ghost-inspector-mcp — MCP server entry point.
 *
 * Every tool is registered and visible. Mutating tools refuse unless
 * GHOST_INSPECTOR_ALLOW_WRITES=true and executing refuses unless
 * GHOST_INSPECTOR_ALLOW_RUNS=true — enforced per call, so the answer to a
 * caller without the opt-in is an instruction rather than an absence.
 *
 * Suite deletion is never exposed at any setting: DELETE /suites/{id} cascades
 * to every test in the suite with no version history and no recycle bin.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { redact, runsAllowed, writesAllowed } from "./config.js";
import { stripCredentials } from "./redact-record.js";
import { request } from "./client.js";
import { createSuite, duplicateTest } from "./create.js";
import { getTest, readBatch } from "./detail.js";
import { findTests } from "./find.js";
import { diagnoseTest } from "./diagnose.js";
import { type Steps } from "./graph.js";
import { failureGroups, testHistory } from "./history.js";
import { getInventory } from "./inventory.js";
import { getModuleUsage } from "./modules.js";
import { acceptScreenshot, screenshotStatus } from "./screenshots.js";
import { getStaleTests } from "./stale.js";
import { planTest, validateTest, type ValidateOptions } from "./validate.js";
import { getVacuousTests } from "./vacuous.js";
import { proposeRepair } from "./repair.js";
import { runTest } from "./run.js";
import { moveSuite, updateTest } from "./writes.js";

// The manifest ships beside dist/ in the npm package, so it is readable in
// every installed layout. One source for the version; npm bumps it, this reads it.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

// `instructions` is the only place the server can describe itself as a whole.
// Every tool is listed, gated or not, so nothing has to be inferred from an
// absence — that inference is exactly what went wrong before, when a model
// concluded from a short tool list that this server could not write at all.
const server = new McpServer(
  {
    name: "ghost-inspector",
    title: "Ghost Inspector",
    version,
  },
  {
    instructions:
      "Analyze, validate and safely update Ghost Inspector end-to-end browser tests.\n\n" +
      "EVERY tool is listed, including the gated ones, so you never have to infer a " +
      "capability from an absence. Reading needs nothing. Mutating (gi_update_test, " +
      "gi_move_suite, gi_create_suite, gi_duplicate_test, gi_accept_screenshot) needs " +
      "GHOST_INSPECTOR_ALLOW_WRITES=true. Executing a stored test (gi_run_test) needs " +
      "GHOST_INSPECTOR_ALLOW_RUNS=true, which the write variable does NOT imply. Call a " +
      "gated tool without its variable and it refuses, changes nothing, and tells the user " +
      "exactly what to set — relay that instead of concluding the server cannot do it. You " +
      "cannot open either gate yourself, and no tool will ever accept a key or a flag as an " +
      "argument. gi_whoami reports both gates.\n\n" +
      "Before proposing any edit, call gi_get_test: it returns the current definition and " +
      "the `dateUpdated` that gi_update_test requires as `expectedDateUpdated`. Do not " +
      "obtain that token by sending a wrong value and reading it off the refusal.\n\n" +
      "Two facts that cause wrong diagnoses if you miss them. A red test whose definition " +
      "or imported module changed after its last run is STALE, not broken: the failure " +
      "describes a version that no longer exists, so do not repair from it. And modules " +
      "(importOnly) have no results at all, so `passing` is never a boolean for one and " +
      "its last-run date sits at a 1970 sentinel — that is not a failure.\n\n" +
      "Many tests in a real account submit live forms against production. Treat executing " +
      "anything as an action with real-world effects.",
  },
);

/** Wraps a handler so results come back credential-free and failures as readable, key-free text. */
async function safeText(run: () => Promise<unknown>) {
  try {
    const value = stripCredentials(await run());
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `ERROR: ${redact(message)}` }],
      isError: true,
    };
  }
}

/**
 * Runs a read for one id or a batch of them, refusing both or neither.
 *
 * @param testId A single id.
 * @param testIds Up to 20 ids.
 * @param read Reads one id.
 * @return The single result, or {results} with one entry per id.
 * @throws {Error} when both or neither are given.
 */
async function oneOrMany<T>(
  testId: string | undefined,
  testIds: string[] | undefined,
  read: (id: string) => Promise<T>,
): Promise<T | { results: Array<{ id: string; result?: T; error?: string }> }> {
  if ((testId === undefined) === (testIds === undefined)) {
    throw new Error("Pass exactly one of testId (one test) or testIds (up to 20).");
  }
  if (testId !== undefined) return read(testId);
  return { results: await readBatch(testIds ?? [], read) };
}

/**
 * Wraps a gated handler so the tool is always visible and refuses in words.
 *
 * Every tool is registered unconditionally, including the ones that mutate or
 * execute. Withholding them by not registering them makes a gated tool
 * indistinguishable from one that does not exist, and the observed consequence
 * was a model telling its user this server could not write at all — confidently,
 * with nothing available to contradict it. Hiding a capability does not stop
 * anyone asking for it; it only stops them being told how to enable it.
 *
 * 🔴 The guarantee is unchanged and lives here: an operator who has not opted
 * in cannot mutate or execute anything, no matter what the calling model is
 * persuaded to attempt. The check simply happens at call time rather than at
 * registration, so the answer can be an instruction instead of an absence.
 * `server.test.js` proves every gated tool refuses without its variable.
 *
 * @param allowed The gate's current state, re-read on every call.
 * @param variable Environment variable that opens it.
 * @param why What the operator is consenting to, and why it is separate.
 */
function gated(allowed: boolean, variable: string, why: string, run: () => Promise<unknown>) {
  if (allowed) return safeText(run);
  return Promise.resolve({
    content: [
      {
        type: "text" as const,
        text:
          `REFUSED: ${variable} is not set to "true", so this server will not do this.\n\n` +
          `Nothing happened. ${why}\n\n` +
          `This is the operator's decision and you cannot make it from a tool call. ` +
          `Ask the user to set ${variable}=true in the environment that launches this ` +
          `server, then restart it. For a Claude Code user that is:\n` +
          `  claude mcp remove ghost-inspector -s user\n` +
          `  claude mcp add ghost-inspector -s user -e ${variable}=true -- npx -y ghost-inspector-mcp\n` +
          `Call gi_whoami afterwards to confirm the gate is open.`,
      },
    ],
    isError: true,
  });
}

const WHY_WRITES =
  "Editing a Ghost Inspector test is permanent: there is no version history for steps and no recycle bin, so an operator opts in once, deliberately.";
const WHY_RUNS =
  "Running a stored test executes it against a real environment and can submit a real form. It is a separate decision from allowing edits, because an edit can be rolled back from the backup this server returns and a submission cannot.";

interface Organization {
  _id: string;
  name?: string;
}

// Annotations state the same posture the server enforces, in the vocabulary
// clients use to decide permission prompts. gi_validate_test is deliberately
// NOT read-only: it changes nothing in the account, but it drives a real
// browser against a real URL, and that is a side effect.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "gi_whoami",
  {
    title: "Ghost Inspector: verify credentials and check what this server may do",
    description:
      "Confirms the configured API key works, lists the organizations it can " +
      "reach, and reports whether writing is enabled. Read-only and safe to call " +
      "first when diagnosing setup.\n\n" +
      "🔴 Call this before concluding that this server cannot modify anything. Every " +
      "tool is registered whether or not its gate is open, so a tool being listed " +
      "says nothing about whether it will run. `writesEnabled` and `runsEnabled` " +
      "are the authority — GHOST_INSPECTOR_ALLOW_WRITES and GHOST_INSPECTOR_ALLOW_RUNS. " +
      "When one is false the operator must set the matching " +
      "variable and restart this server; it cannot be turned on from a tool call.\n\n" +
      "Returns each organization's id — export the one you want as " +
      "GHOST_INSPECTOR_ORG_ID to enable on-demand validation runs.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () =>
    safeText(async () => {
      const orgs = await request<Organization[]>("GET", "organizations");
      return {
        writesEnabled: writesAllowed(),
        runsEnabled: runsAllowed(),
        gates: {
          writes:
            "GHOST_INSPECTOR_ALLOW_WRITES — gi_update_test, gi_move_suite, gi_create_suite, gi_duplicate_test, gi_accept_screenshot",
          runs: "GHOST_INSPECTOR_ALLOW_RUNS — gi_run_test. Not implied by the write gate.",
        },
        organizations: orgs.map((o) => ({ id: o._id, name: o.name })),
      };
    }),
);

server.registerTool(
  "gi_inventory",
  {
    title: "Ghost Inspector: account overview",
    description:
      "Read-only tour of the whole account: every folder, the suites inside it, " +
      "and per-suite counts of passing / failing / module / not-yet-run tests, " +
      "plus the names of the failing ones. Start here — no other question about " +
      "this account can be answered without knowing what is in it.\n\n" +
      "Import-only tests (modules: shared steps that other tests import, the " +
      "equivalent of a function) are counted in their own bucket and never as " +
      "failures. Marking a test import-only deletes its stored results, so every " +
      "module looks permanently unrun; folding that into a failure count invents " +
      "breakage that does not exist and aims cleanup at the steps the live tests " +
      "all share. Read the `notes` field before drawing conclusions.\n\n" +
      "Fetches roughly 440 KB from the API and returns a summary of it, so ask " +
      "for the whole account rather than probing folder by folder. Totals always " +
      "describe the entire account even when a filter narrows the listing.",
    inputSchema: {
      folder: z
        .string()
        .optional()
        .describe("Case-insensitive substring of a folder name. Omit to see every folder."),
      failingOnly: z
        .boolean()
        .optional()
        .describe("List only suites with at least one failing test. Totals stay account-wide."),
    },
    annotations: READ_ONLY,
  },
  async ({ folder, failingOnly }) => safeText(() => getInventory({ folder, failingOnly })),
);

server.registerTool(
  "gi_module_usage",
  {
    title: "Ghost Inspector: who imports each module",
    description:
      "Answers the one question the API cannot: if I edit this module, which " +
      "tests break? Builds the reverse index of `execute` steps — for every " +
      "imported test, its direct importers and its full transitive blast radius " +
      "through nested chains. Run this BEFORE editing any module.\n\n" +
      "Also surfaces three things that only appear once the index exists: " +
      "import-only tests nobody imports (dead, or a test that lost its caller " +
      "and is silently not running); imported tests NOT flagged import-only, " +
      "which run standalone *and* inside their importers, so an edit changes " +
      "both paths; and execute steps pointing at ids that no longer exist.\n\n" +
      "🔴 It also finds `vacuousTests`: tests that execute no steps at all, " +
      "because their definition is only `execute` calls and the chain bottoms out " +
      "in empty modules. Those pass — nothing can fail — so the dashboard shows " +
      "them green while they assert nothing, which is worse than a red test and " +
      "invisible any other way. Emptying one shared module does this to every " +
      "test that imports it.\n\n" +
      "This is the expensive tool. `steps` is absent from the test listing, so " +
      "it costs one request per test in the account — a few seconds for a few " +
      "hundred tests, at deliberately low concurrency because the rate limit is " +
      "undisclosed. Call it once and work from the result rather than per module. " +
      "A definition that cannot be read is counted in `scanned.unreadable`, never " +
      "skipped silently, because a missing definition understates a blast radius.",
    inputSchema: {
      folder: z.string().optional().describe("Folder id, or part of its name. Lists only the modules its tests import; counts stay account-wide."),
      suite: z.string().optional().describe("Suite id, or part of its name. Lists only the modules its tests import; with folder, both apply."),
      module: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring of a module name. Narrows the listing and names every importer instead of capping the list.",
        ),
    },
    annotations: READ_ONLY,
  },
  async ({ module, folder, suite }) => safeText(() => getModuleUsage({ module, folder, suite })),
);

server.registerTool(
  "gi_stale_tests",
  {
    title: "Ghost Inspector: stale versus genuinely broken",
    description:
      "Call this BEFORE diagnosing or editing any red test. Splits failures into " +
      "two piles by comparing the whole `execute` chain's `dateUpdated` against " +
      "each test's last run.\n\n" +
      "`staleFailures` are red tests whose definition or module chain changed " +
      "AFTER the failing run. The failure describes a version that no longer " +
      "exists — a colleague may already have fixed it and the test simply has not " +
      "run again. Editing on top of one destroys their work, and Ghost Inspector " +
      "keeps no version history of steps. One level deep is not enough here, " +
      "because modules nest; the whole chain is walked.\n\n" +
      "`genuineFailures` have had no change since the failing run, so the failure " +
      "still describes the current definition. Start there, oldest first.\n\n" +
      "🔴 Re-running is not free advice: many Ghost Inspector suites submit real " +
      "forms against production. Confirm what a test does before triggering it.\n\n" +
      "Also reports the case nobody looks for: passing tests whose chain changed " +
      "after their last run, whose green result describes the old definition and " +
      "proves nothing about the current one. Import-only modules are excluded " +
      "rather than evaluated, since they have no results to compare against.\n\n" +
      "Costs one request per test, a few seconds for a few hundred tests.",
    inputSchema: {
      folder: z.string().optional().describe("Folder id, or part of its name. Narrows the report to that folder's tests."),
      suite: z.string().optional().describe("Suite id, or part of its name. Narrows the report to that suite's tests; with folder, both apply."),
      includePasses: z
        .boolean()
        .optional()
        .describe(
          "List the passing-but-unverified tests too. Off by default because it is the long bucket; the count is always reported.",
        ),
    },
    annotations: READ_ONLY,
  },
  async ({ includePasses, folder, suite }) => safeText(() => getStaleTests({ includePasses, folder, suite })),
);

const STEP_SCHEMA = z.object({
  command: z
    .string()
    .describe(
      "One of: assertElementNotPresent, assertElementNotVisible, assertElementPresent, assertElementVisible, assertEval, assertNotText, assertText, assertTextNotPresent, assertTextPresent, assign, click, dragAndDrop, eval, execute, exit, extract, extractEval, keypress, mouseOver, open, pause, refresh, screenshot, store.",
    ),
  target: z
    .union([z.string(), z.array(z.object({ selector: z.string() }).passthrough())])
    .optional()
    .describe(
      "CSS selector, or an array of fallback selectors ({selector}) tried in order, as gi_get_test returns them. 🔴 REQUIRED by the text assertions: assertTextPresent with no target fails with \"Text not contained\" even when the text is plainly on the page, which reads as a product bug rather than a malformed step — scope it to body at minimum. Anchor to stable semantic attributes (data-*, name, id) and scope to a container id. Never :nth-of-type, never XPath matching visible copy, never long chains of presentational classes. A selector matching more than one element is a latent failure. Attribute selectors need brackets: [data-x=\"y\"], not data-x=\"y\", which is not valid CSS and never matched anything.",
    ),
  value: z
    .string()
    .optional()
    .describe(
      "For assign, the value to type — send it unformatted and assert the formatted result, so the test exercises the input mask instead of bypassing it. For eval and assertEval, JavaScript that MUST contain an explicit return; without one it evaluates to undefined and the assertion always fails, which looks like a product bug. For execute, the module's test id.",
    ),
  variableName: z.string().optional(),
  condition: z
    .union([z.string(), z.object({ statement: z.string() })])
    .nullable()
    .optional()
    .describe(
      "JavaScript deciding whether the step runs, with an explicit return. Stored as {statement}, which gi_get_test returns; a bare string is written in that shape. AND-ed with conditions inherited from enclosing imports.",
    ),
  optional: z.boolean().optional().describe("Continue when this step fails."),
  private: z.boolean().optional().describe("Hide the step's value in results, for secrets. Kept on every write; omitting it clears it."),
});

server.registerTool(
  "gi_find_tests",
  {
    title: "Ghost Inspector: find tests by name, place or step",
    description:
      "Read-only. Finds tests and returns their ids, which every other tool takes, " +
      "with suite, folder, importOnly and passing.\n\n" +
      "`name`, `folder` and `suite` are matched against the listing: case-insensitive " +
      "substrings, or an exact id for folder and suite. They are cheap, three requests. " +
      "`step` searches each remaining test's own steps (command exact, target across " +
      "every fallback selector, value as a substring) and costs one request per test " +
      "left after the other filters, so narrow first on a large account. A match " +
      "inside a module is reported on the module, not on the tests that import it; " +
      "gi_module_usage lists those.",
    inputSchema: {
      name: z.string().optional().describe("Part of the test's name."),
      folder: z.string().optional().describe("Folder id, or part of its name."),
      suite: z.string().optional().describe("Suite id, or part of its name."),
      step: z
        .object({
          command: z.string().optional().describe('Exact command, e.g. "click".'),
          target: z.string().optional().describe("Part of any authored selector, fallbacks included."),
          value: z.string().optional().describe("Part of the step's value."),
        })
        .optional()
        .describe("Match tests by what their own steps do. All given fields must match one step."),
      limit: z.number().int().min(1).max(500).optional().describe("Most results to return. Default 50; `total` is always the full count."),
    },
    annotations: READ_ONLY,
  },
  async ({ name, folder, suite, step, limit }) => safeText(() => findTests({ name, folder, suite, step, limit })),
);

server.registerTool(
  "gi_get_test",
  {
    title: "Ghost Inspector: read one test, with the token an edit requires",
    description:
      "Returns a single test's stored definition, identity and current state: " +
      "steps, startUrl, suite, whether it is a module, its last run, and its " +
      "`dateUpdated`.\n\n" +
      "🔴 `dateUpdated` is the concurrency token. gi_update_test requires it as " +
      "`expectedDateUpdated` and refuses the write if the record moved since you " +
      "read it. Call this first and pass the value through. Do not discover the " +
      "token by sending a deliberately wrong one and reading the correct value " +
      "off the refusal — that defeats the guard, which exists to prove the edit " +
      "was composed against the definition that is actually stored.\n\n" +
      "The steps returned are the test's OWN steps. An `execute` step names an " +
      "imported module in `value` and is not expanded here, so the definition you " +
      "edit may be smaller than the run you observed: a result expands every " +
      "module inline. If the step you need to fix came from a module, edit that " +
      "module's test, not this one.",
    inputSchema: {
      testId: z.string().optional().describe("The 24-character test id."),
      testIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .optional()
        .describe("Up to 20 test ids instead of testId. Each comes back with its own result or error; one failure does not sink the rest."),
      expandModules: z
        .boolean()
        .optional()
        .describe(
          "Also return `expanded`: every step a run would execute, modules inlined, each with ownerId, ownerName, indexInOwner (its position in its owner's own list), rootIndex and the combined condition. It lines up with a result's steps position by position.",
        ),
    },
    annotations: READ_ONLY,
  },
  async ({ testId, testIds, expandModules }) =>
    safeText(() => oneOrMany(testId, testIds, (id) => getTest(id, { expandModules }))),
);

server.registerTool(
  "gi_test_result",
  {
    title: "Ghost Inspector: why is this test red",
    description:
      "The last run of one test: the step that failed, its error, and whether " +
      "the result can be trusted at all. Read-only. This is the starting point " +
      "for repairing a failure — gi_stale_tests tells you which tests to look " +
      "at, this tells you what happened in one of them.\n\n" +
      "🔴 Read `verdict` and `staleness` BEFORE the error. A verdict of `stale` " +
      "means the test or one of its imported modules changed after this run, so " +
      "the failure describes a definition that is no longer stored. Diagnosing " +
      "from it is diagnosing from nothing, and a colleague may already have " +
      "fixed it. Re-run the test and read the fresh result instead.\n\n" +
      "🔴 `failingStep.resolvedTarget` is the selector that resolved, NOT what " +
      "the test looks for. Ghost Inspector collapses an authored fallback array " +
      "to the one it used, and sometimes normalises it so it matches nothing in " +
      "the definition textually. `authoredTargets` is what was actually written. " +
      "Reporting the resolved one as the intent is a real and easy misreading.\n\n" +
      "🔴 `failingStep.ownedBy` names the test that contributed the step. " +
      "Results expand imported modules inline, so the failing step frequently " +
      "belongs to a module rather than to the test you asked about — that module " +
      "is what needs editing, and editing it affects every test that imports it. " +
      "The step's position in the result is meaningless against the definition; " +
      "use `ownedBy.sequenceInOwner`.\n\n" +
      "`failingStep.mapping` says how that position was found. `position`: the " +
      "current definition was expanded locally and lines up with the result step " +
      "for step. `stored sequence`: it did not, and the result's own stored " +
      "position was used because the run recorded a distinct one for every step " +
      "of that owner. " +
      "`unmapped`: neither held, so sequenceInOwner and authoredTargets are " +
      "unknown — never guessed. A result's own `extra.source.sequence` is copied " +
      "from the stored `sequence` field, which a client that omits it leaves at 0 " +
      "on every step, so it is not trusted on its own.\n\n" +
      "Other cases it distinguishes rather than blurring: a module (import-only " +
      "tests have no results at all), a run still in flight (`passing: null` is " +
      "pending, never failed), a red run with no failing step (the failure was " +
      "outside the steps — a start URL that would not load), and results that " +
      "have been purged, which it reports as a horizon instead of as silence.",
    inputSchema: {
      testId: z.string().optional().describe("The 24-character test id."),
      testIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .optional()
        .describe("Up to 20 test ids instead of testId. Each comes back with its own result or error; one failure does not sink the rest."),
      runsBack: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("0 (default) is the latest run. Higher walks backwards, within the retained window."),
    },
    annotations: READ_ONLY,
  },
  async ({ testId, testIds, runsBack }) =>
    safeText(() => oneOrMany(testId, testIds, (id) => diagnoseTest({ testId: id, runsBack }))),
);

server.registerTool(
  "gi_test_history",
  {
    title: "Ghost Inspector: a test's run history, and when its red began",
    description:
      "Read-only. Walks a test's results newest first, 50 per page, and returns " +
      "each run's verdict and failing step (command, error, the selector that " +
      "resolved), plus `lastPass` and `firstFail`, the oldest failure of the current " +
      "red streak, which dates a regression.\n\n" +
      "🔴 Read `horizon` before concluding anything. Ghost Inspector purges old " +
      "results. `exhausted: true` means retention ended there and nothing older " +
      "exists. `exhausted: false` means more history exists than was asked for, and " +
      "`streakMayContinue` says the red streak may have begun earlier: raise `runs`. " +
      "A run with `passing: null` is in flight, never a failure. Modules are refused: " +
      "import-only deletes their results. For why the latest run failed, " +
      "gi_test_result maps the failing step back to its definition.",
    inputSchema: {
      testId: z.string().describe("The 24-character test id."),
      runs: z.number().int().min(1).max(500).optional().describe("How many runs to walk back. Default 50, at most 500; one request per 50."),
    },
    annotations: READ_ONLY,
  },
  async ({ testId, runs }) => safeText(() => testHistory({ testId, runs })),
);

server.registerTool(
  "gi_failure_groups",
  {
    title: "Ghost Inspector: red tests grouped by when they started failing",
    description:
      "Read-only. For every red test (modules excluded), finds its onset, the first " +
      "failure after its last green run, and groups onsets that follow each other " +
      "within `windowHours`, across suites and folders. Many tests going red within " +
      "hours usually share one cause: a deploy, a shared module, a page change. Each " +
      "group lists its tests with ids and the most common errors and targets, with " +
      "numbers and quoted text normalised.\n\n" +
      "A red test with no green run within `maxRunsPerTest` goes to `onsetUnknown` " +
      "rather than being guessed. Costs one request per 50 runs per red test; narrow " +
      "with folder or suite on a large account. Staleness is not considered: use " +
      "gi_stale_tests for that.",
    inputSchema: {
      folder: z.string().optional().describe("Folder id, or part of its name."),
      suite: z.string().optional().describe("Suite id, or part of its name."),
      windowHours: z.number().positive().max(720).optional().describe("Largest gap between consecutive onsets in one group. Default 12."),
      maxRunsPerTest: z.number().int().min(1).max(500).optional().describe("How far back to look for a green run per test. Default 200."),
    },
    annotations: READ_ONLY,
  },
  async ({ folder, suite, windowHours, maxRunsPerTest }) =>
    safeText(() => failureGroups({ folder, suite, windowHours, maxRunsPerTest })),
);

server.registerTool(
  "gi_screenshot_status",
  {
    title: "Ghost Inspector: screenshot comparison state of a test",
    description:
      "Read-only. The test's screenshot-comparison settings and its latest result's " +
      "comparison: enabled, passing, the measured difference against the threshold, " +
      "and three image URLs to look at: the current screenshot (`screenshotUrl`), " +
      "the difference image (`diffUrl`) and the baseline it was compared with. " +
      "`latestResult.id` is what gi_accept_screenshot takes as `expectedResultId`.",
    inputSchema: {
      testId: z.string().describe("The 24-character test id."),
    },
    annotations: READ_ONLY,
  },
  async ({ testId }) => safeText(() => screenshotStatus(testId)),
);

server.registerTool(
  "gi_vacuous_tests",
  {
    title: "Ghost Inspector: green tests that prove nothing",
    description:
      "Finds tests that pass while verifying nothing. Green is the dangerous " +
      "colour: a red test gets investigated, a hollow green one sits there while " +
      "every report says coverage is fine.\n\n" +
      "Three classes, kept apart because conflating them hides two of them. " +
      "`executesNothing` runs zero steps — its definition is only `execute` " +
      "calls into empty modules. `assertsNothing` runs its steps and contains no " +
      "assertion anywhere in the chain, so it can only fail if a step errors; " +
      "act on this one first, it is usually the largest. `worthChecking` is a " +
      "SHORTLIST, not a verdict: their single assertion is the final step, so if " +
      "its target also exists on the page the test starts from, it passes with " +
      "the feature completely broken.\n\n" +
      "🔴 That third class cannot be settled from the definition — the selector " +
      "is simply present on the starting page and no earlier step mentions it. " +
      "Scanning for a repeated target finds none of them. To decide, run the " +
      "test with the decisive action removed and see whether the assertion still " +
      "passes; if it does, the test proves nothing.\n\n" +
      "Modules are excluded before counting: import-only deletes results, so " +
      "including them would condemn the shared layer every live test depends on. " +
      "Costs one request per test; with folder or suite, one per test in scope plus the modules they import.",
    inputSchema: {
      folder: z.string().optional().describe("Folder id, or part of its name. Narrows the report to that folder's tests."),
      suite: z.string().optional().describe("Suite id, or part of its name. Narrows the report to that suite's tests; with folder, both apply."),
    },
    annotations: READ_ONLY,
  },
  async ({ folder, suite }) => safeText(() => getVacuousTests({ folder, suite })),
);

server.registerTool(
  "gi_propose_repair",
  {
    title: "Ghost Inspector: propose a fix without applying one",
    description:
      "Turns a diagnosis into a concrete argument: what to change, in which " +
      "test, and the token needed to write it. Read-only — it applies nothing " +
      "and returns steps for you to validate first.\n\n" +
      "🔴 This server cannot see the page. It has the definition, the error and " +
      "the Ghost Inspector contract, so proposals come in two kinds and are " +
      "never blurred. `applicable` proposals carry a rewritten step and come " +
      "from rules that hold whatever the page contains — an assertTextPresent " +
      "with no target always fails, an eval without an explicit return is always " +
      "undefined. `advisory` ones name a real problem that cannot be fixed " +
      "without looking at the DOM, and deliberately stop there rather than " +
      "inventing a selector.\n\n" +
      "Refuses outright on a stale diagnosis. A failure that predates a change " +
      "describes a definition that is no longer stored, so a repair built on it " +
      "would overwrite whatever replaced it, with no version history to recover.\n\n" +
      "🔴 `editTarget` is frequently NOT the test you asked about. Results " +
      "expand imported modules inline, so the failing step often belongs to a " +
      "module — and `proposedSteps` is that module's full step list, not this " +
      "test's. Editing a module affects every test importing it.\n\n" +
      "Validate `proposedSteps` with gi_validate_test before writing. A proposal " +
      "that has not been run is a hypothesis.",
    inputSchema: {
      testId: z.string().describe("The failing test. Its diagnosis drives the proposal."),
    },
    annotations: READ_ONLY,
  },
  async ({ testId }) => safeText(() => proposeRepair(testId)),
);

server.registerTool(
  "gi_validate_test",
  {
    title: "Ghost Inspector: validate a definition without saving or submitting",
    description:
      "Runs a test definition through on-demand execution, which executes it and " +
      "discards it — nothing in the account is created or changed. Use it to check " +
      "that a selector chain still resolves before editing a test, and to check a " +
      "definition you are authoring before saving it.\n\n" +
      "🔴 It drives a real browser against a real URL, so it is an action with " +
      "real-world effects even though nothing is saved. Modules are inlined " +
      "first, because a test whose steps are just `execute` calls hides its " +
      "submit inside a module. Then three guard layers apply, and none can be " +
      "turned off or extended past its cut:\n" +
      "(A) Static: the run is truncated at the first click on a submit-shaped " +
      "target, Enter keypress, or eval/assertEval/extractEval script or step " +
      "condition that could submit or send data (.submit(, requestSubmit(, " +
      ".click(, dispatchEvent(, fetch(, XMLHttpRequest, sendBeacon(, $.ajax, " +
      "$.post, axios). That step becomes an assertElementVisible on its target, " +
      "so the chain is verified, including that the control is reachable. " +
      "`stopBefore` can move this cut earlier, never later.\n" +
      "(B) In the browser: before every remaining click, a wait on its target and " +
      "a probe. The probe stops the run if the element is a form's submit " +
      "button or input, a control inside a form that is not a field, or cannot " +
      "be resolved from the top document; every step is gated on that stop. " +
      "Accepted false positive: a type=submit \"Continue\" inside a form stops " +
      "the run.\n" +
      "(C) Tripwire: armed before every step on every page, click or not, it " +
      "blocks submit events, form.submit(), non-GET fetch and XHR, and sendBeacon, " +
      "and `guard.blockedRequests` lists them. It does not stop the run. " +
      "Residual gaps: a script that saved window.fetch or form.submit before the " +
      "page's first step ran, a WebSocket, anything inside a child frame, and data " +
      "sent by a GET (a pixel or a navigation).\n" +
      "Step numbers in `plan`, `steps` and `guard` count plan steps; the injected " +
      "ones never shift them. There is no way to make this tool submit; that " +
      "stays a deliberate curl.\n\n" +
      "For an existing test the suite's configuration is replicated in the " +
      "request body — viewport, browser, user agent, region, language, delays, " +
      "failOnJavaScriptError, disableVisuals, disallowInsecureCertificates — with " +
      "a non-null value on the test winning over the suite's, and a caller " +
      "override winning over both. Tests inherit these, and a selector can resolve " +
      "on desktop and fail on mobile. `ranAs.settings` shows each value and its " +
      "source; after the run `settingsCheck` lists any the result reports " +
      "differently. HTTP basic auth is never sent. An ad-hoc definition gets the " +
      "same treatment from `suiteId`.\n\n" +
      "🔴 {{variables}} are substituted here, because on-demand execution ignores " +
      "custom variables and silently runs an unknown {{name}} as an empty string — " +
      "a startUrl of https://{{sub}}.example.com/ would run as https://.example.com/ " +
      "and could still pass. Values come from `variables` (yours), then the suite, " +
      "then the organization. A name an earlier step sets at run time " +
      "(variableName), a built-in ({{timestamp}}, {{alphanumeric}}) or a dotted name " +
      "is left for the browser. Anything else without a value refuses the run " +
      "before anything is sent, and `variables.unresolved` says where.\n\n" +
      "A browser run takes 20-100 seconds; the tool polls until it finishes. " +
      "`passing: null` in the raw API means not finished, never failed.",
    inputSchema: {
      testId: z
        .string()
        .optional()
        .describe("Existing test to validate. Its suite's configuration and variables are replicated."),
      definition: z
        .object({
          name: z.string().optional(),
          startUrl: z.string().describe("Where the run begins."),
          steps: z.array(STEP_SCHEMA).describe("Steps in execution order."),
        })
        .optional()
        .describe("Ad-hoc definition to validate instead of an existing test."),
      suiteId: z
        .string()
        .optional()
        .describe("With `definition`: the suite whose configuration and variables it runs with."),
      variables: z
        .record(z.string(), z.string())
        .optional()
        .describe('Variable values, e.g. {"subdomain": "www"}. Win over the suite\'s and the organization\'s.'),
      viewport: z
        .string()
        .optional()
        .describe('Override, e.g. "1280x800". Omit to use the test\'s, then the suite\'s.'),
      browser: z.string().optional().describe('Override, e.g. "chrome". Omit to replicate the suite\'s.'),
      stopBefore: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Stop before this plan step (as numbered by gi_plan_test). Can only cut earlier than the guard's own cut; a later value is ignored."),
      verbose: z
        .boolean()
        .optional()
        .describe("Keep `plan` after a run and return every console entry. Off by default to keep the response small."),
      dryRun: z
        .boolean()
        .optional()
        .describe("Deprecated: use gi_plan_test, which does exactly this and is read-only. Reports what would run and sends nothing."),
    },
    // Not read-only: nothing in the account changes, but a non-dry run drives
    // a real browser against a real URL. Not destructive: it saves nothing
    // and the guard keeps it from submitting.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ testId, definition, suiteId, variables, viewport, browser, stopBefore, verbose, dryRun }) =>
    safeText(() =>
      validateTest({
        testId,
        definition: definition as ValidateOptions["definition"],
        suiteId,
        variables,
        viewport,
        browser,
        stopBefore,
        verbose,
        dryRun,
      }),
    ),
);

server.registerTool(
  "gi_plan_test",
  {
    title: "Ghost Inspector: show what a validation would run, without running it",
    description:
      "Read-only. Returns exactly what gi_validate_test would send: modules inlined, " +
      "{{variables}} resolved from `variables`, the suite and the organization, and " +
      "all three submit-guard layers applied. Nothing is executed, only definitions are read: " +
      "no browser starts, and no organization id is needed. Use it before any " +
      "validation of a test that touches production.\n\n" +
      "`plan` lists the steps in order, numbered as every other report numbers " +
      "them. `guard.stoppedAt` is the static cut, where a submit-shaped step " +
      "became an assertion on its target. `guard.probedClicks` counts the clicks " +
      "that will be probed in the browser before they run. `variables` shows what " +
      "was resolved, what is left for a step that sets it at run time, and what " +
      "has no value. `wouldRefuse` is non-null when gi_validate_test would refuse " +
      "the run before sending anything, and says why.",
    inputSchema: {
      testId: z.string().optional().describe("Existing test to plan. Its suite's configuration and variables are replicated."),
      definition: z
        .object({
          name: z.string().optional(),
          startUrl: z.string().describe("Where the run begins."),
          steps: z.array(STEP_SCHEMA).describe("Steps in execution order."),
        })
        .optional()
        .describe("Ad-hoc definition to plan instead of an existing test."),
      suiteId: z
        .string()
        .optional()
        .describe("With `definition`: the suite whose configuration and variables it runs with."),
      variables: z
        .record(z.string(), z.string())
        .optional()
        .describe('Variable values, e.g. {"subdomain": "www"}. Win over the suite\'s and the organization\'s.'),
      viewport: z.string().optional().describe('Override, e.g. "1280x800".'),
      browser: z.string().optional().describe('Override, e.g. "chrome".'),
      stopBefore: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Stop before this plan step. Can only cut earlier than the guard's own cut."),
    },
    annotations: READ_ONLY,
  },
  async ({ testId, definition, suiteId, variables, viewport, browser, stopBefore }) =>
    safeText(() =>
      planTest({
        testId,
        definition: definition as ValidateOptions["definition"],
        suiteId,
        variables,
        viewport,
        browser,
        stopBefore,
      }),
    ),
);

// Write tools are registered here, behind writesAllowed(). Each one must:
//   1. walk the full `execute` chain comparing dateUpdated against the last run
//      (a red test whose module was edited after its last run is stale, not
//      broken — overwriting it destroys someone else's fix). Imports nest up to
//      10 levels, so cap the depth at 10 and detect cycles; bound the breadth
//      too, because the fan-out multiplies against an undisclosed rate limit,
//   2. return the complete prior definition as the caller's rollback,
//   3. apply the change,
//   4. re-GET and diff against what was sent.
// Registered unconditionally. See `gated` above: the write gate is enforced
// per call so a model can be told how to open it, instead of concluding the
// capability does not exist.
server.registerTool(
    "gi_update_test",
    {
      title: "Ghost Inspector: update a test, behind four guards",
      description:
        "Replaces a test's steps, renames it, or changes its startUrl. 🔴 Ghost Inspector keeps NO " +
        "version history of steps and no recycle bin, so this is permanent.\n\n" +
        "Four guards run on every call and none can be turned off. (1) The whole " +
        "`execute` chain's `dateUpdated` is compared against the test's last run; " +
        "if anything changed after it, the test is stale and the call is refused, " +
        "because a fix diagnosed from a failure that describes a deleted version " +
        "is diagnosed from nothing — and a colleague may already have fixed it. " +
        "(2) The complete prior definition, credentials removed, is saved to " +
        "`backupFile` (under GHOST_INSPECTOR_BACKUP_DIR, owner-only) on refusals " +
        "too, with a `backupSummary` beside it. The file is the rollback; clients " +
        "without filesystem access should pass verbose:true to get it inline as " +
        "`backup`. If the file cannot be written it comes back inline anyway. (3) The change is " +
        "applied. (4) The record is re-read and diffed, both that what was sent " +
        "landed exactly and that every field you did not send is untouched — " +
        "`HTTP 200` proves neither.\n\n" +
        "`expectedDateUpdated` is required: state the `dateUpdated` you believe is " +
        "current, and the write is refused if the record has moved since. Read it " +
        "with gi_get_test first. Every response carries the record's current " +
        "`dateUpdated`; after an applied write that is the token for the next " +
        "edit, so a series of edits needs no re-read in between. After a refusal, " +
        "re-read and recompose rather than resending.\n\n" +
        "Each step's `sequence` is overwritten with its position. Results map a " +
        "failure back to its step through that field, and a list stored without " +
        "it maps every failure to step 0.\n\n" +
        "Before overwriting a red test, prefer gi_validate_test, which runs the " +
        "current definition without saving and without submitting a form. If the " +
        "staleness guard trips and you have genuinely verified the current state, " +
        "`confirmStaleDiagnosis` proceeds — read what the refusal says first.",
      inputSchema: {
        testId: z.string().describe("Test to change."),
        expectedDateUpdated: z
          .string()
          .describe(
            "The dateUpdated you read from this test. Proof you have seen its current state; the write is refused if it no longer matches.",
          ),
        steps: z
          .array(STEP_SCHEMA)
          .optional()
          .describe("Replacement step list, in order. Replaces the whole array — send every step you want kept."),
        name: z.string().optional().describe("New name. Renaming does not move the test or break importers, which reference it by id."),
        startUrl: z
          .string()
          .optional()
          .describe("New start URL. Read back after the write like everything else sent. A module's startUrl is never visited: its importer decides where it starts."),
        confirmStaleDiagnosis: z
          .boolean()
          .optional()
          .describe(
            "Proceed even though the chain changed after the last run. Only after verifying the current definition yourself; otherwise you may be overwriting someone else's fix.",
          ),
        verbose: z
          .boolean()
          .optional()
          .describe("Also return the prior definition inline as `backup`. For clients that cannot read `backupFile`."),
      },
      // Destructive is the honest word: no version history, no recycle bin.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ testId, expectedDateUpdated, steps, name, startUrl, confirmStaleDiagnosis, verbose }) =>
      gated(writesAllowed(), "GHOST_INSPECTOR_ALLOW_WRITES", WHY_WRITES, () =>
        updateTest({
          testId,
          expectedDateUpdated,
          steps: steps as Steps | undefined,
          name,
          startUrl,
          confirmStaleDiagnosis,
          verbose,
        }),
      ),
  );

// Accepting replaces the baseline every later run is compared against, and the
// API has no route back, so it sits behind the write gate and a token.
server.registerTool(
    "gi_accept_screenshot",
    {
      title: "Ghost Inspector: accept the latest screenshot as the new baseline",
      description:
        "Makes the latest result's screenshot the baseline that every later run of " +
        "this test is compared against. 🔴 The API offers no way to restore an " +
        "earlier baseline; the response returns `previousBaselineResult` so it can at " +
        "least be found again.\n\n" +
        "`expectedResultId` is required: the result whose screenshot you looked at, " +
        "from gi_screenshot_status. The accept is refused if a newer run has landed " +
        "since, if the latest run is still going, or if its comparison passed or did " +
        "not run (there is nothing to accept then). The check is read-then-accept with " +
        "no compare-and-swap, so a run landing in the moment between them could still " +
        "slip through: it catches a stale id, not a genuine race. After the accept the test is re-read and `verification` shows " +
        "`screenshotComparePassing`. Accepting does not move `dateUpdated`, so it does " +
        "not invalidate a token you already hold.",
      inputSchema: {
        testId: z.string().describe("The 24-character test id."),
        expectedResultId: z.string().describe("latestResult.id from gi_screenshot_status: the result whose screenshot you reviewed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ testId, expectedResultId }) =>
      gated(writesAllowed(), "GHOST_INSPECTOR_ALLOW_WRITES", WHY_WRITES, () => acceptScreenshot({ testId, expectedResultId })),
  );

  server.registerTool(
    "gi_move_suite",
    {
      title: "Ghost Inspector: move a suite to another folder",
      description:
        "Moves a suite, with all of its tests, into another folder. Reversible — " +
        "unlike everything else on the write path — and the response carries " +
        "`previousFolder` so the undo is one call.\n\n" +
        "`expectedCurrentFolder` is required: state the folder you believe the " +
        "suite is in, and the move is refused if it is somewhere else, which is " +
        "the case where you are about to move the wrong suite. The result is " +
        "verified by re-reading: the folder must have changed and `testCount` must " +
        "be identical, since a move should never detach a test.\n\n" +
        "Note that `DELETE /folders/{id}/` does not exist, so a folder left empty " +
        "by a move can only be removed from the web UI. Folder names have to be " +
        "right the first time.",
      inputSchema: {
        suiteId: z.string().describe("Suite to move."),
        folderId: z.string().describe("Destination folder id."),
        expectedCurrentFolder: z
          .string()
          .describe("The folder id you believe this suite is in right now. Refused if it is not."),
      },
      // A move is the one reversible write, so it is not destructive.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ suiteId, folderId, expectedCurrentFolder }) =>
      gated(writesAllowed(), "GHOST_INSPECTOR_ALLOW_WRITES", WHY_WRITES, () =>
        moveSuite({ suiteId, folderId, expectedCurrentFolder }),
      ),
  );

  server.registerTool(
    "gi_create_suite",
    {
      title: "Ghost Inspector: create a suite",
      description:
        "Creates an empty suite, optionally inside a folder. The folder is " +
        "honoured at creation, so no follow-up move is needed.\n\n" +
        "Refuses when a suite of the same name already exists in the same place, " +
        "because Ghost Inspector allows the duplicate and nothing distinguishes " +
        "the two afterwards. Pass allowDuplicateName only when the repetition is " +
        "genuinely intended.\n\n" +
        "🔴 Getting the name right matters more than usual: this server never " +
        "exposes suite deletion, because DELETE /suites/{id}/ cascades to every " +
        "test inside with no version history and no recycle bin. Folders have no " +
        "delete route in the API at all. Anything created here is tidied up by " +
        "hand, in the web UI.\n\n" +
        "Creating adds and overwrites nothing, so no concurrency token applies.",
      inputSchema: {
        name: z.string().describe("Suite name. Must be unique where it is being created."),
        organization: z
          .string()
          .optional()
          .describe("Organization id. Defaults to GHOST_INSPECTOR_ORG_ID."),
        folder: z.string().optional().describe("Folder id to create it in. Omit to leave it unfiled."),
        allowDuplicateName: z
          .boolean()
          .optional()
          .describe("Proceed even though a suite of this name already exists here."),
      },
      // Additive: it creates and overwrites nothing.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, organization, folder, allowDuplicateName }) =>
      gated(writesAllowed(), "GHOST_INSPECTOR_ALLOW_WRITES", WHY_WRITES, () =>
        createSuite({ name, organization, folder, allowDuplicateName }),
      ),
  );

  server.registerTool(
    "gi_duplicate_test",
    {
      title: "Ghost Inspector: copy a test — the only way to get a new one",
      description:
        "Copies an existing test, then places it in a suite and renames it in one " +
        "call. Returns the new test with its steps and its dateUpdated.\n\n" +
        "🔴 This is how a test comes into existence here, and it is not a create. " +
        "Ghost Inspector has no endpoint that builds a test from nothing — " +
        "POST /tests/ is the listing wearing a POST — so a source test is " +
        "mandatory and there is no way around that. Pick the closest existing " +
        "test and adapt the copy with gi_update_test.\n\n" +
        "🔴 The copy's schedule is cleared unless keepSchedule is set. Whether a " +
        "copy inherits its source's testFrequency is not verified, and in an " +
        "account whose tests submit live forms against production, an inherited " +
        "schedule means an unattended run posting real data. The uncertain case " +
        "is pinned to the safe direction.\n\n" +
        "The copy carries the source's steps verbatim, including any `execute` " +
        "steps: it imports the same modules, so editing those modules still " +
        "affects it. If the copy is placed in a suite with a different viewport " +
        "or browser, selectors that resolved for the source may not resolve for " +
        "it — validate with gi_validate_test before trusting it.\n\n" +
        "If the copy is made but placing or renaming it fails, the response says " +
        "so and returns the id, because the copy is already real and needs " +
        "cleaning up.\n\n" +
        "A copy keeps the source's `dateCreated` to the millisecond, so " +
        "`dateCreated` cannot date a copy or tell it apart from its source.",
      inputSchema: {
        sourceTestId: z.string().describe("The test to copy. Required — there is no create."),
        name: z.string().optional().describe('New name. Defaults to "<source> (Copy)".'),
        suiteId: z.string().optional().describe("Suite to place it in. Defaults to the source's suite."),
        startUrl: z.string().optional().describe("Where the copy starts. Defaults to the source's startUrl."),
        keepSchedule: z
          .boolean()
          .optional()
          .describe("Keep any inherited schedule. Off by default; leaving it off is the safe choice."),
      },
      // Additive: it creates a new record and overwrites nothing existing.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ sourceTestId, name, suiteId, startUrl, keepSchedule }) =>
      gated(writesAllowed(), "GHOST_INSPECTOR_ALLOW_WRITES", WHY_WRITES, () =>
        duplicateTest({ sourceTestId, name, suiteId, startUrl, keepSchedule }),
      ),
  );

  // Deliberately absent: suite deletion. DELETE /suites/{id}/ exists and
// cascades to every test inside, with no version history and no recycle bin.

// Executing a stored test sits behind its OWN gate. An operator who allowed
// writes has not thereby allowed this: an edit is recoverable from the backup
// the write path returns, a submitted form is not recoverable at all.
server.registerTool(
    "gi_run_test",
    {
      title: "Ghost Inspector: run a stored test for real",
      description:
        "Executes a test exactly as saved and waits for the verdict. Use it to " +
        "confirm a repair actually worked, or to get a fresh result when the " +
        "stored one is stale.\n\n" +
        "🔴 Nothing is truncated here. Unlike gi_validate_test, which runs a " +
        "throwaway copy and stops before anything can submit, this runs the real " +
        "test against the real startUrl — in most accounts, production. If the " +
        "test fills and submits a form, this posts a real record into whatever " +
        "that form feeds, and nothing here can withdraw it.\n\n" +
        "Because of that, a test that submits is refused unless `confirmSubmit` " +
        "is set. The check inlines imported modules first, since a test whose " +
        "steps are only `execute` calls hides its submit inside one. A test that " +
        "submits nothing runs without the flag. If a chain cannot be fully " +
        "expanded it counts as submitting — an unnecessary confirmation is " +
        "cheaper than an unintended record.\n\n" +
        "If you only need to know whether the selectors still resolve, this is " +
        "the wrong tool: gi_validate_test answers that without submitting.\n\n" +
        "🔴 A wait that expires is NOT a failure. Browser runs take 20-70 " +
        "seconds and slow ones take longer; the response returns the result id " +
        "and says the run is still going. Read the outcome with gi_test_result " +
        "rather than concluding the test failed.",
      inputSchema: {
        testId: z.string().describe("The 24-character test id. Import-only tests cannot run."),
        confirmSubmit: z
          .boolean()
          .optional()
          .describe(
            "Required only when the test contains a step that could submit a form. Setting it means you accept a real submission against a real environment.",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .optional()
          .describe("How long to wait before handing back the result id. Default 240000."),
      },
      // Not read-only and not destructive in the overwrite sense: it changes
      // nothing stored, but it acts on the outside world and cannot be undone.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ testId, confirmSubmit, timeoutMs }) =>
      gated(runsAllowed(), "GHOST_INSPECTOR_ALLOW_RUNS", WHY_RUNS, () =>
        runTest({ testId, confirmSubmit, timeoutMs }),
      ),
  );

const transport = new StdioServerTransport();
await server.connect(transport);
