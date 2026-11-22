// Guards and the smaller v0.1 features on local Chrome with a mock model:
// purchase guard, allowedOrigins, agent verdicts and the stall guard,
// check(), last(), waitForReady(), tabs(), extract from HTML, callback
// secrets, and regression pages.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { secret, type Ghostwright } from "../../src/index.js";
import { lines, mockModel } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { allText, open, tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

const idOf = (view: string, name: string, role?: string) => lines(view).find(l => l.name === name && (!role || l.role === role))!.id;

describe("purchase guard", () => {
  let gw: Ghostwright;
  beforeAll(async () => { gw = await open({ store: tempStore() }); });
  afterAll(async () => { await gw?.close(); });

  it("refuses order, pay and submit, below the model, and lets cart and checkout through", async () => {
    await gw.goto(`${fx.url}/checkout.html`);
    const v = (await gw.observe()).view;
    const place = await gw.do({ action: "click", id: idOf(v, "Place your order") });
    expect(place.ok).toBe(false);
    expect(place.reason).toMatch(/purchase_blocked: "place your order"/);
    expect(await gw.page.textContent("#status")).toBe("Not ordered");
    // a form whose submit pays: Enter and type-then-submit are refused too
    const field = idOf(v, "Card name");
    expect((await gw.do({ action: "type", id: field, text: "Ada", submit: true })).reason).toMatch(/purchase_blocked/);
    expect((await gw.do({ action: "type", id: field, text: "Ada" })).ok).toBe(true);
    const enter = await gw.do({ action: "press", keys: "Enter" });
    expect(enter.ok).toBe(false);
    expect(enter.reason).toMatch(/purchase_blocked: "pay €12/);
    expect(await gw.page.textContent("#status")).toBe("Not ordered");
    // things that do not buy
    expect((await gw.do({ action: "click", id: idOf(v, "Add to cart") })).ok).toBe(true);
    expect(await gw.page.textContent("#cart")).toBe("Cart: 2 items");
    expect((await gw.do({ action: "check", id: idOf(v, "Subscribe to our newsletter") })).ok).toBe(true);
  });

  it("allows it with allowPurchases", async () => {
    const g = await open({ store: tempStore(), allowPurchases: true });
    try {
      await g.goto(`${fx.url}/checkout.html`);
      const v = (await g.observe()).view;
      expect((await g.do({ action: "click", id: idOf(v, "Place your order") })).ok).toBe(true);
      expect(await g.page.textContent("#status")).toBe("ORDER PLACED");
    } finally { await g.close(); }
  });
});

describe("allowedOrigins", () => {
  it("refuses to open another origin and goes back when a click leaves", async () => {
    const port = new URL(fx.url).port;
    const g = await open({ store: tempStore(), allowedOrigins: [`localhost:${port}`] });
    try {
      expect((await g.goto(`${fx.url}/regress.html`)).ok).toBe(true);
      const off = await g.goto(`${fx.otherOrigin}/books.html`);
      expect(off.ok).toBe(false);
      expect(off.reason).toMatch(/outside allowedOrigins/);
      const v = (await g.observe()).view;
      const r = await g.do({ action: "click", id: idOf(v, "Partner shop") });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/outside allowedOrigins; the request was not sent\); went back/);
      // the other origin never got the request: it was stopped before it was sent
      expect(fx.requests.filter(x => x.includes("books.html")).length).toBe(0);
      expect(g.page.url()).toBe(`${fx.url}/regress.html`);
    } finally { await g.close(); }
  });
});

