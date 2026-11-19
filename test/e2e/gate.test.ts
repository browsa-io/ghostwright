// Regression tests for the end-to-end gate. Each one failed before its fix.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { cdp, env, Ghostwright, secret } from "../../src/index.js";
import { lines, mockModel, pageOf } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

const PW = "SuperSecretPassword!";

describe("B1 a secret whose value holds its own label", () => {
  it("saves the token, selector, label and goal as they were", async () => {
    const store = tempStore();
    process.env.GW_GATE_USER = "tomsmith";
    const secrets = { username: env("GW_GATE_USER", { origins: ["localhost"] }), password: secret(PW, { origins: ["localhost"] }) };
    const gw = await open({ model: mockModel(), store, secrets });
    try {
      const flow = await gw.flow("gate-login");
      await flow.goto(`${fx.url}/gate-login.html`);
      expect((await flow.act("type %username% into the username field")).ok).toBe(true);
      expect((await flow.act("type %password% into the password field")).ok).toBe(true);
      const saved = await flow.save();
      const pw = saved.steps.find(s => s.kind === "type" && /PASSWORD/.test(s.text || ""))!;
      expect(pw.text).toBe("{{secret:PASSWORD}}");
      expect(pw.target?.css).toBe("#password");
      expect(pw.target?.name).toBe("Password");
      expect(pw.goal).toBe("type %password% into the password field");
      expect(JSON.stringify(saved)).not.toMatch(/%%|secret:%/);
      // the page text says "the password", and the view keeps it
      const v = (await gw.observe()).view;
      expect(v).toMatch(/textbox "Password"/);
      expect(v).not.toContain(PW);
      expect(v).not.toContain("tomsmith");
      // and it replays
      const run = await gw.run("gate-login");
      expect(run.repaired).toEqual([]);
      expect(await gw.page.inputValue("#password")).toBe(PW);
    } finally { await gw.close(); }
  });
});

describe("B3 a callback secret", () => {
  it("is masked from the first prompt, before it is ever typed", async () => {
    const model = mockModel();
    const secrets = { password: secret(async () => PW, { origins: ["localhost"] }) };
    const gw = await open({ model, store: tempStore(), secrets });
    try {
      await gw.goto(`${fx.url}/gate-login.html`);
      // nothing typed yet; the page shows the value
      expect(await gw.page.content()).toContain(PW);
      await gw.act("click the username field");
      const all = model.calls.map(c => c.prompt).join("\n") + JSON.stringify(gw.last()) + (await gw.observe()).view;
      expect(model.calls.length).toBeGreaterThan(0);
      expect(all).not.toContain(PW);
      expect(all).toContain("%password%");
    } finally { await gw.close(); }
  });
});

describe("M3 a guard's refusal is final", () => {
  it("act does not choose again after a purchase block, and a replay is not repaired round it", async () => {
    const pick = (re: RegExp) => (req: any) => ({ action: "click", id: lines(pageOf(req.prompt)).find(l => re.test(l.name))!.id });
    const m = mockModel();
    (m as any).generate = mockModel({ act: req => /Choose again/.test(req.prompt) ? pick(/Proceed to checkout/)(req) : pick(/Place your order/)(req) }).generate;
    const calls: string[] = [];
    const store = tempStore();
    const gw = await open({ model: m, store, onEvent: e => { if (e.type === "model-call") calls.push(e.kind); } });
    try {
      await gw.goto(`${fx.url}/checkout.html`);
      const r = await gw.act("finish the order");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/purchase_blocked/);
      expect(calls).toEqual(["act"]);
      expect(await gw.page.textContent("#status")).toBe("Not ordered");
      expect(gw.page.url()).not.toContain("#review");
    } finally { await gw.close(); }
    // recorded where buying was allowed, replayed where it is not
    const rec = await open({ model: mockModel({ act: pick(/Place your order/) }), store, allowPurchases: true });
    try {
      const f = await rec.flow("gate-order");
      await f.goto(`${fx.url}/checkout.html`);
      expect((await f.act("place the order")).ok).toBe(true);
      await f.save();
    } finally { await rec.close(); }
    const m2 = mockModel({ act: pick(/Proceed to checkout/) });
    const g2 = await open({ model: m2, store });
    try {
      await expect(g2.run("gate-order")).rejects.toMatchObject({ code: "blocked" });
      expect(m2.calls.length).toBe(0);
      expect(await g2.page.textContent("#status")).toBe("Not ordered");
    } finally { await g2.close(); }
  });
});

