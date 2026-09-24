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
  "gi_failure_groups",
  "gi_find_tests",
  "gi_get_test",
  "gi_inventory",
  "gi_module_usage",
  "gi_plan_test",
  "gi_propose_repair",
  "gi_screenshot_status",
  "gi_stale_tests",
  "gi_test_history",
  "gi_test_result",
  "gi_vacuous_tests",
  "gi_validate_test",
  "gi_whoami",
];
const WRITE = ["gi_accept_screenshot", "gi_create_suite", "gi_duplicate_test", "gi_move_suite", "gi_update_test"];

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
      GHOST_INSPECTOR_ALLOW_RUNS: "",
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

/** Calls one tool and returns its reply text, with both gates shut by default. */
async function callTool(name, args = {}, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GHOST_INSPECTOR_API_KEY: "",
      GHOST_INSPECTOR_ORG_ID: "",
      GHOST_INSPECTOR_ALLOW_WRITES: "",
      GHOST_INSPECTOR_ALLOW_RUNS: "",
      ...env,
    },
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
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
  assert.ok(reply, `no reply for ${name}`);
  return { text: reply.result.content[0].text, isError: reply.result.isError };
}

const GATED = [
  ["gi_accept_screenshot", { testId: "a".repeat(24), expectedResultId: "b".repeat(24) }, "GHOST_INSPECTOR_ALLOW_WRITES"],
  ["gi_update_test", { testId: "a".repeat(24), expectedDateUpdated: "x" }, "GHOST_INSPECTOR_ALLOW_WRITES"],
  ["gi_move_suite", { suiteId: "a".repeat(24), folderId: "b".repeat(24), expectedCurrentFolder: "c".repeat(24) }, "GHOST_INSPECTOR_ALLOW_WRITES"],
  ["gi_create_suite", { name: "x" }, "GHOST_INSPECTOR_ALLOW_WRITES"],
  ["gi_duplicate_test", { sourceTestId: "a".repeat(24) }, "GHOST_INSPECTOR_ALLOW_WRITES"],
  ["gi_run_test", { testId: "a".repeat(24) }, "GHOST_INSPECTOR_ALLOW_RUNS"],
];

test("every tool is visible whether or not its gate is open", async () => {
  // Hiding a gated tool makes it indistinguishable from one that does not
  // exist, and a model then tells its user the server cannot do the thing.
  // Observed in the wild. Visibility is not permission — the gates below are.
  const { names } = await listTools();
  assert.deepEqual(names, [...READ_ONLY, ...WRITE, "gi_run_test"].sort());
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
  assert.match(instructions, /refuses, changes nothing/, "must say what happens when a gate is shut");
});

test("the write gate is described by gi_whoami, not just reported by it", async () => {
  // The flag was always in the response; a model that reads the description as
  // "verifies credentials" never calls it to answer "may I edit this?".
  const { tools } = await listTools();
  const whoami = tools.find((t) => t.name === "gi_whoami");
  assert.match(whoami.description, /writesEnabled/);
  assert.match(whoami.description, /runsEnabled/, "both gates, since a listed tool proves nothing now");
});

test("the concurrency token is reachable without provoking a refusal", async () => {
  // gi_update_test demands expectedDateUpdated as proof the caller read the
  // record. While no read tool returned it, the only way to get one was to send
  // a wrong value and harvest the right one from the refusal — which proves
  // nothing and became the documented-by-accident happy path.
  const { names, tools } = await listTools();
  assert.ok(names.includes("gi_get_test"), "a read tool must expose dateUpdated");
  const detail = tools.find((t) => t.name === "gi_get_test");
  assert.match(detail.description, /expectedDateUpdated/, "must connect the token to the write tool");
  assert.equal(detail.annotations.readOnlyHint, true);
});

test("every tool ships a description and a schema the model can read", async () => {
  const { tools } = await listTools();
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 120, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
  }
});

test("a gated tool refuses in words, and changes nothing", async () => {
  // The whole point of registering them: the caller gets an instruction rather
  // than an absence. No API key is set, so reaching the real handler would
  // fail with the key error — a refusal proves the gate stopped it first.
  for (const [name, args, variable] of GATED) {
    const { text, isError } = await callTool(name, args);
    assert.equal(isError, true, `${name} must report an error`);
    assert.match(text, /^REFUSED:/, `${name} must refuse, not attempt`);
    assert.match(text, new RegExp(variable), `${name} must name the variable that opens it`);
    assert.match(text, /Nothing happened/, `${name} must say nothing was done`);
    assert.ok(!/Account Settings/.test(text), `${name} must not reach the API-key path`);
  }
});

test("an open gate actually lets the call through", async () => {
  // Otherwise the refusal above could be unconditional and the tests would
  // still pass while the tool never worked at all. With the gate open and no
  // key configured, the call must get as far as the credential check.
  const { text } = await callTool("gi_duplicate_test", { sourceTestId: "a".repeat(24) }, { GHOST_INSPECTOR_ALLOW_WRITES: "true" });
  assert.ok(!/^REFUSED:/.test(text), "the gate must be open");
  assert.match(text, /Account Settings/, "it should reach the credential check instead");
});