describe("agent verdicts and the stall guard", () => {
  it("never reads a missing verdict as success, and asks again for an empty answer", async () => {
    const m = mockModel({ agent: [{ action: "done", answer: "Three deals" }] });
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/books.html`);
      const r = await g.agent("how many books are listed?");
      expect(r.success).toBe("unknown");
      expect(r.status).toBe("done");
      const m2 = mockModel({ agent: [{ action: "done", success: true, answer: "done" }, { action: "done", success: true, answer: "3 books", evidence: { text: "Hyperion" } }] });
      (m as any).generate = m2.generate;
      const r2 = await g.agent("how many books are listed?");
      expect(r2.success).toBe(true);
      expect(r2.answer).toBe("3 books");
      expect(r2.history[0]).toMatch(/done refused: the answer was empty/);
      // a cited text that is not on the page is not a success
      const m3 = mockModel({ agent: [{ action: "done", success: true, answer: "4", evidence: { text: "Foundation" } }, { action: "done", success: true, answer: "4", evidence: { text: "Foundation" } }] });
      (m as any).generate = m3.generate;
      const r3 = await g.agent("how many books are listed?");
      expect(r3.success).toBe("unknown");
      expect(r3.evidence.cited).toEqual({ text: "Foundation", found: false });
    } finally { await g.close(); }
  });

  it("stops a run that repeats itself, and never shows a step budget", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const m = mockModel({ agent: [] });
    (m as any).generate = async (req: any) => {
      calls++;
      prompts.push(req.prompt);
      // always the same click on a heading that does nothing
      const id = lines(req.prompt).find(l => l.role === "heading")!.id;
      return { text: JSON.stringify({ action: "click", id }) };
    };
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/books.html`);
      const r = await g.agent("find the price", { maxSteps: 10 });
      expect(r.status).toBe("stalled");
      expect(r.success).toBe(false);
      expect(r.evidence.lastEffect).toMatch(/did not work|no change/);
      expect(calls).toBeLessThanOrEqual(4);
      expect(r.history.some(h => /it is not getting anywhere/.test(h))).toBe(true);
      expect(prompts.every(p => !/step \d+ of/i.test(p))).toBe(true);
    } finally { await g.close(); }
  });

  it("demands an answer on the last step", async () => {
    const prompts: string[] = [];
    const m = mockModel();
    (m as any).generate = async (req: any) => { prompts.push(req.prompt); return { text: JSON.stringify({ action: "scroll", dy: 200 }) }; };
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/tall.html`);
      const r = await g.agent("read the footer", { maxSteps: 2 });
      expect(r.status).toBe("max_steps");
      expect(prompts[1]).toMatch(/Answer now with "done": this is the last action/);
      expect(prompts[0]).not.toMatch(/last action/);
    } finally { await g.close(); }
  });
});

describe("check, last, waitForReady, tabs", () => {
  it("check() is ok only with words that are on the page", async () => {
    const m = mockModel({ check: (s, page) => (s.includes("2 items") ? { ok: page.includes("Cart: 2 items"), evidence: "Cart: 2 items" } : { ok: true, evidence: "Cart: 9 items" }) });
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/checkout.html`);
      expect((await g.check("the cart shows 2 items")).ok).toBe(false);
      await g.do({ action: "click", role: "button", name: "Add to cart" });
      const c = await g.check("the cart shows 2 items");
      expect(c.ok).toBe(true);
      expect(c.evidence).toMatchObject({ text: "Cart: 2 items", found: true });
      expect(c.meta.modelCalls).toBe(1);
      const lie = await g.check("the cart shows 9 items");
      expect(lie.ok).toBe(false);
      expect(lie.reason).toMatch(/not on the page/);
    } finally { await g.close(); }
  });

  it("last() shows the prompt, answer, plan and cost, with secrets masked", async () => {
    const CANARY = "cb-canary-" + Math.random().toString(36).slice(2);
    fx.creds = { email: "ada@example.com", password: CANARY };
    const m = mockModel();
    let reads = 0;
    const g = await open({
      model: m, store: tempStore(),
      secrets: { email: secret(async () => "ada@example.com", { origins: ["localhost"] }), password: secret(async () => { reads++; return CANARY; }, { origins: ["localhost"] }) },
    });
    try {
      await g.goto(`${fx.url}/login.html`);
      expect(reads).toBe(1); // read once at create, so it is masked from the first prompt
      await g.act("type %email% into the email field");
      await g.act("type %password% into the password field");
      expect(reads).toBe(2); // and again when typed
      const r = await g.act("click the sign in button");
      expect(r.ok).toBe(true);
      expect(g.page.url()).toContain("account.html");
      const last = g.last()!;
      expect(last.kind).toBe("act");
      expect(last.prompt).toContain('button "Sign in"');
      expect(JSON.parse(last.answer).action).toBe("click");
      expect(last.plan).toMatchObject({ ok: true, target: { role: "button", name: "Sign in" } });
      expect(last.inputTokens).toBeGreaterThan(50);
      expect(JSON.stringify(last)).not.toContain(CANARY);
      const all = [m.calls.map(c => c.prompt).join("\n"), JSON.stringify(g.metrics()), allText((g as any).store.dir)].join("\n");
      expect(all.includes(CANARY)).toBe(false);
      expect(all.includes("ada@example.com")).toBe(false);
    } finally { fx.creds = { email: "ada@example.com", password: "pw" }; await g.close(); }
  });

  it("waitForReady() waits for content that comes late", async () => {
    const g = await open({ store: tempStore() });
    try {
      await g.goto(`${fx.url}/slow.html`);
      const r = await g.waitForReady({ timeoutMs: 8000 });
      expect(r.ready).toBe(true);
      expect((await g.observe()).view).toContain('heading "Deals of the day"');
    } finally { await g.close(); }
  });

  it("tabs() gives real titles", async () => {
    const g = await open({ store: tempStore() });
    try {
      await g.goto(`${fx.url}/regress.html`);
      const r = await g.do({ action: "click", role: "link", name: "Account in a new tab" });
      expect(r.result).toMatch(/new tab →/);
      await new Promise(res => setTimeout(res, 500));
      const tabs = await g.tabs();
      // the link opened a tab and Ghostwright followed it there, as a person would
      expect(tabs[0]).toMatchObject({ title: "Your account – Fixture Shop", current: true });
      expect(tabs.some(t => t.title === "Sizes & prices – Fixture Shop")).toBe(true);
      expect(g.page.url()).toBe(`${fx.url}/account.html`);
      expect((await g.observe()).view).toContain("Your account");
    } finally { await g.close(); }
  });

  it("followNewTabs: false stays in the first tab", async () => {
    const g = await open({ store: tempStore(), followNewTabs: false });
    try {
      await g.goto(`${fx.url}/regress.html`);
      const r = await g.do({ action: "click", role: "link", name: "Account in a new tab" });
      expect(r.result).toMatch(/new tab →/);
      await new Promise(res => setTimeout(res, 500));
      const tabs = await g.tabs();
      expect(tabs[0]).toMatchObject({ title: "Sizes & prices – Fixture Shop", current: true });
      expect(g.page.url()).toBe(`${fx.url}/regress.html`);
    } finally { await g.close(); }
  });
});