describe("M1 a target below the fold", () => {
  it("is clicked, not just scrolled to; a scroll alone is not ok", async () => {
    // a model that scrolls when it cannot see the link
    const brain = (req: any) => {
      const l = lines(pageOf(req.prompt)).find(x => /Books at the bottom/.test(x.name));
      return l ? { action: "click", id: l.id } : { action: "scroll", dy: 1800 };
    };
    const m = mockModel({ act: brain });
    const gw = await open({ model: m, store: tempStore() });
    try {
      await gw.goto(`${fx.url}/tall.html`);
      const r = await gw.act("click the Books at the bottom link");
      expect(r.ok).toBe(true);
      expect(gw.page.url()).toBe(`${fx.url}/books.html`);
      // never there: ok false, not "scrolled"
      (m as any).generate = mockModel({ act: () => ({ action: "scroll", dy: 1800 }) }).generate;
      await gw.goto(`${fx.url}/tall.html`);
      const r2 = await gw.act("click the Next link");
      expect(r2.ok).toBe(false);
      expect(r2.reason).toMatch(/only scrolled/);
    } finally { await gw.close(); }
  });
});

describe("M2 a folded list", () => {
  it("act expands it and clicks an item that was folded", async () => {
    const brain = (req: any) => {
      const page = pageOf(req.prompt);
      const l = lines(page).find(x => x.name === "City 37");
      if (l) return { action: "click", id: l.id };
      const ex = /more items \(expand \[(\d+)\]\)/.exec(page);
      return ex ? { action: "expand", id: +ex[1] } : { action: "none", why: "not here" };
    };
    const m = mockModel({ act: brain });
    const gw = await open({ model: m, store: tempStore() });
    try {
      await gw.goto(`${fx.url}/gate-long.html`);
      const r = await gw.act("click City 37");
      expect(r.ok).toBe(true);
      expect(await gw.page.textContent("#status")).toBe("City 37");
      expect(m.calls.some(c => /more items \(expand/.test(c.prompt))).toBe(true);
      // the agent can expand too
      await gw.goto(`${fx.url}/gate-long.html`);
      let n = 0;
      (m as any).generate = async (req: any) => {
        n++;
        const page = pageOf(req.prompt);
        const l = lines(page).find(x => x.name === "City 37");
        const ex = /more items \(expand \[(\d+)\]\)/.exec(page);
        const a = l ? (n > 3 ? { action: "done", success: true, answer: "clicked", evidence: { text: "City 37" } } : { action: "click", id: l.id }) : ex ? { action: "expand", id: +ex[1] } : { action: "scroll", dy: 2000 };
        return { text: JSON.stringify(a) };
      };
      await gw.agent("click City 37", { maxSteps: 6 });
      expect(await gw.page.textContent("#status")).toBe("City 37");
    } finally { await gw.close(); }
  });
});

describe("M4 a refused popup", () => {
  it("is reported: ok false with the reason, no tab left", async () => {
    const port = new URL(fx.url).port;
    const gw = await open({ store: tempStore(), allowedOrigins: [`localhost:${port}`] });
    try {
      await gw.goto(`${fx.url}/sec-popup.html`);
      const r = await gw.do({ action: "click", role: "button", name: "See offer" });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/tried to open http:\/\/127\.0\.0\.1:\d+ in a new tab .*; it was closed/);
      const r2 = await gw.do({ action: "click", role: "button", name: "See more" });
      expect(r2.ok).toBe(false);
      expect(r2.reason).toMatch(/new tab/);
      await new Promise(res => setTimeout(res, 500));
      expect((await gw.tabs()).length).toBe(1);
    } finally { await gw.close(); }
  });
});

