// Models: any provider of the Vercel AI SDK, an OpenAI-compatible endpoint,
// or your own `generate` function. There is no default model.
import { ModelError } from "../errors.js";

export interface ModelRequest {
  system: string;
  prompt: string;
  /** PNG screenshots (hybrid agent mode) */
  images?: Uint8Array[];
  maxOutputTokens?: number;
  /** aborted when the call's time is up */
  signal?: AbortSignal;
}

export interface ModelReply {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}

/** US dollars per million tokens. */
export interface Price { input: number; output: number; cachedInput?: number }

export interface ModelClient {
  /** "provider/model" for reports */
  id: string;
  price?: Price;
  /** true when the model runs on a hosted service that bills per step (see the billing hook in README) */
  hosted?: boolean;
  /** where the price came from: given (yours), table (built in), live (the catalog), or unknown */
  priceSource?: "given" | "table" | "live" | "unknown";
  generate(req: ModelRequest): Promise<ModelReply>;
}

/** Your own model: called with the system text, the prompt and optional images; return the text. */
export interface GenerateCallback {
  id?: string;
  price?: Price;
  generate(req: ModelRequest): Promise<ModelReply | string>;
}

export interface CompatibleModel {
  provider: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  price?: Price;
}

export type ModelSpec = string | GenerateCallback | CompatibleModel | { languageModel: unknown; id?: string; price?: Price };

/** The date of the built-in price snapshot. */
export const PRICES_AS_OF = "2026-11-19";

/**
 * Prices in US$ per million tokens, for usage() and maxCostUsd. The current
 * generation is a snapshot of OpenRouter's public model catalog (it lists the
 * providers' own prices) taken on PRICES_AS_OF. A model missing here is
 * looked up in the live catalog (cached for a day, see livePrices); pass
 * `price` to set it yourself.
 */
export const PRICES: Record<string, Price> = {
  "openai/gpt-5.6-sol": { input: 4, output: 20, cachedInput: 0.4 },
  "openai/gpt-5.6-sol-pro": { input: 4, output: 20, cachedInput: 0.4 },
  "openai/gpt-5.6-terra": { input: 2, output: 12, cachedInput: 0.2 },
  "openai/gpt-5.6-terra-pro": { input: 2, output: 12, cachedInput: 0.2 },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2, cachedInput: 0.02 },
  "openai/gpt-5.6-luna-pro": { input: 0.2, output: 1.2, cachedInput: 0.02 },
  "openai/gpt-5.5": { input: 5, output: 30, cachedInput: 0.5 },
  "openai/gpt-5.5-pro": { input: 30, output: 180 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.075 },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25, cachedInput: 0.02 },
  "anthropic/claude-fable-5.2": { input: 8, output: 40, cachedInput: 0.2 },
  "anthropic/claude-fable-5.1": { input: 10, output: 50, cachedInput: 0.25 },
  "anthropic/claude-fable-5": { input: 10, output: 50, cachedInput: 1 },
  "anthropic/claude-opus-5.5": { input: 4, output: 20, cachedInput: 0.2 },
  "anthropic/claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "anthropic/claude-opus-4.8": { input: 5, output: 25, cachedInput: 0.5 },
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10, cachedInput: 0.1 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "google/gemini-4-neon": { input: 3, output: 15, cachedInput: 0.15 },
  "google/gemini-4-carbon": { input: 2, output: 10, cachedInput: 0.1 },
  "google/gemini-4-argon": { input: 2, output: 10, cachedInput: 0.1 },
  "google/gemini-4-hydrogen": { input: 1.5, output: 7.5, cachedInput: 0.075 },
  "google/gemini-3.8-flash": { input: 0.825, output: 4.125, cachedInput: 0.0825 },
  "google/gemini-3.7-flash": { input: 0.75, output: 3.75, cachedInput: 0.075 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9, cachedInput: 0.15 },
  "google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cachedInput: 0.03 },
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cachedInput: 0.025 },
  "deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cachedInput: 0.006 },
  "deepseek/deepseek-v4-pro": { input: 0.9, output: 1.5, cachedInput: 0.25 },
  "deepseek/deepseek-v4-flash": { input: 0.09, output: 0.18, cachedInput: 0.018 },
  "moonshotai/kimi-k3.1-pro": { input: 0.253, output: 8.8, cachedInput: 0.18 },
  "minimax/minimax-m3.1-flash": { input: 0.15, output: 0.6, cachedInput: 0.015 },
  "x-ai/grok-4.7": { input: 2, output: 6, cachedInput: 0.5 },
  // earlier generations (list prices when they were current)
  "openai/gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "openai/gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  "openai/gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "openai/gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "openai/gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
  "openai/gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "anthropic/claude-opus-4-1": { input: 15, output: 75, cachedInput: 1.5 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.075 },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10, cachedInput: 0.31 },
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1, cachedInput: 0.07 },
};

