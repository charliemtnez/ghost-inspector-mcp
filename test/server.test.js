/**
 * The server speaking the protocol for real.
 *
 * The unit tests cover the reasoning; this covers what they cannot see — a
 * registration mistake or a malformed schema only surfaces once the server is
 * actually answering `tools/list`. It is also where the write gate is proven,
 * which is the single most consequential line of configuration in the project.
 *
 * No API key is set, so nothing here reaches Ghost Inspector.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const READ_ONLY = [
  "gi_inventory",
  "gi_module_usage",
  "gi_stale_tests",
  "gi_validate_test",
  "gi_whoami",
];
const WRITE = ["gi_move_suite", "gi_update_test"];

/** Starts the server, asks for its tools over stdio, and returns their names. */
async function listTools(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Never let an operator's real configuration change the outcome.
      GHOST_INSPECTOR_API_KEY: "",
      GHOST_INSPECTOR_ORG_ID: "",
      GHOST_INSPECTOR_ALLOW_WRITES: "",
      ...env,
    },
  });

  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the server did not exit within 20s"));
    }, 20_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (c) => { clearTimeout(timer); resolve(c); });
  });

  const lines = out.trim().split("\n").filter(Boolean);
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const listing = parsed.find((m) => m?.id === 2);
  assert.ok(listing, `no tools/list response. exit=${code} stderr=${err.slice(0, 400)}`);
  const handshake = parsed.find((m) => m?.id === 1)?.result;
  return {
    names: listing.result.tools.map((t) => t.name).sort(),
    tools: listing.result.tools,
    serverInfo: handshake?.serverInfo,
    instructions: handshake?.instructions,
  };
}

test("the server starts and registers exactly the read-only surface", async () => {
  const { names } = await listTools();
  assert.deepEqual(names, READ_ONLY, "read-only by default, no exceptions");
});

test("the version on the wire is the package version, not a copy of it", async () => {
  // A hardcoded copy drifts on the first release and misreports every one after.
  const pkg = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  );
  const { serverInfo } = await listTools();
  assert.equal(serverInfo?.version, pkg.version);
});

test("a gated server still tells the model that writing exists", async () => {
  // Withholding the write tools by not registering them makes their absence
  // indistinguishable from them not existing, so a model reports "this server
  // cannot write" and the user believes it. Observed in the wild. The handshake
  // is the only place that can say otherwise before any tool is called.
  const { instructions } = await listTools();
  assert.ok(instructions, "the handshake must carry instructions");
  assert.match(instructions, /GHOST_INSPECTOR_ALLOW_WRITES/, "must name the variable that opens the gate");
  assert.match(instructions, /gi_whoami/, "must point at the tool that reports writesEnabled");
  assert.match(instructions, /gated, not missing/, "must correct the wrong conclusion explicitly");
});

test("the write gate is described by gi_whoami, not just reported by it", async () => {
  // The flag was always in the response; a model that reads the description as
  // "verifies credentials" never calls it to answer "may I edit this?".
  const { tools } = await listTools();
  const whoami = tools.find((t) => t.name === "gi_whoami");
  assert.match(whoami.description, /writesEnabled/);
  assert.match(whoami.description, /GHOST_INSPECTOR_ALLOW_WRITES/);
});

test("every tool ships a description and a schema the model can read", async () => {
  const { tools } = await listTools();
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 120, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
  }
});

test("the write gate opens only for an exact true", async () => {
  const { names } = await listTools({ GHOST_INSPECTOR_ALLOW_WRITES: "true" });
  assert.deepEqual(names, [...WRITE, ...READ_ONLY].sort());
});

test("every tool declares the posture a client's permission model reads", async () => {
  const { tools } = await listTools({ GHOST_INSPECTOR_ALLOW_WRITES: "true" });
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} must ship annotations`);
    if (READ_ONLY.includes(tool.name) && tool.name !== "gi_validate_test") {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} is read-only`);
    } else {
      // gi_validate_test drives a real browser; the write tools write.
      assert.equal(tool.annotations.readOnlyHint, false, `${tool.name} has side effects`);
    }
  }
  const update = tools.find((t) => t.name === "gi_update_test");
  assert.equal(update.annotations.destructiveHint, true, "an unversioned overwrite is destructive");
  const move = tools.find((t) => t.name === "gi_move_suite");
  assert.equal(move.annotations.destructiveHint, false, "a move is the one reversible write");
});

test("the write gate stays shut for anything an operator might type instead", async () => {
  // "1" and "yes" look like consent and are not. Getting this wrong exposes a
  // permanent, unversioned overwrite to any agent that asks.
  for (const value of ["", "1", "yes", "y", "on", "false", "0", "truthy"]) {
    const { names } = await listTools({ GHOST_INSPECTOR_ALLOW_WRITES: value });
    assert.deepEqual(names, READ_ONLY, `ALLOW_WRITES=${JSON.stringify(value)} must not open the gate`);
  }
});

test("a tool call with no API key fails with instructions, not a stack trace", async () => {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GHOST_INSPECTOR_API_KEY: "" },
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gi_whoami", arguments: {} } },
  ];
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, 20_000);
    child.on("close", () => { clearTimeout(timer); resolve(); });
  });

  const reply = out.trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m?.id === 2);
  assert.ok(reply, "expected a reply to the tool call");
  assert.equal(reply.result.isError, true);
  const text = reply.result.content[0].text;
  assert.match(text, /Account Settings/, "must say where to get a key");
  assert.ok(!/\bat \w+ \(/.test(text), "must not leak a stack trace");
});
