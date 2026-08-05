#!/usr/bin/env node
/**
 * ghost-inspector-mcp — MCP server entry point.
 *
 * Read-only unless GHOST_INSPECTOR_ALLOW_WRITES=true. Suite deletion is never
 * exposed: DELETE /suites/{id} cascades to every test in the suite with no
 * version history and no recycle bin.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { redact, writesAllowed } from "./config.js";
import { request } from "./client.js";
import { type Steps } from "./graph.js";
import { getInventory } from "./inventory.js";
import { getModuleUsage } from "./modules.js";
import { getStaleTests } from "./stale.js";
import { validateTest, type ValidateOptions } from "./validate.js";
import { moveSuite, updateTest } from "./writes.js";

// The manifest ships beside dist/ in the npm package, so it is readable in
// every installed layout. One source for the version; npm bumps it, this reads it.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const server = new McpServer({
  name: "ghost-inspector",
  version,
});

/** Wraps a handler so failures come back as readable, key-free text. */
async function safeText(run: () => Promise<unknown>) {
  try {
    const value = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `ERROR: ${redact(message)}` }],
      isError: true,
    };
  }
}

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
    title: "Ghost Inspector: verify credentials",
    description:
      "Confirms the configured API key works and lists the organizations it can " +
      "reach. Read-only and safe to call first when diagnosing setup. Returns " +
      "each organization's id — export the one you want as " +
      "GHOST_INSPECTOR_ORG_ID to enable on-demand validation runs.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () =>
    safeText(async () => {
      const orgs = await request<Organization[]>("GET", "organizations");
      return {
        writesEnabled: writesAllowed(),
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
      module: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring of a module name. Narrows the listing and names every importer instead of capping the list.",
        ),
    },
    annotations: READ_ONLY,
  },
  async ({ module }) => safeText(() => getModuleUsage({ module })),
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
      includePasses: z
        .boolean()
        .optional()
        .describe(
          "List the passing-but-unverified tests too. Off by default because it is the long bucket; the count is always reported.",
        ),
    },
    annotations: READ_ONLY,
  },
  async ({ includePasses }) => safeText(() => getStaleTests({ includePasses })),
);

