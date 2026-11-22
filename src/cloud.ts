// Browsa cloud (optional, paid with Browsa credits): push a local flow as a
// Browsa recipe, run it there on Phantom with the in-session captcha solver
// and the repair ladder, or schedule it as a robot. Plain HTTP with your API
// key; everything else in Ghostwright stays local and free.
//
// Secrets: a pushed recipe holds only tokens ({{secret:NAME}},
// {{secret:NAME:password}}, {{totp:NAME}}). Browsa Secrets types them on
// Browsa, by name, with its own origin check. No value is ever sent.
import { secureBase } from "./browser.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FlowError, GhostwrightError } from "./errors.js";
import type { Recipe, Step } from "./recipe.js";
import { TOKEN, type Secrets } from "./secrets.js";
import { ownerWrite, type Store } from "./store.js";

export interface CloudOptions {
  /** a Browsa API key (agt_...); default BROWSA_API_KEY */
  apiKey?: string;
  /** default https://browsa.io */
  baseUrl?: string;
  /** the local secrets: legacy tokens are mapped to Browsa names, and a push that holds a known value is refused */
  secrets?: Secrets;
  /** for tests */
  fetch?: typeof fetch;
}

export interface PushResult {
  recipeId: string;
  name: string;
  version: number;
  priceCredits: number;
  /** the Browsa Secrets the recipe types, by name (save them with POST /v1/secrets) */
  secretNames: string[];
  /** true when Browsa already had this exact recipe from the last push: nothing was uploaded */
  unchanged?: boolean;
  /** the recipe this push replaced, and whether it was deleted (it is kept while a robot or schedule still uses it) */
  replaced?: { recipeId: string; deleted: boolean; keptFor?: string };
}

export interface PushOptions {
  /** "auto" (default): Browsa repairs and promotes; "review": repairs wait for you; "off" */
  repairMode?: "auto" | "review" | "off";
  /** keep the recipe an earlier push made (default: delete it when nothing uses it) */
  keepOld?: boolean;
}

export interface CloudRun<T = any> {
  id: string;
  status: "ok" | "failed" | "cancelled" | "queued" | "running";
  output: T | null;
  errorCode: string | null;
  errorMessage: string | null;
  repaired: boolean;
  repairedSteps: string[];
  newVersion: number | null;
  credits: number;
  durationMs: number | null;
  raw: Record<string, any>;
}

export interface RobotOptions {
  /** one params object per row; each scheduled run does every row */
  rows?: Record<string, unknown>[];
  /** "15m", "6h", "1d", "7d", seconds, or { interval_seconds, at?, weekday?, tz? }; null removes it */
  schedule?: string | number | { interval_seconds: number; at?: string; weekday?: number; tz?: string } | null;
  /** alert rules, e.g. [{ field: "items.price", op: "lt", value: 100 }] */
  alerts?: { field: string; op: string; value?: unknown }[];
  /** where results go, e.g. [{ type: "webhook", url }] or [{ type: "email", to }] */
  destinations?: Record<string, unknown>[];
  /** { model?, proxy?, browser? }; omitted = Auto */
  settings?: Record<string, unknown>;
  description?: string;
  /** robot name on Browsa (default: the flow name) */
  name?: string;
}

interface Link { recipeId: string; version: number; robotId?: string; secretNames?: string[]; hash?: string; priceCredits?: number }
interface Links { [flow: string]: Link }

/** The secret names a recipe types, sorted. */
export function secretNamesIn(r: Recipe): string[] {
  const out = new Set<string>();
  for (const m of JSON.stringify(r.steps).matchAll(TOKEN)) out.add(m[2].toUpperCase());
  return [...out].sort();
}

const STEP_TEXT_FIELDS: (keyof Step)[] = ["url", "value", "keys", "body", "headers", "for", "expr", "how", "source", "goal"];