/**
 * The price used for a model with no known price, when maxCostUsd is set:
 * the most expensive regular (non "pro") model in the snapshot. Calls
 * priced this way say so (priceAssumed). Reasoning "pro" tiers cost more:
 * pass `price` for those.
 */
export const ASSUMED_PRICE: Price = { input: 10, output: 50 };

// "anthropic/claude-opus-5-5", "anthropic/claude-opus-5.5" and dated ids are the same model
const key = (id: string) => id.toLowerCase().replace(/\./g, "-").replace(/:[a-z]+$/, "");

/** The model id a price is looked up by: openrouter/<vendor>/<model> -> <vendor>/<model>. */
export function priceId(id: string): string {
  const [p, ...rest] = id.split("/");
  return p === "openrouter" && rest.length >= 2 ? rest.join("/") : id;
}

function lookup(table: Record<string, Price>, id: string): Price | undefined {
  const want = key(priceId(id));
  const byKey = new Map(Object.entries(table).map(([k, v]) => [key(k), v]));
  if (byKey.has(want)) return byKey.get(want);
  // dated snapshots: openai/gpt-5.4-mini-2026-03-01
  // only a dated snapshot or "-latest" borrows a listed model's price: "gpt-5-pro" is not "gpt-5"
  const base = [...byKey.keys()].filter(k => want.startsWith(k + "-") && /^-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|latest)$/.test(want.slice(k.length))).sort((a, b) => b.length - a.length)[0];
  return base ? byKey.get(base) : undefined;
}

export function priceFor(id: string): Price | undefined {
  return lookup(PRICES, id);
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 24 * 3600 * 1000;

/** Where the price catalog is cached: outside the store you commit. */
export function defaultCacheDir(): string {
  if (process.env.GHOSTWRIGHT_CACHE_DIR) return process.env.GHOSTWRIGHT_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || `${process.env.HOME || process.env.USERPROFILE || "."}/.cache`;
  return `${base}/ghostwright`;
}

/**
 * The price from OpenRouter's public model catalog (no key is sent), cached
 * in `<cacheDir>/prices.json` for a day. Undefined when it is not listed or
 * the catalog cannot be read.
 */
export async function livePrice(id: string, cacheDir?: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Price | undefined> {
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = cacheDir ? join(cacheDir, "prices.json") : null;
  let table: Record<string, Price> | null = null;
  if (file) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8"));
      const age = Date.now() - Date.parse(c.fetched_at);
      // a date in the future is not believed (a cache that never expires)
      if (age >= -5 * 60_000 && age < CATALOG_TTL_MS && c.prices && typeof c.prices === "object") table = c.prices;
    } catch { /* no cache yet */ }
  }
  if (!table) {
    try {
      const r = await fetchImpl(CATALOG_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return undefined;
      const j: any = await r.json();
      table = {};
      for (const m of j.data || []) {
        const p = m.pricing || {};
        const input = parseFloat(p.prompt), output = parseFloat(p.completion);
        if (!(input >= 0) || !(output >= 0) || String(m.id).includes(":")) continue;
        const cached = parseFloat(p.input_cache_read);
        table[m.id] = { input: +(input * 1e6).toFixed(6), output: +(output * 1e6).toFixed(6), ...(cached >= 0 ? { cachedInput: +(cached * 1e6).toFixed(6) } : {}) };
      }
      if (file) {
        try { mkdirSync(cacheDir!, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), source: CATALOG_URL, prices: table }), { mode: 0o600 }); } catch { /* cache is optional */ }
      }
    } catch { return undefined; }
  }
  return lookup(table, id);
}

