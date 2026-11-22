// Ghostwright: act, observe, extract and agent over a compact page view;
// flows recorded as recipes and replayed with no model.
import { join } from "node:path";
import type { Page } from "playwright-core";
import { local, type BrowserSource, type OpenedBrowser } from "./browser.js";
import { findTokenCaptchas, injectToken, type CaptchaSolver } from "./captcha.js";
import { BrowsaCloud, type CloudRun, type PushOptions, type PushResult, type RobotOptions } from "./cloud.js";
import { compileExtract } from "./compile.js";
import { PageSession, type Action, type ActResult, type Target } from "./engine/session.js";
import type { Change } from "./engine/diff.js";
import type { SettleConfig } from "./engine/settle.js";
import type { View } from "./engine/view.js";
import { ActionError, ChallengeError, CostLimitError, GhostwrightError, NoModelError, SecretOriginError } from "./errors.js";
import { purchaseReason, SUBMIT_GUARD } from "./guard.js";
import { defaultCacheDir, isTransient, parseJSON, resolveModel, retryDelay, type ModelClient, type ModelSpec, type Price } from "./model/index.js";
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
  /** when an action opens a new tab, go on working in that tab, as a person would (default true); false stays in the first tab */
  followNewTabs?: boolean;
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
  /** one CSS selector from the top document; an element in a frame comes after its frames: "iframe >>> button" */
  selector?: string;
  /** the frame the element is in (its address without the query), when it is in one */
  frame?: string;
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
  /** when nothing is read while the page is still at work (a request in flight, "Running…"), how long to wait for it before reading once more (ms, default 15000; 0 turns it off) */
  waitMs?: number;
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
  answer?: unknown; success?: boolean; accept?: boolean;
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
  /** when the last step was recorded, and how many steps had been by then */
  lastAt: number;
  stamped: number;
  /** instructions that failed while recording: they are not in the flow */
  failed: string[];
}

