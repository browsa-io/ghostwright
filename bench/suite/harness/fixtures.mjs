// Fixture server. One server per browser lane, so page events never mix between lanes.
//
// Every page is reachable on two origins of the same port:
//   http://localhost:<port>    (the "home" origin, {{O}} in page source)
//   http://127.0.0.1:<port>    (a second site, {{X}} in page source; frames from it are cross-origin)
//
// Each HTML page gets /__probe.js, which reports clicks, input, scroll, loads and
// app-level state (window.__probe.set) back to the server. Checks read that log,
// so a check is the same for every SDK and needs no model.
import http from "node:http";

const PROBE = `(() => {
  if (window.__probe) return;
  const q = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!q.length) return;
    const body = JSON.stringify(q.splice(0));
    try { navigator.sendBeacon("/__ev", body); } catch (e) { fetch("/__ev", { method: "POST", body, keepalive: true }); }
  };
  const send = (ev) => {
    ev.t = Date.now();
    ev.path = location.pathname;
    ev.origin = location.origin;
    ev.top = window === window.top;
    q.push(ev);
    if (!timer) timer = setTimeout(flush, 20);
  };
  addEventListener("pagehide", flush);
  const eidOf = (e) => {
    const p = e.composedPath ? e.composedPath() : [e.target];
    for (const n of p) if (n && n.getAttribute && n.getAttribute("data-eval-id")) return n.getAttribute("data-eval-id");
    return null;
  };
  const valOf = (el) => {
    if (!el) return null;
    if (el.isContentEditable) return el.innerText;
    return "value" in el ? el.value : null;
  };
  // Real apps confirm a saved change on screen ("Saved", a toast). Fixture pages record app
  // state with __probe.set; each such change also shows a small status line, so an SDK that
  // checks for a visible effect sees one, as it would on a real site.
  let saves = 0;
  const toast = () => {
    if (!document.body) return;
    let t = document.getElementById("__status");
    if (!t) {
      t = document.createElement("div");
      t.id = "__status";
      t.setAttribute("role", "status");
      t.style.cssText = "position:fixed;right:8px;bottom:8px;background:#222;color:#fff;font:12px system-ui;padding:4px 8px;border-radius:4px;pointer-events:none;z-index:2147483647";
      document.body.appendChild(t);
    }
    t.textContent = "Change saved (" + (++saves) + ")";
  };
  window.__probe = { set: (k, v) => { send({ type: "kv", k, v }); if (!String(k).startsWith("_")) toast(); }, send };
  addEventListener("error", (e) => send({ type: "jserror", msg: String(e.message || e.error) }));
  addEventListener("click", (e) => send({ type: "click", eid: eidOf(e), tag: e.target && e.target.tagName, trusted: e.isTrusted }), true);
  addEventListener("input", (e) => { const el = e.composedPath()[0]; send({ type: "input", eid: eidOf(e), name: el && el.name, value: valOf(el) }); }, true);
  addEventListener("change", (e) => { const el = e.composedPath()[0]; send({ type: "change", eid: eidOf(e), name: el && el.name, value: valOf(el), checked: el && el.checked }); }, true);
  addEventListener("keydown", (e) => { if (["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "End", "Home"].includes(e.key)) send({ type: "key", key: e.key, eid: eidOf(e) }); }, true);
  let st = null;
  const scrollRep = (el) => {
    const doc = el === document;
    const y = doc ? scrollY : el.scrollTop;
    const max = doc ? document.documentElement.scrollHeight - innerHeight : el.scrollHeight - el.clientHeight;
    send({ type: "scroll", eid: doc ? null : el.getAttribute && el.getAttribute("data-eval-id"), y, max, frac: max > 0 ? y / max : 0, vh: innerHeight });
  };
  let lastTick = 0;
  addEventListener("scroll", (e) => {
    clearTimeout(st);
    const el = e.target;
    st = setTimeout(() => scrollRep(el), 150);
    if (Date.now() - lastTick > 200) { lastTick = Date.now(); send({ type: "tick" }); } // "still moving", lets the harness wait
  }, true);
  const loaded = () => send({ type: "load", title: document.title, href: location.href });
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", loaded); else loaded();
})();`;