const STEP_SCHEMA = z.object({
  command: z
    .string()
    .describe(
      "One of: assertElementNotPresent, assertElementNotVisible, assertElementPresent, assertElementVisible, assertEval, assertNotText, assertText, assertTextNotPresent, assertTextPresent, assign, click, dragAndDrop, eval, execute, exit, extract, extractEval, keypress, mouseOver, open, pause, refresh, screenshot, store.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "CSS selector. 🔴 REQUIRED by the text assertions: assertTextPresent with no target fails with \"Text not contained\" even when the text is plainly on the page, which reads as a product bug rather than a malformed step — scope it to body at minimum. Anchor to stable semantic attributes (data-*, name, id) and scope to a container id. Never :nth-of-type, never XPath matching visible copy, never long chains of presentational classes. A selector matching more than one element is a latent failure. Attribute selectors need brackets: [data-x=\"y\"], not data-x=\"y\", which is not valid CSS and never matched anything.",
    ),
  value: z
    .string()
    .optional()
    .describe(
      "For assign, the value to type — send it unformatted and assert the formatted result, so the test exercises the input mask instead of bypassing it. For eval and assertEval, JavaScript that MUST contain an explicit return; without one it evaluates to undefined and the assertion always fails, which looks like a product bug. For execute, the module's test id.",
    ),
  variableName: z.string().optional(),
  condition: z
    .string()
    .optional()
    .describe("JavaScript deciding whether the step runs. AND-ed with conditions inherited from enclosing imports."),
  optional: z.boolean().optional().describe("Continue when this step fails."),
});

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
      "real-world effects even though nothing is saved. Two guards apply and " +
      "neither can be turned off. Modules are inlined first, because a test whose " +
      "steps are just `execute` calls hides its submit inside a module and " +
      "guarding the definition as written would miss it. Then the run is " +
      "truncated at the first step that could submit a form, and that step is " +
      "replaced by an assertion on the same target — so the whole chain is " +
      "verified, including that the submit control is reachable, without ever " +
      "activating it. There is no way to make this tool submit; that stays a " +
      "deliberate curl.\n\n" +
      "For an existing test the suite's viewport and browser are replicated, " +
      "because tests inherit those and a selector can resolve on desktop and fail " +
      "on mobile. Read `ranAs.configSource` to see what was actually used.\n\n" +
      "A browser run takes 20-100 seconds; the tool polls until it finishes. " +
      "`passing: null` in the raw API means not finished, never failed.",
    inputSchema: {
      testId: z
        .string()
        .optional()
        .describe("Existing test to validate. Its suite's viewport and browser are replicated."),
      definition: z
        .object({
          name: z.string().optional(),
          startUrl: z.string().describe("Where the run begins."),
          steps: z.array(STEP_SCHEMA).describe("Steps in execution order."),
        })
        .optional()
        .describe("Ad-hoc definition to validate instead of an existing test."),
      viewport: z
        .string()
        .optional()
        .describe('Override, e.g. "1280x800". Omit to replicate the suite\'s.'),
      browser: z.string().optional().describe('Override, e.g. "chrome". Omit to replicate the suite\'s.'),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Report exactly what would run — after modules are inlined and the submit guard applied — and stop. Nothing is sent to Ghost Inspector, no browser starts, no page loads, and no organization id is needed. Use it first on anything that touches production.",
        ),
    },
    // Not read-only: nothing in the account changes, but a non-dry run drives
    // a real browser against a real URL. Not destructive: it saves nothing
    // and the guard keeps it from submitting.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ testId, definition, viewport, browser, dryRun }) =>
    safeText(() =>
      validateTest({
        testId,
        definition: definition as ValidateOptions["definition"],
        viewport,
        browser,
        dryRun,
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
if (writesAllowed()) {
  server.registerTool(
    "gi_update_test",
    {
      title: "Ghost Inspector: update a test, behind four guards",
      description:
        "Replaces a test's steps and/or renames it. 🔴 Ghost Inspector keeps NO " +
        "version history of steps and no recycle bin, so this is permanent.\n\n" +
        "Four guards run on every call and none can be turned off. (1) The whole " +
        "`execute` chain's `dateUpdated` is compared against the test's last run; " +
        "if anything changed after it, the test is stale and the call is refused, " +
        "because a fix diagnosed from a failure that describes a deleted version " +
        "is diagnosed from nothing — and a colleague may already have fixed it. " +
        "(2) The complete prior definition comes back as `backup`, on refusals " +
        "too; it is the only rollback that exists, so keep it. (3) The change is " +
        "applied. (4) The record is re-read and diffed, both that what was sent " +
        "landed exactly and that every field you did not send is untouched — " +
        "`HTTP 200` proves neither.\n\n" +
        "`expectedDateUpdated` is required: state the `dateUpdated` you believe is " +
        "current, and the write is refused if the record has moved since. Read the " +
        "test first; a refusal tells you the current value so a retry is one step.\n\n" +
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
        confirmStaleDiagnosis: z
          .boolean()
          .optional()
          .describe(
            "Proceed even though the chain changed after the last run. Only after verifying the current definition yourself; otherwise you may be overwriting someone else's fix.",
          ),
      },
      // Destructive is the honest word: no version history, no recycle bin.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ testId, expectedDateUpdated, steps, name, confirmStaleDiagnosis }) =>
      safeText(() =>
        updateTest({
          testId,
          expectedDateUpdated,
          steps: steps as Steps | undefined,
          name,
          confirmStaleDiagnosis,
        }),
      ),
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
      safeText(() => moveSuite({ suiteId, folderId, expectedCurrentFolder })),
  );

  // Deliberately absent:
  //   · suite deletion — DELETE /suites/{id}/ cascades to every test with no undo.
  //   · test creation — Ghost Inspector documents no create endpoint. The
  //     documented path is POST /tests/{id}/duplicate/ followed by an update,
  //     which needs a source test, so it is a different tool than "create" and
  //     is not guessed at here.
}

const transport = new StdioServerTransport();
await server.connect(transport);