describe("extract from HTML", () => {
  it("reads raw HTML and a local file without touching the page", async () => {
    const m = mockModel({ extract: (_i, page) => ({ names: lines(page).filter(l => l.role === "link").map(l => ({ name: l.name })) }) });
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/books.html`);
      const html = `<ul><li><a href="https://example.test/a">Alpha</a></li><li><a href="https://example.test/b">Beta</a></li></ul><img src="https://example.test/track.gif">`;
      const S = z.object({ names: z.array(z.object({ name: z.string() })) });
      const r = await g.extract("every link name", S, { html });
      expect(r.data.names.map(n => n.name)).toEqual(["Alpha", "Beta"]);
      expect(g.page.url()).toBe(`${fx.url}/books.html`);
      const dir = mkdtempSync(join(tmpdir(), "gw-html-"));
      writeFileSync(join(dir, "page.html"), `<a href="/x">Gamma</a>`);
      const f = await g.extract("every link name", S, { file: join(dir, "page.html") });
      expect(f.data.names).toEqual([{ name: "Gamma" }]);
      expect(g.page.context().pages().length).toBe(1);
    } finally { await g.close(); }
  });
});

describe("regression pages", () => {
  let gw: Ghostwright;
  beforeAll(async () => { gw = await open({ store: tempStore() }); });
  afterAll(async () => { await gw?.close(); });

  it("keeps one-character cells, search matches and the real title", async () => {
    await gw.goto(`${fx.url}/regress.html`);
    const v = (await gw.observe()).view;
    expect(v).toContain('row "S" | "Y" | "$69.99"');
    expect(v).toContain('row "M" | "N" | "€12,50"');
    expect(v).toContain('text "Red mug, a sturdy one"');
    expect(v).toContain('text "Blue mug with a lid"');
    expect(v.split("\n")[0]).toContain('page "Sizes & prices – Fixture Shop"');
  });

  it("says when the whole page or its end is in view, so nobody scrolls for more", async () => {
    await gw.goto(`${fx.url}/regress.html`);
    const short = (await gw.observe()).view;
    expect(short.split("\n")[0]).toContain("(whole page in view)");
    expect(short).not.toContain("below the fold");
    await gw.goto(`${fx.url}/tall.html`);
    const top = (await gw.observe()).view;
    expect(top).toContain("below the fold");
    expect(top.split("\n")[0]).not.toMatch(/in view\)/);
    await gw.do({ action: "scroll", to: "bottom" });
    const end = (await gw.observe()).view;
    expect(end.split("\n")[0]).toContain("(end of page in view)");
    expect(end).not.toContain("below the fold");
  });

  it("reports script errors with their message", async () => {
    await gw.goto(`${fx.url}/regress.html`);
    const r = await gw.do({ action: "click", role: "button", name: "Break it" });
    expect(r.result).toMatch(/errors: 1 \(first: "TypeError: boom-4711 cannot read the cart"\)/);
  });

  it("keeps decimals in prices", async () => {
    const m = mockModel({ extract: () => ({ prices: [{ size: "S", price: "$69.99" }, { size: "M", price: "€12,50" }, { size: "L", price: "1.234,56 kr" }] }) });
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/regress.html`);
      const r = await g.extract("prices", z.object({ prices: z.array(z.object({ size: z.string(), price: z.number() })) }));
      expect(r.data.prices.map(p => p.price)).toEqual([69.99, 12.5, 1234.56]);
    } finally { await g.close(); }
  });
});
