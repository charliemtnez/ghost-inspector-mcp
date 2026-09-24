/** Scripts the validation guard injects into the browser: a probe before each click, a stop condition on every step, a closing log. */

/** Classifies an element: a reason string when activating it could submit something, or null. */
export const VERDICT_SOURCE = String.raw`function (el) {
  if (!el || el.nodeType !== 1) return "target not resolvable from the top document";
  var c = (el.closest && el.closest("button, input, select, textarea, option, label, a, [role=button], [onclick]")) || el;
  if (String(c.tagName || "").toUpperCase() === "LABEL" && c.control) c = c.control;
  var tag = String(c.tagName || "").toUpperCase();
  var type = String(c.type || "").toLowerCase();
  var form = c.form || (el.closest ? el.closest("form") : null);
  if (tag === "BUTTON" && type === "submit" && form) return "a form's submit button";
  if (tag === "INPUT" && (type === "submit" || type === "image") && form) return "a form's submit input";
  var field = (tag === "INPUT" && ["button", "submit", "image", "reset"].indexOf(type) === -1) ||
    tag === "SELECT" || tag === "TEXTAREA" || tag === "OPTION";
  if (form && !field) return "a control inside a form that is not a field";
  return null;
}`;

/** Resolves a step's selectors in order, the way Ghost Inspector tries fallbacks; counts the ones it could not read. */
export const FIND_SOURCE = String.raw`function (selectors) {
  var unreadable = 0;
  for (var i = 0; i < selectors.length; i++) {
    var sel = String(selectors[i] || "");
    try {
      var el = null;
      if (/^xpath=/i.test(sel)) el = document.evaluate(sel.slice(6), document, null, 9, null).singleNodeValue;
      else if (/^\(?\/\//.test(sel)) el = document.evaluate(sel, document, null, 9, null).singleNodeValue;
      else if (/^css=/i.test(sel)) el = document.querySelector(sel.slice(4));
      else el = document.querySelector(sel);
      if (el) return { el: el, unreadable: unreadable };
    } catch (e) {
      unreadable += 1;
    }
  }
  return { el: null, unreadable: unreadable };
}`;

/** Installs the tripwire once per page: submit events, form.submit(), non-GET fetch and XHR, and sendBeacon are blocked and logged. */
export const ARM_SOURCE = String.raw`function (g) {
  if (g.armed) return;
  g.armed = true;
  g.log = function (entry) {
    g.blocked.push(entry);
    try {
      var kept = JSON.parse(window.sessionStorage.getItem("__giGuardBlocked") || "[]");
      kept.push(entry);
      window.sessionStorage.setItem("__giGuardBlocked", JSON.stringify(kept));
    } catch (e) {}
  };
  g.reads = function (method) {
    var m = String(method || "GET").toUpperCase();
    return m === "GET" || m === "HEAD";
  };
  try {
    window.addEventListener("submit", function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var form = event.target;
      g.log("submit " + String((form && form.method) || "get").toUpperCase() + " " + String((form && form.action) || location.href));
    }, true);
  } catch (e) {}
  try {
    HTMLFormElement.prototype.submit = function () {
      g.log("form.submit() " + String(this.method || "get").toUpperCase() + " " + String(this.action || location.href));
    };
  } catch (e) {}
  try {
    var realFetch = window.fetch;
    if (realFetch) {
      window.fetch = function (input, init) {
        var method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
        var url = typeof input === "string" ? input : String((input && input.url) || input);
        if (!g.reads(method)) {
          g.log("fetch " + String(method).toUpperCase() + " " + url);
          return Promise.reject(new TypeError("blocked by the Ghost Inspector validation guard"));
        }
        return realFetch.apply(this, arguments);
      };
    }
  } catch (e) {}
  try {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__giMethod = method;
      this.__giUrl = url;
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (!g.reads(this.__giMethod)) {
        g.log("xhr " + String(this.__giMethod).toUpperCase() + " " + String(this.__giUrl));
        return undefined;
      }
      return send.apply(this, arguments);
    };
  } catch (e) {}
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon = function (url) {
        g.log("sendBeacon POST " + String(url));
        return true;
      };
    }
  } catch (e) {}
}`;

const STATE = `window.__giGuard || (window.__giGuard = { armed: false, blocked: [], stop: null })`;

/**
 * The selectors a target offers, in the order Ghost Inspector tries them.
 *
 * @param target A step's authored target: a string or a fallback array.
 * @return Every non-empty selector.
 */
export function selectorsOf(target: string | Array<Record<string, unknown>>): string[] {
  if (typeof target === "string") return target ? [target] : [];
  return target.map((entry) => (typeof entry["selector"] === "string" ? entry["selector"] : "")).filter(Boolean);
}

/**
 * The extractEval body injected before a click: arms the tripwire, then stops the run if the target could submit.
 *
 * @param selectors The click's selectors, in fallback order.
 * @param planIndex The click's position in the plan, named in the stop reason.
 * @param optional An optional click whose selectors all read but match nothing is let through: it would be skipped.
 * @return A script returning "clear", or the stop reason.
 */
export function probeScript(selectors: string[], planIndex: number, optional = false): string {
  return [
    `var g = ${STATE};`,
    `(${ARM_SOURCE})(g);`,
    `var prior = g.stop;`,
    `if (!prior) { try { prior = window.sessionStorage.getItem("__giGuardStop"); } catch (e) {} }`,
    `if (prior) return prior;`,
    `var found = (${FIND_SOURCE})(${JSON.stringify(selectors)});`,
    optional ? `if (!found.el && found.unreadable === 0) return "clear";` : "",
    `var reason = (${VERDICT_SOURCE})(found.el);`,
    `if (!reason) return "clear";`,
    `var stop = ${JSON.stringify(`plan step ${planIndex}: `)} + reason;`,
    `g.stop = stop;`,
    `try { window.sessionStorage.setItem("__giGuardStop", stop); } catch (e) {}`,
    `return stop;`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The condition every step carries: arms the tripwire on the current page, and is false once a probe has stopped the run.
 *
 * @return A script returning true while the run may go on.
 */
export function stopCondition(): string {
  return [
    `var g = ${STATE};`,
    `try { (${ARM_SOURCE})(g); } catch (e) {}`,
    `var stored = null;`,
    `try { stored = window.sessionStorage.getItem("__giGuardStop"); } catch (e) {}`,
    `return !(g.stop || stored);`,
  ].join("\n");
}

/**
 * The extractEval body appended last, with no condition: what stopped the run and what was blocked.
 *
 * @return A script returning JSON {stopped, blocked}.
 */
export function logScript(): string {
  return [
    `var g = window.__giGuard || { blocked: [], stop: null };`,
    `var stored = [];`,
    `try { stored = JSON.parse(window.sessionStorage.getItem("__giGuardBlocked") || "[]"); } catch (e) {}`,
    `var stop = g.stop || null;`,
    `try { stop = stop || window.sessionStorage.getItem("__giGuardStop"); } catch (e) {}`,
    `var seen = {};`,
    `var blocked = [];`,
    `(g.blocked || []).concat(stored).forEach(function (entry) { if (!seen[entry]) { seen[entry] = true; blocked.push(entry); } });`,
    `return JSON.stringify({ stopped: stop, blocked: blocked });`,
  ].join("\n");
}
