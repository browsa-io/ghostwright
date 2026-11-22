import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readJSON } from "../../src/compile.js";
import { CostLimitError, SecretOriginError } from "../../src/errors.js";
import { checkEffect, toStep } from "../../src/ghostwright.js";
import { ASSUMED_PRICE, livePrice, parseJSON, priceFor, resolveModel } from "../../src/model/index.js";
import { evaluate, jsonpath, paramsSchema, pathMatches, recipeName, render, templatize, templatizePath, type Recipe } from "../../src/recipe.js";
import { coerce, sameJSON, toSchema, validate } from "../../src/schema.js";
import { browsaSecret, env, fill, placeholders, secret, Secrets, totpCode } from "../../src/secrets.js";
import { Meter } from "../../src/usage.js";
import { BrowsaCloud, secretNamesIn } from "../../src/cloud.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipeErrors } from "../recipe-schema.js";
import type { ActResult } from "../../src/engine/session.js";

describe("recipe helpers", () => {
  it("names, renders and templates", () => {
    expect(recipeName("My Invoices!")).toBe("my-invoices");
    expect(render("https://x/s?q={{q}}&j={{json:q}}", { q: "mug" })).toBe('https://x/s?q=mug&j="mug"');
    expect(templatize("https://x/s?q=red%20mug", { q: "red mug" })).toBe("https://x/s?q={{q}}");
    expect(paramsSchema({ q: "x", n: 2 })).toEqual({ type: "object", properties: { q: { type: "string" }, n: { type: "number" } }, required: ["q", "n"] });
  });
  it("reads a JSONPath subset", () => {
    const d = { data: { items: [{ a: 1, b: { c: "x" } }, { a: 2, b: { c: "y" } }] } };
    expect(jsonpath("$.data.items[*].a", d)).toEqual([1, 2]);
    expect(jsonpath("$.data.items[1].b.c", d)).toBe("y");
    expect(jsonpath("$['data']['items'][0]['a']", d)).toBe(1);
    expect(readJSON(d, { jsonpath: "$.data.items[*]", fields: { a: "$.a", c: "$.b.c" }, limit: 1 })).toEqual([{ a: 1, c: "x" }]);
  });
  it("evaluates assertions and refuses anything else", () => {
    const scope = { output: { items: [{ price: 3 }] }, params: {}, saved: {} };
    expect(evaluate("output.items.length >= 1 && output.items[0].price > 0", scope)).toBe(true);
    expect(evaluate("output.missing === null || !output.missing", scope)).toBe(true);
    expect(() => evaluate("output.constructor.constructor('x')()", scope)).toThrow();
    expect(() => evaluate("process.exit()", scope)).toThrow();
    expect(() => evaluate("output.__proto__", scope)).toThrow();
  });
});

