// Regression tests for the end-to-end gate (no browser).
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cdp, launchError } from "../../src/browser.js";
import { CostLimitError, ModelError } from "../../src/errors.js";
import { Ghostwright } from "../../src/ghostwright.js";
import { callOptions, modelError, resolveModel } from "../../src/model/index.js";
import type { Recipe } from "../../src/recipe.js";
import { toSchema } from "../../src/schema.js";
import { Store } from "../../src/store.js";
import { Tracer } from "../../src/trace.js";
import { Meter } from "../../src/usage.js";
import { secret, Secrets } from "../../src/secrets.js";

describe("M9 model errors", () => {
  let srv: Server;
  let base = "";
  const replies: Record<string, [number, object]> = {
    "bad-key": [401, { error: { message: "User not found.", code: 401 } }],
    "busy": [429, { error: { message: "Rate limit exceeded", code: 429 } }],
    "no-such": [404, { error: { message: "nope/x is not a valid model ID", code: 404 } }],
  };
  beforeAll(async () => {
    srv = createServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body || "{}").model as string;
        const [status, j] = replies[m] ?? [500, { error: { message: "boom" } }];
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      });
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => { await new Promise(r => srv.close(r)); });

  const call = async (model: string) => {
    const c = await resolveModel({ provider: "openai-compatible", baseURL: base, model, apiKey: "x", price: { input: 0, output: 0 } });
    return c.generate({ system: "s", prompt: "p" }).catch(e => e);
  };

  it("gives each failure a code and says what to fix", async () => {
    const auth = await call("bad-key");
    expect(auth).toBeInstanceOf(ModelError);
    expect(auth.code).toBe("model_auth");
    expect(auth.statusCode).toBe(401);
    expect((await call("busy")).code).toBe("model_rate_limit");
    expect((await call("no-such")).code).toBe("model_not_found");
    expect((await call("other")).code).toBe("model_unavailable");
  });

  it("names the provider's key variable, never the key", () => {
    const e = modelError(Object.assign(new Error("User not found."), { statusCode: 401 }), "openrouter/google/gemini-3.1-flash-lite") as ModelError;
    expect(e.code).toBe("model_auth");
    expect(e.message).toMatch(/OPENROUTER_API_KEY/);
    const g = modelError(Object.assign(new Error("API key not valid. Please pass a valid API key."), { statusCode: 400 }), "google/gemini-3.1-flash-lite") as ModelError;
    expect(g.code).toBe("model_auth");
    expect(g.message).toMatch(/GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY/);
    const r = modelError(Object.assign(new Error("Too Many Requests"), { statusCode: 429 }), "anthropic/claude-sonnet-5") as ModelError;
    expect(r.code).toBe("model_rate_limit");
    expect(r.isRetryable).toBe(true);
    // a time-out stays what it is (the caller's timeout handling needs it)
    const t = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(modelError(t, "openai/x")).toBe(t);
  });
});

// ask() runs without a browser: a Ghostwright with just models, a meter and a store
async function bare(models: any[], o: { maxCostUsd?: number; store?: string } = {}) {
  const g: any = Object.create(Ghostwright.prototype);
  const events: any[] = [];
  Object.assign(g, { models, o: { modelTimeoutMs: 500, onEvent: (e: any) => events.push(e) }, meter: new Meter(o.maxCostUsd), secrets: new Secrets(), tracer: new Tracer(null, new Secrets(), false), lastCall: null, store: new Store(o.store ?? mkdtempSync(join(tmpdir(), "gw-gate-"))) });
  return { g: g as Ghostwright & { ask: (k: string, s: string, p: string) => Promise<unknown> }, events };
}
const reply = (x: unknown) => ({ text: JSON.stringify(x), usage: { inputTokens: 10, outputTokens: 2 } });
const recipe = (version: number): Recipe => ({ name: "flow-a", version, params: { type: "object", properties: {} }, output: { type: "object", properties: {} }, steps: [{ id: "s1", kind: "navigate", url: "https://x.test/" }] });

describe("minor: cost cap", () => {
  it("says what the refused call could cost, and a model the cap refuses passes to the next", async () => {
    const custom = { id: "my/model", generate: async () => reply({ from: "custom" }) };        // no price: assumed
    const cheap = { id: "b/cheap", price: { input: 0.1, output: 0.4 }, generate: async () => reply({ from: "cheap" }) };
    const { g } = await bare([custom, cheap], { maxCostUsd: 0.004 });
    expect(await g.ask("act", "s", "p")).toEqual({ from: "cheap" });
    const only = (await bare([custom], { maxCostUsd: 0.004 })).g;
    const e: any = await only.ask("act", "s", "p").catch(x => x);
    expect(e).toBeInstanceOf(CostLimitError);
    expect(e.message).toMatch(/the next call to my\/model could cost up to \$0\.1\d+ .*2000 output tokens.*assumed price: pass price.*spent \$0\.0000 of maxCostUsd \$0\.004/);
    expect(e.estimateUsd).toBeGreaterThan(0.1);
  });
});

