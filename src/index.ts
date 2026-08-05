#!/usr/bin/env node
/**
 * ghost-inspector-mcp — MCP server entry point.
 *
 * Read-only unless GHOST_INSPECTOR_ALLOW_WRITES=true. Suite deletion is never
 * exposed: DELETE /suites/{id} cascades to every test in the suite with no
 * version history and no recycle bin.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { redact, writesAllowed } from "./config.js";
import { request } from "./client.js";
import { getInventory } from "./inventory.js";
import { getModuleUsage } from "./modules.js";
import { getStaleTests } from "./stale.js";

const server = new McpServer({
  name: "ghost-inspector",
  version: "0.1.0",
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
  },
  async ({ includePasses }) => safeText(() => getStaleTests({ includePasses })),
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
  // TODO(phase-1): validate_test, create_test, update_test, move_suite.
}

const transport = new StdioServerTransport();
await server.connect(transport);