describe("schemas", () => {
  it("validates, coerces and compares", async () => {
    const s = { type: "object", properties: { n: { type: "number" }, ok: { type: "boolean" } }, required: ["n"] };
    expect(validate(s, { n: "1" })).toMatch(/expected number/);
    expect(coerce(s, { n: "$1,234.50", ok: "yes" })).toEqual({ n: 1234.5, ok: true });
    expect(sameJSON({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    const zs = await toSchema(z.object({ items: z.array(z.object({ t: z.string() })) }));
    expect(zs.json.properties.items.type).toBe("array");
    expect(zs.check({ items: [{ t: 1 }] }).ok).toBe(false);
  });
  it("finds JSON in a chatty answer", () => {
    expect(parseJSON('Sure!\n```json\n{"action":"click","id":3}\n```')).toEqual({ action: "click", id: 3 });
    expect(parseJSON('noise {"a": "}"} tail')).toEqual({ a: "}" });
  });
});

describe("secrets", () => {
  it("fills placeholders only on allowed origins and scrubs values", async () => {
    const s = new Secrets({ pw: secret("hunter2-xyz", { origins: ["app.example.com"] }), tok: secret("t0ken-abc", { origins: ["*.example.com"] }) });
    const f = await fill("%user% / %pw%", { user: "ada" }, s, "https://app.example.com/login");
    expect(f.value).toBe("ada / hunter2-xyz");
    expect(f.recipe).toBe("{{user}} / {{secret:PW}}");
    await expect(fill("%pw%", {}, s, "https://evil.test/")).rejects.toThrow(SecretOriginError);
    expect((await fill("%tok%", {}, s, "https://api.example.com/")).value).toBe("t0ken-abc");
    expect(s.scrub('value "hunter2-xyz" and t0ken-abc')).toBe('value "%pw%" and %tok%');
    expect(placeholders("type %a% and %b%")).toEqual(["a", "b"]);
  });
  it("reads a callback secret only when typed, on its origins, and masks it after", async () => {
    let calls = 0;
    const s = new Secrets({ otp: secret(async () => { calls++; return "cb-value-778"; }, { origins: ["app.example.com"] }) });
    expect(calls).toBe(0);
    expect(s.scrub("cb-value-778")).toBe("cb-value-778"); // not known before it is read
    await expect(s.valueFor("otp", "https://evil.test/")).rejects.toThrow(SecretOriginError);
    expect(calls).toBe(0); // the origin is checked before the value is read
    expect(await s.valueFor("otp", "https://app.example.com/")).toBe("cb-value-778");
    expect(calls).toBe(1);
    expect(s.scrub("x cb-value-778 y")).toBe("x %otp% y");
    const empty = new Secrets({ e: secret(async () => "", { origins: ["app.example.com"] }) });
    await expect(empty.valueFor("e", "https://app.example.com/")).rejects.toThrow(/no value/);
  });
  it("needs origins", () => {
    expect(() => env("X", { origins: [] })).toThrow();
  });
  it("records Browsa Secrets tokens and maps them back for local runs", async () => {
    process.env.GW_TEST_APP_PASSWORD = "pa55-word-local";
    const s = new Secrets({
      email: env("APP_EMAIL", { origins: ["app.example.com"] }),
      pw: browsaSecret("APP_LOGIN", { field: "password", local: env("GW_TEST_APP_PASSWORD", { origins: ["app.example.com"] }) }),
      code: browsaSecret("APP_TOTP", { totp: true, local: secret("JBSWY3DPEHPK3PXP", { origins: ["app.example.com"] }) }),
      gh: browsaSecret("GITHUB_LOGIN", { field: "password" }),
    });
    expect(s.tokenOf("email")).toBe("{{secret:APP_EMAIL}}");
    expect(s.tokenOf("pw")).toBe("{{secret:APP_LOGIN:password}}");
    expect(s.tokenOf("code")).toBe("{{totp:APP_TOTP}}");
    expect(s.nameOfToken("secret", "APP_LOGIN", "password")).toBe("pw");
    expect(s.nameOfToken("totp", "APP_TOTP")).toBe("code");
    expect(await s.valueFor("pw", "https://app.example.com/")).toBe("pa55-word-local");
    expect(await s.valueFor("code", "https://app.example.com/")).toMatch(/^\d{6}$/);
    // a value kept only in Browsa Secrets is never available here
    await expect(s.valueFor("gh", "https://github.com/")).rejects.toThrow(/never leaves Browsa/);
    expect(s.scrub("x pa55-word-local y")).toBe("x %pw% y");
    expect(() => new Secrets({ a: browsaSecret("SAME"), b: browsaSecret("SAME") })).toThrow(/same Browsa secret/);
    expect(() => browsaSecret("bad-name")).toThrow();
  });
  it("makes RFC 6238 codes", () => {
    // RFC 6238 vector: seed "12345678901234567890" (base32 below), t = 59 s -> 94287082; 6 digits: 287082
    expect(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });
});

describe("models and cost", () => {
  it("knows current prices, with dots or dashes, through OpenRouter ids and dated ids", () => {
    expect(priceFor("anthropic/claude-opus-5-5")).toEqual({ input: 4, output: 20, cachedInput: 0.2 });
    expect(priceFor("anthropic/claude-opus-5.5")?.input).toBe(4);
    expect(priceFor("openrouter/google/gemini-3.1-flash-lite")?.output).toBe(1.5);
    expect(priceFor("openai/gpt-5.6-luna-2026-10-01")?.input).toBe(0.2);
    expect(priceFor("anthropic/claude-fable-5-2")?.output).toBe(40);
    expect(priceFor("google/gemini-3.8-flash")?.input).toBe(0.825);
    expect(priceFor("deepseek/deepseek-v4.1-flash")?.input).toBe(0.3);
    expect(priceFor("openai/gpt-4.1-mini")?.input).toBe(0.4);
    expect(priceFor("acme/unknown-model")).toBeUndefined();
  });
  it("looks a missing model up in the live catalog, caches it, and says where a price came from", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-prices-"));
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ data: [{ id: "openai/gpt-9-new", pricing: { prompt: "0.000001", completion: "0.000004", input_cache_read: "0.0000001" } }] })); }) as unknown as typeof fetch;
    expect(await livePrice("openai/gpt-9-new", dir, f)).toEqual({ input: 1, output: 4, cachedInput: 0.1 });
    expect(await livePrice("openrouter/openai/gpt-9-new", dir, f)).toEqual({ input: 1, output: 4, cachedInput: 0.1 });
    expect(calls).toBe(1);
    const m = await resolveModel({ languageModel: {}, id: "openai/gpt-9-new" }, { cacheDir: dir, fetch: f });
    expect(m.priceSource).toBe("live");
    const t = await resolveModel({ languageModel: {}, id: "anthropic/claude-sonnet-5.5" }, { cacheDir: dir, fetch: f });
    expect(t.priceSource).toBe("table");
    const off = await resolveModel({ languageModel: {}, id: "openai/gpt-9-new" }, { livePrices: false });
    expect(off.priceSource).toBe("unknown");
    const down = await livePrice("openai/gpt-9-new", undefined, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(down).toBeUndefined();
  });
  it("counts an unknown price at the assumed rate instead of refusing", async () => {
    const m = await resolveModel({ id: "local/llama", generate: async () => "{}" });
    expect(m.priceSource).toBe("unknown");
    const meter = new Meter(1);
    meter.before(m, "x".repeat(4000));
    const r = meter.record("act", m, { inputTokens: 100000, outputTokens: 1000 }, "", "", 3);
    expect(r.priceAssumed).toBe(true);
    expect(r.usd).toBeCloseTo((100000 * ASSUMED_PRICE.input + 1000 * ASSUMED_PRICE.output) / 1e6);
    expect(meter.total.usdAssumed).toBeCloseTo(r.usd);
    expect(() => meter.before(m, "x".repeat(400000))).toThrow(CostLimitError);
  });
  it("refuses calls past the cap", async () => {
    const m = await resolveModel({ id: "x/y", price: { input: 1000, output: 1000 }, generate: async () => "{}" });
    const meter = new Meter(0.01);
    expect(() => meter.before(m, "x".repeat(400))).toThrow(CostLimitError);
    const r = meter.record("act", m, { inputTokens: 10, outputTokens: 5 }, "", "", 3);
    expect(r.usd).toBeCloseTo(0.015);
  });
});