export class BrowsaCloud {
  private base: string;
  private f: typeof fetch;
  constructor(private store: Store, private o: CloudOptions = {}) {
    this.base = secureBase(o.baseUrl || process.env.BROWSA_BASE_URL || "https://browsa.io", "the Browsa base URL");
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private key(): string {
    const k = this.o.apiKey || process.env.BROWSA_API_KEY;
    if (!k) throw new GhostwrightError("no_api_key", "Browsa cloud calls need an API key: pass browsaApiKey or set BROWSA_API_KEY");
    return k;
  }

  private async http<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const r = await this.f(this.base + path, {
      method,
      headers: { "X-API-Key": this.key(), Accept: "application/json", "User-Agent": "ghostwright", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      const code = j?.error?.code || j?.code || `HTTP_${r.status}`;
      const msg = j?.error?.message || j?.message || text.slice(0, 200);
      const e = new GhostwrightError(String(code).toLowerCase(), `Browsa ${method} ${path}: ${msg}`);
      (e as any).status = r.status;
      throw e;
    }
    return j as T;
  }

  private linksFile(): string { return join(this.store.dir, "browsa.json"); }
  private links(): Links {
    try { return JSON.parse(readFileSync(this.linksFile(), "utf8")); } catch { return {}; }
  }
  private saveLinks(l: Links): void {
    ownerWrite(this.linksFile(), JSON.stringify(l, null, 2) + "\n");
  }

  /**
   * The recipe as Browsa runs it: secret tokens by Browsa name, only in
   * `type` steps. Refused when it holds a known secret value.
   */
  static toBrowsa(r: Recipe, secrets?: Secrets): Recipe {
    const body = JSON.parse(JSON.stringify(r)) as Recipe;
    for (const s of body.steps) {
      // locators only local replays read are left out
      for (const t of [s.target, s.for?.target]) if (t) delete (t as any).within;
      // a read by pattern is a local one: on Browsa that extract asks the model
      if (s.kind === "extract" && (s.how?.match || s.how?.pick || s.how?.nested)) {
        const into = s.how.into;
        s.output_schema = s.output_schema ?? (into && body.output?.properties?.[into] ? { type: "object", properties: { [into]: body.output.properties[into] }, required: [into] } : body.output);
        s.from = "page";
        s.how = { model: true };
      }
      for (const f of STEP_TEXT_FIELDS) {
        const v = s[f];
        if (v != null && new RegExp(TOKEN.source).test(typeof v === "string" ? v : JSON.stringify(v))) {
          throw new GhostwrightError("secret_not_allowed", `step ${s.id} has a secret token in "${String(f)}": secrets are typed only in type steps`);
        }
      }
      if (typeof s.text !== "string") continue;
      s.text = s.text.replace(TOKEN, (m, kind: string, name: string, field?: string) => {
        if (/^[A-Z0-9_]{1,64}$/.test(name)) return m.replace(/\s/g, "");
        // a token written with the local name (before tokens used Browsa names)
        const local = secrets?.nameOfToken(kind, name, field);
        if (local) return secrets!.tokenOf(local);
        throw new GhostwrightError("secret_name", `step ${s.id} types secret "${name}", which has no Browsa Secrets name: use browsaSecret("NAME") or an UPPER_CASE env() name`);
      });
    }
    if (body.meta) delete (body.meta as any).secrets;
    if (secrets?.leaks(JSON.stringify(body))) {
      throw new GhostwrightError("secret_value", `flow "${r.name}" holds a secret value; it was not pushed`);
    }
    return body;
  }

  /** Uploads a saved flow to Browsa as a recipe (secret tokens by name, never values). */
  async push(name: string, o: PushOptions = {}): Promise<PushResult> {
    const r = this.store.load(name);
    if (!r) throw new FlowError("not_found", `no saved flow "${name}" in ${this.store.dir}`);
    const body = BrowsaCloud.toBrowsa(r, this.o.secrets);
    const secretNames = secretNamesIn(body);
    const upload = { recipe: body, name: r.name, repair_mode: o.repairMode ?? r.repair?.mode ?? "auto" };
    // the same content as the last push: the same Browsa recipe, nothing uploaded (while it is still there)
    const hash = createHash("sha256").update(JSON.stringify(upload)).digest("hex");
    const links = this.links();
    const old = links[name];
    if (old?.hash === hash) {
      const have = await this.http<any>("GET", `/v1/recipes/${old.recipeId}`).catch(e => { if ((e as any).status === 404) return null; throw e; });
      if (have) return { recipeId: old.recipeId, name: have.name ?? r.name, version: r.version, priceCredits: have.price_credits ?? old.priceCredits ?? 0, secretNames, unchanged: true };
    }
    const v = await this.http("POST", "/v1/recipes", upload);
    links[name] = { ...(old || {}), recipeId: v.id, version: r.version, secretNames, hash, priceCredits: v.price_credits };
    this.saveLinks(links);
    const out: PushResult = { recipeId: v.id, name: v.name, version: r.version, priceCredits: v.price_credits, secretNames };
    if (old && old.recipeId !== v.id) {
      // the flow's robot moves to the new recipe, in place
      if (old.robotId) await this.http("PATCH", `/v1/robots/${old.robotId}`, { recipe_id: v.id }).catch(e => { if ((e as any).status !== 404) throw e; });
      out.replaced = { recipeId: old.recipeId, ...(o.keepOld ? { deleted: false, keptFor: "keepOld" } : await this.retire(old.recipeId)) };
    }
    return out;
  }

  /** Deletes a recipe unless a robot or a schedule still uses it. */
  private async retire(recipeId: string): Promise<{ deleted: boolean; keptFor?: string }> {
    const robots = (await this.http<{ robots?: any[] }>("GET", "/v1/robots")).robots || [];
    const rb = robots.find(x => x.recipe_id === recipeId);
    if (rb) return { deleted: false, keptFor: `robot ${rb.id}` };
    const schedules = (await this.http<{ schedules?: any[] }>("GET", "/v1/schedules")).schedules || [];
    const sc = schedules.find(x => x.recipe_id === recipeId);
    if (sc) return { deleted: false, keptFor: `schedule ${sc.id}` };
    await this.http("DELETE", `/v1/recipes/${recipeId}`).catch(e => { if ((e as any).status !== 404) throw e; });
    return { deleted: true };
  }

  /** The Browsa recipe of a flow, pushed when it is not there yet or the local flow is newer. */
  private async ensurePushed(name: string, o: PushOptions = {}): Promise<Link> {
    const l = this.links()[name];
    const local = this.store.load(name);
    if (l && local && l.version === local.version) return l;
    await this.push(name, o);
    return this.links()[name];
  }

  /** Runs a flow on Browsa (pushing it first when the local flow is newer) and waits for the result. Paid with Browsa credits. */
  async run<T = any>(name: string, params: Record<string, unknown> = {}, o: { timeoutMs?: number; proxy?: Record<string, unknown>; push?: PushOptions } = {}): Promise<CloudRun<T>> {
    const link = await this.ensurePushed(name, o.push);
    const deadline = Date.now() + (o.timeoutMs ?? 300000);
    const body: Record<string, unknown> = { params, wait: 60 };
    // by name: Browsa looks them up in the workspace's Secrets; no value is sent
    if (link.secretNames?.length) body.secret_ids = link.secretNames;
    if (o.proxy) body.proxy = o.proxy;
    let run = await this.http("POST", `/v1/recipes/${link.recipeId}/run`, body, 75000);
    while ((run.status === "queued" || run.status === "running") && Date.now() < deadline) {
      run = await this.http("GET", `/v1/recipe-runs/${run.id}?wait=60`, undefined, 75000);
    }
    return {
      id: run.id, status: run.status, output: run.output ?? null, errorCode: run.error_code ?? null, errorMessage: run.error_message ?? null,
      repaired: !!run.repaired, repairedSteps: run.repaired_steps || [], newVersion: run.new_version ?? null,
      credits: run.credits ?? 0, durationMs: run.duration_ms ?? null, raw: run,
    };
  }

  /**
   * Creates the flow's robot, or updates the same robot in place. Its runs
   * type the recipe's secrets by name from Browsa Secrets (the robots API
   * attaches them from the recipe; it takes no secret_ids).
   */
  async robot(name: string, o: RobotOptions = {}): Promise<Record<string, any>> {
    const link = await this.ensurePushed(name);
    const body: Record<string, unknown> = { recipe_id: link.recipeId };
    if (o.rows) body.inputs = o.rows;
    if (o.schedule !== undefined) body.schedule = parseSchedule(o.schedule);
    if (o.alerts) body.monitors = o.alerts;
    if (o.destinations) body.destinations = o.destinations;
    if (o.settings) body.settings = o.settings;
    if (o.description) body.description = o.description;
    const links = this.links();
    const robotId = links[name]?.robotId;
    if (robotId) {
      try { return await this.http("PATCH", `/v1/robots/${robotId}`, body); } catch (e) {
        if ((e as any).status !== 404) throw e; // deleted on Browsa: make a new one
      }
    }
    const rb = await this.http("POST", "/v1/robots", { name: o.name ?? name, ...body });
    links[name] = { ...links[name], robotId: rb.id };
    this.saveLinks(links);
    return rb;
  }

  /**
   * Deletes what push() and robot() made on Browsa for a flow: its robot
   * (with the robot's runs history kept by Browsa for billing), then its
   * recipe, and forgets the link. Already gone is fine. The local flow stays.
   */
  async unpush(name: string): Promise<{ robotId?: string; recipeId?: string }> {
    const links = this.links();
    const l = links[name];
    if (!l) return {};
    const gone = (e: unknown) => { if ((e as any).status !== 404) throw e; };
    if (l.robotId) await this.http("DELETE", `/v1/robots/${l.robotId}`).catch(gone);
    await this.http("DELETE", `/v1/recipes/${l.recipeId}`).catch(gone);
    delete links[name];
    this.saveLinks(links);
    return { robotId: l.robotId, recipeId: l.recipeId };
  }

  /** The Browsa recipe and robot a flow was pushed to, if any. */
  linked(name: string): Link | undefined { return this.links()[name]; }
}

export function parseSchedule(s: RobotOptions["schedule"]): Record<string, unknown> | null {
  if (s === null) return null;
  if (typeof s === "number") return { interval_seconds: s };
  if (typeof s === "object" && s) return s;
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(String(s).trim());
  if (!m) throw new TypeError(`schedule "${s}": use 15m, 6h, 1d, 7d or seconds`);
  const mult = { m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as "m" | "h" | "d" | "w"];
  return { interval_seconds: +m[1] * mult };
}
