// Every script in examples/ runs here, as written, against the fixture site
// with a mock model ("ghostwright" resolves to this source, see vitest.config.ts).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { local } from "../../src/index.js";
import { mockModel } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterAll(async () => { vi.restoreAllMocks(); await fx?.close(); });

const options = (extra: object = {}) => ({ browser: local({ headless: true }), store: tempStore(), ...extra });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("examples", () => {
  it("has a test for every example", () => {
    const files = readdirSync(new URL("../../examples/", import.meta.url)).filter(f => f.endsWith(".mjs")).sort();
    expect(files).toEqual(["any-cdp.mjs", "extract-list.mjs", "login-secrets.mjs", "quickstart.mjs"]);
  });

  it("quickstart.mjs records, then replays another category with 0 model calls", async () => {
    const { main } = await import("../../examples/quickstart.mjs");
    const titles = (page: string) => ({ titles: [...page.matchAll(/"((?:A|Another) \w+ book)"/g)].map(m => ({ title: m[1] })) });
    const r = await main({ url: `${fx.url}/gate-cats.html`, other: "Mystery", options: options({ model: mockModel({ extract: (_i, page) => titles(page) }) }) });
    expect(r.recorded.titles.map((t: any) => t.title)).toEqual(["A travel book", "Another travel book"]);
    expect(r.replayed.titles.map((t: any) => t.title)).toEqual(["A mystery book", "Another mystery book"]);
    expect(r.replayCalls).toBe(0);
  });

  it("extract-list.mjs reads a list into a schema", async () => {
    const { main } = await import("../../examples/extract-list.mjs");
    const books = { books: [{ title: "Dune", price: 9.5 }] };
    const r = await main({ url: `${fx.url}/books.html`, options: options({ model: mockModel({ extract: () => books }) }) });
    expect(r).toEqual(books);
  });

  it("login-secrets.mjs signs in and saves tokens, never values", async () => {
    const { main } = await import("../../examples/login-secrets.mjs");
    const before = { u: process.env.DEMO_USERNAME, p: process.env.DEMO_PASSWORD };
    process.env.DEMO_USERNAME = fx.creds.email;
    process.env.DEMO_PASSWORD = "pw-" + "x".repeat(12);
    fx.creds.password = process.env.DEMO_PASSWORD;
    try {
      const model = mockModel();
      const r = await main({ url: `${fx.url}/login.html`, userField: "email", submit: "click the sign in button", options: options({ model }) });
      expect(r.ok).toBe(true);
      expect(r.leaked).toBe(false);
      expect(JSON.stringify(r.recipe)).toContain("{{secret:DEMO_PASSWORD}}");
      expect(JSON.stringify(model.calls)).not.toContain(process.env.DEMO_PASSWORD);
    } finally {
      fx.creds.password = "pw";
      process.env.DEMO_USERNAME = before.u; process.env.DEMO_PASSWORD = before.p;
      if (before.u === undefined) delete process.env.DEMO_USERNAME;
      if (before.p === undefined) delete process.env.DEMO_PASSWORD;
    }
  });

  it.skipIf(!existsSync(CHROME))("any-cdp.mjs attaches to a running browser and acts with no model", async () => {
    const { main } = await import("../../examples/any-cdp.mjs");
    const dir = mkdtempSync(join(tmpdir(), "gw-cdp-"));
    const p = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      const ws = await new Promise<string>((res, rej) => {
        let err = "";
        p.stderr!.on("data", d => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]); });
        setTimeout(() => rej(new Error("Chrome printed no DevTools address")), 15000);
      });
      const r = await main({ cdpUrl: ws, url: `${fx.url}/gate-cats.html`, click: "Travel", options: { store: tempStore() } });
      expect(r.url).toBe(`${fx.url}/gate-cat-travel.html`);
      expect(r.modelCalls).toBe(0);
      await expect(main({ options: { store: tempStore() } })).rejects.toThrow(/set CDP_URL/);
    } finally { p.kill("SIGKILL"); }
  });
});