const ok = (o: Partial<ActResult>): ActResult => ({ action: "x", status: "ok", changes: [], newTabs: [], downloads: [], errors: [], errorCount: 0, failedRequests: [], settle: { quietAfterMs: 0, waitedMs: 1, capHit: false, requests: [], requestCount: 0 }, text: "", ...o });

describe("post-action check", () => {
  it("fails a click that changed nothing and a field that did not take the text", () => {
    expect(checkEffect({ action: "click", id: 1 }, ok({ noChange: true }), null).ok).toBe(false);
    expect(checkEffect({ action: "click", id: 1 }, ok({ changes: [{ op: "added", kind: "text", role: "text", text: "+" }] }), null).effect.kind).toBe("change");
    expect(checkEffect({ action: "type", id: 2, text: "a" }, ok({ noChange: true }), null).ok).toBe(false);
    expect(checkEffect({ action: "type", id: 2, text: "a" }, ok({ changes: [{ op: "changed", id: 2, kind: "element", role: "textbox", fields: { value: "a" }, text: "~" }] }), null).ok).toBe(true);
    expect(checkEffect({ action: "click", id: 1 }, ok({ changes: [{ op: "added", kind: "text", role: "text", text: "+" }] }), { kind: "navigate" }).ok).toBe(false);
  });
});

