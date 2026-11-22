// Regression tests for the security review (ported from its harness).
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sameService, secureBase } from "../../src/browser.js";
import { BrowsaCloud } from "../../src/cloud.js";
import { stripTokens } from "../../src/compile.js";
import { controlBuys, purchaseReason } from "../../src/guard.js";
import { Ghostwright } from "../../src/index.js";
import { livePrice, priceFor, resolveModel } from "../../src/model/index.js";
import { originAllowed, secret, Secrets } from "../../src/secrets.js";
import { Store } from "../../src/store.js";
import { Meter } from "../../src/usage.js";

describe("H1 scrubbing", () => {
  const v = "Cx9!canary pw+&=/@Zq#";
  const s = new Secrets({ pw: secret(v, { origins: ["example.com"] }) });
  it("catches every form a value takes when it leaks", () => {
    for (const leak of [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), v.toUpperCase(), v.toLowerCase(), v.slice(0, 16), v.slice(3, 15)]) {
      expect(s.scrub(`x ${leak} y`), leak).not.toContain(leak);
      expect(s.leaks(`x ${leak} y`)).toBe(true);
    }
    expect(s.scrub("q=" + new URLSearchParams({ q: v }).toString().slice(2))).toBe("q=%pw%");
    expect(s.scrub("nothing here")).toBe("nothing here");
  });
  it("B1: leaves tokens, placeholders and words that are only parts of the value", () => {
    const p = new Secrets({ password: secret("SuperSecretPassword!", { origins: ["example.com"] }) });
    for (const t of ["{{secret:PASSWORD}}", "%password%", "#password", "Password", "Your password is invalid!", "type %password% into the password field"]) expect(p.scrub(t)).toBe(t);
    expect(p.scrub("pw: SuperSecretPassword! / supersecretpassword! / SuperSecretPa")).toBe("pw: %password% / %password% / %password%");
    // a value wrapped to look like a placeholder is still caught
    const q = new Secrets({ k: secret("hunter2hunter2", { origins: ["example.com"] }) });
    expect(q.scrub("%hunter2hunter2% {{hunter2hunter2}}")).not.toContain("hunter2hunter2");
    // a recipe keeps its structure; a locator holding a value is dropped, other text with one is refused
    const r = p.safeRecipe({ steps: [{ id: "s1", kind: "type", text: "{{secret:PASSWORD}}", goal: "type %password%", target: { css: "#password", name: "Password", text: "SuperSecretPassword!" } }] });
    expect(r.steps[0]).toEqual({ id: "s1", kind: "type", text: "{{secret:PASSWORD}}", goal: "type %password%", target: { css: "#password", name: "Password" } });
    expect(() => p.safeRecipe({ steps: [{ id: "s1", kind: "navigate", url: "https://example.com/?p=SuperSecretPassword!" }] })).toThrow(/secret value/);
  });
});

describe("M1 cost cap", () => {
  it("prices only dated or -latest variants of a listed model", () => {
    for (const id of ["openai/gpt-5-pro", "openai/gpt-5-codex-max", "anthropic/claude-opus-5-ultra", "google/gemini-2.5-pro-deep-think", "openai/gpt-4o-realtime-audio"]) expect(priceFor(id), id).toBeUndefined();
    expect(priceFor("openai/gpt-5.6-luna-2026-10-01")?.input).toBe(0.2);
    expect(priceFor("openai/gpt-5.6-luna-latest")?.input).toBe(0.2);
    expect(priceFor("anthropic/claude-sonnet-5-20261001")?.input).toBe(2);
  });
  it("estimates a call with its whole output limit", async () => {
    const m = await resolveModel({ id: "x/y", price: { input: 1, output: 100 }, generate: async () => "{}" });
    const meter = new Meter(0.15);
    // 2000 output tokens at $100/M is $0.20: refused before it is sent
    expect(() => meter.before(m, "x".repeat(400))).toThrow(/maxCostUsd/);
  });
  it("clamps usage to finite and not below zero", async () => {
    const m = await resolveModel({ id: "x/y", price: { input: 1, output: 1 }, generate: async () => "{}" });
    const meter = new Meter();
    meter.record("act", m, { inputTokens: -5_000_000, outputTokens: Number.NaN, cachedInputTokens: Infinity }, "x".repeat(40), "y".repeat(8), 1);
    expect(meter.total.usd).toBeGreaterThanOrEqual(0);
    expect(meter.total.inputTokens).toBe(10);
  });
  it("charges the estimate for a call that timed out", async () => {
    const slow = { id: "a/slow", price: { input: 1, output: 1 }, generate: () => new Promise<never>(() => undefined) };
    const g: any = Object.create(Ghostwright.prototype);
    const { Tracer } = await import("../../src/trace.js");
    Object.assign(g, { models: [await resolveModel(slow)], o: { modelTimeoutMs: 50 }, meter: new Meter(), secrets: new Secrets(), tracer: new Tracer(null, new Secrets(), false), lastCall: null });
    await expect(g.ask("act", "s", "p".repeat(400))).rejects.toThrow(/no answer/);
    // a timeout is retried once: both calls were sent, both count at their estimate
    expect(g.meter.total.modelCalls).toBe(2);
    expect(g.meter.calls.every((c: any) => c.estimated)).toBe(true);
    expect(g.meter.total.outputTokens).toBe(4000);
  });
  it("does not trust a price cache dated in the future", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-cache-"));
    writeFileSync(join(dir, "prices.json"), JSON.stringify({ fetched_at: "2099-01-01T00:00:00Z", prices: { "openai/brand-new-model": { input: 0, output: 0 } } }));
    const p = await livePrice("openai/brand-new-model", dir, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(p).toBeUndefined();
  });
});