describe("minor: schemas are checked before any model call", () => {
  it("refuses what is not a JSON Schema, with what to write instead", async () => {
    await expect(toSchema({ authors: "string" })).rejects.toThrow(/not a JSON Schema.*properties: \{ authors: \{ type: "string" \} \}/);
    await expect(toSchema({ type: "objekt", properties: {} })).rejects.toThrow(/"objekt" is not a JSON Schema type/);
    await expect(toSchema({ type: "object", properties: { a: "string" } })).rejects.toThrow(/schema\.properties\.a must be a JSON Schema object \(write \{ type: "string" \}\)/);
    for (const ok of [{ type: "object" }, { type: "object", properties: { a: {}, b: { description: "any" }, c: { anyOf: [{ type: "string" }, { type: "null" }] } } }, { type: "array", items: { type: "number" } }]) await expect(toSchema(ok)).resolves.toBeTruthy();
  });
});

describe("minor: versions and drafts", () => {
  it("rollback and promote say which versions exist; promote() sends a promote event", async () => {
    const { g, events } = await bare([]);
    const st: Store = (g as any).store;
    st.promote(recipe(1));
    st.promote(recipe(2));
    expect(() => g.rollback("flow-a", 9)).toThrow(/flow-a has no v9 \(versions: v1, v2 \(active\)\)/);
    expect(() => g.promote("flow-a")).toThrow(/no draft of flow-a to promote \(no drafts\)/);
    st.saveDraft(recipe(3), "review");
    expect(g.promote("flow-a").version).toBe(3);
    expect(events).toContainEqual({ type: "promote", flow: "flow-a", version: 3 });
  });
});

describe("minor: browsers", () => {
  it("an unreachable CDP address says what to do", async () => {
    const ws: any = await cdp("ws://127.0.0.1:9/devtools/browser/x?token=abc").open().catch(x => x);
    expect(ws.code).toBe("browser_unreachable");
    expect(ws.message).toMatch(/ws:\/\/127\.0\.0\.1:9\/devtools\/browser\/x: .*Check that the browser is running/);
    expect(ws.message).not.toContain("token=abc");
    const e: any = await cdp("http://127.0.0.1:9/").open().catch(x => x);
    expect(e.code).toBe("browser_unreachable");
    expect(e.message).toMatch(/could not attach to a browser at http:\/\/127\.0\.0\.1:9\/.*--remote-debugging-port=0.*ws:\/\/ address it prints/);
  });
  it("a missing Chrome and a failed sandbox say what to pass", () => {
    const missing: any = launchError(new Error("Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome\nRun \"npx playwright install chrome\""), {});
    expect(missing.code).toBe("browser_missing");
    expect(missing.message).toMatch(/Chrome is not installed on this machine: install Google Chrome.*executablePath.*channel: "msedge"/);
    expect(missing.message).not.toMatch(/playwright install|Chromium/);
    const sandbox: any = launchError(new Error("Failed to launch: No usable sandbox! Update your kernel"), {});
    expect(sandbox.code).toBe("browser_sandbox");
    expect(sandbox.message).toMatch(/local\(\{ sandbox: false \}\).*executablePath/);
    const other = new Error("something else");
    expect(launchError(other, {})).toBe(other);
  });
  it("screenshots go as a file part (no deprecated image part, no warning on stderr)", () => {
    const o: any = callOptions({ system: "s", prompt: "p", images: [new Uint8Array([1, 2])] }, {});
    expect(o.messages[0].content[1]).toMatchObject({ type: "file", mediaType: "image/png" });
    expect(o.messages[0].content.some((c: any) => c.type === "image")).toBe(false);
  });
});

describe("B3 secrets are known before the first prompt", () => {
  it("prime() reads every local value once, callbacks too", async () => {
    let reads = 0;
    const s = new Secrets({ pw: secret(async () => { reads++; return "cb-value-778-long"; }, { origins: ["app.example.com"] }) });
    expect(s.scrub("x cb-value-778-long y")).toBe("x cb-value-778-long y");
    await s.prime();
    expect(reads).toBe(1);
    expect(s.scrub("x cb-value-778-long y")).toBe("x %pw% y");
  });
});
