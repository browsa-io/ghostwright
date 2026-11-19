// Ghostwright: act, observe, extract and agent over a compact page view;
// flows recorded as recipes and replayed with no model.
import { join } from "node:path";
import type { Page } from "playwright-core";
import { local, type BrowserSource, type OpenedBrowser } from "./browser.js";
import { findTokenCaptchas, injectToken, type CaptchaSolver } from "./captcha.js";
import { BrowsaCloud, type CloudRun, type PushOptions, type PushResult, type RobotOptions } from "./cloud.js";
import { compileExtract } from "./compile.js";
import { PageSession, type Action, type ActResult, type Target } from "./engine/session.js";
import type { SettleConfig } from "./engine/settle.js";
import type { View } from "./engine/view.js";
import { ActionError, ChallengeError, CostLimitError, GhostwrightError, NoModelError, SecretOriginError } from "./errors.js";
import { purchaseReason } from "./guard.js";
import { defaultCacheDir, isTransient, parseJSON, resolveModel, type ModelClient, type ModelSpec, type Price } from "./model/index.js";
import * as P from "./model/prompts.js";
import { paramsSchema, recipeName, render, templatize, templatizePath, type Effect, type Recipe, type Step } from "./recipe.js";
import { hostsOf, runFlow, shownTokens, type RunOptions, type RunResult } from "./replay.js";
import { coerce, toSchema, type JSONSchema, type SchemaLike } from "./schema.js";
import { placeholders, planText, SecretNotAllowedError, Secrets, type SecretRef } from "./secrets.js";
import { Store } from "./store.js";
import { Tracer } from "./trace.js";
import { addUsage, emptyUsage, Meter, type CallRecord, type Usage } from "./usage.js";

export interface GhostwrightOptions {
  /** local() (default), cdp(url) or browsa({ apiKey }) */
  browser?: BrowserSource;
  /** "openai/gpt-5.6-luna", "anthropic/...", "google/...", "openrouter/...", "deepseek/...", an openai-compatible endpoint, or { generate }; a list = fallbacks in order. No default. */
  model?: ModelSpec | ModelSpec[];
  /** models tried in order when the model fails (after one retry on a transient error) */
  fallbackModels?: ModelSpec[];
  /** the longest one model call may take (default 60000 ms) */
  modelTimeoutMs?: number;
  /** allow clicks and submits that place an order, pay, subscribe or start a paid trial (default false) */
  allowPurchases?: boolean;
  /** origins the page may go to ("example.com", "*.example.com", "https://app.example.com"); others are refused */
  allowedOrigins?: string[];
  /** let pages open file: addresses (off: only http, https and about:blank are ever opened) */
  allowFileUrls?: boolean;
  /** the model provider's key (default: the provider's usual environment variable) */
  modelApiKey?: string;
  /** US$ per million tokens, for models without a known price */
  price?: Price;
  /** named secrets: the model sees only %name% */
  secrets?: Record<string, SecretRef>;
  /** the local store folder (default ".ghostwright") */
  store?: string;
  /** stop before model spend passes this many US$; a model with no known price counts at ASSUMED_PRICE */
  maxCostUsd?: number;
  /** look up a model missing from the built-in price table in OpenRouter's public catalog, cached a day (default true) */
  livePrices?: boolean;
  /** where the price catalog is cached (default ~/.cache/ghostwright, or GHOSTWRIGHT_CACHE_DIR) */
  cacheDir?: string;
  /** print each step (true) or pass a function; silent by default */
  debug?: boolean | ((line: string) => void);
  /** local token captchas: browsaCaptcha({ apiKey }) */
  captcha?: CaptchaSolver;
  /** the most local captcha solves in this Ghostwright (default 5; each costs credits) */
  maxCaptchaSolves?: number;
  /** events: model-call, captcha, repair, promote, warning */
  onEvent?: (e: GhostwrightEvent) => void;
  /** print warnings (an extract that did not compile) with console.warn (default true) */
  warnings?: boolean;
  /** view budget in approximate tokens (default 2000) */
  viewBudget?: number;
  /** one more model call when an action fails or does nothing (default true) */
  selfHeal?: boolean;
  settle?: Partial<SettleConfig>;
  /** Browsa cloud calls (push, runOnBrowsa, robot): default BROWSA_API_KEY */
  browsaApiKey?: string;
  browsaBaseUrl?: string;
  /** @internal tests */
  browsaFetch?: typeof fetch;
}

export type GhostwrightEvent =
  | { type: "model-call"; kind: string; model: string; inputTokens: number; outputTokens: number; usd: number; priceAssumed: boolean; ms: number; hosted: boolean }
  | { type: "captcha"; kind: string; where: "phantom" | "local"; status: "waiting" | "solving" | "passed" | "failed"; ms?: number }
  | { type: "repair"; flow: string; step: string; ok: boolean }
  | { type: "promote"; flow: string; version: number }
  | { type: "warning"; flow?: string; step?: string; message: string };

/** What gw.last() shows: the last model call, secrets masked. */
export interface LastCall {
  kind: string;
  model: string;
  system: string;
  /** the prompt as sent: the instruction and the page view */
  prompt: string;
  /** the model's answer, as text */
  answer: string;
  /** what was done with it: the action, the element and its locators */
  plan?: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ms: number;
  at: string;
}

export interface Meta {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ms: number;
}

export interface ActOutcome {
  ok: boolean;
  /** what was done, e.g. `click [6]` */
  action: string;
  /** what the page did: the diff, or the new page's view */
  result: string;
  reason?: string;
  meta: Meta;
}

export interface Candidate {
  id: number;
  role: string;
  name: string;
  action: string;
  description: string;
  target: Target | null;
}

export interface CheckOutcome {
  ok: boolean;
  /** the words the answer rests on, whether they are on the page, and where */
  evidence: { text: string; found: boolean; url: string; element?: { id: number; role: string; name: string } };
  reason?: string;
  meta: Meta;
}

export interface ExtractOptions {
  /** view budget in approximate tokens (default 12000) */
  budget?: number;
  /** read from this HTML instead of the current page (no navigation; nothing it links to is fetched) */
  html?: string;
  /** read from a local HTML file instead of the current page */
  file?: string;
}

export interface ExtractOutcome<T> {
  data: T;
  meta: Meta & { layer: "model" | "fetch" | "page_json" | "css" };
}

export interface AgentOptions {
  /** the most actions (default 20); the model is not told the number */
  maxSteps?: number;
  mode?: "dom" | "hybrid";
  /** secrets the agent may type besides the ones the task names as %name% */
  secrets?: string[];
  /** the stall guard: a note to the model, then a stop, after the same action repeats or actions keep changing nothing */
  stall?: { repeatNote?: number; repeatStop?: number; idleNote?: number; idleStop?: number };
}

export interface AgentOutcome {
  /** done: the model answered; stalled: it repeated itself or nothing changed; max_steps: no answer in the steps allowed */
  status: "done" | "stalled" | "max_steps";
  /** the model's own verdict; "unknown" when it gave none or its answer was empty. Never read "unknown" as success. */
  success: true | false | "unknown";
  answer: unknown;
  steps: number;
  history: string[];
  /** where the run ended, and what its last action did */
  /** where the run ended, what its last action did, and the words the model cited for its answer (found on the page or not) */
  evidence: { url: string; title: string; lastEffect: string; cited?: { text: string; found: boolean } };
  meta: Meta;
}