const BASE_CSS = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;line-height:1.45;color:#111}
button{font:inherit;padding:6px 12px;margin:4px}input,select,textarea{font:inherit;padding:4px 6px;margin:4px}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}
.card{border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0}`;

export class LaneState {
  constructor() {
    this.reset();
  }
  reset() {
    this.events = [];
    this.kv = {};
    this.variant = "v1";
  }
  push(ev) {
    this.events.push(ev);
    if (ev.type === "kv") this.kv[ev.k] = ev.v;
  }
  // Helpers used by checks
  clicked(eid) {
    return this.events.some((e) => e.type === "click" && e.eid === eid);
  }
  clicks() {
    return this.events.filter((e) => e.type === "click").map((e) => e.eid);
  }
  loads() {
    return this.events.filter((e) => e.type === "load");
  }
  lastScroll(eid = null) {
    const s = this.events.filter((e) => e.type === "scroll" && (eid === null ? !e.eid && e.top : e.eid === eid));
    return s[s.length - 1] || null;
  }
  valueOf(eid) {
    const s = this.events.filter((e) => (e.type === "input" || e.type === "change") && e.eid === eid);
    return s.length ? s[s.length - 1].value : null;
  }
  interactions() {
    return this.events.filter((e) => ["click", "input", "change", "key"].includes(e.type) || (e.type === "kv" && !String(e.k).startsWith("_")));
  }
  allText() {
    return JSON.stringify(this.events);
  }
}

/**
 * pages: Map<path, page> where page = { title, body, head?, raw? } or (ctx) => that.
 * ctx = { variant, O, X, query, path }
 */
export async function startFixtureServer(pages, { port = 0 } = {}) {
  const state = new LaneState();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__probe.js") {
      res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      return res.end(PROBE);
    }
    if (u.pathname === "/__ev" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const evs = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const ev of Array.isArray(evs) ? evs : [evs]) state.push(ev);
      } catch {}
      res.writeHead(204);
      return res.end();
    }
    if (u.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    const p = port;
    const ctx = { variant: state.variant, O: `http://localhost:${p}`, X: `http://127.0.0.1:${p}`, query: u.searchParams, path: u.pathname, state };
    let page = pages.get(u.pathname);
    if (typeof page === "function") page = page(ctx);
    if (!page) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<!doctype html><title>Not found</title><h1>Not found</h1>");
    }
    if (page.redirect) {
      res.writeHead(302, { location: page.redirect.replaceAll("{{O}}", ctx.O).replaceAll("{{X}}", ctx.X) });
      return res.end();
    }
    const fill = (s) => (s || "").replaceAll("{{O}}", ctx.O).replaceAll("{{X}}", ctx.X);
    const html = page.raw
      ? fill(page.raw)
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${page.title || "Page"}</title><script src="/__probe.js"></script><style>${BASE_CSS}${page.css || ""}</style>${fill(page.head)}</head>` +
        `<body>${fill(page.body)}</body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  // listen on all loopback names: localhost resolves to 127.0.0.1 (and maybe ::1)
  port = server.address().port;
  const server6 = http.createServer((req, res) => server.emit("request", req, res));
  await new Promise((r) => {
    server6.once("error", () => r());
    server6.listen(port, "::1", r);
  });
  return {
    port,
    state,
    O: `http://localhost:${port}`,
    X: `http://127.0.0.1:${port}`,
    url: (path) => `http://localhost:${port}${path}`,
    close: async () => {
      await new Promise((r) => server.close(r));
      await new Promise((r) => server6.close(() => r()));
    },
  };
}
