// A small fixture site on two ports. localhost:A is the site; 127.0.0.1:A is
// another site (its frames run out of process); localhost:B is another origin
// of the same site (same process, cross-origin).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const DIR = new URL("./fixtures/", import.meta.url);

export const PRODUCTS = [
  { slug: "red-mug", name: "Red mug", price: 12.5, inStock: true },
  { slug: "blue-cup", name: "Blue cup", price: 9, inStock: false },
  { slug: "green-bowl", name: "Green bowl", price: 18.25, inStock: true },
];

export interface Fixtures {
  url: string;
  otherSite: string;
  otherOrigin: string;
  creds: { email: string; password: string };
  variant: "base" | "changed";
  requests: string[];
  close(): Promise<void>;
}

export async function startFixtures(): Promise<Fixtures> {
  const fx = { creds: { email: "ada@example.com", password: "pw" }, variant: "base", requests: [] as string[] } as Fixtures;
  const handler = (req: any, res: any) => {
    const u = new URL(req.url, "http://x");
    fx.requests.push(req.method + " " + (req.headers.host || "") + u.pathname + u.search);
    if (u.pathname === "/api/products.json") {
      const q = (u.searchParams.get("q") || "").toLowerCase();
      const items = PRODUCTS.filter(p => !q || p.name.toLowerCase().includes(q));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { items, total: items.length } }));
      return;
    }
    if (u.pathname === "/api/slow") {
      // a report that takes 3 s, longer than an act waits for a request
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ rows: ["Genoa North", "Lyon Est", "Porto Sul"] })); }, 3000);
      return;
    }
    if (u.pathname === "/api/login") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        let j: any = {};
        try { j = JSON.parse(body); } catch { /* empty */ }
        const ok = j.email === fx.creds.email && j.password === fx.creds.password;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok, name: ok ? "Ada" : "" }));
      });
      return;
    }
    let file = u.pathname === "/" ? "login.html" : u.pathname.slice(1);
    if (!/^[a-z0-9-]+\.html$/.test(file)) { res.writeHead(404); res.end("not found"); return; }
    let html: string;
    try { html = readFileSync(new URL(file, DIR), "utf8"); } catch { res.writeHead(404); res.end("not found"); return; }
    const changed = fx.variant === "changed";
    html = html
      .replaceAll("__SIGNIN__", changed ? "Sign in now" : "Sign in")
      .replaceAll("__VARIANT__", fx.variant)
      .replaceAll("__GATE_ABOUT__", changed ? "products.html" : "books.html")
      .replaceAll("__GATE_PW__", changed ? '<label>Notes <input type="text" id="notes"></label> <label>Passphrase <input type="password" id="pp"></label>' : '<label>Password <input type="password" id="password"></label>')
      .replaceAll("__OTHER_SITE__", fx.otherSite)
      .replaceAll("__OTHER_ORIGIN__", fx.otherOrigin);
    // the redesign: a new button where the old one was, the old one renamed
    if (changed) html = html.replace('<button type="submit" id="signin"', '<button type="button" id="help">Help</button>\n  <button type="submit" id="submit-btn" class="primary"');
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };
  const a: Server = createServer(handler);
  const b: Server = createServer(handler);
  for (const srv of [a, b]) srv.on("upgrade", (req, sock) => { fx.requests.push(`WS ${req.headers.host}${req.url}`); sock.destroy(); });
  await new Promise<void>(r => a.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>(r => b.listen(0, "127.0.0.1", () => r()));
  const pa = (a.address() as AddressInfo).port, pb = (b.address() as AddressInfo).port;
  fx.url = `http://localhost:${pa}`;
  fx.otherSite = `http://127.0.0.1:${pa}`;
  fx.otherOrigin = `http://localhost:${pb}`;
  fx.close = async () => {
    await new Promise(r => a.close(r));
    await new Promise(r => b.close(r));
  };
  return fx;
}