interface Decision {
  action: string; id?: number; text?: string; clear?: boolean; submit?: boolean; option?: string; keys?: string;
  dy?: number; url?: string; next?: string; why?: string; x?: number; y?: number; ms?: number; instruction?: string;
  answer?: unknown; success?: boolean;
}

/** @internal the flow being recorded */
export interface Recorder {
  name: string;
  params: Record<string, unknown>;
  steps: Step[];
  output: JSONSchema;
  startUrl?: string;
  n: number;
  /** hosts the recorded steps ran on */
  hosts: Set<string>;
}

export class Ghostwright {
  readonly page: Page;
  readonly browserKind: "local" | "cdp" | "browsa";
  /** @internal */ readonly session: PageSession;
  /** @internal */ readonly secrets: Secrets;
  /** @internal */ readonly store: Store;
  /** @internal */ readonly meter: Meter;
  /** @internal */ tracer: Tracer;
  /** @internal */ recorder: Recorder | null = null;
  /** the model first, then the fallbacks, in order */
  private models: ModelClient[];
  private opened: OpenedBrowser;
  private o: GhostwrightOptions;
  private solvedOn = -1;
  private lastCall: LastCall | null = null;
  private captchaSeen = new Set<string>();
  private captchaSolves = 0;

  private constructor(o: GhostwrightOptions, opened: OpenedBrowser, session: PageSession, models: ModelClient[]) {
    this.o = o;
    this.opened = opened;
    this.page = opened.page;
    this.browserKind = opened.kind;
    this.session = session;
    this.models = models;
    this.secrets = new Secrets(o.secrets);
    this.store = new Store(o.store ?? ".ghostwright");
    this.meter = new Meter(o.maxCostUsd);
    this.tracer = new Tracer(null, this.secrets, o.debug ?? false);
    session.purchaseGuard = o.allowPurchases ? null : purchaseReason;
    session.allowedOrigins = o.allowedOrigins?.length ? o.allowedOrigins : null;
    session.secretInUrl = (url, names) => this.secrets.inUrl(url, names);
    // a store made by an older version may be readable by others: owner only from now on
    this.store.tighten();
  }

