import { describe, expect, it } from "vitest";
import { controlBuys, purchaseReason } from "../../src/guard.js";
import { degenerate, effectVerdict, onPage } from "../../src/ghostwright.js";
import { callOptions, isTransient } from "../../src/model/index.js";
import { agentPrompt } from "../../src/model/prompts.js";
import { parseNumber } from "../../src/schema.js";
import { Ghostwright } from "../../src/index.js";
import type { ActResult } from "../../src/engine/session.js";

describe("purchase guard phrases", () => {
  const f = (label: string, tag = "button", ids: string[] = []) => controlBuys({ tag, labels: [label], ids });
  it("knows what buys", () => {
    for (const l of ["Place your order", "Buy now", "Pay €12,50", "Confirm and pay", "Jetzt kaufen", "Valider ma commande", "Comprar ahora"]) {
      expect(f(l), l).not.toBeNull();
    }
  });
  it("lets cart, checkout and the like through", () => {
    for (const l of ["Add to cart", "Proceed to checkout", "Buy again", "View cart", "Unsubscribe", "Sign in", "Search"]) expect(f(l), l).toBeNull();
  });
  it("reads ids of controls, not of anything", () => {
    expect(controlBuys({ tag: "button", labels: [""], ids: ["placeYourOrder1"] })).toBe("placeYourOrder1");
    expect(controlBuys({ tag: "div", labels: [""], ids: ["buy-now-section"] })).toBeNull();
    expect(controlBuys({ tag: "button", labels: ["Add to cart"], ids: ["buy-now-form"] })).toBeNull();
    expect(purchaseReason([{ tag: "input", labels: ["Ada"], ids: [] }, { tag: "button", labels: ["Pay now"], ids: [] }])).toBe("pay now");
  });
});

describe("numbers keep their decimals", () => {
  it("in either notation", () => {
    expect(parseNumber("$69.99")).toBe(69.99);
    expect(parseNumber("€12,50")).toBe(12.5);
    expect(parseNumber("1.234,56 kr")).toBe(1234.56);
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1 299,00 €")).toBe(1299);
    expect(parseNumber("4 5 stars")).toBe(4);
    expect(parseNumber("-3")).toBe(-3);
    expect(parseNumber("none")).toBeUndefined();
  });
});

describe("agent text", () => {
  it("rejects degenerate answers", () => {
    for (const a of [null, "", "  ", "done", "Done.", "N/A", "task complete", "{}", {}, { a: "" }, "...", "find the price"]) expect(degenerate(a, "find the price"), JSON.stringify(a)).toBe(true);
    for (const a of ["$12.50", "3 books", { total: 3 }, 0 as unknown]) expect(degenerate(a), JSON.stringify(a)).toBe(false);
  });
  it("never shows a step budget, and adds the final note only at the end", () => {
    expect(agentPrompt("t", [], "page")).not.toMatch(/step|last action/i);
    expect(agentPrompt("t", [], "page", [], true)).toMatch(/last action you can take/);
  });
  it("finds cited words on the page", () => {
    expect(onPage("Cart: 2 items", 'text "Cart: 2 items"')).toBe(true);
    expect(onPage("“Dune”", 'row "Dune"')).toBe(true);
    expect(onPage("Cart: 3 items", 'text "Cart: 2 items"')).toBe(false);
    // a table row cited the way a person reads it
    expect(onPage("Neuromancer | William Gibson | 1984", 'row "Neuromancer" | "William Gibson" | "1984"')).toBe(true);
    expect(onPage("Neuromancer | Frank Herbert", 'row "Neuromancer" | "William Gibson" | "1984"\nrow "Dune" | "Frank Herbert" | "1965"')).toBe(false);
    expect(onPage("", "anything")).toBe(false);
  });
  it("says what an action did", () => {
    const base: ActResult = { action: "x", status: "ok", changes: [], newTabs: [], downloads: [], errors: [], errorCount: 0, failedRequests: [], settle: { quietAfterMs: 0, waitedMs: 1, capHit: false, requests: [], requestCount: 0 }, text: "" };
    expect(effectVerdict({ action: "click" }, { ok: true, result: base })).toBe("no change");
    expect(effectVerdict({ action: "click" }, { ok: true, result: { ...base, navigation: { url: "https://x/y", sameDocument: false } } })).toBe("navigated to https://x/y");
    expect(effectVerdict({ action: "type", id: 3 }, { ok: true, result: { ...base, changes: [{ op: "changed", id: 3, kind: "element", role: "textbox", fields: { value: "ada" }, text: "~" }] } })).toBe('the field now holds "ada"');
    expect(effectVerdict({ action: "click" }, { ok: false, reason: "covered", result: base })).toBe("did not work: covered");
  });
});