describe("M5 leftover: a bracket closed after the cut", () => {
  it("compiles a title the model wrote as \"(Notes From…)\", and replays it with no model", async () => {
    const FULL = ["It's Only the Himalayas", "Full Moon over Noah’s Ark: An Odyssey to Mount Ararat and Beyond", "Under the Tuscan Sun", "The Road to Little Dribbling: Adventures of an American in Britain (Notes From a Small Island #2)", "1,000 Places to See Before You Die"];
    const wrote = [...FULL];
    wrote[3] = "The Road to Little Dribbling: Adventures of an American in Britain (Notes From…)";
    wrote[1] = "Full Moon over Noah’s Ark: An Odyssey to Mount…\"";
    const store = tempStore();
    const gw = await open({ model: mockModel({ extract: () => ({ titles: wrote.map(title => ({ title })) }) }), store, warnings: false });
    try {
      const f = await gw.flow("gate-closed");
      await f.goto(`${fx.url}/gate-travel.html`);
      const r = await f.extract("every book title", z.object({ titles: z.array(z.object({ title: z.string() })) }));
      expect(r.meta.layer).toBe("css");
      expect(r.data.titles.map(t => t.title)).toEqual(FULL);
      await f.save();
    } finally { await gw.close(); }
    const g2 = await open({ store });
    try {
      const run = await g2.run("gate-closed");
      expect(run.meta.modelCalls).toBe(0);
      expect(run.output.titles.map((t: any) => t.title)).toEqual(FULL);
    } finally { await g2.close(); }
  });
});

describe("M6 extract outside a flow", () => {
  it("returns the full text, not the names the view cut at 80 characters", async () => {
    // the model copies what the view shows
    const fromView = (_i: string, page: string) => ({ reports: lines(page).filter(l => l.role === "link").map(l => ({ title: l.name })) });
    const gw = await open({ model: mockModel({ extract: fromView }), store: tempStore() });
    try {
      await gw.goto(`${fx.url}/gate-names.html`);
      const r = await gw.extract("every report title", z.object({ reports: z.array(z.object({ title: z.string() })) }));
      expect(r.data.reports.map(x => x.title)).toEqual([
        "Quarterly report on the regional distribution of renewable energy projects and their grid connections, 2026 edition",
        "Annual summary of maintenance work carried out on the northern railway lines, including bridges, tunnels and stations",
        "Short one",
      ]);
    } finally { await gw.close(); }
  });
});

describe("M7 waitForReady", () => {
  it("is not ready while the page says Loading...", async () => {
    const gw = await open({ store: tempStore() });
    try {
      await gw.goto(`${fx.url}/gate-loading.html`);
      const r = await gw.waitForReady({ timeoutMs: 8000 });
      expect(r.ready).toBe(true);
      expect(await gw.page.textContent("#app")).toContain("Order 1001");
      await gw.goto(`${fx.url}/gate-loading.html?never`);
      const r2 = await gw.waitForReady({ timeoutMs: 1500 });
      expect(r2.ready).toBe(false);
      expect(r2.reason).toMatch(/loading indicator \("Loading\.\.\."\)/);
    } finally { await gw.close(); }
  });
});

describe("M8 a repair that would type a secret into another field", () => {
  it("types nothing: the repair waits as a draft until promoted", async () => {
    const store = tempStore();
    const PWV = "Gate-pass-778899";
    const secrets = { password: secret(PWV, { origins: ["localhost"] }) };
    const rec = await open({ model: mockModel(), store, secrets });
    try {
      const f = await rec.flow("gate-secret");
      await f.goto(`${fx.url}/gate-secret.html`);
      expect((await f.act("type %password% into the password field")).ok).toBe(true);
      await f.save();
    } finally { await rec.close(); }
    const m = mockModel({ act: req => ({ action: "type", id: lines(pageOf(req.prompt)).find(l => l.name === "Passphrase")!.id, text: "%password%" }) });
    const gw = await open({ model: m, store, secrets });
    try {
      fx.variant = "changed";
      const err = await gw.run("gate-secret").catch(e => e);
      expect(err.code).toBe("needs_review");
      expect(err.message).toMatch(/another field \(Passphrase\).*nothing was typed.*draft v2/);
      expect(await gw.page.inputValue("#pp")).toBe("");
      expect(await gw.page.inputValue("#notes")).toBe("");
      // a person looked at it: promoted, it types there
      gw.promote("gate-secret");
      m.reset();
      const run = await gw.run("gate-secret");
      expect(run.version).toBe(2);
      expect(m.calls.length).toBe(0);
      expect(await gw.page.inputValue("#pp")).toBe(PWV);
      expect(await gw.page.inputValue("#notes")).toBe("");
    } finally { fx.variant = "base"; await gw.close(); }
  });
});