describe("lows", () => {
  it("strips credential-like query parameters from compiled request URLs", () => {
    const u = stripTokens("https://shop.test/api/items?q=mug&page=2&access_token=abc&sig=xyz&apiKey=k1&t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x&x=Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3W");
    expect(u).toBe("https://shop.test/api/items?q=mug&page=2");
  });
  it("sends API keys over https only, and connects only to the Browsa domain", () => {
    expect(() => secureBase("http://browsa.example", "x")).toThrow(/https/);
    expect(secureBase("http://127.0.0.1:9", "x")).toBe("http://127.0.0.1:9");
    expect(() => new BrowsaCloud(new Store(mkdtempSync(join(tmpdir(), "gw-"))), { apiKey: "agt_x", baseUrl: "http://api.evil.test" })).toThrow(/https/);
    expect(sameService("https://cdp.browsa.io/v1/cdp/1", "https://browsa.io")).toBe(true);
    expect(sameService("https://browsa.io.evil.test/cdp", "https://browsa.io")).toBe(false);
    expect(sameService("http://cdp.browsa.io/", "https://browsa.io")).toBe(false);
  });
  it("tightens a store an older version made", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-old-"));
    const s = new Store(join(dir, ".ghostwright"));
    s.promote({ name: "f", version: 1, params: {}, output: {}, steps: [{ id: "s1", kind: "navigate", url: "https://x.test/" }] });
    chmodSync(join(dir, ".ghostwright", "flows"), 0o755);
    chmodSync(join(dir, ".ghostwright", "flows", "f.json"), 0o644);
    s.tighten();
    expect((statSync(join(dir, ".ghostwright", "flows")).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(join(dir, ".ghostwright", "flows", "f.json")).mode & 0o777).toString(8)).toBe("600");
  });
  it("finds a whole secret in a URL in any encoding, not a shared domain", () => {
    const s = new Secrets({ pw: secret("Kq8$TOCTOU-canary-77", { origins: ["x.test"] }), mail: secret("ada@example.com", { origins: ["x.test"] }) });
    expect(s.inUrl("https://x.test/search?q=" + new URLSearchParams({ a: "Kq8$TOCTOU-canary-77" }).toString().slice(2))).toBe(true);
    expect(s.inUrl("https://x.test/s?q=" + encodeURIComponent("KQ8$TOCTOU-CANARY-77"))).toBe(true);
    expect(s.inUrl("https://example.com/login?next=/home")).toBe(false);
    expect(s.inUrl("https://x.test/?u=ada%40example.com", ["mail"])).toBe(true);
    expect(s.inUrl("https://x.test/?u=ada%40example.com", ["pw"])).toBe(false);
  });
  it("writes the store for the owner only", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-modes-"));
    const s = new Store(join(dir, ".ghostwright"));
    s.promote({ name: "f", version: 1, params: {}, output: {}, steps: [{ id: "s1", kind: "navigate", url: "https://x.test/" }] });
    expect((statSync(join(dir, ".ghostwright", "flows", "f.json")).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(join(dir, ".ghostwright", "flows")).mode & 0o777).toString(8)).toBe("700");
    expect(() => s.promote({ name: "../x", version: 1, params: {}, output: {}, steps: [] })).toThrow(/bad flow name/);
    expect(() => s.saveDraft({ name: "f", version: 1.5, params: {}, output: {}, steps: [] }, "x")).toThrow(/bad flow version/);
  });
  it("caps captcha solves and solves each widget once", async () => {
    let solves = 0;
    const g: any = Object.create(Ghostwright.prototype);
    const widgets = [{ kind: "recaptcha", sitekey: "A", url: "u" }, { kind: "recaptcha", sitekey: "A", url: "u" }, { kind: "turnstile", sitekey: "B", url: "u" }, { kind: "recaptcha", sitekey: "C", url: "u" }];
    Object.assign(g, {
      o: { captcha: { solve: async () => { solves++; return "tok"; } }, maxCaptchaSolves: 5 }, captchaSeen: new Set(), captchaSolves: 0,
      session: { documentEpoch: 1, currentURL: "https://x.test/" }, emit: () => undefined,
      // the page: reading the widgets returns these; writing a token does nothing
      page: { evaluate: async (fn: unknown) => (String(fn).includes("data-sitekey") ? widgets : undefined) },
    });
    await expect(g.solveTokens("recaptcha")).rejects.toThrow(/limit/);
    expect(solves).toBe(2); // A once (it is on the page twice), B once; C is past 2 per page
    // a new page: one more is allowed, then maxCaptchaSolves
    g.session.documentEpoch = 2;
    g.o.maxCaptchaSolves = 3;
    await expect(g.solveTokens("recaptcha")).rejects.toThrow(/limit/);
    expect(solves).toBe(3);
  });
});