describe("model calls", () => {
  it("never sends a frequency or presence penalty, and leaves retries to Ghostwright", () => {
    const o = callOptions({ system: "s", prompt: "p" }, {});
    expect(o).not.toHaveProperty("frequencyPenalty");
    expect(o).not.toHaveProperty("presencePenalty");
    expect(o.maxRetries).toBe(0);
    expect(o.temperature).toBe(0);
  });
  it("knows transient errors", () => {
    expect(isTransient({ statusCode: 503 })).toBe(true);
    expect(isTransient({ statusCode: 429 })).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isTransient({ statusCode: 401, message: "bad key" })).toBe(false);
  });

  // ask() runs without a browser: a Ghostwright with just models and a meter
  async function bare(models: any[], timeoutMs = 200) {
    const g: any = Object.create(Ghostwright.prototype);
    const { Meter } = await import("../../src/usage.js");
    const { Secrets } = await import("../../src/secrets.js");
    const { Tracer } = await import("../../src/trace.js");
    Object.assign(g, { models, o: { modelTimeoutMs: timeoutMs }, meter: new Meter(), secrets: new Secrets(), tracer: new Tracer(null, new Secrets(), false), lastCall: null });
    return g as Ghostwright & { ask: (k: string, s: string, p: string) => Promise<unknown> };
  }
  const reply = (x: unknown) => ({ text: JSON.stringify(x), usage: { inputTokens: 10, outputTokens: 2 } });

  it("retries once on a transient error, then falls back to the next model", async () => {
    const seen: string[] = [];
    const flaky = { id: "a/flaky", price: { input: 1, output: 1 }, generate: async () => { seen.push("a"); throw Object.assign(new Error("overloaded"), { statusCode: 529 }); } };
    const good = { id: "b/good", price: { input: 1, output: 1 }, generate: async () => { seen.push("b"); return reply({ ok: 1 }); } };
    const g = await bare([flaky, good]);
    expect(await g.ask("act", "s", "p")).toEqual({ ok: 1 });
    expect(seen).toEqual(["a", "a", "b"]);
    expect(g.last()?.model).toBe("b/good");
  });
  it("does not retry a non-transient error", async () => {
    const seen: string[] = [];
    const bad = { id: "a/bad", generate: async () => { seen.push("a"); throw Object.assign(new Error("invalid api key"), { statusCode: 401 }); } };
    const good = { id: "b/good", generate: async () => { seen.push("b"); return reply({ ok: 2 }); } };
    expect(await (await bare([bad, good])).ask("act", "s", "p")).toEqual({ ok: 2 });
    expect(seen).toEqual(["a", "b"]);
  });
  it("gives each call a timeout", async () => {
    let aborted = false;
    const slow = { id: "a/slow", generate: (req: any) => new Promise(() => { req.signal?.addEventListener("abort", () => { aborted = true; }); }) };
    const good = { id: "b/good", generate: async () => reply({ ok: 3 }) };
    const t0 = Date.now();
    expect(await (await bare([slow, good], 150)).ask("act", "s", "p")).toEqual({ ok: 3 });
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
    await expect((await bare([slow], 100)).ask("act", "s", "p")).rejects.toThrow(/no answer after 100 ms/);
  });
});