describe("Browsa recipe schema", () => {
  const steps = [
    { id: "s1", kind: "navigate" as const, url: "https://shop.test/search?q={{q}}" },
    { ...toStep({ action: "type", id: 1, text: "x" }, { role: "textbox", name: "Email", css: "#email" }, "{{secret:APP_LOGIN:username}}", { kind: "value" }, "type %email%", {}, "https://shop.test")!, id: "s2" },
    { ...toStep({ action: "check", id: 2 }, { role: "checkbox", name: "Remember", xpath: "/html[1]/body[1]/input[1]" }, undefined, { kind: "change" }, "check remember", {}, "")!, id: "s3" },
    { ...toStep({ action: "hover", id: 3 }, { role: "button", name: "Menu" }, undefined, { kind: "none" }, "hover menu", {}, "")!, id: "s4" },
    { ...toStep({ action: "scroll", dy: 600 }, null, undefined, { kind: "none" }, "scroll", {}, "")!, id: "s5" },
    { id: "s6-f", kind: "fetch" as const, in_page: true as const, method: "GET" as const, url: "https://shop.test/api?q={{q}}", save_as: "data_s6", mutation: false },
    { id: "s6", kind: "extract" as const, from: "saved" as const, source: "data_s6", how: { jsonpath: "$.items[*]", fields: { name: "$.name" }, into: "items" }, schema_ref: "output" as const },
    { id: "s7", kind: "extract" as const, from: "page" as const, how: { model: true }, schema_ref: "output" as const, goal: "the total", output_schema: { type: "object" } },
  ];
  const recipe: Recipe = {
    name: "shop", version: 1, params: paramsSchema({ q: "mug" }),
    output: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
    start_url: "https://shop.test/", steps, assertions: [{ after: "s6", expr: "output.items.length >= 1" }], repair: { mode: "auto", max_steps: 3 }, meta: { secrets: ["email"] },
  };
  it("saved recipes match Browsa's recipe v1 schema", () => {
    expect(recipeErrors(recipe)).toBe("");
    expect(recipeErrors({ ...recipe, extra: 1 })).not.toBe("");
  });
  it("pushes secret tokens by Browsa name, never values", () => {
    const b = BrowsaCloud.toBrowsa(recipe);
    expect(b.steps[1].text).toBe("{{secret:APP_LOGIN:username}}");
    expect(secretNamesIn(b)).toEqual(["APP_LOGIN"]);
    expect(recipeErrors(b)).toBe("");
    // a token written with a local name maps to the secret's Browsa name
    const s = new Secrets({ email: env("APP_EMAIL", { origins: ["shop.test"] }), pin: secret("4242-xyz", { origins: ["shop.test"] }) });
    const legacy = { ...recipe, steps: recipe.steps.map(x => (x.id === "s2" ? { ...x, text: "{{secret:email}}" } : x)) };
    expect(BrowsaCloud.toBrowsa(legacy, s).steps[1].text).toBe("{{secret:APP_EMAIL}}");
    // a token outside a type step, an unmappable name, or a value: refused
    const inUrl = { ...recipe, steps: recipe.steps.map(x => (x.id === "s1" ? { ...x, url: "https://x/?t={{secret:APP_EMAIL}}" } : x)) };
    expect(() => BrowsaCloud.toBrowsa(inUrl)).toThrow(/only in type steps/);
    expect(() => BrowsaCloud.toBrowsa(legacy)).toThrow(/no Browsa Secrets name/);
    const leaky = { ...recipe, steps: recipe.steps.map(x => (x.id === "s7" ? { ...x, goal: "type 4242-xyz" } : x)) };
    expect(() => BrowsaCloud.toBrowsa(leaky, s)).toThrow(/holds a secret value/);
  });
  it("vendored schema is Browsa's", () => {
    const mono = new URL("../../../../services/replay/recipe.schema.json", import.meta.url);
    if (!existsSync(mono)) return;
    // the one addition: target.within, which only local replays read (a push leaves it out)
    const own = readFileSync(new URL("../../schema/recipe-v1.json", import.meta.url), "utf8").split("\n").filter(l => !/^\s*"within":/.test(l)).join("\n");
    expect(own).toBe(readFileSync(mono, "utf8"));
  });
  it("a push leaves out what only local replays read", () => {
    const r = { recipe_version: 1, name: "x", version: 1, output: { type: "object" }, steps: [{ id: "s1", kind: "click", target: { role: "button", name: "Compare", within: "Model A" } }, { id: "s2", kind: "wait", for: { target: { css: "#a", within: "Row 2" } } }] } as any;
    const body = BrowsaCloud.toBrowsa(r);
    expect(JSON.stringify(body)).not.toContain("within");
    expect(r.steps[0].target.within).toBe("Model A");
    expect(body.steps[0].target).toEqual({ role: "button", name: "Compare" });
  });
});

describe("B2 recorded paths", () => {
  it("templates a param in a path and matches it with the next value", () => {
    const p = templatizePath("/catalogue/category/books/travel_2/index.html", { category: "Travel" });
    expect(p).toBe("/catalogue/category/books/{{category}}_2/index.html");
    expect(pathMatches(p, "/catalogue/category/books/mystery_3/index.html", { category: "Mystery" })).toBe(true);
    expect(pathMatches(p, "/catalogue/category/books/travel_2/index.html", { category: "Mystery" })).toBe(false);
    expect(pathMatches("/item/123", "/item/456", {})).toBe(true);
    expect(pathMatches("/account.html", "/help.html", {})).toBe(false);
    expect(pathMatches("/p/blue-mug", "/p/red-lamp", {}, true)).toBe(true);
    expect(pathMatches("/p/blue-mug", "/x/red-lamp", {}, true)).toBe(false);
  });
});