describe("H4 purchase guard labels", () => {
  const buys = (l: string, type = "submit") => purchaseReason([{ tag: "button", type, labels: [l], ids: [] }]);
  it("blocks orders, payments and subscriptions in many languages", () => {
    for (const l of [
      "注文を確定する", "注文を確定", "提交订单", "立即购买", "Оформить заказ", "Оплатить", "Kupuję i płacę", "Zamawiam z obowiązkiem zapłaty",
      "Order with obligation to pay", "Order now", "Donate $25", "Place bid", "Checkout", "Köp nu", "Siparişi onayla", "주문하기", "Place your order", "Pay €12,50",
    ]) expect(buys(l), l).not.toBeNull();
  });
  it("blocks subscribe, confirm, book, upgrade and trials only where money is in play", () => {
    const soft = ["Subscribe", "Confirm", "Book now", "Upgrade now", "Rent now", "Renew membership", "Get Premium", "Start your free trial", "Abonnieren"];
    for (const l of soft) {
      expect(purchaseReason([{ tag: "button", type: "submit", labels: [l], ids: [] }]), l).toBeNull();
      expect(purchaseReason([{ tag: "button", type: "submit", labels: [l], ids: [], money: true }]), l).not.toBeNull();
    }
    // a newsletter form and an appointment page: no money
    expect(controlBuys({ tag: "button", submit: true, labels: ["Subscribe"], ids: ["subscribe"] })).toBeNull();
  });
  it("lets the harmless ones through", () => {
    for (const l of ["Add to cart", "Proceed to checkout", "Buy again", "View cart", "Unsubscribe", "Sign in", "Search", "Continue"]) expect(buys(l), l).toBeNull();
    // a bare "Confirm" that is not a submit button (a dialog's) passes
    expect(controlBuys({ tag: "button", type: "button", labels: ["Confirm"], ids: [] })).toBeNull();
  });
  it("a buying label wins over a safe one on the same control", () => {
    expect(purchaseReason([{ tag: "button", type: "submit", labels: ["Place order", "Add to cart"], ids: [] }])).not.toBeNull();
  });
  it("blocks any submit of a form with card fields, and unlabelled submits of order forms", () => {
    expect(controlBuys({ tag: "button", submit: true, cardForm: true, labels: ["Continue"], ids: [] })).toBe("a form with card fields");
    expect(controlBuys({ tag: "input", type: "image", submit: true, labels: [], ids: [], action: "/order?case=img" })).toMatch(/unlabelled submit/);
    expect(controlBuys({ tag: "input", type: "image", submit: true, labels: [], ids: [], action: "/search" })).toBeNull();
    expect(controlBuys({ tag: "iframe", labels: [], ids: [], unreadableFrame: true })).toMatch(/frame from another site/);
  });
});

describe("M5 origin patterns", () => {
  const table: [string[], string, boolean][] = [
    [["example.com"], "http://example.com/login", false],
    [["example.com"], "https://example.com:8443/", false],
    [["example.com"], "https://example.com/", true],
    [["*.example.com"], "https://evil-example.com/", false],
    [["*.example.com"], "https://example.com.evil.com/", false],
    [["*.example.com"], "https://a.b.c.example.com/", true],
    [["example.com"], "https://example.com@evil.com/", false],
    [["paypal.com"], "https://pаypal.com/", false],
    [["bücher.de"], "https://bücher.de/", true],
    [["xn--bcher-kva.de"], "https://bücher.de/", true],
    [["example.com"], "https://example.com./", true],
    [["https://example.com"], "http://example.com/", false],
    [["example.com:443"], "https://example.com/", true],
    [["example.com:8443"], "https://example.com:8443/", true],
    [["http://example.com:8080"], "http://example.com:8080/", true],
    [[""], "file:///etc/passwd", false],
    [[""], "https://example.com/", false],
    [["example.com"], "blob:https://example.com/123", false],
    [["localhost"], "http://localhost:3000/", true],
    [["localhost:3000"], "http://localhost:3001/", false],
    [["127.0.0.1"], "http://127.0.0.1:9/", true],
  ];
  it.each(table)("%j vs %s -> %s", (p, u, want) => {
    expect(originAllowed(p, u)).toBe(want);
  });
});