describe("minor: error codes and placeholders", () => {
  it("a missing secret and an extract that needs a model have codes of their own", async () => {
    const store = tempStore();
    const secrets = { password: secret("Gate-pass-112233", { origins: ["localhost"] }) };
    const rec = await open({ model: mockModel({ extract: () => ({ note: "not on the page" }) }), store, secrets, warnings: false });
    try {
      const f = await rec.flow("gate-missing");
      await f.goto(`${fx.url}/gate-secret.html`);
      expect((await f.act("type %password% into the password field")).ok).toBe(true);
      await f.save();
      const x = await rec.flow("gate-model-extract");
      await x.goto(`${fx.url}/books.html`);
      await x.extract("a note", z.object({ note: z.string() }));
      await x.save();
    } finally { await rec.close(); }
    const gw = await open({ store });
    try {
      await expect(gw.run("gate-missing")).rejects.toMatchObject({ code: "secret_missing", message: expect.stringMatching(/\{\{secret:PASSWORD\}\}, which is not in this Ghostwright's secrets/) });
      const e: any = await gw.run("gate-model-extract").catch(err => err);
      expect(e.code).toBe("no_model");
      expect(e.message).not.toMatch(/site_changed|no model to repair/);
    } finally { await gw.close(); }
  });

  it("do() types a %secret% as a secret, and a placeholder that is not one is never typed", async () => {
    const PWV = "Gate-pass-445566";
    const m = mockModel({ agent: [{ action: "type", id: 0, text: "%username%" }, { action: "done", success: false, answer: "no" }] });
    const gw = await open({ model: m, store: tempStore(), secrets: { password: secret(PWV, { origins: ["localhost"] }) } });
    try {
      await gw.goto(`${fx.url}/gate-secret.html`);
      const r = await gw.do({ action: "type", role: "textbox", name: "Password", text: "%password%" });
      expect(r.ok).toBe(true);
      expect(await gw.page.inputValue("#password")).toBe(PWV);
      expect(r.action).not.toContain(PWV);
      const r2 = await gw.do({ action: "type", role: "textbox", name: "Email", text: "%username%" });
      expect(r2.ok).toBe(false);
      expect(r2.reason).toMatch(/%username%, which is not a secret here; nothing was typed/);
      expect(await gw.page.inputValue("#email")).toBe("");
      // the agent: a placeholder it made up is refused, not typed
      const email = lines((await gw.observe()).view).find(l => l.name === "Email")!.id;
      (m as any).generate = mockModel({ agent: [{ action: "type", id: email, text: "%username%" }, { action: "done", success: false, answer: "no" }] }).generate;
      const a = await gw.agent("log in", { maxSteps: 3 });
      expect(a.history[0]).toMatch(/%username%, which is not a secret or variable here; nothing was typed/);
      expect(await gw.page.inputValue("#email")).toBe("");
    } finally { await gw.close(); }
  });
});

const CHROME = process.env.GW_CHROME || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");

describe("docs: cdp()", () => {
  // our own Chrome on a free port, reached by its exact ws:// address (never a fixed port)
  it.skipIf(!existsSync(CHROME))("takes the browser's current tab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-cdp-"));
    const p = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", `${fx.url}/books.html`], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      const ws = await new Promise<string>((res, rej) => {
        let err = "";
        p.stderr!.on("data", d => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) res(m[1]); });
        setTimeout(() => rej(new Error("Chrome printed no DevTools address")), 15000);
      });
      const gw = await Ghostwright.create({ browser: cdp(ws), store: tempStore() });
      try {
        await gw.waitForReady({ timeoutMs: 5000 });
        expect(gw.page.url()).toBe(`${fx.url}/books.html`);
        expect((await gw.tabs()).length).toBe(1);
      } finally { await gw.close(); }
    } finally { p.kill("SIGKILL"); }
  });
});