const KEY_ENV: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
};

function keyFor(provider: string, given?: string): string | undefined {
  if (given) return given;
  for (const n of KEY_ENV[provider] || []) if (process.env[n]) return process.env[n];
  return undefined;
}

/**
 * The options of one model call. No frequency or presence penalty is ever
 * set: they push a model away from repeating ids and names it must copy.
 * Retries are Ghostwright's own (one on a transient error), not the library's.
 */
export function callOptions(req: ModelRequest, languageModel: unknown): Record<string, unknown> {
  const content: any[] = [{ type: "text", text: req.prompt }];
  for (const img of req.images || []) content.push({ type: "file", data: img, mediaType: "image/png" });
  return {
    model: languageModel,
    system: req.system,
    messages: [{ role: "user", content }],
    maxOutputTokens: req.maxOutputTokens ?? 2000,
    temperature: 0,
    maxRetries: 0,
    ...(req.signal ? { abortSignal: req.signal } : {}),
  };
}

/** A network hiccup, a timeout, a rate limit or a 5xx: worth one more try. */
export function isTransient(e: unknown): boolean {
  const x = e as any;
  if (!x) return false;
  if (x.name === "TimeoutError" || x.name === "AbortError" || x.isRetryable === true) return true;
  const status = x.statusCode ?? x.status ?? x.response?.status;
  if ([408, 409, 425, 429, 500, 502, 503, 504, 529].includes(Number(status))) return true;
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|overloaded|timed? ?out|rate limit/i.test(String(x.message ?? x));
}

/**
 * A provider error as a ModelError with a code and what to fix (the env
 * variable of the key). A time-out or an abort is passed on as it is.
 */
export function modelError(e: unknown, id: string): unknown {
  const x = e as any;
  if (!x || x.name === "AbortError" || x.name === "TimeoutError" || x instanceof ModelError) return e;
  const provider = id.split("/")[0];
  const envs = KEY_ENV[provider];
  const keyHint = envs ? `set ${envs.join(" or ")}, or pass modelApiKey` : "check the endpoint's apiKey";
  const status = Number(x.statusCode ?? x.status ?? x.response?.status) || undefined;
  const said = String(x.message ?? x).replace(/\s+/g, " ").slice(0, 200).replace(/[.\s]+$/, "");
  const o = { statusCode: status, isRetryable: x.isRetryable, cause: e };
  if (status === 401 || status === 403 || x.name === "AI_LoadAPIKeyError" || /api key|apikey|unauthori[sz]ed|user not found|invalid.*key|authentication|permission denied/i.test(said)) {
    return new ModelError("model_auth", `${provider} refused the API key for ${id}${status ? ` (${status})` : ""}: ${said}. ${keyHint[0].toUpperCase() + keyHint.slice(1)}.`, id, o);
  }
  if (status === 429 || /rate limit|quota|too many requests/i.test(said)) {
    return new ModelError("model_rate_limit", `${provider} rate-limited ${id} (429): ${said}. Wait and retry, raise the account's limits or credits, or add fallbackModels.`, id, { ...o, isRetryable: true });
  }
  if (status === 404 || /not a valid model|model not found|no such model|does not exist|unknown model/i.test(said)) {
    return new ModelError("model_not_found", `${provider} has no model "${id.split("/").slice(1).join("/")}"${status ? ` (${status})` : ""}: ${said}. Check the model name.`, id, o);
  }
  if (status && status >= 500) return new ModelError("model_unavailable", `${provider} failed for ${id} (${status}): ${said}. Retry later or add fallbackModels.`, id, o);
  return new ModelError("model_error", `${id}: ${said}`, id, o);
}

