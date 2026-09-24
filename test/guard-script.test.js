/** The in-browser guard: the probe that stops a run before a click that could submit, and the tripwire that blocks what slips past. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARM_SOURCE,
  FIND_SOURCE,
  logScript,
  probeScript,
  stopCondition,
  VERDICT_SOURCE,
} from "../dist/guard-script.js";

const verdict = new Function(`return ${VERDICT_SOURCE}`)();

/**
 * A minimal element: enough of the DOM for the verdict to walk.
 * @param {string} tag
 * @param {object} props type, form, parent, control, attrs
 */
const el = (tag, props = {}) => {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), type: props.type ?? "", form: props.form ?? null, parent: props.parent ?? null, control: props.control ?? null, attrs: props.attrs ?? {} };
  node.closest = (selector) => {
    const wanted = selector.split(",").map((part) => part.trim());
    for (let at = node; at; at = at.parent) {
      const hit = wanted.some((w) => w === at.tagName.toLowerCase()
        || (w === "[role=button]" && at.attrs.role === "button")
        || (w === "[onclick]" && "onclick" in at.attrs));
      if (hit) return at;
    }
    return null;
  };
  return node;
};

test("the audit's false negative: an aria-labelled submit button in a form stops the run", () => {
  // Its target reads button[aria-label="Get my free guide"], which no target
  // pattern can call a submit. The element itself can.
  const form = el("form");
  assert.equal(verdict(el("button", { type: "submit", form, parent: form, attrs: { "aria-label": "Get my free guide" } })), "a form's submit button");
});

test("a click on the text inside a submit button stops the run", () => {
  const form = el("form");
  const button = el("button", { type: "submit", form, parent: form });
  assert.equal(verdict(el("span", { parent: button })), "a form's submit button");
});

test("a radio in a form is a field and does not stop", () => {
  const form = el("form");
  assert.equal(verdict(el("input", { type: "radio", form, parent: form })), null);
});

test("a link outside any form does not stop", () => {
  assert.equal(verdict(el("a", { parent: el("nav") })), null);
});

test("an unresolvable target stops the run", () => {
  assert.equal(verdict(null), "target not resolvable from the top document");
});

test("a label for a submit button stops the run", () => {
  const form = el("form");
  const button = el("button", { type: "submit", form, parent: form });
  assert.equal(verdict(el("label", { parent: form, control: button })), "a form's submit button");
});

test("every generated script parses", () => {
  for (const source of [VERDICT_SOURCE, FIND_SOURCE, ARM_SOURCE]) {
    assert.doesNotThrow(() => new Function(`return ${source}`), source.slice(0, 40));
  }
  for (const script of [probeScript(["#a", "xpath=//button[@id='b']", "(//a)[1]"], 3), stopCondition(), logScript()]) {
    assert.doesNotThrow(() => new Function(script), script.slice(0, 40));
  }
});

test("no generated script carries {{ of its own, which Ghost Inspector would take for a variable", () => {
  for (const script of [probeScript(["#a"], 0), stopCondition(), logScript()]) {
    assert.ok(!script.includes("{{"), script.slice(0, 60));
  }
  assert.ok(probeScript(["{{formSelector}} button"], 0).includes("{{formSelector}}"), "a runtime variable in a selector is left for Ghost Inspector");
});

// --- the scripts run against a simulated page --------------------------------

/**
 * A fake page the generated scripts can run in, with a form whose submit button `#go` matches.
 * @param {object} options storageThrows: every sessionStorage access throws
 */