describe("M5 extract compile", () => {
  const Titles = z.object({ titles: z.array(z.object({ title: z.string() })) });
  const SHOWN = ["It's Only the Himalayas", "Full Moon over Noah’s ...", "Under the Tuscan Sun", "The Road to Little ...", "1,000 Places to See ..."];
  const FULL = ["It's Only the Himalayas", "Full Moon over Noah’s Ark: An Odyssey to Mount Ararat and Beyond", "Under the Tuscan Sun", "The Road to Little Dribbling: Adventures of an American in Britain (Notes From a Small Island #2)", "1,000 Places to See Before You Die"];
  it("compiles titles the page shows cut short, and returns them in full, and save() warns when one does not compile", async () => {
    const store = tempStore();
    let answer: unknown = { titles: SHOWN.map(title => ({ title })) };
    const warnings: string[] = [];
    const gw = await open({ model: mockModel({ extract: () => answer }), store, warnings: false, onEvent: e => { if (e.type === "warning") warnings.push(e.message); } });
    try {
      const f = await gw.flow("gate-travel");
      await f.goto(`${fx.url}/gate-travel.html`);
      const r = await f.extract("every book title", Titles);
      expect(r.meta.layer).toBe("css");
      // the full titles: what the page shows cut short is completed from it
      expect(r.data.titles.map(t => t.title)).toEqual(FULL);
      await f.save();
      expect(warnings).toEqual([]);
      const run = await gw.run("gate-travel");
      expect(run.meta.modelCalls).toBe(0);
      // an answer the page does not hold: stays a model extract, and save() says so
      answer = { titles: [{ title: "A book that is not here" }] };
      const g = await gw.flow("gate-travel-2");
      await g.goto(`${fx.url}/gate-travel.html`);
      expect((await g.extract("every book title", Titles)).meta.layer).toBe("model");
      await g.save();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/did not compile/);
    } finally { await gw.close(); }
  });
});

describe("B2 a replay that did something else", () => {
  it("a param value that is not on the page fails; it never falls back to the recorded position", async () => {
    const store = tempStore();
    const rec = await open({ model: mockModel(), store });
    try {
      const flow = await rec.flow("gate-cat", { params: { category: "Travel" } });
      await flow.goto(`${fx.url}/gate-cats.html`);
      expect((await flow.act("open the %category% category")).ok).toBe(true);
      const saved = await flow.save();
      expect(saved.steps[1].target?.name).toBe("{{category}}");
      expect(saved.steps[1].effect?.path).toBe("/gate-cat-{{category}}.html");
    } finally { await rec.close(); }
    const gw = await open({ store });
    try {
      await gw.run("gate-cat", { category: "Mystery" });
      expect(gw.page.url()).toBe(`${fx.url}/gate-cat-mystery.html`);
      await expect(gw.run("gate-cat", { category: "Nonexistent Category" })).rejects.toThrow(/no element matches name "Nonexistent Category"/);
      expect(gw.page.url()).toBe(`${fx.url}/gate-cats.html`);
    } finally { await gw.close(); }
  });

  it("a step that goes somewhere else than when recorded fails", async () => {
    const store = tempStore();
    const rec = await open({ model: mockModel(), store });
    try {
      const flow = await rec.flow("gate-about");
      await flow.goto(`${fx.url}/gate-cats.html`);
      expect((await flow.act("click the about us link")).ok).toBe(true);
      expect((await flow.save()).steps[1].effect).toEqual({ kind: "navigate", path: "/books.html" });
    } finally { await rec.close(); }
    const gw = await open({ store });
    try {
      await gw.run("gate-about");
      fx.variant = "changed";
      await expect(gw.run("gate-about")).rejects.toThrow(/went to \/products\.html, not \/books\.html/);
    } finally { fx.variant = "base"; await gw.close(); }
  });
});