async function aiSdkClient(id: string, languageModel: unknown, price?: Price): Promise<ModelClient> {
  const { generateText } = await import("ai");
  return {
    id,
    price,
    async generate(req) {
      let r: any;
      try { r = await generateText(callOptions(req, languageModel) as any); } catch (e) { throw modelError(e, id); }
      const u = r.usage || {};
      return {
        text: r.text,
        usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens },
      };
    },
  };
}

export interface ResolveOptions {
  apiKey?: string;
  price?: Price;
  /** where the live price catalog is cached */
  cacheDir?: string;
  /** look a model missing from the built-in table up in the live catalog (default true) */
  livePrices?: boolean;
  fetch?: typeof fetch;
}

/** Turns a model option into a client, with its price: yours, the built-in table, the live catalog, or unknown. */
export async function resolveModel(spec: ModelSpec, o: ResolveOptions = {}): Promise<ModelClient> {
  const c = await clientFor(spec, o);
  if (c.price) { c.priceSource = "given"; return c; }
  const fromTable = priceFor(c.id);
  if (fromTable) { c.price = fromTable; c.priceSource = "table"; return c; }
  const listed = /^(openai|anthropic|google|deepseek|openrouter)\//.test(c.id);
  const live = listed && o.livePrices !== false ? await livePrice(c.id, o.cacheDir, o.fetch) : undefined;
  if (live) { c.price = live; c.priceSource = "live"; return c; }
  c.priceSource = "unknown";
  return c;
}

async function clientFor(spec: ModelSpec, o: ResolveOptions): Promise<ModelClient> {
  if (typeof spec === "object" && spec && "generate" in spec && typeof spec.generate === "function") {
    const cb = spec as GenerateCallback;
    return {
      id: cb.id || "custom", price: cb.price ?? o.price,
      async generate(req) {
        const r = await cb.generate(req);
        return typeof r === "string" ? { text: r } : r;
      },
    };
  }
  if (typeof spec === "object" && spec && "languageModel" in spec) {
    const lm: any = (spec as any).languageModel;
    return aiSdkClient((spec as any).id || `${lm.provider ?? "custom"}/${lm.modelId ?? "model"}`, lm, (spec as any).price ?? o.price);
  }
  if (typeof spec === "object" && spec && (spec as CompatibleModel).provider === "openai-compatible") {
    const c = spec as CompatibleModel;
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const p = createOpenAICompatible({ name: "compatible", baseURL: c.baseURL, apiKey: c.apiKey, headers: c.headers });
    return aiSdkClient("compatible/" + c.model, p(c.model), c.price ?? o.price);
  }
  if (typeof spec !== "string" || !spec.includes("/")) throw new TypeError(`model must be "provider/model" (openai/..., anthropic/..., google/..., openrouter/..., deepseek/...), a { generate } function or an openai-compatible endpoint`);
  const [provider, ...rest] = spec.split("/");
  const name = rest.join("/");
  const key = keyFor(provider, o.apiKey);
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return aiSdkClient(spec, createOpenAI({ apiKey: key })(name), o.price);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return aiSdkClient(spec, createAnthropic({ apiKey: key })(name), o.price);
    }
    case "google": {
      const g: any = await import("@ai-sdk/google");
      const create = g.createGoogle ?? g.createGoogleGenerativeAI;
      return aiSdkClient(spec, create({ apiKey: key })(name), o.price);
    }
    case "openrouter":
    case "deepseek": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const baseURL = provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.deepseek.com/v1";
      return aiSdkClient(spec, createOpenAICompatible({ name: provider, baseURL, apiKey: key })(name), o.price);
    }
  }
  throw new TypeError(`unknown model provider "${provider}"; use an openai-compatible endpoint: { provider: "openai-compatible", baseURL, model }`);
}

/** The first JSON object in a model's answer. */
export function parseJSON(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { /* look for the object */ }
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in the model's answer");
  const open = t[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error("unfinished JSON in the model's answer");
}
