// Real-model and live Browsa checks. Off unless asked:
//   GHOSTWRIGHT_SMOKE=1 GHOSTWRIGHT_GEMINI_KEY_FILE=~/.config/... npx vitest run test/smoke
//   GHOSTWRIGHT_LIVE_BROWSA=1 GHOSTWRIGHT_BROWSA_KEY_FILE=... (pushes one recipe, runs it once, deletes it)
// Keys are read from files here and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Ghostwright, local, secret } from "../../src/index.js";
import { Store } from "../../src/store.js";
import { PRODUCTS, startFixtures, type Fixtures } from "../server.js";
import { tempStore } from "../e2e/helpers.js";

const readKey = (env: string, def: string) => {
  const p = (process.env[env] || def).replace(/^~/, homedir());
  try { return readFileSync(p, "utf8").trim(); } catch { return ""; }
};

const smoke = process.env.GHOSTWRIGHT_SMOKE === "1";
const live = process.env.GHOSTWRIGHT_LIVE_BROWSA === "1";
const MODEL = process.env.GHOSTWRIGHT_SMOKE_MODEL || "google/gemini-3.1-flash-lite";
// an assumed price, on the high side, so the cap below is conservative
const PRICE = { input: 2, output: 12 };

describe.runIf(smoke)("real model", () => {
  let fx: Fixtures;
  let gw: Ghostwright;
  beforeAll(async () => {
    fx = await startFixtures();
    const key = readKey("GHOSTWRIGHT_GEMINI_KEY_FILE", "~/.config/browsa/gemini-key");
    gw = await Ghostwright.create({
      browser: local(), model: MODEL, modelApiKey: key, price: PRICE, store: tempStore(), maxCostUsd: 0.5,
      secrets: { email: secret(() => fx.creds.email, { origins: ["localhost"] }), password: secret(() => fx.creds.password, { origins: ["localhost"] }) },
    });
  });
  afterAll(async () => {
    if (gw) console.log("smoke usage:", JSON.stringify({ ...gw.usage(), usd: +gw.usage().usd.toFixed(5) }));
    await gw?.close();
    await fx?.close();
  });

  it("records a login + extract flow with a real model and replays it with none", async () => {
    const flow = await gw.flow("smoke-shop");
    await flow.goto(`${fx.url}/login.html`);
    expect((await flow.act("type %email% into the email field")).ok).toBe(true);
    expect((await flow.act("type %password% into the password field")).ok).toBe(true);
    expect((await flow.act("click the sign in button")).ok).toBe(true);
    expect(gw.page.url()).toContain("account.html");
    expect((await flow.act("open the products page")).ok).toBe(true);
    const ex = await flow.extract("every product: name, price, and whether it is in stock", z.object({ items: z.array(z.object({ name: z.string(), price: z.number(), inStock: z.boolean() })) }));
    expect(ex.data.items.map(i => i.name)).toEqual(PRODUCTS.map(p => p.name));
    await flow.save();
    const before = gw.usage().modelCalls;
    const run = await gw.run("smoke-shop");
    expect(run.meta.modelCalls).toBe(0);
    expect(gw.usage().modelCalls).toBe(before);
    expect((run.output as any).items.length).toBe(3);
    console.log("extract layer:", ex.meta.layer);
  });

  it("checks a statement with cited words, and an agent cites what it saw", async () => {
    await gw.goto(`${fx.url}/checkout.html`);
    expect((await gw.check("the cart holds 1 item")).ok).toBe(true);
    const no = await gw.check("the cart holds 5 items");
    expect(no.ok).toBe(false);
    await gw.goto(`${fx.url}/books.html`);
    const r = await gw.agent("Who wrote Neuromancer? Answer with the author's name.", { maxSteps: 4 });
    console.log("agent:", JSON.stringify({ status: r.status, success: r.success, answer: r.answer, cited: r.evidence.cited }));
    expect(r.status).toBe("done");
    expect(String(r.answer)).toMatch(/William Gibson/);
    expect(r.success).toBe(true);
    expect(r.evidence.cited?.found).toBe(true);
  });

  it("refuses a purchase the model asks for", async () => {
    await gw.goto(`${fx.url}/checkout.html`);
    const r = await gw.act("click place your order");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/purchase_blocked/);
    expect(await gw.page.textContent("#status")).toBe("Not ordered");
  });

  it("the CLI extract playground prints JSON and usage", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    const file = fileURLToPath(new URL("../fixtures/team.html", import.meta.url));
    const key = readKey("GHOSTWRIGHT_GEMINI_KEY_FILE", "~/.config/browsa/gemini-key");
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "extract", file, "every team member's name", "--store", tempStore()], {
      encoding: "utf8", timeout: 120000, env: { ...process.env, GHOSTWRIGHT_MODEL: MODEL, GOOGLE_GENERATIVE_AI_API_KEY: key },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Grace Hopper/);
    expect(r.stderr).toMatch(/1 model call, \d+ tokens in/);
  });

  it("picks from a custom dropdown and acts in a cross-site frame", async () => {
    await gw.goto(`${fx.url}/dropdown.html`);
    expect((await gw.act("set the shipping speed to Express")).ok).toBe(true);
    expect(await gw.page.textContent("#summary")).toContain("express");
    await gw.goto(`${fx.url}/frames.html`);
    expect((await gw.act("type 'Ada L' as the name on card in the payment frame")).ok).toBe(true);
    expect((await gw.act("click Use this card")).ok).toBe(true);
    expect(await gw.page.textContent("#status")).toBe("Paid by Ada L");
  });
});

describe.runIf(live)("Browsa cloud, live", () => {
  it("runs the same recipe file locally and on Browsa, then deletes it", async () => {
    const apiKey = readKey("GHOSTWRIGHT_BROWSA_KEY_FILE", "");
    expect(apiKey.startsWith("agt_")).toBe(true);
    const dir = tempStore();
    // a tiny flow: the book titles on page 1
    new Store(dir).promote({
      name: "gw-smoke-books", version: 1,
      params: { type: "object", properties: {} },
      output: { type: "object", properties: { titles: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } } }, required: ["titles"] },
      start_url: "https://books.toscrape.com/",
      steps: [
        { id: "s1", kind: "navigate", url: "https://books.toscrape.com/" },
        { id: "s2", kind: "extract", from: "page", how: { css: "article.product_pod h3 a", fields: { title: ".@title" }, into: "titles" }, schema_ref: "output" },
      ],
      assertions: [{ after: "s2", expr: "output.titles.length >= 1" }],
      repair: { mode: "off" },
    });
    const gw = await Ghostwright.create({ browser: local(), store: dir, browsaApiKey: apiKey });
    try {
      const localRun = await gw.run("gw-smoke-books");
      expect((localRun.output as any).titles.length).toBe(20);
      const pushed = await gw.push("gw-smoke-books");
      expect(pushed.priceCredits).toBeLessThanOrEqual(10);
      const cloud = await gw.runOnBrowsa("gw-smoke-books", {}, { timeoutMs: 240000 });
      console.log("browsa run:", JSON.stringify({ status: cloud.status, credits: cloud.credits, ms: cloud.durationMs, error: cloud.errorCode, titles: (cloud.output as any)?.titles?.length }));
      expect(cloud.status).toBe("ok");
      expect((cloud.output as any).titles).toEqual((localRun.output as any).titles);
    } finally {
      await (gw as any).cloud().unpush("gw-smoke-books").catch((e: Error) => console.log("cleanup failed:", e.message));
      await gw.close();
    }
  });
});