export class Ghostwright {
  /** the tab Ghostwright works in: a link that opens a new tab moves it there, as a person would follow it */
  page: Page;
  readonly browserKind: "local" | "cdp" | "browsa";
  /** @internal */ session: PageSession;
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
    session.submitGuard = o.allowPurchases ? null : SUBMIT_GUARD;
    session.allowedOrigins = o.allowedOrigins?.length ? o.allowedOrigins : null;
    session.secretInUrl = (url, names) => this.secrets.inUrl(url, names);
    // a store made by an older version may be readable by others: owner only from now on
    this.store.tighten();
  }

  /**
   * Opens the browser (local Chrome unless `browser` says otherwise) and returns a Ghostwright on its tab.
   * A model whose key is missing is reported here, before any browser starts.
   */
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

  /** Closes a browser Ghostwright started; detaches from one it attached to (`cdp()`), which keeps running. */
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
          if (attempt === 0 && isTransient(e)) { await new Promise(r => setTimeout(r, retryDelay(e))); continue; }
          break;
        }
      }
    }
    // no model could be asked within the cap, or the ones asked failed
    throw lastErr ?? overCap;
  }

  /** Is a model configured? Without one, run() replays and nothing is repaired. */
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
      this.stamp();
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

  /** @internal after an action that opened a tab: work in that tab from now on */
  async followNewTab(r: ActResult): Promise<void> {
    if (r.status !== "ok" || !r.newTabs.length || this.o.followNewTabs === false) return;
    const ctx = this.page.context();
    let p: Page | undefined;
    for (let i = 0; i < 30 && !p; i++) {
      p = ctx.pages().filter(x => x !== this.page && !x.isClosed()).pop();
      if (!p) await new Promise(res => setTimeout(res, 100));
    }
    if (!p) return;
    await p.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
    if (p.isClosed()) return;
    const next = await this.session.follow(p, { settle: this.o.settle });
    await this.session.close().catch(() => undefined);
    this.session = next;
    this.page = p;
    await p.bringToFront().catch(() => undefined);
    this.tracer.write("tab", { url: p.url() });
  }

  /** The open tabs with their real titles (the first is the tab Ghostwright works in). */
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
    const ex = await this.actCore(instruction, vars, allowed);
    if (ex.ok && this.recorder) this.recorder.steps.push(...ex.steps);
    if (!ex.ok && this.recorder) this.recorder.failed.push(instruction);
    this.stamp();
    this.tracer.write("act", { instruction, action: ex.action, status: ex.ok ? "ok" : "failed", reason: ex.reason, layer: "model" });
    return { ok: ex.ok, action: this.secrets.scrub(ex.action), result: this.secrets.scrub(ex.result?.text ?? ""), reason: ex.reason, meta: this.end(b) };
  }

  /**
   * @internal one instruction: the model picks, Ghostwright acts and checks. Also what a replay
   * repair runs (with a note on what the step did when recorded, and the run's params).
   */
  async actCore(instruction: string, vars: Record<string, string>, allowed: Set<string>, extra = "", stepParams?: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; action: string; result: ActResult | null; steps: Step[] }> {
    const hint = (...xs: string[]) => [extra, ...xs, this.hints(allowed)].filter(Boolean).join("\n");
    let view = await this.view();
    const shown = this.showVars(instruction, vars);
    let d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, hint()))) as Decision;
    // a scroll is not what was asked unless the instruction says scroll: the
    // target is further down, so read the whole page and act on the element
    const wantsScroll = /\bscroll|\bpage ?(down|up)\b/i.test(instruction);
    const notInView = (x: Decision) => x.action === "none" || (x.action === "scroll" && !wantsScroll);
    if (notInView(d) && view.scope === "viewport") {
      view = await this.view("page", Math.max(this.budget(), 6000), false, 0, true);
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, hint(P.WHOLE_PAGE_NOTE)))) as Decision;
    }
    // a folded list: show all of it and ask again
    for (let i = 0; i < 2 && d.action === "expand" && d.id != null; i++) {
      view = await this.view(view.scope === "page" ? "page" : "viewport", Math.max(this.budget(), 6000), false, Number(d.id));
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, hint()))) as Decision;
    }
    if (d.action === "expand") d = { action: "none", why: "the list did not show the target when expanded" } as Decision;
    let scrolled = "";
    if (d.action === "scroll" && !wantsScroll) {
      // more may load further down: scroll once, then act on what is there
      const sx = await this.execute(d, vars, instruction, stepParams, allowed);
      scrolled = sx.action + "; ";
      view = await this.view();
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, hint(P.SCROLLED_NOTE)))) as Decision;
      if (d.action === "scroll") d = { action: "none", why: "the target was not found on the page (the model only scrolled)" } as Decision;
    }
    if (d.action === "none") return { ok: false, action: scrolled + "none", result: null, reason: d.why || "nothing on the page fits", steps: [] };
    let ex = await this.execute(d, vars, instruction, stepParams, allowed);
    if (ex.ok && d.action === "dialog" && this.recorder?.steps.length) answerOn(this.recorder.steps[this.recorder.steps.length - 1], d, ex.dialogText);
    // a safety guard refused it: report that, never look for another way round
    if (!ex.ok && !ex.result.guard && (this.o.selfHeal ?? true)) {
      view = await this.view();
      const note = `Your last action (${ex.action}) did not work: ${ex.reason}. Choose again.`;
      d = (await this.ask("act", P.ACT_SYSTEM, P.actPrompt(shown, view.text, hint(note)))) as Decision;
      if (d.action !== "none") ex = await this.execute(d, vars, instruction, stepParams, allowed);
    }
    // More to do after the first action? When the model says so ("next"), when the action opened
    // something to choose in (a menu, a list), when it left a JavaScript dialog open, or when the
    // instruction has several parts ("... and ...", "... then ..."). The model is
    // shown the page as it is now and what was done, and answers "none" when nothing is left: ok
    // means the whole instruction, not its first part.
    // (quoted text is left out: "type 'bread and butter'" is one part)
    const multi = /\b(and|then|after that|afterwards)\b/i.test(instruction.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, " "));
    let lastD = d;
    for (let i = 0; i < 3 && ex.ok && ex.result; i++) {
      const r = ex.result;
      const opened = lastD.action === "click" && !r.view && (r.changes.some(c =>
        (c.op === "changed" && c.id === Number(lastD.id) && c.fields?.expanded === "true") ||
        (c.op === "added" && ["option", "menuitem", "menuitemradio", "menuitemcheckbox", "listbox", "menu"].includes(c.role))) || opensChoice(instruction, r.changes, Number(lastD.id)));
      const dialogOpen = !!r.dialog && lastD.action !== "dialog";
      const left = typeof lastD.next === "string" ? lastD.next.trim() : "";
      // a hover is never the whole of an instruction that does not ask for a hover: it showed something to act on
      const hoverOnly = lastD.action === "hover" && i === 0 && !/hover|mouse ?over|point(er)? (at|to|over)/i.test(instruction);
      if (!(left || opened || dialogOpen || hoverOnly || (multi && i === 0 && !["scroll", "none"].includes(lastD.action)))) break;
      // What a click opened (a menu, a list, a panel) is shown as what changed, with the wording 0.1
      // used: the model picks in it, or answers "none". A confirmation the instruction did not ask
      // for is left for the next instruction. In the other cases (a dialog, several parts) the model
      // sees the whole page as it is now and is told what was done.
      const inOpened = opened && !dialogOpen;
      const goal = instruction;
      const asked = inOpened ? (left || shown) : shown;
      const note = inOpened
        ? `After ${this.secrets.scrub(ex.action)}, this changed (what opened is listed below). Finish the instruction with one more action, or answer "none" if it is already done. If what opened only asks to confirm (a confirmation box), answer "none" unless the instruction says to confirm.`
        : `Already done: ${this.secrets.scrub(ex.action)}. Do not do that again.${left ? ` You said this is left: ${JSON.stringify(left.slice(0, 200))}.` : ""} The page as it is now is below. If the instruction is now fully carried out, answer {"action": "none"}: do nothing it does not ask for. Only if a part of it is still left, give the one next action.`;
      const text = inOpened ? r.text : (await this.view()).text;
      const d2 = (await this.ask("two-step", P.ACT_SYSTEM, P.actPrompt(asked, text, hint(note)))) as Decision;
      if (d2.action === "none" && notYet(d2.why)) {
        // "none, but it is not finished yet": the page is still at work. Wait for it and ask once more;
        // a second "not yet" is not done.
        await this.session.waitReady(8000).catch(() => undefined);
        const d3 = (await this.ask("two-step", P.ACT_SYSTEM, P.actPrompt(asked, (await this.view()).text, hint(note)))) as Decision;
        if (d3.action === "none") {
          if (notYet(d3.why)) ex = { ...ex, ok: false, reason: `not done yet: ${String(d3.why).slice(0, 160)}` };
          break;
        }
        Object.assign(d2, d3);
      }
      if (d2.action === "none" || sameDecision(d2, lastD)) break;
      const ex2 = await this.execute(d2, vars, goal, stepParams, allowed);
      // a dialog answered right after the action that opened it belongs to that step
      if (ex2.ok && d2.action === "dialog" && ex.steps.length) answerOn(ex.steps[ex.steps.length - 1], d2, ex2.dialogText);
      ex = { ...ex2, action: ex.action + "; " + ex2.action, steps: [...ex.steps, ...ex2.steps] };
      lastD = d2;
    }
    if (scrolled && ex.ok) ex = { ...ex, action: scrolled + ex.action };
    return ex;
  }

  /** @internal a warning: an event, a trace line, and console.warn unless warnings are off */
  warning(message: string, extra: Record<string, unknown> = {}): void {
    this.emit({ type: "warning", message, ...extra } as any);
    this.tracer.write("warning", { message, ...extra });
    if (this.warn) console.warn("[ghostwright] " + message);
  }

  /** @internal the steps recorded since the last call get the time that passed (a replay waits about that long for a late element) */
  stamp(): void {
    const rec = this.recorder;
    if (!rec) return;
    const now = Date.now();
    if (rec.steps.length > rec.stamped) {
      const s = rec.steps[rec.stamped];
      if (rec.stamped > 0) s.after_ms = Math.min(60000, Math.max(0, now - rec.lastAt));
      rec.stamped = rec.steps.length;
    }
    rec.lastAt = now;
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
  async view(scope: "viewport" | "page" = "viewport", budget = this.budget(), fullLinks = false, expand = 0, allItems = false): Promise<View> {
    let v = await this.session.observe({ scope, budget, fullLinks, expand, allItems });
    if (v.state === "challenge") {
      await this.handleChallenge(v.challenge?.kind || "unknown");
      v = await this.session.observe({ scope, budget, fullLinks, expand, allItems });
    }
    if (v.state === "ok" && v.elements.some(e => e.role === "captcha")) await this.solveWidgets(v);
    return v;
  }

  /** @internal runs a model decision; returns the recipe steps it makes */
  async execute(d: Decision, vars: Record<string, string>, goal: string, stepParams?: Record<string, unknown>, allowed?: Set<string>): Promise<{ ok: boolean; reason?: string; action: string; result: ActResult; steps: Step[]; dialogText?: string }> {
    const a: Action = { action: d.action };
    let target: Target | null = null;
    let recipeText: string | undefined;
    let dialogText: string | undefined;
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
      case "scroll": if ((d as any).to != null) a.to = String((d as any).to); else a.dy = Number(d.dy ?? 600); break;
      case "navigate": a.url = String(d.url ?? ""); break;
      case "wait": a.ms = Math.min(Number(d.ms ?? 1000), 10000); break;
      case "back": break;
      case "dialog": {
        a.accept = d.accept !== false;
        if (d.text != null && a.accept) {
          // text typed into a prompt(): params and secrets as in a field (a secret only for the page's own origin)
          const plan = planText(String(d.text), vars, this.secrets, allowed ?? new Set());
          const left = placeholders(plan.recipe);
          if (left.length) {
            const reason = `the text holds ${left.map(n => `%${n}%`).join(", ")}, which is not a secret or variable here; nothing was typed`;
            return { ok: false, reason, action: "dialog accept", result: emptyResult("dialog accept", reason), steps: [] };
          }
          a.text = await plan.resolve(this.session.currentURL);
          const params = this.recorder?.params ?? stepParams ?? {};
          dialogText = plan.usedSecrets.length ? plan.recipe : templatize(plan.recipe, params);
        }
        break;
      }
      case "click": if (d.id == null && d.x != null) { a.x = Number(d.x); a.y = Number(d.y); } break;
    }
    const control = a.id != null && !!this.session.last?.byId.get(a.id)?.interactive;
    const r = await this.session.act(a);
    if (r.status === "challenge") await this.handleChallenge(r.challenge?.kind || "unknown");
    const chk = checkEffect(a, r, null, { control });
    if (chk.ok) await this.followNewTab(r);
    const steps: Step[] = [];
    const params = this.recorder?.params ?? stepParams;
    if (chk.ok && params) {
      const s = toStep(a, target, recipeText, chk.effect, goal, params, this.session.currentURL);
      if (s) { s.id = this.recorder ? this.stepId() : ""; steps.push(s); }
      if (this.recorder) for (const h of hostsOf(this.session.currentURL)) this.recorder.hosts.add(h);
    }
    this.notePlan({ action: r.action, ok: chk.ok, reason: chk.reason, target, effect: chk.effect, status: r.status });
    return { ok: chk.ok, reason: chk.reason, action: r.action, result: r, steps, ...(dialogText != null ? { dialogText } : {}) };
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
    if (chk.ok) await this.followNewTab(r);
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
      const target = await this.session.locators(el.id);
      const selector = await this.session.selectorOf(el.id);
      out.push({ id: el.id, role: el.role, name: this.secrets.scrub(el.name), action: m.action, description: m.description, target, ...(selector ? { selector } : {}), ...(target?.frame ? { frame: target.frame } : {}) });
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
    // The page's state when its view is taken: still at work (a request in flight, "Running…"), and what
    // it shows. A model answer takes seconds, so the work can finish meanwhile; it is judged by the view.
    const waitMs = o.waitMs ?? 15000;
    const wasBusy = waitMs > 0 ? await this.session.busy() : null;
    const stamp = waitMs > 0 ? await this.session.pageStamp() : "";
    let { value } = await this.modelExtract(instruction, sch, o.budget);
    // Nothing read, and the page was at work when it was read, is at work now, or has changed since:
    // wait for it, a bounded time, and read once more before an empty answer is returned
    if (isEmptyAnswer(value) && waitMs > 0) {
      let why = await this.session.busy();
      const changed = !!stamp && (await this.session.pageStamp()) !== stamp;
      if (why || wasBusy || changed) {
        const until = Date.now() + waitMs;
        while (why && Date.now() < until) { await new Promise(r => setTimeout(r, 300)); why = await this.session.busy(); }
        await this.session.waitReady(3000).catch(() => undefined);
        this.tracer.write("extract", { instruction, note: "read again after the page finished its work" });
        ({ value } = await this.modelExtract(instruction, sch, o.budget));
      }
    }
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
      this.stamp();
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
    // every row and item: a read must not stop where a view would fold a long list
    const v = session ? await session.observe({ scope: "page", budget: budget ?? 16000, fullLinks: true, allItems: true }) : await this.view("page", budget ?? 16000, true, 0, true);
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
      if (ex.ok && this.recorder) { this.recorder.steps.push(...ex.steps); this.stamp(); }
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
    this.recorder = { name: n, params: o.params || {}, steps: [], output: { type: "object", properties: {}, required: [] }, n: 0, hosts: new Set(), lastAt: Date.now(), stamped: 0, failed: [] };
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

  /** Opens a URL; the first one is the flow's start page. */
  goto(url: string) { return this.gw.goto(url); }
  /** Does one thing, described in plain words, and records it as a step when it worked. */
  act(instruction: string, o?: { variables?: Record<string, unknown> }) { return this.gw.act(instruction, o); }
  /** Reads data into a schema and records how; `meta.layer` says whether replays will need a model for it. */
  extract<T = any>(instruction: string, schema: unknown, o?: { budget?: number; waitMs?: number }) { return this.gw.extract<T>(instruction, schema, o); }
  /** Finds elements that match a request (not recorded). */
  observe(request: string) { return this.gw.observe(request); }
  /** Runs a multi-step task; every action of the run is recorded as a step. */
  agent(task: string, o?: AgentOptions) { return this.gw.agent(task, o); }

  /** The steps so far (scrubbed). */
  get steps(): Step[] { return this.gw.secrets.safeRecipe({ steps: this.gw.recorder?.steps ?? [] }).steps; }

  /** Writes the recipe to the store and stops recording. Saving again makes a new version. */
  async save(o: { repair?: "auto" | "review" | "off"; /** at most this many steps repaired in one run (default: every step, at least 3, at most 20) */ maxRepairs?: number } = {}): Promise<Recipe> {
    const rec = this.gw.recorder;
    if (!rec || rec.name !== this.name) throw new GhostwrightError("flow_closed", `flow "${this.name}" is not recording`);
    if (!rec.steps.length) throw new GhostwrightError("flow_empty", `flow "${this.name}" has no steps`);
    if (rec.failed.length) this.gw.warning(`flow "${this.name}": ${rec.failed.length} instruction${rec.failed.length === 1 ? "" : "s"} failed while recording and ${rec.failed.length === 1 ? "is" : "are"} not in the saved flow, so replays will not do ${rec.failed.length === 1 ? "it" : "them"}: ${rec.failed.map(x => JSON.stringify(x.slice(0, 80))).join(", ")}`);
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
      repair: { mode: o.repair ?? (rec.steps.some(s => /\{\{\s*(secret|totp)\s*:/.test(s.text || "")) ? "review" : "auto"), max_steps: Math.min(20, Math.max(1, o.maxRepairs ?? Math.max(3, rec.steps.length))) },
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

/**
 * A click that showed choices (a custom dropdown's options, a menu without menu roles) where one
 * of them carries a word of the instruction that the clicked control did not: the instruction
 * needs one more action in what opened ("Set the speed to Express" after "Standard ▾" opened).
 */
/** A model's reason for "none" that says the work is not finished ("still processing", "not enabled yet"). */
export function notYet(why: unknown): boolean {
  const t = String(why ?? "");
  return /\b(not (yet|enabled|ready|finished|done|complete|loaded|available)|still (processing|loading|working|disabled|running|waiting|pending)|(is|are) (disabled|loading|pending)|has not (yet )?(appeared|loaded|finished)|waiting for)\b/i.test(t);
}

/** An extract answer with nothing in it: every list empty, every value null or blank. */
export function isEmptyAnswer(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) return v.every(isEmptyAnswer);
  if (typeof v === "object") { const xs = Object.values(v as object); return !xs.length || xs.every(isEmptyAnswer); }
  return false;
}

/** The answer to a JavaScript dialog, kept on the step that opened it: accept or dismiss, and the text typed into a prompt(). */
function answerOn(step: Step, d: Decision, text: string | undefined): void {
  step.dialog = d.accept === false ? "dismiss" : "accept";
  if (step.dialog === "accept" && text != null) step.dialog_text = text;
  else delete step.dialog_text;
}

/** The same action on the same element with the same input: a model repeating itself. */
function sameDecision(a: Decision, b: Decision): boolean {
  return a.action === b.action && a.id === b.id && (a.text ?? "") === (b.text ?? "") && (a.option ?? "") === (b.option ?? "") && (a.keys ?? "") === (b.keys ?? "") && (a.url ?? "") === (b.url ?? "") && a.action !== "scroll";
}

function opensChoice(instruction: string, changes: Change[], clicked: number): boolean {
  const added = changes.filter(c => c.op === "added" && c.name && ["clickable", "link", "button", "option", "menuitem", "radio", "checkbox", "treeitem", "tab"].includes(c.role));
  if (added.length < 2) return false;
  const was = (changes.find(c => c.id === clicked)?.was || changes.find(c => c.id === clicked)?.name || "").toLowerCase();
  const words = (instruction.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w) && !was.includes(w));
  return added.some(c => words.some(w => c.name!.toLowerCase().includes(w)));
}
const STOP = new Set(["the", "and", "for", "from", "into", "with", "set", "choose", "pick", "select", "click", "open", "option", "menu", "this", "that", "your"]);

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

const STATE_KEYS = ["expanded", "checked", "pressed", "selected"];

/** Did the action do what it should? (a click on something that is not a control and changed nothing did not work) */
export function checkEffect(a: Action, r: ActResult, want: Effect | null, o: { control?: boolean; stateAfter?: Record<string, string> } = {}): { ok: boolean; reason?: string; effect: Effect } {
  if (r.status !== "ok") return { ok: false, reason: `${r.status}: ${r.reason}`, effect: { kind: "none" } };
  const control = o.control ?? r.control ?? false;
  const id = a.id ?? r.id;
  const moved = !!r.navigation && !r.navigation.sameDocument;
  const changed = moved || !!r.view || r.changes.length > 0 || r.newTabs.length > 0 || r.downloads.length > 0 || !!r.dialog || !!r.navigation;
  const nav: Effect = { kind: "navigate", path: r.navigation ? safePath(r.navigation.url) : undefined };
  switch (a.action) {
    case "type": {
      if (!a.text) return { ok: true, effect: { kind: "none" } };
      // the field was read back after typing: that decides when it could be read
      if (r.typed === false && !moved) return { ok: false, reason: "the field did not take the text", effect: { kind: "none" } };
      const took = r.typed === true || r.view || r.changes.some(c => c.id === id && c.fields && ("value" in c.fields || "pw" in c.fields || "secret" in c.fields));
      if (took || moved) return { ok: true, effect: moved ? nav : { kind: "value" } };
      return { ok: false, reason: "the field did not take the text", effect: { kind: "none" } };
    }
    case "click":
    case "check":
    case "uncheck":
    case "press":
    case "select": {
      const eff: Effect = moved ? nav : changed ? { kind: "change" } : { kind: "none" };
      // the state the target took (open, checked, pressed, selected): checked again on replay
      const took = r.changes.find(c => c.id === id && c.op === "changed" && c.fields);
      const st = took ? Object.fromEntries(Object.entries(took.fields!).filter(([k, v]) => STATE_KEYS.includes(k) && v !== "")) : {};
      if (!moved && Object.keys(st).length) eff.state = st;
      if (want) {
        if (want.kind === "navigate" && !moved && !r.navigation) return { ok: false, reason: "the page did not navigate as when the flow was recorded", effect: eff };
        if (want.kind === "change" && !changed) return { ok: false, reason: "no visible effect", effect: eff };
        if (want.state && o.stateAfter) {
          const off = Object.entries(want.state).find(([k, v]) => o.stateAfter![k] !== undefined && o.stateAfter![k] !== v);
          if (off) return { ok: false, reason: `the element is not ${off[0]}=${off[1]} as when the flow was recorded`, effect: eff };
        }
        if (!changed && a.action === "click" && !((r.mutations || 0) > 0 || r.settle.requestCount > 0)) return { ok: false, reason: "no effect: the page did not change and sent nothing", effect: eff };
        return { ok: true, effect: eff };
      }
      if (!changed && (a.action === "click" || a.action === "press")) {
        // a control may change nothing the view lists (a star that only fills in, a button that only saves):
        // it worked when the page itself changed or sent something. A click that left the page as it
        // was and sent nothing did nothing.
        if (a.action === "click" && control && ((r.mutations || 0) > 0 || r.settle.requestCount > 0)) return { ok: true, reason: "clicked; the page changed, nothing new to read", effect: eff };
        return { ok: false, reason: a.action === "click" && control ? "no effect: the page did not change and sent nothing" : "no visible effect", effect: eff };
      }
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
    case "scroll": return { ...base, kind: "scroll", value: a.to ?? String(a.dy ?? 600), ...(tg && (a.to || a.dy) ? { target: tg } : {}) };
    case "navigate": return { ...base, kind: "navigate", url: templatize(a.url || pageURL, params) };
    case "wait": return { ...base, kind: "wait", timeout_ms: Math.max(100, a.ms || 100) };
  }
  return null;
}

export { render };