  static async create(o: GhostwrightOptions = {}): Promise<Ghostwright> {
    const specs = [...(Array.isArray(o.model) ? o.model : o.model ? [o.model] : []), ...(o.fallbackModels || [])];
    const ro = { apiKey: o.modelApiKey, cacheDir: o.cacheDir ?? defaultCacheDir(), livePrices: o.livePrices };
    const models: ModelClient[] = [];
    for (const [i, s] of specs.entries()) models.push(await resolveModel(s, { ...ro, price: i === 0 ? o.price : undefined, apiKey: i === 0 ? o.modelApiKey : undefined }));
    const opened = await (o.browser ?? local()).open();
    try {
      const session = await PageSession.attach(opened.page, { settle: o.settle });
      session.allowFileUrls = !!o.allowFileUrls;
      if (o.allowedOrigins?.length) {
        session.allowedOrigins = o.allowedOrigins;
        await session.enforceOrigins();
      }
      const gw = new Ghostwright(o, opened, session, models);
      // every value is known before the first prompt, so it is masked from the start
      await gw.secrets.prime();
      return gw;
    } catch (e) {
      await opened.close();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.session.close().catch(() => undefined);
    await this.opened.close();
  }

  /** Total model use so far. */
  usage(): Usage { return { ...this.meter.total }; }

  /** Every model call, and totals per kind of call. */
  metrics(): { total: Usage; byKind: Record<string, Usage>; calls: CallRecord[] } {
    const byKind: Record<string, Usage> = {};
    for (const c of this.meter.calls) {
      addUsage((byKind[c.kind] ??= emptyUsage()), c);
    }
    return { total: this.usage(), byKind, calls: [...this.meter.calls] };
  }

  /** @internal */
  emit(e: GhostwrightEvent): void {
    try { this.o.onEvent?.(e); } catch { /* a listener never breaks a run */ }
  }

  /** @internal start/finish of a metered call */
  begin(): { t0: number; u: Usage } { return { t0: Date.now(), u: { ...this.meter.total } }; }
  /** @internal */
  end(b: { t0: number; u: Usage }): Meta {
    const t = this.meter.total;
    return { modelCalls: t.modelCalls - b.u.modelCalls, inputTokens: t.inputTokens - b.u.inputTokens, outputTokens: t.outputTokens - b.u.outputTokens, usd: +(t.usd - b.u.usd).toFixed(6), ms: Date.now() - b.t0 };
  }

  /**
   * @internal one model call, scrubbed, metered and traced. Each model gets
   * modelTimeoutMs and one retry on a transient error; then the next model
   * of the list is asked.
   */
  async ask(kind: string, system: string, prompt: string, images?: Uint8Array[]): Promise<unknown> {
    if (!this.models.length) throw new NoModelError(kind);
    const safe = this.secrets.scrub(prompt);
    const timeout = this.o.modelTimeoutMs ?? 60000;
    let lastErr: unknown;
    let overCap: CostLimitError | undefined;
    models: for (const [i, m] of this.models.entries()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        // a model the cap does not allow (an unknown price counts high) passes to the next one
        try { this.meter.before(m, system + safe); } catch (e) {
          if (!(e instanceof CostLimitError)) throw e;
          overCap ??= e;
          this.tracer.write("model", { kind, model: m.id, status: "skipped", reason: e.message });
          continue models;
        }
        const t0 = Date.now();
        const ctl = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          const reply = await Promise.race([
            m.generate({ system, prompt: safe, images, signal: ctl.signal }),
            new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(Object.assign(new Error(`${m.id}: no answer after ${timeout} ms`), { name: "TimeoutError" })); }, timeout); }),
          ]);
          clearTimeout(timer);
          const rec = this.meter.record(kind, m, reply.usage, system + safe, reply.text, Date.now() - t0);
          this.emit({ type: "model-call", kind, model: m.id, inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, usd: rec.usd, priceAssumed: rec.priceAssumed, ms: rec.ms, hosted: !!m.hosted });
          this.tracer.write("model", { kind, model: m.id, fallback: i > 0 || undefined, retry: attempt > 0 || undefined, tokens: { input: rec.inputTokens, output: rec.outputTokens }, usd: rec.usd, ms: rec.ms });
          const answer = this.secrets.scrub(reply.text);
          this.lastCall = { kind, model: m.id, system, prompt: safe, answer, inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, usd: rec.usd, ms: rec.ms, at: rec.at };
          try { return parseJSON(reply.text); } catch (e) {
            throw new ActionError(`the model's answer was not JSON (${(e as Error).message})`, answer.slice(0, 300));
          }
        } catch (e) {
          clearTimeout(timer);
          if (e instanceof ActionError || e instanceof CostLimitError) throw e;
          // a call that timed out was sent and may be billed: it counts at its estimate
          if ((e as Error)?.name === "TimeoutError") this.meter.charged(kind, m, system + safe, Date.now() - t0);
          lastErr = e;
          this.tracer.write("model", { kind, model: m.id, status: "failed", reason: String((e as Error)?.message ?? e).slice(0, 200) });
          if (attempt === 0 && isTransient(e)) { await new Promise(r => setTimeout(r, 800)); continue; }
          break;
        }
      }
    }
    // no model could be asked within the cap, or the ones asked failed
    throw lastErr ?? overCap;
  }

  get hasModel(): boolean { return this.models.length > 0; }
  /** @internal */ get warn(): boolean { return this.o.warnings ?? true; }

  /** Debug info for the last model call: the view and prompt sent, the answer, the plan, tokens and cost. Secrets masked. */
  last(): LastCall | null { return this.lastCall ? { ...this.lastCall } : null; }

  /** @internal adds the plan (action, locators) to the last call's record */
  notePlan(plan: Record<string, unknown>): void {
    if (this.lastCall) this.lastCall.plan = this.secrets.scrubJSON(plan);
  }

  // ---- navigation -----------------------------------------------------------

  /** Opens a URL. In a flow, %param% placeholders are filled from the flow's params. */
  async goto(url: string): Promise<ActOutcome> {
    const b = this.begin();
    const vars = this.recorder ? stringify(this.recorder.params) : {};
    const real = url.replace(/%([A-Za-z_]\w*)%/g, (m, k) => (k in vars ? encodeURIComponent(vars[k]) : m));
    const r = await this.session.act({ action: "navigate", url: real });
    const ok = r.status === "ok";
    if (r.status === "challenge") await this.handleChallenge(r.challenge?.kind || "unknown");
    if (ok && this.recorder) {
      const rec = this.recorder;
      rec.startUrl ??= real;
      const tpl = url.replace(/%([A-Za-z_]\w*)%/g, (m, k) => (k in vars ? `{{${k}}}` : m));
      rec.steps.push({ id: this.stepId(), kind: "navigate", url: templatize(tpl, rec.params) });
      for (const h of hostsOf(this.session.currentURL)) rec.hosts.add(h);
    }
    this.tracer.write("goto", { url: real, status: r.status });
    return { ok, action: this.secrets.scrub(r.action), result: this.secrets.scrub(r.text), reason: r.reason, meta: this.end(b) };
  }

  /** @internal */
  stepId(): string { return "s" + ++this.recorder!.n; }

  /**
   * Is a statement about the page true? One model call. `ok` is true only
   * when the model says so and the words it cites are on the page.
   */
  async check(statement: string): Promise<CheckOutcome> {
    const b = this.begin();
    const v = await this.view("page", Math.max(this.budget(), 6000));
    const r = (await this.ask("check", P.CHECK_SYSTEM, P.checkPrompt(statement, v.text))) as { ok?: unknown; evidence?: unknown; id?: unknown };
    const text = typeof r.evidence === "string" ? this.secrets.scrub(r.evidence) : "";
    const found = !!text && onPage(text, v.text);
    const ok = r.ok === true && found;
    const el = r.id != null ? this.session.last?.byId.get(Number(r.id)) : undefined;
    this.notePlan({ check: statement, said: r.ok, evidence: text, found });
    // TODO(v0.2): in a flow, compile a passing check into an assert step that replays with no model call
    this.tracer.write("check", { instruction: statement, status: ok ? "ok" : "failed" });
    return {
      ok,
      evidence: { text, found, url: this.session.currentURL, ...(el ? { element: { id: el.id, role: el.role, name: this.secrets.scrub(el.name) } } : {}) },
      ...(r.ok === true && !found ? { reason: "the words the model cited are not on the page" } : {}),
      meta: this.end(b),
    };
  }

  /** Waits until the page can be read: requests and layout quiet, content shown. */
  waitForReady(o: { timeoutMs?: number } = {}): Promise<{ ready: boolean; ms: number; reason?: string }> {
    return this.session.waitReady(o.timeoutMs ?? 15000);
  }

  /** The open tabs with their real titles (the first is the page Ghostwright drives). */
  async tabs(): Promise<{ url: string; title: string; current: boolean }[]> {
    const pages = this.page.context().pages();
    const list = [this.page, ...pages.filter(p => p !== this.page)];
    return Promise.all(list.map(async p => ({ url: p.url(), title: await p.title().catch(() => ""), current: p === this.page })));
  }

  // ---- act --------------------------------------------------------------------

  /**
   * Does one thing on the page, described in plain words. %name% in the
   * instruction refers to variables or secrets; the model sees only the name.
   */
  async act(instruction: string, o: { variables?: Record<string, unknown> } = {}): Promise<ActOutcome> {
    const b = this.begin();
    const vars = { ...stringify(this.recorder?.params || {}), ...stringify(o.variables || {}) };
    // the secrets this instruction names, and no others
    const allowed = new Set(placeholders(instruction).filter(n => this.secrets.has(n)));
    let view = await this.view();
    const shown = this.showVars(instruction, vars);
    let d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, this.hints(allowed)))) as Decision;
    // a scroll is not what was asked unless the instruction says scroll: the
    // target is further down, so read the whole page and act on the element
    const wantsScroll = /\bscroll|\bpage ?(down|up)\b/i.test(instruction);
    const notInView = (x: Decision) => x.action === "none" || (x.action === "scroll" && !wantsScroll);
    if (notInView(d) && view.scope === "viewport") {
      view = await this.view("page", Math.max(this.budget(), 6000));
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, [P.WHOLE_PAGE_NOTE, this.hints(allowed)].filter(Boolean).join("\n")))) as Decision;
    }
    // a folded list: show all of it and ask again
    for (let i = 0; i < 2 && d.action === "expand" && d.id != null; i++) {
      view = await this.view(view.scope === "page" ? "page" : "viewport", Math.max(this.budget(), 6000), false, Number(d.id));
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, this.hints(allowed)))) as Decision;
    }
    if (d.action === "expand") d = { action: "none", why: "the list did not show the target when expanded" } as Decision;
    let scrolled = "";
    if (d.action === "scroll" && !wantsScroll) {
      // more may load further down: scroll once, then act on what is there
      const sx = await this.execute(d, vars, instruction, undefined, allowed);
      scrolled = sx.action + "; ";
      view = await this.view();
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, [P.SCROLLED_NOTE, this.hints(allowed)].filter(Boolean).join("\n")))) as Decision;
      if (d.action === "scroll") d = { action: "none", why: "the target was not found on the page (the model only scrolled)" } as Decision;
    }
    if (d.action === "none") {
      this.tracer.write("act", { instruction, status: "none", reason: d.why });
      return { ok: false, action: scrolled + "none", result: "", reason: d.why || "nothing on the page fits", meta: this.end(b) };
    }
    let ex = await this.execute(d, vars, instruction, undefined, allowed);
    // a safety guard refused it: report that, never look for another way round
    if (!ex.ok && !ex.result.guard && (this.o.selfHeal ?? true)) {
      view = await this.view();
      const note = `Your last action (${ex.action}) did not work: ${ex.reason}. Choose again.`;
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, note + "\n" + this.hints(allowed)))) as Decision;
      if (d.action !== "none") ex = await this.execute(d, vars, instruction, undefined, allowed);
    }
    // a second action inside what the first one opened (a menu, a list):
    // when the model says so, or when the click visibly opened a popup
    const opened = ex.ok && d.action === "click" && !ex.result.view && ex.result.changes.some(c =>
      (c.op === "changed" && c.id === Number(d.id) && c.fields?.expanded === "true") ||
      (c.op === "added" && ["option", "menuitem", "menuitemradio", "menuitemcheckbox", "listbox", "menu"].includes(c.role)));
    if (ex.ok && (d.next || opened)) {
      const goal = d.next || instruction;
      const note = `After ${ex.action}, this changed (what opened is listed below). Finish the instruction with one more action, or answer "none" if it is already done.`;
      const d2 = (await this.ask("two-step", P.ACT_SYSTEM, P.actPrompt(goal, ex.result.text, note))) as Decision;
      if (d2.action !== "none") {
        const ex2 = await this.execute(d2, vars, goal, undefined, allowed);
        ex = { ...ex2, action: ex.action + "; " + ex2.action, steps: [...ex.steps, ...ex2.steps] };
      }
    }
    if (ex.ok && this.recorder) this.recorder.steps.push(...ex.steps);
    this.tracer.write("act", { instruction, action: ex.action, status: ex.ok ? "ok" : "failed", reason: ex.reason, layer: "model" });
    return { ok: ex.ok, action: this.secrets.scrub(ex.action), result: this.secrets.scrub(ex.result.text), reason: ex.reason, meta: this.end(b) };
  }

  private budget(): number { return this.o.viewBudget ?? 2000; }

  /** @internal secrets stay %name%; plain variables are shown with their values */
  showVars(text: string, vars: Record<string, string>): string {
    return text.replace(/%([A-Za-z_]\w*)%/g, (m, k: string) => (this.secrets.has(k) || !(k in vars) ? m : vars[k]));
  }

  private hints(allowed: Set<string>): string {
    const names = [...allowed];
    return names.length ? `Secret placeholders you can type: ${names.map(n => `%${n}%`).join(", ")}` : "";
  }

  /** @internal the page view a model reads */
  async view(scope: "viewport" | "page" = "viewport", budget = this.budget(), fullLinks = false, expand = 0): Promise<View> {
    let v = await this.session.observe({ scope, budget, fullLinks, expand });
    if (v.state === "challenge") {
      await this.handleChallenge(v.challenge?.kind || "unknown");
      v = await this.session.observe({ scope, budget, fullLinks, expand });
    }
    if (v.state === "ok" && v.elements.some(e => e.role === "captcha")) await this.solveWidgets(v);
    return v;
  }

  /** @internal runs a model decision; returns the recipe steps it makes */
  async execute(d: Decision, vars: Record<string, string>, goal: string, stepParams?: Record<string, unknown>, allowed?: Set<string>): Promise<{ ok: boolean; reason?: string; action: string; result: ActResult; steps: Step[] }> {
    const a: Action = { action: d.action };
    let target: Target | null = null;
    let recipeText: string | undefined;
    if (d.id != null) {
      a.id = Number(d.id);
      if (!this.session.last?.byId.has(a.id)) {
        const reason = `there is no element [${d.id}] on the page`;
        return { ok: false, reason, action: `${d.action} [${d.id}]`, result: emptyResult(`${d.action} [${d.id}]`, reason), steps: [] };
      }
      target = await this.session.locators(a.id);
    }
    switch (d.action) {
      case "type": {
        // secrets: only the ones the instruction names, read at the keystroke for the field's own document
        const plan = planText(String(d.text ?? ""), vars, this.secrets, allowed ?? new Set());
        // a placeholder that is neither a secret nor a variable is never typed as text
        const left = placeholders(plan.recipe);
        if (left.length) {
          const reason = `the text holds ${left.map(n => `%${n}%`).join(", ")}, which is not a secret or variable here; nothing was typed`;
          return { ok: false, reason, action: `type [${d.id}]`, result: emptyResult(`type [${d.id}]`, reason), steps: [] };
        }
        if (plan.usedSecrets.length) {
          a.secretText = { resolve: plan.resolve, names: plan.usedSecrets };
          a.textShown = JSON.stringify(shownTokens(plan.recipe));
        } else a.text = await plan.resolve(a.id ? this.session.urlOf(a.id) : this.session.currentURL);
        recipeText = plan.recipe;
        a.clear = d.clear ?? true;
        a.submit = !!d.submit;
        break;
      }
      case "select": a.option = String(d.option ?? d.text ?? ""); break;
      case "press": a.keys = String(d.keys ?? "Enter"); break;
      case "scroll": a.dy = Number(d.dy ?? 600); break;
      case "navigate": a.url = String(d.url ?? ""); break;
      case "wait": a.ms = Math.min(Number(d.ms ?? 1000), 10000); break;
      case "back": break;
      case "click": if (d.id == null && d.x != null) { a.x = Number(d.x); a.y = Number(d.y); } break;
    }
    const r = await this.session.act(a);
    if (r.status === "challenge") await this.handleChallenge(r.challenge?.kind || "unknown");
    const chk = checkEffect(a, r, null);
    const steps: Step[] = [];
    const params = this.recorder?.params ?? stepParams;
    if (chk.ok && params) {
      const s = toStep(a, target, recipeText, chk.effect, goal, params, this.session.currentURL);
      if (s) { s.id = this.recorder ? this.stepId() : ""; steps.push(s); }
      if (this.recorder) for (const h of hostsOf(this.session.currentURL)) this.recorder.hosts.add(h);
    }
    this.notePlan({ action: r.action, ok: chk.ok, reason: chk.reason, target, effect: chk.effect, status: r.status });
    return { ok: chk.ok, reason: chk.reason, action: r.action, result: r, steps };
  }

  /** Runs an action you spell out yourself (no model), e.g. { action: "click", role: "button", name: "Save" }. */
  async do(a: Action): Promise<ActOutcome> {
    const b = this.begin();
    // %name% in typed text: a secret is typed as one (its origin rule holds); anything else is refused
    if (a.action === "type" && typeof a.text === "string" && placeholders(a.text).length) {
      const plan = planText(a.text, {}, this.secrets, new Set(placeholders(a.text).filter(n => this.secrets.has(n))));
      const left = placeholders(plan.recipe);
      if (left.length) return { ok: false, action: "type", result: "", reason: `the text holds ${left.map(n => `%${n}%`).join(", ")}, which is not a secret here; nothing was typed`, meta: this.end(b) };
      a = { ...a, text: undefined, secretText: { resolve: plan.resolve, names: plan.usedSecrets }, textShown: JSON.stringify(shownTokens(plan.recipe)) };
    }
    const r = await this.session.act(a);
    const chk = checkEffect(a, r, null);
    return { ok: chk.ok, action: this.secrets.scrub(r.action), result: this.secrets.scrub(r.text), reason: chk.reason, meta: this.end(b) };
  }

  // ---- observe ------------------------------------------------------------------

  /** With no request: the page view (no model). With one: matching elements, best first, with locators. */
  async observe(): Promise<{ view: string; elements: { id: number; role: string; name: string; state?: Record<string, string> }[] }>;
  async observe(request: string): Promise<Candidate[]>;
  async observe(request?: string): Promise<any> {
    if (!request) {
      const v = await this.view();
      return { view: this.secrets.scrub(v.text), elements: this.secrets.scrubJSON(v.elements.filter(e => e.id).map(e => ({ id: e.id, role: e.role, name: e.name, state: e.state }))) };
    }
    const v = await this.view("page", Math.max(this.budget(), 4000));
    const r = (await this.ask("observe", P.OBSERVE_SYSTEM, P.observePrompt(request, v.text))) as { matches?: { id: number; action: string; description: string }[] };
    const out: Candidate[] = [];
    for (const m of r.matches || []) {
      const el = this.session.last?.byId.get(Number(m.id));
      if (!el) continue;
      out.push({ id: el.id, role: el.role, name: this.secrets.scrub(el.name), action: m.action, description: m.description, target: await this.session.locators(el.id) });
    }
    return out;
  }

  // ---- extract ------------------------------------------------------------------

  /** Reads data off the page into a schema (zod or JSON Schema). In a flow, it is compiled for replay when possible. */
  async extract<T = any>(instruction: string, schema: unknown, o: ExtractOptions = {}): Promise<ExtractOutcome<T>> {
    const b = this.begin();
    const sch = await toSchema(schema);
    if (o.html != null || o.file != null) {
      // read from HTML of your own: a page of its own, offline, not part of a flow
      const { value } = await this.extractFromHtml(instruction, sch, o);
      this.tracer.write("extract", { instruction, layer: "model", source: o.file ? "file" : "html" });
      return { data: value as T, meta: { ...this.end(b), layer: "model" } };
    }
    let { value } = await this.modelExtract(instruction, sch, o.budget);
    let layer: ExtractOutcome<T>["meta"]["layer"] = "model";
    const rec = this.recorder;
    const id = rec ? this.stepId() : "x";
    // read the same data off the page itself: its own full text, not the
    // names the view cut short (and, in a flow, the step that replays it)
    const compiled = await compileExtract({ session: this.session, id, goal: instruction, answer: value, schema: sch, captured: this.session.captured, params: rec?.params ?? {} }).catch(() => null);
    if (compiled) value = this.secrets.scrubJSON(compiled.value);
    if (rec) {
      if (compiled) { layer = compiled.layer; rec.steps.push(...compiled.steps); }
      else rec.steps.push({ id, kind: "extract", from: "page", how: { model: true }, schema_ref: "output", goal: instruction, output_schema: sch.json });
      mergeOutput(rec.output, sch.json);
    }
    this.tracer.write("extract", { instruction, layer });
    return { data: value as T, meta: { ...this.end(b), layer } };
  }

  private async extractFromHtml(instruction: string, sch: SchemaLike, o: ExtractOptions): Promise<{ value: unknown }> {
    const html = o.html ?? (await import("node:fs")).readFileSync(o.file!, "utf8");
    // a context of its own: no scripts run, nothing is fetched, no cookies shared
    const browser = this.page.context().browser();
    const ctx = browser ? await browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: "block" }).catch(() => null) : null;
    const page = ctx ? await ctx.newPage() : await this.page.context().newPage();
    let s: PageSession | null = null;
    try {
      if (!ctx) {
        // a persistent profile has no second context: switch scripts and network off for this page
        const c = await this.page.context().newCDPSession(page);
        await c.send("Emulation.setScriptExecutionDisabled", { value: true });
        await c.send("Network.enable");
        await c.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await page.route("**/*", r => r.abort());
      }
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
      s = await PageSession.attach(page, { settle: { cap: 1000 } });
      return await this.modelExtract(instruction, sch, o.budget, s);
    } finally {
      await s?.close().catch(() => undefined);
      await page.close().catch(() => undefined);
      await ctx?.close().catch(() => undefined);
    }
  }

  /** @internal */
  async modelExtract(instruction: string, sch: SchemaLike, budget?: number, session?: PageSession): Promise<{ value: unknown }> {
    const v = session ? await session.observe({ scope: "page", budget: budget ?? 12000, fullLinks: true }) : await this.view("page", budget ?? 12000, true);
    let err: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.ask("extract", P.EXTRACT_SYSTEM, P.extractPrompt(instruction, sch.json, v.text, err));
      const c = sch.check(coerce(sch.json, raw));
      // what the view cut short ("…"), completed from the page
      if (c.ok) return { value: this.secrets.scrubJSON(await completeCut(session ?? this.session, c.value)) };
      err = c.error;
    }
    throw new ActionError(`the extracted data does not fit the schema: ${err}`);
  }

  // ---- agent ----------------------------------------------------------------------

  /**
   * Works on a task step by step until done. In a flow, every step is
   * recorded. The model never sees a step budget; on the last allowed step
   * it must answer with what it has. A run that repeats itself or keeps
   * doing nothing is stopped as "stalled".
   */
  async agent(task: string, o: AgentOptions = {}): Promise<AgentOutcome> {
    const b = this.begin();
    const maxSteps = Math.max(1, o.maxSteps ?? 20);
    const st = { repeatNote: 2, repeatStop: 4, idleNote: 3, idleStop: 6, ...(o.stall || {}) };
    const hybrid = o.mode === "hybrid";
    const system = hybrid ? P.AGENT_SYSTEM + "\n" + P.AGENT_HYBRID : P.AGENT_SYSTEM;
    const vars = stringify(this.recorder?.params || {});
    const history: string[] = [];
    const seen = new Map<string, number>();
    let idle = 0, emptyAnswers = 0, uncited = 0;
    let lastEffect = "nothing done yet";
    let cited: { text: string; found: boolean } | undefined;
    const out = (status: AgentOutcome["status"], success: AgentOutcome["success"], answer: unknown, steps: number): AgentOutcome => {
      this.tracer.write("agent", { action: "end", status, reason: String(success) });
      return { status, success, answer: answer ?? null, steps, history, evidence: { url: this.session.currentURL, title: this.session.last?.title ?? "", lastEffect, ...(cited ? { cited } : {}) }, meta: this.end(b) };
    };
    // the secrets the task names, or the ones listed in agent({ secrets }); no others
    const allowed = new Set([...placeholders(task), ...(o.secrets || [])].filter(n => this.secrets.has(n)));
    let expand = 0;
    for (let step = 1; step <= maxSteps; step++) {
      const final = step === maxSteps;
      const v = await this.view("viewport", expand ? Math.max(this.budget(), 6000) : this.budget(), false, expand);
      expand = 0;
      const notes: string[] = [];
      if (idle >= st.idleNote) notes.push(`Your last ${idle} actions changed nothing on the page. Try a different approach, or finish with done.`);
      // no screenshot while a field holding a secret is on screen: the picture would show it
      let images: Uint8Array[] | undefined;
      // also when the page shows a secret's value anywhere in view (mirrored, echoed)
      if (hybrid && (this.session.secretOnScreen || this.secrets.leaks(v.text))) notes.push("No screenshot this step: a secret is on screen.");
      else if (hybrid) images = [new Uint8Array(await this.page.screenshot({ type: "png" }))];
      const d = (await this.ask("agent", system, P.agentPrompt(this.showVars(task, vars), history, v.text + "\n" + this.hints(allowed), notes, final), images)) as Decision;
      if (d.action === "done") {
        let success: AgentOutcome["success"] = d.success === true ? true : d.success === false ? false : "unknown";
        if (success === true && degenerate(d.answer, task)) {
          if (!final && ++emptyAnswers <= 2) {
            history.push(`${step}. done refused: the answer was empty or a placeholder. Give the actual result you found.`);
            continue;
          }
          return out("done", "unknown", d.answer, step);
        }
        // a claimed success cites what it saw: words on this page or in what the run saw
        const ev = (d as any).evidence;
        const words = this.secrets.scrub(typeof ev === "string" ? ev : typeof ev?.text === "string" ? ev.text : "");
        cited = { text: words, found: !!words && onPage(words, v.text, history.join("\n")) };
        if (success === true && !cited.found) {
          if (!final && ++uncited <= 1) {
            history.push(`${step}. done refused: cite the words on the page that show the result in "evidence": {"text": ...}, copied exactly.`);
            continue;
          }
          success = "unknown";
        }
        return out("done", success, d.answer, step);
      }
      if (final) {
        // the last step: only an answer is accepted
        history.push(`${step}. ${d.action} not done: it was the last step and an answer was due`);
        return out("max_steps", false, null, step);
      }
      if (d.action === "expand" && d.id != null) {
        // the next view shows the whole list
        expand = Number(d.id);
        history.push(`${step}. expand [${d.id}] -> the list is shown in full below`);
        continue;
      }
      if (d.action === "extract") {
        const { value } = await this.modelExtract(d.instruction || task, await toSchema({ type: "object" }));
        lastEffect = "read data";
        history.push(`${step}. extract ${JSON.stringify(d.instruction || "")} -> ${this.secrets.scrub(JSON.stringify(value)).slice(0, 800)}`);
        idle = 0;
        continue;
      }
      // the same action on the same page, again
      const fp = fingerprint(this.session.currentURL, v.text, d);
      const n = (seen.get(fp) || 0) + 1;
      seen.set(fp, n);
      if (n >= st.repeatStop) {
        history.push(`${step}. stopped: ${d.action} on the same page ${n} times`);
        return out("stalled", false, null, step);
      }
      let ex: Awaited<ReturnType<Ghostwright["execute"]>>;
      try { ex = await this.execute(d, vars, d.why || task, undefined, allowed); } catch (e) {
        // a refused secret is a failed step the model hears about, not the end of the run
        if (!(e instanceof SecretNotAllowedError || e instanceof SecretOriginError)) throw e;
        const reason = (e as Error).message;
        ex = { ok: false, reason, action: `${d.action}${d.id != null ? ` [${d.id}]` : ""}`, result: emptyResult(d.action, reason), steps: [] };
      }
      if (ex.ok && this.recorder) this.recorder.steps.push(...ex.steps);
      lastEffect = this.secrets.scrub(effectVerdict(d, ex));
      const changed = ex.ok && !/^no change/.test(lastEffect);
      idle = changed ? 0 : idle + 1;
      const detail = changed ? this.secrets.scrub(ex.result.text).split("\n").slice(1, 9).join("\n") : "";
      let line = `${step}. ${this.secrets.scrub(ex.action)} -> ${lastEffect}`;
      if (n >= st.repeatNote) line += `\n(note: you have done this ${n} times on this same page; it is not getting anywhere)`;
      history.push(detail ? `${line}\n${detail}` : line);
      this.tracer.write("agent", { step, action: ex.action, status: ex.ok ? "ok" : "failed", reason: ex.reason });
      if (idle >= st.idleStop) return out("stalled", false, null, step);
    }
    return out("max_steps", false, null, maxSteps);
  }

  // ---- flows -----------------------------------------------------------------------

  /** Starts recording a flow. Its steps become a recipe on save(). */
  async flow(name: string, o: { params?: Record<string, unknown> } = {}): Promise<Flow> {
    if (this.recorder) throw new GhostwrightError("flow_open", `flow "${this.recorder.name}" is still recording: save() it first`);
    const n = recipeName(name);
    this.recorder = { name: n, params: o.params || {}, steps: [], output: { type: "object", properties: {}, required: [] }, n: 0, hosts: new Set() };
    this.tracer = new Tracer(this.store.traceFile(`${n}-record-${Date.now()}`), this.secrets, this.o.debug ?? false);
    return new Flow(this, n);
  }

  /** Replays a saved flow: no model calls while nothing changed; one call to repair a broken step. */
  async run<T = any>(name: string, params: Record<string, unknown> = {}, o: RunOptions = {}): Promise<RunResult<T>> {
    if (this.recorder) throw new GhostwrightError("flow_open", `flow "${this.recorder.name}" is still recording: save() it first`);
    const n = recipeName(name);
    this.tracer = new Tracer(this.store.traceFile(`${n}-run-${Date.now()}`), this.secrets, this.o.debug ?? false);
    return runFlow<T>(this, n, params, o);
  }

  /** Makes an earlier version of a flow the active one. */
  rollback(name: string, version?: number): Recipe { return this.store.rollback(recipeName(name), version); }

  /** Makes a repaired version that waits for review (run().draft) the active one. */
  promote(name: string, version?: number): Recipe {
    const r = this.store.promoteDraft(recipeName(name), version);
    this.emit({ type: "promote", flow: r.name, version: r.version });
    this.tracer.write("promote", { flow: r.name, version: r.version, by: "promote()" });
    return r;
  }

  // ---- Browsa cloud (optional, credits) -----------------------------------------------

  private cloudClient?: BrowsaCloud;
  private cloud(): BrowsaCloud {
    return (this.cloudClient ??= new BrowsaCloud(this.store, { secrets: this.secrets, apiKey: this.o.browsaApiKey, baseUrl: this.o.browsaBaseUrl, fetch: this.o.browsaFetch }));
  }

  /** Browsa cloud: uploads a saved flow as a Browsa recipe. Returns its id and price per run. */
  push(name: string, o?: PushOptions): Promise<PushResult> { return this.cloud().push(recipeName(name), o); }

  /** Browsa cloud: runs a flow on Phantom (captchas solved server-side, repairs on Browsa). Pushes it first when needed. */
  runOnBrowsa<T = any>(name: string, params: Record<string, unknown> = {}, o?: { timeoutMs?: number; proxy?: Record<string, unknown>; push?: PushOptions }): Promise<CloudRun<T>> {
    return this.cloud().run<T>(recipeName(name), params, o);
  }

  /** Browsa cloud: creates or updates a robot (scheduled runs, rows, alerts) from a flow. */
  robot(name: string, o?: RobotOptions): Promise<Record<string, any>> { return this.cloud().robot(recipeName(name), o); }

  /** Browsa cloud: deletes the flow's robot and recipe on Browsa (the local flow stays). */
  unpush(name: string): Promise<{ robotId?: string; recipeId?: string }> { return this.cloud().unpush(recipeName(name)); }

  // ---- captchas -------------------------------------------------------------------

  /** @internal a full-page bot check */
  async handleChallenge(kind: string): Promise<void> {
    const t0 = Date.now();
    if (this.browserKind === "browsa") {
      // Phantom's in-session solver works on the server: wait for it
      this.emit({ type: "captcha", kind, where: "phantom", status: "waiting" });
      for (let i = 0; i < 45; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const v = await this.session.observe({});
        if (v.state !== "challenge") {
          this.emit({ type: "captcha", kind, where: "phantom", status: "passed", ms: Date.now() - t0 });
          this.tracer.write("captcha", { kind, status: "passed", ms: Date.now() - t0 });
          return;
        }
      }
      this.emit({ type: "captcha", kind, where: "phantom", status: "failed", ms: Date.now() - t0 });
      throw new ChallengeError(kind, this.session.currentURL);
    }
    if (this.o.captcha && (await this.solveTokens(kind))) return;
    throw new ChallengeError(kind, this.session.currentURL, `${kind} bot check on ${this.session.currentURL}: run on Phantom (browsa()) or pass captcha: browsaCaptcha() for token captchas`);
  }

  private async solveWidgets(v: View): Promise<void> {
    if (this.solvedOn === this.session.documentEpoch) return;
    this.solvedOn = this.session.documentEpoch;
    const kind = v.elements.find(e => e.role === "captcha")?.name || "captcha";
    if (this.browserKind === "browsa") { this.emit({ type: "captcha", kind, where: "phantom", status: "waiting" }); return; }
    if (this.o.captcha) await this.solveTokens(kind);
  }

  private async solveTokens(kind: string): Promise<boolean> {
    const all = await findTokenCaptchas(this.page).catch(() => []);
    if (!all.length || !this.o.captcha) return false;
    // one solve per widget (kind + sitekey) and page, at most 2 per page and maxCaptchaSolves (5) per Ghostwright: solves cost credits
    const page = this.session.documentEpoch;
    const found = all.filter((c, i) => all.findIndex(x => x.kind === c.kind && x.sitekey === c.sitekey) === i && !this.captchaSeen.has(`${page}:${c.kind}:${c.sitekey}`));
    for (const c of found) {
      const onPage = [...this.captchaSeen].filter(k => k.startsWith(page + ":")).length;
      if (onPage >= 2 || this.captchaSolves >= (this.o.maxCaptchaSolves ?? 5)) {
        throw new ChallengeError(kind, this.session.currentURL, `captcha solve limit reached (${this.captchaSolves} this run; maxCaptchaSolves ${this.o.maxCaptchaSolves ?? 5})`);
      }
      this.captchaSeen.add(`${page}:${c.kind}:${c.sitekey}`);
      this.captchaSolves++;
      const t0 = Date.now();
      this.emit({ type: "captcha", kind: c.kind, where: "local", status: "solving" });
      try {
        const token = await this.o.captcha.solve(c);
        await injectToken(this.page, c, token);
        this.emit({ type: "captcha", kind: c.kind, where: "local", status: "passed", ms: Date.now() - t0 });
      } catch (e) {
        this.emit({ type: "captcha", kind: c.kind, where: "local", status: "failed", ms: Date.now() - t0 });
        throw new ChallengeError(kind, this.session.currentURL, `could not solve ${c.kind}: ${(e as Error).message}`);
      }
    }
    return true;
  }
}

