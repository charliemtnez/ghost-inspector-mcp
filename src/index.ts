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

import { redact, writesAllowed } from "./config.js";
import { request } from "./client.js";

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
