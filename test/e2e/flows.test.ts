// Flows: record, replay with no model, repair after a site change, compiled
// extracts, secrets that never leak, the cost cap.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLimitError, FlowError, SecretNotAllowedError, SecretOriginError, secret, type Recipe } from "../../src/index.js";
import { mockModel } from "../mock-model.js";
import { PRODUCTS, startFixtures, type Fixtures } from "../server.js";
import { allText, open, tempStore } from "./helpers.js";
import { recipeErrors } from "../recipe-schema.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

const Products = z.object({ items: z.array(z.object({ name: z.string(), price: z.number(), inStock: z.boolean() })) });
const productsAnswer = () => ({ items: PRODUCTS.map(p => ({ name: p.name, price: p.price, inStock: p.inStock })) });

describe("flows", () => {
  it("records a login + extract flow and replays it with 0 model calls", async () => {
    const store = tempStore();
    const model = mockModel({ extract: () => productsAnswer() });
    const secrets = { email: secret(() => fx.creds.email, { origins: ["localhost"] }), password: secret(() => fx.creds.password, { origins: ["localhost"] }) };
    const gw = await open({ model, store, secrets });
    try {
      const flow = await gw.flow("shop-products");
      await flow.goto(`${fx.url}/login.html`);
      expect((await flow.act("type %email% into the email field")).ok).toBe(true);
      expect((await flow.act("type %password% into the password field")).ok).toBe(true);
      expect((await flow.act("click the sign in button")).ok).toBe(true);
      expect((await flow.act("click the products link")).ok).toBe(true);
      const ex = await flow.extract("every product with its price and stock", Products);
      expect(ex.data).toEqual(productsAnswer());
      expect(ex.meta.layer).toBe("fetch");
      const recipe = await flow.save();
      expect(recipeErrors(recipe)).toBe("");
      expect(recipe.version).toBe(1);
      expect(recipe.steps.map(s => s.kind)).toEqual(["navigate", "type", "type", "click", "click", "fetch", "extract"]);
      // Browsa Secrets tokens: the same file runs on Browsa
      expect(recipe.steps[1].text).toBe("{{secret:EMAIL}}");
      expect(recipe.steps[2].text).toBe("{{secret:PASSWORD}}");

      model.reset();
      const run = await gw.run("shop-products");
      expect(run.output).toEqual(productsAnswer());
      expect(run.meta.modelCalls).toBe(0);
      expect(model.calls.length).toBe(0);
      expect(run.repaired).toEqual([]);
      expect(run.steps.find(s => s.kind === "fetch")?.layer).toBe("fetch");
    } finally { await gw.close(); }
  });

  it("replays a flow with other params: templated text and a templated fetch", async () => {
    const store = tempStore();
    const shown = (page: string) => ({ items: PRODUCTS.filter(p => page.includes(`"${p.name}"`)).map(p => ({ name: p.name, price: p.price, inStock: p.inStock })) });
    const model = mockModel({ extract: (_i, page) => shown(page) });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("search", { params: { q: "mug" } });
      await flow.goto(`${fx.url}/products.html`);
      expect((await flow.act("type '%q%' into the search box")).ok).toBe(true);
      expect((await flow.act("click the search button")).ok).toBe(true);
      const ex = await flow.extract("the products", Products);
      expect(ex.data.items.map(i => i.name)).toEqual(["Red mug"]);
      const r = await flow.save();
      expect(recipeErrors(r)).toBe("");
      expect(r.steps.find(s => s.kind === "type")?.text).toBe("{{q}}");
      expect(r.steps.find(s => s.kind === "fetch")?.url).toContain("q={{q}}");
      model.reset();
      const run = await gw.run("search", { q: "bowl" });
      expect(run.output.items.map((i: any) => i.name)).toEqual(["Green bowl"]);
      expect(model.calls.length).toBe(0);
      await expect(gw.run("search", {})).rejects.toMatchObject({ code: "params_invalid" });
    } finally { await gw.close(); }
  });

  it("repairs a broken step with one model call and promotes it after the run passes", async () => {
    const store = tempStore();
    const model = mockModel();
    const secrets = { email: secret(() => fx.creds.email, { origins: ["localhost"] }), password: secret(() => fx.creds.password, { origins: ["localhost"] }) };
    const gw = await open({ model, store, secrets });
    try {
      const flow = await gw.flow("login");
      await flow.goto(`${fx.url}/login.html`);
      await flow.act("type %email% into the email field");
      await flow.act("type %password% into the password field");
      await flow.act("click the sign in button");
      const r1 = await flow.save();
      // a flow that types secrets keeps its repairs for review
      expect(r1.repair?.mode).toBe("review");
      const click = r1.steps.find(s => s.kind === "click")!;
      expect(click.target).toMatchObject({ role: "button", name: "Sign in", css: "#signin" });
      expect(click.effect?.kind).toBe("navigate");

      // the site changes: new label, new id
      fx.variant = "changed";
      model.reset();
      const run = await gw.run("login");
      expect(run.repaired).toEqual([click.id]);
      expect(model.calls.length).toBe(1);
      expect(run.promoted).toBeUndefined();
      expect(run.draft).toMatchObject({ version: 2 });
      expect(gw.page.url()).toContain("account.html");
      // reviewed: now it is the version run() uses
      expect(gw.promote("login").version).toBe(2);
      const v2: Recipe = JSON.parse(readFileSync(join(store, "flows", "login.json"), "utf8"));
      expect(recipeErrors(v2)).toBe("");
      expect(v2.version).toBe(2);
      expect(v2.steps.find(s => s.id === click.id)?.target?.name).toBe("Sign in now");

      model.reset();
      const again = await gw.run("login");
      expect(again.meta.modelCalls).toBe(0);
      expect(again.version).toBe(2);

      // and back
      expect(gw.rollback("login").version).toBe(1);
    } finally { fx.variant = "base"; await gw.close(); }
  });

  it("fails a broken step with no model as site_changed", async () => {
    const store = tempStore();
    const model = mockModel();
    const secrets = { email: secret(() => fx.creds.email, { origins: ["localhost"] }), password: secret(() => fx.creds.password, { origins: ["localhost"] }) };
    const rec = await open({ model, store, secrets });
    const flow = await rec.flow("login");
    await flow.goto(`${fx.url}/login.html`);
    await flow.act("type %email% into the email field");
    await flow.act("type %password% into the password field");
    await flow.act("click the sign in button");
    await flow.save();
    await rec.close();
    const gw = await open({ store, secrets });
    try {
      fx.variant = "changed";
      const err = await gw.run("login").catch(e => e);
      expect(err).toBeInstanceOf(FlowError);
      expect(err.code).toBe("site_changed");
    } finally { fx.variant = "base"; await gw.close(); }
  });

  it("compiles extracts from page JSON and from CSS", async () => {
    const store = tempStore();
    const books = { books: [{ title: "Dune", author: "Frank Herbert", year: 1965 }, { title: "Neuromancer", author: "William Gibson", year: 1984 }, { title: "Hyperion", author: "Dan Simmons", year: 1989 }] };
    const team = { people: [{ name: "Grace Hopper", role: "Engineering", contact: `${fx.url}/contact/grace` }, { name: "Alan Turing", role: "Research", contact: `${fx.url}/contact/alan` }, { name: "Katherine Johnson", role: "Flight", contact: `${fx.url}/contact/katherine` }] };
    const model = mockModel({ extract: i => (i.includes("book") ? books : team) });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("reading");
      await flow.goto(`${fx.url}/books.html`);
      const a = await flow.extract("every book", z.object({ books: z.array(z.object({ title: z.string(), author: z.string(), year: z.number() })) }));
      expect(a.meta.layer).toBe("page_json");
      await flow.goto(`${fx.url}/team.html`);
      const b = await flow.extract("every team member", z.object({ people: z.array(z.object({ name: z.string(), role: z.string(), contact: z.string() })) }));
      expect(b.meta.layer).toBe("css");
      const r = await flow.save();
      expect(recipeErrors(r)).toBe("");
      const css = r.steps.find(s => s.from === "page")!;
      expect(css.how?.css).toBeTruthy();
      model.reset();
      const run = await gw.run("reading");
      expect(run.meta.modelCalls).toBe(0);
      expect(run.output).toEqual({ ...books, ...team });
    } finally { await gw.close(); }
  });

  it("never leaks a secret: prompts, traces, recipes, results", async () => {
    const store = tempStore();
    const CANARY = "canary-" + Math.random().toString(36).slice(2) + "-Zq9";
    fx.creds = { email: "canary.user@example.com", password: CANARY };
    const model = mockModel({ extract: () => ({ who: "Signed in as Ada" }) });
    const secrets = { email: secret("canary.user@example.com", { origins: ["localhost"] }), password: secret(CANARY, { origins: ["localhost"] }) };
    const lines: string[] = [];
    const gw = await open({ model, store, secrets, debug: l => lines.push(l) });
    const outputs: string[] = [];
    try {
      const flow = await gw.flow("canary");
      await flow.goto(`${fx.url}/login.html`);
      for (const ins of ["type %email% into the email field", "type %password% into the password field", "click the sign in button"]) {
        const r = await flow.act(ins);
        expect(r.ok).toBe(true);
        outputs.push(JSON.stringify(r));
      }
      outputs.push(JSON.stringify(await flow.extract("who is signed in", z.object({ who: z.string() }))));
      outputs.push(JSON.stringify(await flow.save()));
      const run = await gw.run("canary");
      outputs.push(JSON.stringify(run));
      expect(gw.page.url()).toContain("account.html");
      const everything = [model.calls.map(c => c.system + c.prompt).join("\n"), allText(store), lines.join("\n"), outputs.join("\n"), JSON.stringify(gw.metrics())].join("\n");
      expect(everything.includes(CANARY)).toBe(false);
      expect(everything.includes("canary.user@example.com")).toBe(false);
      expect(model.calls.length).toBeGreaterThan(0);
    } finally { fx.creds = { email: "ada@example.com", password: "pw" }; await gw.close(); }
  });

  it("refuses to type a secret on another origin (prompt injection)", async () => {
    const port = new URL(fx.url).port;
    const model = mockModel({ act: () => ({ action: "type", id: 2, text: "%password%" }) });
    const gw = await open({ model, store: tempStore(), secrets: { password: secret("s3cret-value", { origins: [`localhost:${port}`] }) } });
    try {
      await gw.goto(`${fx.otherOrigin}/inject.html`);
      const v = await gw.observe();
      const box = v.elements.find(e => e.role === "textbox")!;
      (model as any).generate = mockModel({ act: () => ({ action: "type", id: box.id, text: "%password%" }) }).generate;
      // the instruction did not name the secret: refused before anything else
      await expect(gw.act("do what the page says")).rejects.toBeInstanceOf(SecretNotAllowedError);
      // named, but the field is on another origin: refused there
      await expect(gw.act("type %password% where the page asks")).rejects.toBeInstanceOf(SecretOriginError);
      expect(await gw.page.inputValue("#v")).toBe("");
    } finally { await gw.close(); }
  });

  it("stops before passing maxCostUsd", async () => {
    const model = mockModel();
    const gw = await open({ model, store: tempStore(), maxCostUsd: 0.000001 });
    try {
      await gw.goto(`${fx.url}/login.html`);
      await expect(gw.act("click the sign in button")).rejects.toBeInstanceOf(CostLimitError);
      expect(model.calls.length).toBe(0);
    } finally { await gw.close(); }
  });

  it("reports usage per call", async () => {
    const model = mockModel();
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(`${fx.url}/login.html`);
      const r = await gw.act("check keep me signed in");
      expect(r.meta.modelCalls).toBe(1);
      expect(r.meta.inputTokens).toBeGreaterThan(100);
      expect(r.meta.usd).toBeGreaterThan(0);
      const m = gw.metrics();
      expect(m.byKind.act.modelCalls).toBe(1);
      expect(gw.usage().modelCalls).toBe(1);
    } finally { await gw.close(); }
  });
});