/** A flow being recorded. Each call is the same as on Ghostwright and is saved as a step. */
export class Flow {
  constructor(private gw: Ghostwright, readonly name: string) {}

  goto(url: string) { return this.gw.goto(url); }
  act(instruction: string, o?: { variables?: Record<string, unknown> }) { return this.gw.act(instruction, o); }
  extract<T = any>(instruction: string, schema: unknown, o?: { budget?: number }) { return this.gw.extract<T>(instruction, schema, o); }
  observe(request: string) { return this.gw.observe(request); }
  agent(task: string, o?: AgentOptions) { return this.gw.agent(task, o); }

  /** The steps so far (scrubbed). */
  get steps(): Step[] { return this.gw.secrets.safeRecipe({ steps: this.gw.recorder?.steps ?? [] }).steps; }

  /** Writes the recipe to the store and stops recording. Saving again makes a new version. */
  async save(o: { repair?: "auto" | "review" | "off" } = {}): Promise<Recipe> {
    const rec = this.gw.recorder;
    if (!rec || rec.name !== this.name) throw new GhostwrightError("flow_closed", `flow "${this.name}" is not recording`);
    if (!rec.steps.length) throw new GhostwrightError("flow_empty", `flow "${this.name}" has no steps`);
    const prev = this.gw.store.load(rec.name);
    const assertions: Recipe["assertions"] = [];
    const lists = Object.entries(rec.output.properties || {}).filter(([, s]: any) => s.type === "array").map(([k]) => k);
    const lastExtract = [...rec.steps].reverse().find(s => s.kind === "extract");
    if (lastExtract) for (const k of lists) assertions.push({ after: lastExtract.id, expr: `output.${k}.length >= 1` });
    const recipe: Recipe = this.gw.secrets.safeRecipe({
      name: rec.name,
      version: (prev?.version ?? 0) + 1,
      params: paramsSchema(rec.params),
      output: rec.output,
      ...(rec.startUrl ? { start_url: templatize(rec.startUrl, rec.params) } : {}),
      steps: rec.steps,
      ...(assertions.length ? { assertions } : {}),
      // a flow that types secrets keeps its repairs for review unless told otherwise
      repair: { mode: o.repair ?? (rec.steps.some(s => /\{\{\s*(secret|totp)\s*:/.test(s.text || "")) ? "review" : "auto"), max_steps: 3 },
      meta: { created_at: new Date().toISOString(), recorded_with: "ghostwright", hosts: [...rec.hosts].sort() },
    });
    this.gw.store.promote(recipe);
    this.gw.recorder = null;
    this.gw.tracer.write("save", { flow: recipe.name, version: recipe.version, steps: recipe.steps.length });
    // an extract that did not compile calls the model on every run
    for (const s of recipe.steps) {
      if (s.kind !== "extract" || !s.how?.model) continue;
      const message = `flow "${recipe.name}": extract ${s.id} (${JSON.stringify(s.goal || "")}) did not compile to a page read; each run calls the model for it`;
      this.gw.emit({ type: "warning", flow: recipe.name, step: s.id, message });
      this.gw.tracer.write("warning", { flow: recipe.name, step: s.id, message });
      if (this.gw.warn) console.warn("[ghostwright] " + message);
    }
    return recipe;
  }

  /** Stops recording without saving. */
  discard(): void { if (this.gw.recorder?.name === this.name) this.gw.recorder = null; }
}

// ---- helpers ------------------------------------------------------------------------

/** What an action did, in a few words: navigated, changed, no change; for typing, what the field now holds. */
export function effectVerdict(d: { action: string; id?: number }, ex: { ok: boolean; reason?: string; result: ActResult }): string {
  const r = ex.result;
  if (!ex.ok) return `did not work: ${ex.reason}`;
  if (r.navigation && !r.navigation.sameDocument) return `navigated to ${r.navigation.url}`;
  if (d.action === "type") {
    const c = r.changes.find(x => x.id === Number(d.id) && x.fields && ("value" in x.fields || "pw" in x.fields || "secret" in x.fields));
    if (c?.fields?.secret !== undefined || c?.fields?.pw !== undefined) return "the field now holds a value (hidden)";
    if (c?.fields?.value !== undefined) return `the field now holds ${JSON.stringify(c.fields.value)}`;
  }
  if (r.navigation?.sameDocument) return `the address changed to ${r.navigation.url}`;
  if (r.view) return `the page changed a lot (${r.freshReason})`;
  if (r.changes.length) return `changed (${r.changes.length} ${r.changes.length === 1 ? "thing" : "things"})`;
  if (r.newTabs.length) return `opened a tab: ${r.newTabs[0]}`;
  if (r.dialog) return `a dialog opened: ${r.dialog.message}`;
  return "no change";
}

/** The same action on the same page. */
function fingerprint(url: string, view: string, d: Decision): string {
  let h = 5381;
  const s = url + "\n" + view + "\n" + JSON.stringify([d.action, d.id, d.text, d.x, d.y, d.url, d.keys, d.dy, d.option]);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// "…" where the text was cut; a model may close a bracket or quote after it ("(Notes From…)")
const CUT = /^(.{10,}?)\s*(?:…|\.\.\.)[\s)\]}"'”’»]*$/s;

/** Strings the model copied cut short ("…" where the view stopped), completed from the page when only one text fits. */
export async function completeCut(session: PageSession, value: unknown): Promise<unknown> {
  const cut = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { const m = CUT.exec(v); if (m) cut.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  if (!cut.size) return value;
  let full: Record<string, string | null> = {};
  try { full = await session.complete([...cut].slice(0, 500)); } catch { return value; }
  const fix = (v: unknown): unknown => {
    if (typeof v === "string") { const m = CUT.exec(v); return m && full[m[1]] ? full[m[1]] : v; }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return fix(value);
}

/** Are these words (from a model) on the page, or in what the run saw? Case and spacing aside. */
export function onPage(words: string, ...texts: string[]): boolean {
  // the view quotes page text and joins table cells with " | ": neither counts
  const n = (s: string) => s.toLowerCase().replace(/\\"/g, '"').replace(/[‘’]/g, "'").replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  const w = n(words);
  if (w.length < 2) return false;
  const hay = texts.map(n);
  if (hay.some(t => t.includes(w))) return true;
  // cells of one row, cited together
  const parts = w.split(/\s*\|\s*/).filter(p => p.length >= 2);
  const lines = texts.flatMap(t => t.split("\n")).map(n);
  return parts.length > 1 && lines.some(line => parts.every(p => line.includes(p)));
}

/** An answer that says nothing: empty, a placeholder, or the task read back. */
export function degenerate(answer: unknown, task = ""): boolean {
  if (answer == null) return true;
  if (typeof answer === "object") return Object.keys(answer as object).length === 0 || Object.values(answer as object).every(v => degenerate(v));
  const s = String(answer).trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (!s || /^[\W_]+$/.test(s)) return true;
  if (/^(done|ok|okay|yes|no answer|n\/?a|none|null|undefined|unknown|task (is )?(complete|completed|done)|completed|finished|success|see above|as requested)$/.test(s)) return true;
  return !!task && s === task.trim().toLowerCase();
}

function emptyResult(action: string, reason: string): ActResult {
  return { action, status: "failed", reason, changes: [], newTabs: [], downloads: [], errors: [], errorCount: 0, failedRequests: [], settle: { quietAfterMs: 0, waitedMs: 0, capHit: false, requests: [], requestCount: 0 }, text: `after: ${action}\nfailed: ${reason}` };
}

function stringify(o: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
}

function mergeOutput(out: JSONSchema, s: JSONSchema): void {
  if (s.type === "object" && s.properties) {
    Object.assign(out.properties, s.properties);
    out.required = [...new Set([...(out.required || []), ...(s.required || [])])];
  } else {
    out.properties.value = s;
  }
}

/** Did the action do what it should? (a click that changed nothing did not work) */
export function checkEffect(a: Action, r: ActResult, want: Effect | null): { ok: boolean; reason?: string; effect: Effect } {
  if (r.status !== "ok") return { ok: false, reason: `${r.status}: ${r.reason}`, effect: { kind: "none" } };
  const moved = !!r.navigation && !r.navigation.sameDocument;
  const changed = moved || !!r.view || r.changes.length > 0 || r.newTabs.length > 0 || r.downloads.length > 0 || !!r.dialog || !!r.navigation;
  const nav: Effect = { kind: "navigate", path: r.navigation ? safePath(r.navigation.url) : undefined };
  switch (a.action) {
    case "type": {
      if (!a.text) return { ok: true, effect: { kind: "none" } };
      const took = r.view || r.changes.some(c => c.id === a.id && c.fields && ("value" in c.fields || "pw" in c.fields || "secret" in c.fields));
      if (took || moved) return { ok: true, effect: moved ? nav : { kind: "value" } };
      return { ok: false, reason: "the field did not take the text", effect: { kind: "none" } };
    }
    case "click":
    case "check":
    case "uncheck":
    case "press":
    case "select": {
      const eff: Effect = moved ? nav : changed ? { kind: "change" } : { kind: "none" };
      if (want) {
        if (want.kind === "navigate" && !moved && !r.navigation) return { ok: false, reason: "the page did not navigate as when the flow was recorded", effect: eff };
        if (want.kind === "change" && !changed) return { ok: false, reason: "no visible effect", effect: eff };
        return { ok: true, effect: eff };
      }
      if (!changed && (a.action === "click" || a.action === "press")) return { ok: false, reason: "no visible effect", effect: eff };
      return { ok: true, effect: eff };
    }
    case "navigate":
      return { ok: true, effect: nav };
  }
  return { ok: true, effect: { kind: "none" } };
}

function safePath(u: string): string | undefined {
  try { return new URL(u).pathname; } catch { return undefined; }
}

/** A recipe step for an action that worked. */
export function toStep(a: Action, target: Target | null, recipeText: string | undefined, effect: Effect, goal: string, params: Record<string, unknown>, pageURL: string): Step | null {
  // locators that contain a param value replay with the next run's value
  const tg = target ? (Object.fromEntries(Object.entries(target).map(([k, v]) => [k, k === "xpath" ? v : templatize(String(v), params)])) as Target) : undefined;
  const base = { id: "", goal: goal.slice(0, 500), effect: effect.kind === "navigate" && effect.path ? { ...effect, path: templatizePath(effect.path, params) } : effect };
  switch (a.action) {
    case "click": return tg ? { ...base, kind: "click", target: tg } : null;
    case "check":
    case "uncheck": return tg ? { ...base, kind: "click", target: tg, state: a.action === "check" ? "checked" : "unchecked" } : null;
    case "hover": return tg ? { ...base, kind: "wait", for: { target: tg }, hover: true } : null;
    case "type": return tg ? { ...base, kind: "type", target: tg, text: templatize(recipeText ?? a.text ?? "", params), clear: a.clear, submit: a.submit || undefined } : null;
    case "select": return tg ? { ...base, kind: "select", target: tg, value: templatize(a.option || "", params) } : null;
    case "press": return { ...base, kind: "press", keys: a.keys };
    case "scroll": return { ...base, kind: "scroll", value: String(a.dy ?? 600) };
    case "navigate": return { ...base, kind: "navigate", url: templatize(a.url || pageURL, params) };
    case "wait": return { ...base, kind: "wait", timeout_ms: Math.max(100, a.ms || 100) };
  }
  return null;
}

export { render };