const page = (options = {}) => {
  const store = new Map();
  const sessionStorage = {
    getItem: (key) => { if (options.storageThrows) throw new Error("denied"); return store.has(key) ? store.get(key) : null; },
    setItem: (key, value) => { if (options.storageThrows) throw new Error("denied"); store.set(key, String(value)); },
  };
  const form = el("form");
  const elements = { "#go": el("button", { type: "submit", form, parent: form }), "#link": el("a") };
  const listeners = [];
  const fetched = [];
  /** A stand-in XMLHttpRequest whose send records that it got through. */
  class FakeXhr {
    /** Accepts any method and URL. */
    open() {}
    /** Records that a request left the page. */
    send() { fetched.push("xhr sent"); }
  }
  const window = {
    sessionStorage,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    fetch: (url, init) => { fetched.push(`${init?.method ?? "GET"} ${url}`); return Promise.resolve("ok"); },
  };
  const env = {
    window,
    document: { querySelector: (selector) => elements[selector] ?? null, evaluate: () => ({ singleNodeValue: null }) },
    navigator: { sendBeacon: () => { fetched.push("beacon sent"); return true; } },
    HTMLFormElement: { prototype: { submit() { fetched.push("form submitted"); } } },
    XMLHttpRequest: FakeXhr,
    location: { href: "https://example.com/form" },
  };
  /** Run one generated script in this page. */
  const run = (script) => new Function(...Object.keys(env), script)(...Object.values(env));
  return { env, run, listeners, fetched, store };
};

test("a probe that finds a submit button records the stop, and every later step is gated", () => {
  const p = page();
  assert.equal(p.run(stopCondition()), true, "nothing stopped yet");
  assert.equal(p.run(probeScript(["#missing", "#go"], 7)), "plan step 7: a form's submit button", "fallbacks tried in order");
  assert.equal(p.run(stopCondition()), false);
  assert.equal(p.store.get("__giGuardStop"), "plan step 7: a form's submit button", "survives a navigation within the origin");
  assert.equal(p.run(probeScript(["#link"], 9)), "plan step 7: a form's submit button", "a later probe respects the earlier stop");
});

test("a harmless target leaves the run going", () => {
  const p = page();
  assert.equal(p.run(probeScript(["#link"], 2)), "clear");
  assert.equal(p.run(stopCondition()), true);
});

test("the tripwire blocks what it can see and logs it, without stopping the run", async () => {
  const p = page();
  p.run(probeScript(["#link"], 0));
  p.run(probeScript(["#link"], 1));
  assert.equal(p.listeners.filter((l) => l.type === "submit").length, 1, "armed once however many probes run");

  await assert.rejects(p.env.window.fetch("https://example.com/lead", { method: "POST" }));
  assert.equal(await p.env.window.fetch("https://example.com/page"), "ok", "a GET passes");
  const xhr = new p.env.XMLHttpRequest();
  xhr.open("POST", "/lead");
  xhr.send();
  p.env.navigator.sendBeacon("/beacon", "x");
  p.env.HTMLFormElement.prototype.submit.call({ method: "post", action: "https://example.com/submit" });
  let prevented = false;
  p.listeners[0].fn({ preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {}, target: { method: "post", action: "https://example.com/submit" } });

  assert.ok(prevented, "a submit event is cancelled");
  assert.deepEqual(p.fetched, ["GET https://example.com/page"], "nothing that sends data got through");
  const log = JSON.parse(p.run(logScript()));
  assert.equal(log.stopped, null, "blocking is reported, it does not stop the run");
  assert.deepEqual(log.blocked, [
    "fetch POST https://example.com/lead",
    "xhr POST /lead",
    "sendBeacon POST /beacon",
    "form.submit() POST https://example.com/submit",
    "submit POST https://example.com/submit",
  ]);
});

test("with sessionStorage denied, the stop still holds on the page and never skips a run that was not stopped", () => {
  // Failing closed here would skip every step and come back green having
  // proved nothing, so an unreadable store counts only what window says.
  const p = page({ storageThrows: true });
  assert.equal(p.run(stopCondition()), true);
  assert.equal(p.run(probeScript(["#go"], 4)), "plan step 4: a form's submit button");
  assert.equal(p.run(stopCondition()), false);
});