test("every tool declares the posture a client's permission model reads", async () => {
  const { tools } = await listTools();
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
  for (const name of ["gi_create_suite", "gi_duplicate_test"]) {
    assert.equal(
      tools.find((t) => t.name === name).annotations.destructiveHint,
      false,
      `${name} adds a record and overwrites none`,
    );
  }
});

test("no deletion is reachable, with the gate wide open", async () => {
  // DELETE /suites/{id}/ cascades to every test inside with no version history
  // and no recycle bin. It stays a deliberate curl by someone who knows.
  const { names } = await listTools();
  assert.ok(!names.some((n) => /delete|remove|destroy/i.test(n)), `no destructive tool may exist: ${names}`);
});

test("the write gate stays shut for anything an operator might type instead", async () => {
  // "1" and "yes" look like consent and are not. Getting this wrong exposes a
  // permanent, unversioned overwrite to any agent that asks.
  for (const value of ["", "1", "yes", "y", "on", "false", "0", "truthy"]) {
    const { text } = await callTool("gi_create_suite", { name: "x" }, { GHOST_INSPECTOR_ALLOW_WRITES: value });
    assert.match(text, /^REFUSED:/, `ALLOW_WRITES=${JSON.stringify(value)} must not open the gate`);
  }
});

test("the run gate is separate from the write gate, in both directions", async () => {
  // Executing a stored test submits whatever it submits, against production in
  // most accounts, and no backup undoes that. An operator who accepted edits
  // has not accepted this.
  const runUnderWrites = await callTool("gi_run_test", { testId: "a".repeat(24) }, { GHOST_INSPECTOR_ALLOW_WRITES: "true" });
  assert.match(runUnderWrites.text, /^REFUSED:/, "allowing writes must not allow running");
  assert.match(runUnderWrites.text, /GHOST_INSPECTOR_ALLOW_RUNS/);

  const writeUnderRuns = await callTool("gi_create_suite", { name: "x" }, { GHOST_INSPECTOR_ALLOW_RUNS: "true" });
  assert.match(writeUnderRuns.text, /^REFUSED:/, "allowing runs must not allow writes");
  assert.match(writeUnderRuns.text, /GHOST_INSPECTOR_ALLOW_WRITES/);
});

test("the run gate stays shut for anything an operator might type instead", async () => {
  for (const value of ["", "1", "yes", "on", "false", "truthy"]) {
    const { text } = await callTool("gi_run_test", { testId: "a".repeat(24) }, { GHOST_INSPECTOR_ALLOW_RUNS: value });
    assert.match(text, /^REFUSED:/, `ALLOW_RUNS=${JSON.stringify(value)} must not open the gate`);
  }
});

test("running a test declares that it acts on the outside world", async () => {
  const { tools } = await listTools();
  const run = tools.find((t) => t.name === "gi_run_test");
  assert.equal(run.annotations.readOnlyHint, false, "it drives a real browser and can submit");
  assert.equal(run.annotations.openWorldHint, true);
  assert.match(run.description, /confirmSubmit/, "must tell the model about the per-call confirmation");
  assert.match(run.description, /gi_validate_test/, "must point at the tool that answers without submitting");
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

test("gi_plan_test shows the cut before a submit without a key, an org id or a browser", async () => {
  const { text } = await callTool("gi_plan_test", {
    definition: {
      startUrl: "https://example.com/",
      steps: [
        { command: "assign", target: "#email", value: "jane@example.com" },
        { command: "click", target: "#next" },
        { command: "click", target: 'button[type="submit"]' },
      ],
    },
  });
  const plan = JSON.parse(text);
  assert.equal(plan.guard.stoppedAt, 2, "the static cut lands on the submit");
  assert.equal(plan.guard.probedClicks, 1, "the click before it is probed in the browser");
  assert.equal(plan.wouldRefuse, null);
  assert.equal(plan.plan[2].command, "assertElementVisible");
});

test("gi_plan_test says a run would be refused over an unresolved variable", async () => {
  const { text } = await callTool("gi_plan_test", { definition: { startUrl: "https://{{nope}}.example.com/", steps: [] } });
  const plan = JSON.parse(text);
  assert.match(plan.wouldRefuse, /\{\{nope\}\}/);
  assert.deepEqual(plan.variables.unresolved.map((u) => u.name), ["nope"]);
});

test("a stored step with a fallback array and a private flag passes the step schema", async () => {
  // gi_get_test returns targets as arrays and every step with `private`; a
  // schema that refuses them breaks get → validate → update on real tests.
  const { text, isError } = await callTool("gi_plan_test", {
    definition: {
      startUrl: "https://example.com/",
      steps: [{ command: "assign", target: [{ selector: "#pin" }, { selector: "[name=pin]" }], value: "1234", private: true }],
    },
  });
  assert.ok(!isError, text);
  assert.equal(JSON.parse(text).plan[0].target, JSON.stringify([{ selector: "#pin" }, { selector: "[name=pin]" }]));
});
