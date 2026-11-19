// One page: the isolated worlds the page script runs in, the view, and
// actions with trusted input. TypeScript port of Browsa's pageview session,
// extended to read cross-origin frames and closed shadow roots.
import { readFileSync } from "node:fs";
import type { BrowserContext, CDPSession, Dialog, Frame, Page } from "playwright-core";
import { captchaPatterns, classifyChallenge } from "./challenge.js";
import { diffSnapshots, MAX_DIFF_LINES, Volatility, type Change } from "./diff.js";
import { charKey, MOD, MODIFIER_KEYS, NAMED_KEYS, parseKeys, type KeyCombo, type KeyDef } from "./keys.js";
import { DEFAULT_SETTLE, isBeacon, NetTracker, QuietTracker, type RequestInfo, type SettleConfig } from "./settle.js";
import { bareOrQuote, cut, estimateTokens, plural, quote, shortURL } from "./text.js";
import type { ControlFacts } from "../guard.js";
import { originAllowed } from "../secrets.js";
import {
  buildView, findAll, findIn, ident, indexItems, parseItems, snapshotContains,
  type Box, type Challenge, type Element, type JSDialog, type ObserveOptions, type RawSnapshot, type Snapshot, type View,
} from "./view.js";

const PAGE_SCRIPT = readFileSync(new URL("./pageview.js", import.meta.url), "utf8");
const LOCATE_SCRIPT = readFileSync(new URL("./locate.js", import.meta.url), "utf8");

export interface Action {
  /** click, type, press, select, check, uncheck, hover, scroll, navigate, back, forward, reload, wait, upload, dialog */
  action: string;
  id?: number;
  role?: string;
  name?: string;
  text?: string;
  /** shown instead of `text` in the echo (secrets) */
  textShown?: string;
  /**
   * Text that holds secrets: read only at the keystroke, for the document
   * the field is in (`resolve(url)` applies the secrets' origin rules).
   * Typed into the element itself, never as key events to whatever has focus.
   */
  secretText?: { resolve(url: string): Promise<string>; names: string[] };
  clear?: boolean;
  submit?: boolean;
  keys?: string;
  option?: string;
  double?: boolean;
  right?: boolean;
  modifiers?: string[];
  x?: number;
  y?: number;
  dy?: number;
  to?: string;
  url?: string;
  ms?: number;
  for?: "text" | "id-gone" | "url-change";
  timeout?: number;
  files?: string[];
  accept?: boolean;
}

export interface SettleInfo { quietAfterMs: number; waitedMs: number; capHit: boolean; requests: RequestInfo[]; requestCount: number }

export interface ActResult {
  action: string;
  status: "ok" | "failed" | "blocked" | "challenge";
  reason?: string;
  changes: Change[];
  noChange?: boolean;
  view?: View;
  freshReason?: string;
  navigation?: { url: string; sameDocument: boolean };
  settle: SettleInfo;
  newTabs: string[];
  downloads: string[];
  dialog?: JSDialog;
  challenge?: Challenge;
  errors: string[];
  errorCount: number;
  failedRequests: RequestInfo[];
  /** a safety guard (purchase, origin, secret rules) refused it: do not try another way */
  guard?: boolean;
  focus?: Element;
  volatileIgnored?: number;
  text: string;
}

export interface CapturedResponse { url: string; method: string; status: number; body: string; at: number }

/** A locator chain for one element, in the recipe's target shape. */
export interface Target { role?: string; name?: string; css?: string; text?: string; xpath?: string; near?: string; frame?: string }

export interface SessionOptions { settle?: Partial<SettleConfig>; callTimeout?: number; readFrames?: boolean; readClosedShadow?: boolean }

interface World {
  key: string;
  cdp: CDPSession;
  frameId: string;
  ctx: number;
  epoch: number;
  parent?: World;
  hostLocal?: number;
  url: string;
}

interface Pre {
  err?: string; role: string; name: string; tag: string; type: string; checked?: boolean; sel?: number; multiple?: boolean;
  opts?: { t: string; v: string; d: boolean }[]; len?: number; selAll?: boolean; editable?: boolean; focused?: boolean; mac?: boolean;
}

class Failure { constructor(public status: "failed" | "blocked" | "challenge", public reason: string, public guard = false) {} }
const failf = (s: string) => new Failure("failed", s);
// a safety guard said no (purchase, origin, secret rules): not to be retried another way
const guardf = (s: string) => new Failure("blocked", s, true);

class ChallengeError extends Error { constructor(public ch: Challenge) { super("challenge: " + ch.kind); } }
class DialogOpen extends Error { constructor() { super("a JavaScript dialog is open"); } }

const KNOWN = new Set("click type press select check uncheck hover scroll navigate back forward reload wait upload dialog".split(" "));
const NEEDS_TARGET = new Set("click type select check uncheck hover upload".split(" "));
const ON_CHALLENGE = new Set("press wait navigate back forward reload".split(" "));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Is the page readable? Its content size, and a loading indicator that is
// on screen: aria-busy, a progress bar, a spinner, or text that only says
// "Loading…". Read only.
const READY_PROBE = `function() {
  const b = document.body;
  if (!b || document.readyState === 'loading') return JSON.stringify({ content: 0 });
  const shown = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  let loading = '';
  for (const el of document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .spinner, .loader, .loading, .skeleton')) {
    if (shown(el)) { loading = el.getAttribute('aria-busy') === 'true' ? 'busy' : el.getAttribute('role') === 'progressbar' ? 'progress bar' : 'spinner'; break; }
  }
  if (!loading) {
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(), i = 0; n && i < 5000; n = w.nextNode(), i++) {
      const t = n.nodeValue.trim();
      if (t.length < 40 && /^(loading|please wait|one moment)\\b[^a-z]*$/i.test(t) && n.parentElement && shown(n.parentElement)) { loading = JSON.stringify(t); break; }
    }
  }
  return JSON.stringify({ content: (b.innerText || '').trim().length + document.images.length, loading });
}`;
const isContextGone = (e: unknown) => /Cannot find context|context with specified id|Execution context was destroyed|uniqueContextId not found|Inspected target navigated|No frame with given id/i.test(String((e as Error)?.message ?? e));

export class PageSession {
  readonly page: Page;
  readonly context: BrowserContext;
  private cdp!: CDPSession;
  private cfg: SettleConfig;
  private callTimeout: number;
  private readFrames: boolean;
  private readClosedShadow: boolean;

  last: Snapshot | null = null;
  private vol = new Volatility();
  private main: World | null = null;
  private frameWorlds = new Map<string, World>();
  private oopifSessions = new Map<Frame, CDPSession | null>();
  private gids = new Map<string, number>();
  private rev = new Map<number, { world: string; local: number; backend?: number }>();
  private nextGid = 1;
  private gidEpoch = -1;
  private gen = 0;

  private epoch = 0;
  private domReady = true;
  private url = "";
  private mainFrameId = "";
  private net: NetTracker;
  private sameDocNavs: string[] = [];
  private newTabs: string[] = [];
  private blockedPopups: string[] = [];
  private popupChecks = new Set<Promise<unknown>>();
  private downloads: string[] = [];
  private errors: string[] = [];
  private dialog: Dialog | null = null;
  private dialogWaiters = new Set<() => void>();
  private mouseX = 0;
  private mouseY = 0;
  private lastTypeAhead = 0;
  private jsonMeta = new Map<string, { url: string; method: string; status: number }>();
  captured: CapturedResponse[] = [];
  private opQueue: Promise<unknown> = Promise.resolve();
  /** refuses clicks and submits that would buy; null = allowed */
  purchaseGuard: ((facts: ControlFacts[]) => string | null) | null = null;
  /** origins the page may navigate to; null = any */
  allowedOrigins: string[] | null = null;
  /** file: pages may be opened (off by default) */
  allowFileUrls = false;
  /** the last main-frame navigation the router aborted before it was sent, and why */
  private blockedNav = "";
  private blockedWhy = "";
  /** names of the secrets typed in this session */
  private typedSecrets = new Set<string>();
  /** fields a secret was typed into: "<world>:<local id>" -> secret names */
  private secretFields = new Map<string, string[]>();
  /** a field with a secret is in the viewport (hybrid screenshots are skipped then) */
  secretOnScreen = false;

  /** Navigation to anything but http(s) and about:blank is refused; file: only when allowed. */
  schemeAllowed(url: string): boolean {
    if (url === "about:blank") return true;
    let p = "";
    try { p = new URL(url).protocol; } catch { return false; }
    return p === "http:" || p === "https:" || (p === "file:" && this.allowFileUrls);
  }

  private navAllowed(url: string): string | null {
    if (!this.schemeAllowed(url)) return `${url.split(":")[0]}: addresses are not opened${url.startsWith("file:") ? " (allowFileUrls: true allows file:)" : ""}`;
    if (this.allowedOrigins && url !== "about:blank" && !originAllowed(this.allowedOrigins, url)) return `${safeOrigin(url)} is outside allowedOrigins`;
    return null;
  }

  /**
   * Enforces allowedOrigins before requests: document requests of every
   * frame and popup to another origin are aborted, and popups that end up
   * elsewhere are closed.
   */
  async enforceOrigins(): Promise<void> {
    const ctx = this.context;
    await this.installRouter();
    const police = async (p: Page) => {
      if (p === this.page) return;
      await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      if (this.navAllowed(p.url()) || p.url() === "about:blank") this.blockedPopups.push(p.url());
      if (this.navAllowed(p.url()) || p.url() === "about:blank") await p.close().catch(() => undefined);
    };
    // an action waits for the tabs it opened to be checked, so it can say one was refused
    ctx.on("page", p => {
      const c = police(p).catch(() => undefined);
      this.popupChecks.add(c);
      void c.finally(() => this.popupChecks.delete(c));
    });
    for (const p of ctx.pages()) void police(p);
  }

  /** set by Ghostwright: does this URL carry a whole value of one of these typed secrets? */
  secretInUrl: ((url: string, names: string[]) => boolean) | null = null;
  private routerOn = false;

  /**
   * One request router for the context (all frames and popups), installed
   * for allowedOrigins or once a secret was typed. It aborts page loads to
   * refused addresses, and GET page loads whose address carries a typed
   * secret. It never throws: whatever goes wrong, the request is aborted.
   */
  async installRouter(): Promise<void> {
    if (this.routerOn) return;
    this.routerOn = true;
    await this.context.route("**/*", async route => {
      let abort = true;
      try {
        const r = route.request();
        const url = r.url();
        abort = false;
        if (r.isNavigationRequest() && this.navAllowed(url)) {
          abort = true;
          let main = false;
          try { main = r.frame() === this.page.mainFrame(); } catch { main = false; } // a popup's first request has no frame yet
          if (main) { this.blockedNav = url; this.blockedWhy = ""; }
          else {
            // a new tab (not a frame of this page) that was refused
            let popup = true;
            try { popup = r.frame().page() !== this.page; } catch { popup = true; }
            if (popup && this.blockedPopups.length < 5) this.blockedPopups.push(url);
          }
        } else if (this.secretInUrl && this.typedSecrets.size && r.method() === "GET" && r.isNavigationRequest() && this.secretInUrl(url, [...this.typedSecrets])) {
          abort = true;
          this.blockedNav = url;
          this.blockedWhy = "the request carried a secret in its address and was not sent";
        }
      } catch { abort = true; }
      try {
        if (abort) await route.abort("blockedbyclient");
        else await route.continue();
      } catch { /* the page or the request is gone */ }
    });
  }

  private constructor(page: Page, o: SessionOptions) {
    this.page = page;
    this.context = page.context();
    this.cfg = { ...DEFAULT_SETTLE, ...(o.settle || {}) };
    this.callTimeout = o.callTimeout ?? 15000;
    this.readFrames = o.readFrames ?? true;
    this.readClosedShadow = o.readClosedShadow ?? true;
    this.net = new NetTracker(this.cfg.longLived);
  }

  static async attach(page: Page, o: SessionOptions = {}): Promise<PageSession> {
    const s = new PageSession(page, o);
    await s.init();
    return s;
  }

  private async init(): Promise<void> {
    this.cdp = await this.context.newCDPSession(this.page);
    const c = this.cdp;
    const now = () => Date.now();
    c.on("Page.frameNavigated", (p: any) => {
      if (!p.frame.parentId) {
        this.epoch++;
        this.domReady = p.type === "BackForwardCacheRestore";
        this.mainFrameId = p.frame.id;
        this.url = p.frame.url;
        this.jsonMeta.clear();
      } else this.frameWorlds.delete(p.frame.id);
    });
    c.on("Page.navigatedWithinDocument", (p: any) => {
      if (p.frameId === this.mainFrameId) { this.url = p.url; this.sameDocNavs.push(p.url); }
    });
    c.on("Page.domContentEventFired", () => { this.domReady = true; });
    c.on("Page.loadEventFired", () => { this.domReady = true; });
    c.on("Page.windowOpen", (p: any) => this.addNewTab(p.url));
    c.on("Page.downloadWillBegin", (p: any) => { if (this.downloads.length < 10) this.downloads.push(p.suggestedFilename || p.url); });
    c.on("Page.javascriptDialogOpening", () => { for (const w of this.dialogWaiters) w(); });
    c.on("Network.requestWillBeSent", (p: any) => {
      this.net.onRequest(p.requestId, p.type, p.request.method, p.request.url, p.type === "Document" && p.frameId === this.mainFrameId, now());
    });
    c.on("Network.responseReceived", (p: any) => {
      this.net.onResponse(p.requestId, p.response.status, p.type, p.response.mimeType);
      if (/json/i.test(p.response.mimeType || "") && (p.type === "XHR" || p.type === "Fetch" || p.type === "Document")) {
        const r = this.net.log.find(x => x.id === p.requestId);
        this.jsonMeta.set(p.requestId, { url: p.response.url, method: r?.method || "GET", status: p.response.status });
      }
    });
    c.on("Network.loadingFinished", (p: any) => {
      this.net.onDone(p.requestId, "", now());
      const m = this.jsonMeta.get(p.requestId);
      if (m) {
        this.jsonMeta.delete(p.requestId);
        if (p.encodedDataLength > 4_000_000) return;
        c.send("Network.getResponseBody", { requestId: p.requestId }).then((b: any) => {
          const body = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
          this.captured.push({ ...m, body, at: now() });
          if (this.captured.length > 60) this.captured.shift();
        }).catch(() => undefined);
      }
    });
    c.on("Network.loadingFailed", (p: any) => {
      const failed = p.canceled || p.errorText === "net::ERR_ABORTED" ? "" : p.errorText || "failed";
      this.net.onDone(p.requestId, failed, now());
    });
    c.on("Log.entryAdded", (p: any) => {
      if (p.entry.level === "error" && p.entry.source !== "network") this.addError(p.entry.text);
    });
    this.page.on("dialog", d => { this.dialog = d; });
    // script errors with their own message (the page's runtime, read by the library's own session)
    this.page.on("pageerror", e => this.addError(`${e.name || "Error"}: ${e.message}`));
    this.page.on("console", m => { if (m.type() === "error") this.addError(m.text()); });
    this.page.on("popup", p => this.addNewTab(p.url()));

    await c.send("Page.enable");
    await c.send("Network.enable");
    await c.send("Log.enable").catch(() => undefined);
    const ft: any = await c.send("Page.getFrameTree");
    this.mainFrameId = ft.frameTree.frame.id;
    this.url = ft.frameTree.frame.url;
  }

  async close(): Promise<void> {
    for (const s of this.oopifSessions.values()) await s?.detach().catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
  }

  /** Runs one operation at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.opQueue.then(fn, fn);
    this.opQueue = p.catch(() => undefined);
    return p;
  }

  private addNewTab(u: string): void {
    if (this.newTabs.includes(u)) return;
    const i = this.newTabs.findIndex(t => !t || t === "about:blank");
    if (i >= 0 && u && u !== "about:blank") { this.newTabs[i] = u; return; }
    if (this.newTabs.length < 10) this.newTabs.push(u);
  }

  private addError(t: string): void {
    if (this.errors.length < 50) this.errors.push(cut(String(t).replace(/\s+/g, " ").trim(), 200));
  }

  get currentURL(): string { return this.url || this.page.url(); }

  /** The URL of the document element `id` lives in (a frame's own URL for frame content). */
  urlOf(id: number): string {
    const r = this.rev.get(id);
    const w = r ? this.worldByKey(r.world) : undefined;
    return w && w.key !== "main" && w.url ? w.url : this.currentURL;
  }
  get documentEpoch(): number { return this.epoch; }

  private pendingDialog(): JSDialog | undefined {
    const d = this.dialog;
    return d ? { type: d.type(), message: d.message(), default: d.defaultValue() || undefined } : undefined;
  }

  // ---- protocol helpers --------------------------------------------------

  private async call<T = any>(cdp: CDPSession, method: string, params?: object, timeout = this.callTimeout): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        cdp.send(method as any, params as any) as Promise<T>,
        new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${method}: no answer after ${timeout} ms`)), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  /** A call the renderer cannot answer while a JavaScript dialog is open. */
  private async callD<T = any>(cdp: CDPSession, method: string, params?: object): Promise<T> {
    if (this.dialog) throw new DialogOpen();
    let off: () => void = () => undefined;
    let nudge: NodeJS.Timeout | undefined;
    try {
      const dialogP = new Promise<T>((_, rej) => {
        const w = () => rej(new DialogOpen());
        this.dialogWaiters.add(w);
        off = () => this.dialogWaiters.delete(w);
      });
      if (method.startsWith("Input.")) {
        // a tab in the background acknowledges input late: bring it to the front once
        nudge = setTimeout(() => { this.cdp.send("Page.bringToFront").catch(() => undefined); }, 1200);
      }
      return await Promise.race([this.call<T>(cdp, method, params), dialogP]);
    } finally { off(); clearTimeout(nudge); }
  }

  // ---- worlds --------------------------------------------------------------

  private async checkChallenge(): Promise<{ ch: Challenge | null; title: string; url: string }> {
    const ti: any = await this.call(this.cdp, "Target.getTargetInfo").catch(() => ({ targetInfo: { title: "", url: this.url } }));
    const title = ti.targetInfo.title || "";
    const url = ti.targetInfo.url || this.url;
    const frames = this.page.frames().filter(f => f !== this.page.mainFrame());
    const urls = frames.map(f => f.url());
    const ch = await classifyChallenge(title, urls, async i => {
      try {
        const el = await frames[i].frameElement();
        const b = await el.boundingBox();
        await el.dispose();
        if (!b) return null;
        const vp = this.page.viewportSize() || (await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null));
        const box: Box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
        if (!vp) return { share: 0, box };
        const x1 = Math.max(0, b.x), y1 = Math.max(0, b.y), x2 = Math.min(vp.width, b.x + b.width), y2 = Math.min(vp.height, b.y + b.height);
        return { share: x2 > x1 && y2 > y1 ? ((x2 - x1) * (y2 - y1)) / (vp.width * vp.height) : 0, box };
      } catch { return null; }
    });
    return { ch, title, url };
  }

  private async ensureMain(): Promise<World> {
    if (this.main && this.main.epoch === this.epoch && this.main.ctx) return this.main;
    this.main = null;
    for (let i = 0; !this.domReady && i < 150; i++) await sleep(20);
    const { ch } = await this.checkChallenge();
    if (ch) throw new ChallengeError(ch);
    const epoch = this.epoch;
    const w = await this.makeWorld(this.cdp, this.mainFrameId, "main");
    if (this.epoch !== epoch) throw new Error("Cannot find context: the document changed while the world was created");
    w.epoch = epoch;
    w.url = this.url;
    this.main = w;
    return w;
  }

  private async makeWorld(cdp: CDPSession, frameId: string, key: string): Promise<World> {
    const r: any = await this.call(cdp, "Page.createIsolatedWorld", { frameId, worldName: "", grantUniveralAccess: false });
    const w: World = { key, cdp, frameId, ctx: r.executionContextId, epoch: this.epoch, url: "" };
    for (const src of [PAGE_SCRIPT, LOCATE_SCRIPT]) {
      const e: any = await this.callD(cdp, "Runtime.evaluate", { expression: src, contextId: w.ctx, returnByValue: true, silent: true });
      if (e.exceptionDetails) throw new Error("page script failed: " + (e.exceptionDetails.exception?.description || e.exceptionDetails.text));
    }
    return w;
  }

  private async evalIn(w: World, expr: string, byValue = true): Promise<{ value: any; objectId?: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (w.key === "main") w = await this.ensureMain();
        const r: any = await this.callD(w.cdp, "Runtime.evaluate", { expression: expr, contextId: w.ctx, returnByValue: byValue, awaitPromise: byValue, silent: true, objectGroup: "gw" });
        if (r.exceptionDetails) throw new Error("page script failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return { value: r.result.value, objectId: r.result.objectId };
      } catch (e) {
        if (isContextGone(e) && attempt < 2) {
          if (w.key === "main") this.main = null;
          else throw e;
          await sleep(30);
          continue;
        }
        throw e;
      }
    }
  }

  private worldByKey(key: string): World | undefined {
    if (key === "main") return this.main ?? undefined;
    for (const w of this.frameWorlds.values()) if (w.key === key) return w;
    return undefined;
  }

  /** The isolated world of the frame an iframe element shows, or null. */
  private async frameWorld(parent: World, hostLocal: number): Promise<World | null> {
    const { objectId } = await this.evalIn(parent, `__pv.el(${hostLocal})`, false);
    if (!objectId) return null;
    const d: any = await this.call(parent.cdp, "DOM.describeNode", { objectId }).catch(() => null);
    const frameId: string | undefined = d?.node?.frameId;
    if (!frameId) return null;
    const known = this.frameWorlds.get(frameId);
    if (known && known.parent === parent && known.hostLocal === hostLocal) return known;
    // in the parent's process?
    let cdp: CDPSession | null = null;
    const tree: any = await this.call(parent.cdp, "Page.getFrameTree").catch(() => null);
    const inTree = (t: any): boolean => t && (t.frame.id === frameId || (t.childFrames || []).some(inTree));
    if (tree && inTree(tree.frameTree) && tree.frameTree.frame.id !== frameId) cdp = parent.cdp;
    else cdp = await this.oopifSession(frameId);
    if (!cdp) return null;
    const w = await this.makeWorld(cdp, frameId, `f${++this.gen}`);
    w.parent = parent;
    w.hostLocal = hostLocal;
    const u = await this.evalIn(w, "location.href").catch(() => ({ value: "" }));
    w.url = String(u.value || "");
    this.frameWorlds.set(frameId, w);
    return w;
  }

  /** The protocol session of an out-of-process frame. */
  private async oopifSession(frameId: string): Promise<CDPSession | null> {
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      let s = this.oopifSessions.get(f);
      if (s === undefined) {
        s = await this.context.newCDPSession(f).catch(() => null);
        this.oopifSessions.set(f, s);
      }
      if (!s) continue;
      const t: any = await this.call(s, "Page.getFrameTree").catch(() => null);
      if (t?.frameTree?.frame?.id === frameId) return s;
    }
    return null;
  }

  /** Top-left of a world's content in top-level viewport pixels. */
  private async offsetOf(w: World): Promise<[number, number]> {
    if (!w.parent || w.hostLocal === undefined) return [0, 0];
    const [px, py] = await this.offsetOf(w.parent);
    const r = await this.evalIn(w.parent, `(()=>{const e=__pv.el(${w.hostLocal});if(!e)return null;const r=e.getBoundingClientRect();return [r.left+e.clientLeft,r.top+e.clientTop]})()`);
    const v = r.value as [number, number] | null;
    return v ? [px + v[0], py + v[1]] : [px, py];
  }

  // ---- ids -----------------------------------------------------------------

  private gid(world: string, local: number, backend?: number): number {
    const k = world + ":" + local + (backend ? "b" + backend : "");
    let g = this.gids.get(k);
    if (!g) {
      g = this.nextGid++;
      this.gids.set(k, g);
      this.rev.set(g, { world, local, backend });
    }
    return g;
  }

  // ---- snapshot --------------------------------------------------------------

  private async collect(w: World, expandLocal: number): Promise<RawSnapshot> {
    const opts = JSON.stringify({ expand: expandLocal, cap: captchaPatterns() });
    const r = await this.evalIn(w, `__pv.collect(${opts})`);
    return JSON.parse(r.value as string) as RawSnapshot;
  }

  /** Reads the page: the main document, readable frames and closed shadow roots. */
  async snapshot(expand = 0): Promise<Snapshot> {
    const main = await this.ensureMain();
    if (this.gidEpoch !== main.epoch) {
      this.gids.clear(); this.rev.clear(); this.nextGid = 1; this.gidEpoch = main.epoch;
      this.frameWorlds.clear();
      this.secretFields.clear();
    }
    const ex = expand ? this.rev.get(expand) : undefined;
    const raw = await this.collect(main, ex?.world === "main" ? ex.local : 0);
    const items = parseItems(raw, l => this.gid("main", l), "main");
    const sn: Snapshot = {
      url: raw.u, title: raw.ti, sx: raw.sx, sy: raw.sy, vw: raw.vw, vh: raw.vh, pw: raw.pw, ph: raw.ph,
      focus: raw.foc ? this.gid("main", raw.foc) : 0, modal: raw.modal ? this.gid("main", raw.modal) : 0,
      epoch: main.epoch, collectMs: raw.ms, loading: raw.ld === 1, rematched: raw.rm, items, byId: new Map(),
      frames: raw.frames.map(f => ({ id: this.gid("main", f.i), name: f.n, sameOrigin: f.same, origin: f.o })),
      widgets: (raw.cw || []).map(c => ({ kind: c.k, version: c.v, puzzle: c.p, state: c.st, question: c.q })),
    };
    if (this.readFrames) await this.stitchFrames(sn, main, raw, ex, 0);
    if (this.readClosedShadow) await this.readShadowHosts(sn);
    // a field a secret was typed into shows "value hidden", never its value or length
    this.secretOnScreen = false;
    if (this.secretFields.size) {
      for (const e of sn.items) {
        if (!e.local || !this.secretFields.has(`${e.world}:${e.local}`)) continue;
        const st = { ...(e.state || {}) };
        delete st.value; delete st.pw;
        st.secret = "true";
        e.state = st;
        if (e.inViewport) this.secretOnScreen = true;
      }
    }
    indexItems(sn);
    return sn;
  }

  private async stitchFrames(sn: Snapshot, w: World, raw: RawSnapshot, ex: { world: string; local: number } | undefined, depth: number): Promise<void> {
    if (depth > 2) return;
    let n = 0;
    for (const f of raw.frames) {
      if (f.same || n >= 6) continue;
      const host = sn.items.find(e => e.world === w.key && e.local === f.i);
      if (!host || host.role === "captcha" || host.box.w < 8 || host.box.h < 8) continue;
      n++;
      let fw: World | null = null;
      try { fw = await this.frameWorld(w, f.i); } catch { fw = null; }
      if (!fw) continue;
      let craw: RawSnapshot;
      try { craw = await this.collect(fw, ex?.world === fw.key ? ex.local : 0); } catch { this.frameWorlds.delete(fw.frameId); continue; }
      const kids = parseItems(craw, l => this.gid(fw!.key, l), fw.key);
      const ox = host.box.x, oy = host.box.y;
      for (const k of kids) {
        if (!k.parent) k.parent = host.id;
        k.box = { ...k.box, x: k.box.x + ox, y: k.box.y + oy };
        if (!host.inViewport) { k.inViewport = false; k.where = host.where; }
        if (host.behindDialog) k.behindDialog = true;
        k.frame = k.frame || host.name || f.o;
      }
      host.kind = "group";
      host.role = "frame";
      if (host.state) { delete host.state.opaque; delete host.state.size; }
      const fi = sn.frames.find(x => x.id === host.id);
      if (fi) fi.read = true;
      const at = sn.items.indexOf(host);
      sn.items.splice(at + 1, 0, ...kids);
      for (const cf of craw.frames) sn.frames.push({ id: this.gid(fw.key, cf.i), name: cf.n, sameOrigin: cf.same, origin: cf.o });
      await this.stitchFrames(sn, fw, craw, ex, depth + 1);
    }
  }

  /** Custom elements with a closed shadow root: their content from the accessibility tree. */
  private async readShadowHosts(sn: Snapshot): Promise<void> {
    const hosts = sn.items.filter(e => e.role === "custom" && e.world === "main" && e.inViewport).slice(0, 5);
    for (const h of hosts) {
      try {
        const { objectId } = await this.evalIn(this.main!, `__pv.el(${h.local})`, false);
        if (!objectId) continue;
        const d: any = await this.call(this.cdp, "DOM.describeNode", { objectId });
        const backend = d?.node?.backendNodeId;
        if (!backend) continue;
        const q: any = await this.call(this.cdp, "Accessibility.queryAXTree", { backendNodeId: backend });
        const kids: Element[] = [];
        for (const n of (q.nodes || []) as any[]) {
          if (n.ignored || !n.backendDOMNodeId || n.backendDOMNodeId === backend) continue;
          const role = String(n.role?.value || "");
          const name = String(n.name?.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
          if (!role || ["generic", "none", "StaticText", "InlineTextBox", "LineBreak", "presentation"].includes(role)) continue;
          const state: Record<string, string> = {};
          for (const p of (n.properties || []) as any[]) {
            const v = p.value?.value;
            if (p.name === "checked") state.checked = v === "mixed" ? "mixed" : String(v === true || v === "true");
            else if (p.name === "disabled" && v) state.disabled = "true";
            else if (p.name === "expanded") state.expanded = String(!!v);
            else if (p.name === "focused" && v) state.focused = "true";
            else if (p.name === "required" && v) state.required = "true";
          }
          if (n.value?.value !== undefined && ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(role)) state.value = String(n.value.value).slice(0, 80);
          const id = this.gid("main", h.local!, n.backendDOMNodeId);
          kids.push({
            id, kind: "element", role, name, state: Object.keys(state).length ? state : undefined,
            box: h.box, inViewport: h.inViewport, parent: h.id, shadow: true, interactive: ["link", "button", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "slider", "spinbutton", "tab", "menuitem", "option"].includes(role),
            key: `ax:${h.local}:${n.backendDOMNodeId}`, index: -1, count: 0, world: "main", local: h.local, backend: n.backendDOMNodeId,
          });
          if (kids.length >= 40) break;
        }
        if (!kids.length) continue;
        h.kind = "group";
        if (h.state) { delete h.state.opaque; }
        sn.items.splice(sn.items.indexOf(h) + 1, 0, ...kids);
      } catch { /* the accessibility tree is a best effort */ }
    }
  }

  // ---- observe ----------------------------------------------------------------

  observe(o: ObserveOptions = {}): Promise<View> {
    return this.serial(() => this.observeNow(o));
  }

  private async observeNow(o: ObserveOptions): Promise<View> {
    const d = this.pendingDialog();
    if (d) return this.dialogView(d);
    const { ch, title, url } = await this.checkChallenge();
    if (ch) return challengeView(ch, title, url);
    let sn: Snapshot;
    try { sn = await this.snapshot(o.expand || 0); } catch (e) {
      if (e instanceof DialogOpen && this.pendingDialog()) return this.dialogView(this.pendingDialog()!);
      if (e instanceof ChallengeError) return challengeView(e.ch, title, url);
      throw e;
    }
    this.vol.note(this.last, sn);
    this.last = sn;
    return buildView(sn, o);
  }

  private dialogView(d: JSDialog): View {
    const text = `page ${quote(this.last?.title || "")} ${bareOrQuote(cut(this.url, 200))}\n${dialogLine(d)}\nno elements listed: the page is blocked until the dialog is answered (dialog accept | dialog dismiss)`;
    return { state: "dialog", url: this.url, title: this.last?.title || "", dialog: d, scrollX: 0, scrollY: 0, viewportW: 0, viewportH: 0, pageW: 0, pageH: 0, scope: "viewport", elements: [], total: 0, totalInteractive: 0, degraded: 0, tokens: estimateTokens(text), collectMs: 0, text };
  }

  /**
   * Waits until the page can be read: the document is parsed, requests and
   * layout went quiet, and the body shows something (text or images).
   */
  waitReady(timeoutMs = 15000): Promise<{ ready: boolean; ms: number; reason?: string }> {
    return this.serial(async () => {
      const t0 = Date.now();
      let reason = "timeout";
      while (Date.now() - t0 < timeoutMs) {
        if (this.dialog) return { ready: false, ms: Date.now() - t0, reason: "a JavaScript dialog is open" };
        const { ch } = await this.checkChallenge();
        if (ch) return { ready: false, ms: Date.now() - t0, reason: `${ch.kind} bot check` };
        const st = await this.settle(Date.now());
        let content = 0, loading = "";
        try {
          const r = JSON.parse(String((await this.evalIn(await this.ensureMain(), `(${READY_PROBE})()`)).value || "{}"));
          content = Number(r.content) || 0;
          loading = String(r.loading || "");
        } catch { content = 0; }
        if (content > 0 && !loading && !st.capHit) return { ready: true, ms: Date.now() - t0 };
        reason = loading ? `the page still shows a loading indicator (${loading})` : content > 0 ? "the page kept changing" : "the page shows nothing yet";
        await sleep(200);
      }
      return { ready: false, ms: Date.now() - t0, reason };
    });
  }

  /** document.body.innerText of the main document. */
  async bodyText(): Promise<string> {
    return this.serial(async () => String((await this.evalIn(await this.ensureMain(), "__pv.text()")).value || ""));
  }

  /** Evaluates an expression in the main isolated world. */
  async evalMain(expr: string): Promise<any> {
    return this.serial(async () => (await this.evalIn(await this.ensureMain(), expr)).value);
  }

  // ---- locators -----------------------------------------------------------------

  /** The locator chain of an element of the last read. */
  async locators(id: number): Promise<Target | null> {
    return this.serial(async () => {
      const ref = this.rev.get(id);
      const el = this.last?.byId.get(id);
      if (!ref || !el) return null;
      const t: Target = {};
      if (el.role && el.name) { t.role = el.role; t.name = el.name; }
      const w = this.worldByKey(ref.world);
      if (w && !ref.backend) {
        try {
          const r = await this.evalIn(w, `__gw.loc(${ref.local})`);
          const l = JSON.parse(r.value as string);
          if (l) {
            if (l.css) t.css = l.css;
            if (l.text && l.text !== t.name) t.text = l.text;
            if (l.xpath) t.xpath = l.xpath;
            if (l.near) t.near = l.near;
          }
        } catch { /* keep what we have */ }
        if (w.key !== "main" && w.url) {
          try { const u = new URL(w.url); t.frame = u.host + u.pathname; } catch { t.frame = w.url; }
        }
      }
      return t;
    });
  }

  /** Finds the element a locator chain points to, reading the page first. Null when nothing matches. */
  async resolve(t: Target): Promise<{ id: number; by: string } | null> {
    return this.serial(async () => {
      const sn = await this.snapshot(0);
      this.vol.note(this.last, sn);
      this.last = sn;
      const score = new Map<number, number>();
      const firstBy = new Map<number, string>();
      const add = (ids: number[], by: string, weight = 1) => {
        for (const id of new Set(ids)) {
          score.set(id, (score.get(id) || 0) + weight);
          if (!firstBy.has(id)) firstBy.set(id, by);
        }
      };
      const order: string[] = [];
      if (t.role && t.name) {
        let rn = findAll(sn.items, t.role, t.name);
        if (t.frame) rn = rn.filter(e => this.worldMatchesFrame(e.world || "main", t.frame!));
        if (rn.length === 1) return { id: rn[0].id, by: "role" };
        add(rn.map(e => e.id), "role", 2);
        order.push("role");
      }
      const worlds = [this.main!, ...this.frameWorlds.values()].filter(w => w && (t.frame ? this.worldMatchesFrame(w.key, t.frame) : w.key === "main"));
      for (const w of worlds) {
        let found: { css: number[]; text: number[]; xpath: number[]; near: number[] };
        try { found = JSON.parse((await this.evalIn(w, `__gw.find(${JSON.stringify({ css: t.css, text: t.text, xpath: t.xpath, near: t.near })})`)).value as string); } catch { continue; }
        const g = (ls: number[]) => ls.map(l => this.gid(w.key, l)).filter(id => sn.byId.has(id));
        const css = g(found.css), text = g(found.text), xp = g(found.xpath), near = g(found.near);
        if (!score.size && css.length === 1) return { id: css[0], by: "css" };
        add(css, "css", 2); add(text, "text"); add(xp, "xpath"); add(near, "near");
      }
      if (!score.size) return null;
      let best = -1, bestScore = 0, tie = false;
      for (const e of sn.items) {
        const s = score.get(e.id) || 0;
        if (s > bestScore) { best = e.id; bestScore = s; tie = false; } else if (s === bestScore && s > 0) tie = true;
      }
      if (best < 0 || (tie && bestScore < 3)) return null;
      return { id: best, by: firstBy.get(best) || "css" };
    });
  }

  private worldMatchesFrame(key: string, frame: string): boolean {
    const w = this.worldByKey(key);
    return !!w && w.key !== "main" && w.url.includes(frame.split("/")[0]) && w.url.includes(frame.slice(frame.indexOf("/")));
  }

  /** Reads `fields` under `css` in the main document (a recipe's DOM extract). */
  async domExtract(spec: { css?: string | null; fields?: Record<string, string>; limit?: number }): Promise<unknown> {
    return JSON.parse(await this.evalMain(`__gw.dom(${JSON.stringify(spec)})`));
  }

  /** The full page text for each prefix of a value the view cut short (null when not one). */
  async complete(prefixes: string[]): Promise<Record<string, string | null>> {
    return JSON.parse(await this.evalMain(`__gw.complete(${JSON.stringify(prefixes)})`));
  }

  async pageJson(): Promise<{ sel: string; json: unknown }[]> {
    return JSON.parse(await this.evalMain("__gw.pageJson()"));
  }

  async compileCss(rows: unknown, keys: string[]): Promise<{ css: string | null; fields: Record<string, string> } | null> {
    return JSON.parse(await this.evalMain(`__gw.compileCss(${JSON.stringify(rows)}, ${JSON.stringify(keys)})`));
  }

  // ---- act ------------------------------------------------------------------------

  act(a: Action): Promise<ActResult> {
    return this.serial(() => this.actNow(a));
  }

  private async actNow(a: Action): Promise<ActResult> {
    a = { ...a, action: String(a.action || "").trim().toLowerCase() };
    const res: ActResult = {
      action: describe(a), status: "ok", changes: [], newTabs: [], downloads: [], errors: [], errorCount: 0, failedRequests: [],
      settle: { quietAfterMs: 0, waitedMs: 0, capHit: false, requests: [], requestCount: 0 }, text: "",
    };
    const finish = (f?: Failure | null) => {
      if (f) { res.status = f.status; res.reason = f.reason; if (f.guard) res.guard = true; }
      res.text = renderResult(res);
      return res;
    };
    if (!KNOWN.has(a.action)) return finish(failf(`unknown action "${a.action}"`));

    let pre = this.last;
    let startEpoch = this.epoch, startURL = this.url;
    let start = Date.now();

    if (a.action === "dialog") {
      const d = this.dialog;
      if (!d) return finish(failf("no dialog open"));
      this.resetActionLog();
      start = Date.now();
      try { if (a.accept) await d.accept(a.text); else await d.dismiss(); } catch (e) { return finish(failf("could not answer the dialog: " + (e as Error).message)); }
      this.dialog = null;
    } else {
      const pd = this.pendingDialog();
      if (pd) { res.dialog = pd; return finish(new Failure("blocked", "a JavaScript dialog is open: answer it with dialog accept or dialog dismiss")); }
      const { ch } = await this.checkChallenge();
      const onChallenge = !!ch;
      if (ch) {
        res.challenge = ch;
        const pointClick = a.action === "click" && !a.id && !a.role && a.x != null && a.y != null;
        const wheel = a.action === "scroll" && !a.id && !a.to;
        if (!ON_CHALLENGE.has(a.action) && !pointClick && !wheel) {
          return finish(new Failure("challenge", `${challengeWhat(ch)} is up: only click {x,y}, press, wait, scroll {dy} and navigation work on it`));
        }
        pre = null;
      } else {
        try {
          const sn = await this.snapshot(0);
          this.vol.note(this.last, sn);
          this.last = pre = sn;
        } catch (e) { const f = this.special(res, e); if (f) return finish(f); throw e; }
        if (!a.id && (a.role || a.name) && (NEEDS_TARGET.has(a.action) || a.action === "scroll")) {
          const e = findIn(pre.items, a.role || "", a.name || "");
          if (!e) return finish(failf(`no element with role ${quote(a.role || "")} and name ${quote(a.name || "")}`));
          a.id = e.id;
          res.action = describe(a);
        }
        if (NEEDS_TARGET.has(a.action) && !a.id && !(a.action === "click" && a.x != null && a.y != null)) return finish(failf(`${a.action} needs an element id`));
        if (a.id && !this.rev.has(a.id)) return finish(failf("unknown id"));
        await this.evalIn(this.main!, "__pv.mark()").catch(() => undefined);
      }
      startEpoch = this.epoch; startURL = this.url;
      this.resetActionLog();
      let f: Failure | null = null;
      try { f = await this.perform(a, pre, res); } catch (e) {
        const sf = this.special(res, e);
        if (sf && sf.status === "challenge") f = null;
        else if (e instanceof DialogOpen) f = null;
        else throw e;
      }
      start = Date.now();
      if (f) {
        if (!onChallenge) await this.evalIn(this.main!, "__pv.idle()").catch(() => undefined);
        return finish(f);
      }
    }

    let st = await this.settle(start);
    if (this.popupChecks.size) await Promise.race([Promise.all([...this.popupChecks]), new Promise(r => setTimeout(r, 3000))]);
    // a click or a redirect that went to a refused scheme, or left allowedOrigins: go back
    let leftFor = this.url ? this.navAllowed(this.url) : null;
    if (leftFor) {
      let left = this.url.startsWith("http") ? safeOrigin(this.url) : this.url.split(":")[0] + ":";
      // the error page of a navigation the origin rule stopped before any request
      if (this.url.startsWith("chrome-error:") && this.blockedNav) {
        left = safeOrigin(this.blockedNav);
        leftFor = this.blockedWhy || `${left} is outside allowedOrigins; the request was not sent`;
      }
      this.blockedNav = "";
      this.blockedWhy = "";
      const h: any = await this.call(this.cdp, "Page.getNavigationHistory").catch(() => null);
      let back: any = null;
      for (let i = (h?.currentIndex ?? 0) - 1; i >= 0 && !back; i--) if (!this.navAllowed(h.entries[i].url)) back = h.entries[i];
      if (back) await this.call(this.cdp, "Page.navigateToHistoryEntry", { entryId: back.id }).catch(() => undefined);
      else await this.call(this.cdp, "Page.navigate", { url: "about:blank" }).catch(() => undefined);
      st = await this.settle(Date.now());
      this.fillSideEffects(res, st);
      this.last = null;
      return finish(guardf(`the page went to ${left} (${leftFor}); went back`));
    }
    this.fillSideEffects(res, st);
    // a new tab the origin rule refused: said plainly, not an ok
    if (this.blockedPopups.length) {
      const u = this.blockedPopups.find(x => x !== "about:blank") ?? "about:blank";
      res.newTabs = res.newTabs.filter(t => t && t !== "about:blank" && !this.blockedPopups.includes(t));
      if (u === "about:blank") return finish(guardf("the page opened a blank new tab, which was closed (with allowedOrigins only tabs on allowed origins are kept)"));
      return finish(guardf(`the page tried to open ${u.startsWith("http") ? safeOrigin(u) : u.split(":")[0] + ":"} in a new tab (${this.navAllowed(u) || "not allowed"}); it was closed`));
    }
    const pd = this.pendingDialog();
    if (pd) { res.dialog = pd; return finish(); }
    const { ch, url: pageURL } = await this.checkChallenge();
    if (ch) {
      res.challenge = ch;
      res.status = "challenge";
      res.reason = challengeWhat(ch) + (startEpoch === this.epoch && !pre ? " is still up" : " appeared");
      if (pageURL) res.navigation = { url: pageURL, sameDocument: false };
      this.last = null;
      return finish();
    }
    res.challenge = undefined;
    let post: Snapshot;
    try { post = await this.snapshot(0); } catch (e) {
      const f = this.special(res, e);
      if (f) return finish(res.dialog ? null : f);
      throw e;
    }
    await this.evalIn(this.main!, "__pv.idle()").catch(() => undefined);
    this.last = post;
    const newDoc = post.epoch !== startEpoch || !pre || pre.epoch !== post.epoch;
    if (newDoc) {
      if (post.url !== startURL || this.epoch !== startEpoch) res.navigation = { url: post.url, sameDocument: false };
      res.view = buildView(post, {});
      res.freshReason = "new page";
    } else if (a.action === "scroll") {
      res.view = buildView(post, {});
      res.freshReason = "scrolled";
    } else {
      if (this.url !== startURL) res.navigation = { url: this.url, sameDocument: true };
      const d = diffSnapshots(pre!, post, this.vol.is(post.epoch), a.id || 0);
      res.volatileIgnored = d.volatile || undefined;
      if (d.changes.length > MAX_DIFF_LINES) {
        res.view = buildView(post, {});
        res.freshReason = `large change (${d.changed} changed, ${d.added} added, ${d.removed} removed)`;
      } else {
        res.changes = d.changes;
        res.noChange = d.changes.length === 0;
      }
      if (post.focus !== pre!.focus && post.focus && post.focus !== a.id && !isAncestor(post, post.focus, a.id || 0)) {
        const e = post.byId.get(post.focus);
        if (e) res.focus = { ...e };
      }
    }
    return finish();
  }

  private special(res: ActResult, e: unknown): Failure | null {
    if (e instanceof DialogOpen) { res.dialog = this.pendingDialog(); return new Failure("blocked", "a JavaScript dialog is open: answer it with dialog accept or dialog dismiss"); }
    if (e instanceof ChallengeError) { res.challenge = e.ch; return new Failure("challenge", challengeWhat(e.ch) + " appeared"); }
    return null;
  }

  private resetActionLog(): void {
    this.net.reset();
    this.sameDocNavs = []; this.newTabs = []; this.downloads = []; this.errors = []; this.blockedPopups = [];
  }

  private fillSideEffects(res: ActResult, st: SettleInfo): void {
    res.settle = st;
    res.settle.requestCount = this.net.log.length;
    for (const r of this.net.log) {
      const ri: RequestInfo = { method: r.method, url: shortURL(r.url, this.url, 70), type: r.type, status: r.status || undefined, failed: r.failed || undefined };
      if ((r.type === "Document" || r.type === "XHR" || r.type === "Fetch") && !isBeacon(r.url) && res.settle.requests.length < 20) res.settle.requests.push(ri);
      if ((r.status >= 400 || r.failed) && res.failedRequests.length < 5 && !r.url.endsWith("/favicon.ico") && !isBeacon(r.url)) res.failedRequests.push(ri);
    }
    res.newTabs = [...this.newTabs];
    res.downloads = [...this.downloads];
    res.errorCount = this.errors.length;
    res.errors = this.errors.slice(0, 3);
  }

  private async settle(start: number): Promise<SettleInfo> {
    const q = new QuietTracker(this.cfg, start);
    let evalOK = true;
    let lastEpoch = this.epoch;
    for (;;) {
      if (this.dialog) break;
      const smp = { inflight: 0, netLast: 0, loading: false, mutAgo: -1, shiftAgo: -1, scrollX: 0, scrollY: 0, haveScroll: false, animations: 0 };
      const worldBefore = this.main;
      const newDoc = !this.main || this.epoch !== this.main.epoch;
      if (newDoc && !this.domReady) smp.loading = true;
      else if (evalOK) {
        try {
          const v = (await this.evalIn(this.main && !newDoc ? this.main : await this.ensureMain(), "__pv.q()")).value as number[];
          if (v && v.length >= 7) {
            smp.mutAgo = v[0]; smp.scrollX = v[2]; smp.scrollY = v[3]; smp.haveScroll = true;
            smp.shiftAgo = v[4]; smp.animations = v[5]; smp.loading = v[6] === 0;
          }
        } catch (e) {
          if (e instanceof ChallengeError) evalOK = false;
          else if (!(e instanceof DialogOpen)) smp.loading = true;
        }
      }
      const now = Date.now();
      smp.inflight = this.net.blocking(now);
      smp.netLast = this.net.last;
      smp.loading = smp.loading || this.net.mainDocPending();
      if (this.epoch !== lastEpoch || this.main !== worldBefore) { lastEpoch = this.epoch; q.bump(now); }
      q.feed(now, smp);
      const { settled, capHit } = q.done(now);
      if (settled) {
        if (capHit && evalOK && !this.dialog) await this.evalIn(this.main!, "__pv.capNoisy()").catch(() => undefined);
        return { quietAfterMs: q.quietAfter(), waitedMs: Date.now() - start, capHit, requests: [], requestCount: 0 };
      }
      await sleep(this.cfg.poll);
    }
    return { quietAfterMs: q.quietAfter(), waitedMs: Date.now() - start, capHit: false, requests: [], requestCount: 0 };
  }

  // ---- performing actions -------------------------------------------------------

  private ref(id: number): { w: World; local: number; backend?: number } | null {
    const r = this.rev.get(id);
    if (!r) return null;
    const w = this.worldByKey(r.world);
    return w ? { w, local: r.local, backend: r.backend } : null;
  }

  private async preInfo(id: number): Promise<Pre> {
    const r = this.ref(id);
    if (!r) return { err: "unknown id", role: "", name: "", tag: "", type: "" };
    if (r.backend) {
      const el = this.last?.byId.get(id);
      return { role: el?.role || "", name: el?.name || "", tag: "", type: "", focused: false, checked: el?.state?.checked ? el.state.checked === "true" : undefined };
    }
    return JSON.parse((await this.evalIn(r.w, `__pv.pre(${r.local})`)).value as string) as Pre;
  }

  private async objectOf(id: number, expr: "t" | "el"): Promise<{ w: World; objectId?: string } | null> {
    const r = this.ref(id);
    if (!r) return null;
    if (r.backend) {
      const n: any = await this.call(this.cdp, "DOM.resolveNode", { backendNodeId: r.backend, executionContextId: this.main!.ctx, objectGroup: "gw" }).catch(() => null);
      return { w: r.w, objectId: n?.object?.objectId };
    }
    const { objectId } = await this.evalIn(r.w, `__pv.${expr}(${r.local})`, false);
    return { w: r.w, objectId };
  }

  private async target(id: number, allowDisabled: boolean, allowHidden: boolean): Promise<{ p: Pre; f: Failure | null }> {
    const p = await this.preInfo(id);
    if (!p.err) return { p, f: null };
    if (p.err === "disabled" && allowDisabled) return { p, f: null };
    if (p.err === "not visible" && allowHidden) return { p, f: null };
    return { p, f: failf(p.err) };
  }

  private async scrollChain(w: World): Promise<void> {
    if (!w.parent || w.hostLocal === undefined) return;
    await this.scrollChain(w.parent);
    const { objectId } = await this.evalIn(w.parent, `__pv.el(${w.hostLocal})`, false);
    if (objectId) await this.call(w.parent.cdp, "DOM.scrollIntoViewIfNeeded", { objectId }).catch(() => undefined);
  }

  private async quads(w: World, objectId: string): Promise<number[][]> {
    if (w.key === "main") {
      const q: any = await this.call(this.cdp, "DOM.getContentQuads", { objectId }).catch(() => null);
      return q?.quads || [];
    }
    const r: any = await this.call(w.cdp, "Runtime.callFunctionOn", {
      objectId, returnByValue: true, silent: true,
      functionDeclaration: "function(){return Array.from(this.getClientRects()).map(r=>[r.left,r.top,r.right,r.top,r.right,r.bottom,r.left,r.bottom])}",
    }).catch(() => null);
    const [ox, oy] = await this.offsetOf(w);
    return ((r?.result?.value as number[][]) || []).map(q => q.map((v, i) => v + (i % 2 ? oy : ox)));
  }

  /** Scrolls the element into view, picks a point inside it and checks a click there reaches it. */
  private async aim(id: number, pre: Snapshot | null): Promise<{ x: number; y: number } | Failure> {
    const o = await this.objectOf(id, "t");
    if (!o?.objectId) return failf("element gone");
    await this.scrollChain(o.w);
    await this.call(o.w.cdp, "DOM.scrollIntoViewIfNeeded", { objectId: o.objectId }).catch(() => undefined);
    let q: number[][] = [];
    let prev = "", same = 0;
    for (let i = 0; i < 40; i++) {
      q = await this.quads(o.w, o.objectId);
      if (!q.length) return failf("not visible");
      const cur = JSON.stringify(q);
      if (cur === prev) { if (++same >= 2) break; } else same = 0;
      prev = cur;
      await sleep(16);
    }
    const vw = pre?.vw || 1e6, vh = pre?.vh || 1e6;
    const pts: [number, number][] = [];
    for (const quad of q) {
      let [x1, y1, x2, y2] = quadBounds(quad);
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(vw, x2); y2 = Math.min(vh, y2);
      if (x2 - x1 < 1 || y2 - y1 < 1) continue;
      const w = x2 - x1, h = y2 - y1;
      pts.push([x1 + w / 2, y1 + h / 2]);
      if (pts.length === 1) pts.push([x1 + w / 4, y1 + h / 2], [x1 + 3 * w / 4, y1 + h / 2], [x1 + w / 2, y1 + h / 4], [x1 + w / 2, y1 + 3 * h / 4]);
      if (pts.length > 8) break;
    }
    if (!pts.length) return failf("not visible");
    let by = "";
    for (const [x, y] of pts) {
      const h = await this.hitTest(id, x, y);
      if (h.ok) return { x, y };
      if (!by) by = h.by;
    }
    if (!by) return new Failure("blocked", `element [${id}] does not take clicks where it is drawn: a click there reaches its container`);
    return new Failure("blocked", `element [${id}] is covered by ${by}`);
  }

  /** Does a click at (x, y) (top-level viewport) reach element `id`? */
  private async hitTest(id: number, x: number, y: number): Promise<{ ok: boolean; by: string }> {
    const r = this.ref(id);
    if (!r) return { ok: false, by: "nothing (element gone)" };
    if (r.w.key !== "main") {
      // the frame itself must be reachable in its parent, then the element inside it
      const parentHit = await this.hitWorld(r.w.parent!, r.w.hostLocal!, x, y);
      if (!parentHit.ok) return parentHit;
      const [ox, oy] = await this.offsetOf(r.w);
      return this.hitWorld(r.w, r.local, x - ox, y - oy);
    }
    if (r.backend) {
      const lm: any = await this.call(this.cdp, "Page.getLayoutMetrics");
      const loc: any = await this.call(this.cdp, "DOM.getNodeForLocation", { x: Math.floor(x + lm.cssVisualViewport.pageX), y: Math.floor(y + lm.cssVisualViewport.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }).catch(() => null);
      if (!loc?.backendNodeId) return { ok: true, by: "" };
      if (loc.backendNodeId === r.backend) return { ok: true, by: "" };
      const tgt = await this.objectOf(id, "el");
      const hit: any = await this.call(this.cdp, "DOM.resolveNode", { backendNodeId: loc.backendNodeId, executionContextId: this.main!.ctx }).catch(() => null);
      if (!tgt?.objectId || !hit?.object?.objectId) return { ok: true, by: "" };
      const c: any = await this.call(this.cdp, "Runtime.callFunctionOn", {
        objectId: tgt.objectId, returnByValue: true, silent: true, arguments: [{ objectId: hit.object.objectId }],
        functionDeclaration: "function(h){for(let n=h,i=0;n&&i<400;i++){if(n===this)return true;n=n.parentNode||n.host}return false}",
      });
      return c?.result?.value ? { ok: true, by: "" } : { ok: false, by: "another element" };
    }
    return this.hitWorld(r.w, r.local, x, y);
  }

  private async hitWorld(w: World, local: number, x: number, y: number): Promise<{ ok: boolean; by: string }> {
    let arg: any = { value: null };
    if (w.key === "main") {
      const lm: any = await this.call(this.cdp, "Page.getLayoutMetrics");
      const loc: any = await this.call(this.cdp, "DOM.getNodeForLocation", { x: Math.floor(x + lm.cssVisualViewport.pageX), y: Math.floor(y + lm.cssVisualViewport.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }).catch(() => null);
      if (loc?.backendNodeId) {
        const rn: any = await this.call(this.cdp, "DOM.resolveNode", { backendNodeId: loc.backendNodeId, executionContextId: w.ctx, objectGroup: "gw" }).catch(() => null);
        if (rn?.object?.objectId) arg = { objectId: rn.object.objectId };
      }
    }
    const r: any = await this.callD(w.cdp, "Runtime.callFunctionOn", {
      functionDeclaration: `function(h,x,y){return __pv.hit(${local},h,x,y)}`, executionContextId: w.ctx,
      arguments: [arg, { value: x }, { value: y }], returnByValue: true, silent: true,
    });
    const v = JSON.parse(r.result.value as string);
    if (v.ok) return { ok: true, by: "" };
    if (v.gone) return { ok: false, by: "nothing (element gone)" };
    if (v.miss) return { ok: false, by: "" };
    if (v.by?.id) {
      const g = this.gid(w.key, v.by.id);
      return { ok: false, by: ident({ id: g, role: v.by.role, name: v.by.name }) };
    }
    return { ok: false, by: "an unlisted element " + quote(v.by?.desc || "") };
  }

  private async mouse(type: string, x: number, y: number, button?: string, buttons = 0, count = 0, mods = 0): Promise<void> {
    const p: any = { type, x, y, modifiers: mods, pointerType: "mouse" };
    if (button) { p.button = button; p.buttons = buttons; p.clickCount = count; }
    await this.callD(this.cdp, "Input.dispatchMouseEvent", p);
  }

  private async mouseMove(x: number, y: number, mods = 0): Promise<void> {
    const fx = this.mouseX, fy = this.mouseY;
    for (let i = 1; i <= 3; i++) await this.mouse("mouseMoved", fx + (x - fx) * i / 3, fy + (y - fy) * i / 3, undefined, 0, 0, mods);
    this.mouseX = x; this.mouseY = y;
  }

  private async mousePress(x: number, y: number, right: boolean, clicks: number, mods: number): Promise<void> {
    const button = right ? "right" : "left", bits = right ? 2 : 1;
    for (let c = 1; c <= clicks; c++) {
      await this.mouse("mousePressed", x, y, button, bits, c, mods);
      await this.mouse("mouseReleased", x, y, button, 0, c, mods);
    }
  }

  private async clickElement(id: number, pre: Snapshot | null, right: boolean, clicks: number, mods: number): Promise<Failure | null> {
    for (let attempt = 0; ; attempt++) {
      const p = await this.aim(id, pre);
      if (p instanceof Failure) return p;
      await this.mouseMove(p.x, p.y, mods);
      const h = await this.hitTest(id, p.x, p.y);
      if (h.ok || attempt === 2) { await this.mousePress(p.x, p.y, right, clicks, mods); return null; }
    }
  }

  private async keyEvent(k: KeyDef, mods = 0, commands?: string[]): Promise<void> {
    const down: any = { type: k.text ? "keyDown" : "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mods };
    if (k.text) { down.text = k.text; down.unmodifiedText = k.text; }
    if (commands?.length) down.commands = commands;
    await this.callD(this.cdp, "Input.dispatchKeyEvent", down);
    await this.callD(this.cdp, "Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mods });
  }

  private async pressCombo(c: KeyCombo): Promise<void> {
    const order: [number, KeyDef][] = [[MOD.ctrl, MODIFIER_KEYS.control.def], [MOD.alt, MODIFIER_KEYS.alt.def], [MOD.shift, MODIFIER_KEYS.shift.def], [MOD.meta, MODIFIER_KEYS.meta.def]];
    let held = 0;
    for (const [bit, def] of order) {
      if (c.mods & bit) { held |= bit; await this.callD(this.cdp, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers: held }); }
    }
    try { await this.keyEvent(c.key, c.mods); } finally {
      for (const [bit, def] of [...order].reverse()) {
        if (c.mods & bit) { held &= ~bit; await this.callD(this.cdp, "Input.dispatchKeyEvent", { type: "keyUp", key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers: held }); }
      }
    }
  }

  private async typeText(text: string): Promise<void> {
    if ([...text].length > 120) { await this.callD(this.cdp, "Input.insertText", { text }); return; }
    for (const ch of text) {
      if (ch === "\n") { await this.keyEvent(NAMED_KEYS.enter); continue; }
      const k = charKey(ch);
      if (!k) { await this.callD(this.cdp, "Input.insertText", { text: ch }); continue; }
      await this.keyEvent(k, k.shift ? MOD.shift : 0);
    }
  }

  private async readFacts(w: World, expr: string): Promise<ControlFacts[]> {
    try { return JSON.parse((await this.evalIn(w, expr)).value as string) as ControlFacts[]; } catch { return []; }
  }

  /** Facts at a top-level point, followed into frames (a click on a frame lands on what is inside it). */
  private async factsAtPoint(w: World, x: number, y: number, depth = 0): Promise<ControlFacts[]> {
    const [ox, oy] = await this.offsetOf(w);
    const f = await this.readFacts(w, `__gw.facts(0, ${x - ox}, ${y - oy}, false)`);
    const fid = f[0]?.frameId;
    if (fid && depth < 3) {
      const child = await this.frameWorld(w, fid).catch(() => null);
      if (!child) return [{ tag: "iframe", labels: [], ids: [], unreadableFrame: true }];
      return this.factsAtPoint(child, x, y, depth + 1);
    }
    return f;
  }

  /** Facts about the focused control, followed into frames. */
  private async factsAtFocus(w: World, depth = 0): Promise<ControlFacts[]> {
    const f = await this.readFacts(w, "__gw.facts(0, 0, 0, true)");
    if (f[0]?.unreadableFrame && f[0].frameId && depth < 3) {
      const child = await this.frameWorld(w, f[0].frameId).catch(() => null);
      if (child) return this.factsAtFocus(child, depth + 1);
    }
    return f;
  }

  /** A purchase-guard refusal for this action, or null. */
  private async purchaseCheck(a: Action): Promise<Failure | null> {
    if (!this.purchaseGuard) return null;
    let facts: ControlFacts[] = [];
    // Enter, NumpadEnter, Return or Space anywhere in a key sequence submits, or presses the focused button
    const tokens = a.action === "press" ? (a.keys || "").trim().split(/\s+/).map(t => (t.split("+").pop() || "").toLowerCase()) : [];
    const keySubmit = tokens.some(k => ["enter", "return", "numpadenter", "space", "spacebar"].includes(k));
    // a newline in typed text is Enter
    const typeSubmit = a.action === "type" && (!!a.submit || /[\r\n]/.test(a.text || ""));
    if (a.action === "click" && !a.id && a.x != null && a.y != null) facts = await this.factsAtPoint(await this.ensureMain(), a.x, a.y);
    else if ((a.action === "click" || typeSubmit) && a.id) {
      const r = this.ref(a.id);
      const el = this.last?.byId.get(a.id);
      if (r?.backend || !r) facts = el ? [{ role: el.role, labels: [el.name], ids: [] }] : [];
      else facts = await this.readFacts(r.w, `__gw.facts(${r.local}, 0, 0, ${typeSubmit})`);
      if (el && ["checkbox", "radio", "switch"].includes(el.role)) facts = [];
    } else if (keySubmit || typeSubmit) facts = await this.factsAtFocus(await this.ensureMain());
    else return null;
    const why = this.purchaseGuard(facts);
    return why ? guardf(`purchase_blocked: "${why}" would place an order, pay or subscribe; nothing was done. Report what the page shows instead (allowPurchases: true allows it)`) : null;
  }

  /**
   * Types text that holds secrets into the element itself. The value is
   * read for the field's own document at this moment, then inserted by one
   * call on the element that checks, in the page, that the element is still
   * there and its document still has that origin. No key events go to
   * whatever has focus. If the page rejects the inserted value, keys are
   * sent one by one, each after checking focus, element, origin and document.
   */
  private async typeSecret(a: Action): Promise<Failure | null> {
    const r = this.ref(a.id!);
    if (!r) return failf("unknown id");
    if (r.backend) return guardf("a secret is not typed into an element read from the accessibility tree");
    const o = await this.objectOf(a.id!, "el");
    if (!o?.objectId) return failf("element gone");
    const epoch = this.epoch;
    const call = async (fn: string, args: unknown[] = []) => {
      const x: any = await this.callD(o.w.cdp, "Runtime.callFunctionOn", { objectId: o.objectId, functionDeclaration: fn, arguments: args.map(v => ({ value: v })), returnByValue: true, silent: true });
      if (x.exceptionDetails) throw new Error("page script failed");
      return x.result?.value;
    };
    const facts = JSON.parse(await call(`function(){
      if (!this.isConnected) return 'null';
      const f = this.form || null, d = this.ownerDocument;
      return JSON.stringify({ url: d.location.href, tag: this.tagName, type: (this.getAttribute('type') || this.type || '').toLowerCase(),
        editable: !!this.isContentEditable && this.tagName !== 'INPUT' && this.tagName !== 'TEXTAREA',
        // an explicit method="get" (a form with no method is often a script's login form: the network stop covers it)
        method: f ? (f.getAttribute('method') || '').trim().toLowerCase() : null,
        getSubmit: f ? Array.from(f.elements || []).some(e => (e.tagName === 'BUTTON' || e.tagName === 'INPUT') && e.hasAttribute('formmethod') && String(e.formMethod).toLowerCase() === 'get') : false,
        maxlen: typeof this.maxLength === 'number' ? this.maxLength : -1 });
    }`));
    if (!facts) return failf("element gone");
    if (facts.editable || (facts.tag !== "INPUT" && facts.tag !== "TEXTAREA")) return guardf("a secret is typed only into a text field (not an editable region)");
    if (facts.type === "search") return guardf("a secret is not typed into a search box");
    if (facts.tag === "INPUT" && !/^(text|password|email|tel|url|number|)$/.test(facts.type)) return guardf(`a secret is not typed into a ${facts.type} field`);
    // a form that sends its fields in the address: the secret would end up in a URL
    if (facts.method === "get" || facts.getSubmit) return guardf("a secret is not typed into a form that sends its fields in the address (GET)");
    const value = await a.secretText!.resolve(facts.url); // origin rule of every secret, for this document
    // from now on a page load that carries this secret in its address is stopped
    for (const n of a.secretText!.names) this.typedSecrets.add(n);
    await this.installRouter();
    if (facts.maxlen > 0 && [...value].length > facts.maxlen) return guardf(`the field takes at most ${facts.maxlen} characters and the secret is longer; nothing was typed`);
    if (this.epoch !== epoch) return failf("the page changed before typing; nothing was typed");
    const origin = new URL(facts.url).origin;
    const put = await call(`function(value, origin, clear){
      if (!this.isConnected || this.ownerDocument.location.origin !== origin) return 'moved';
      try { this.focus({ preventScroll: true }); } catch (e) {}
      if (!this.isConnected || this.ownerDocument.location.origin !== origin) return 'moved';
      const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const next = clear ? value : (this.value || '') + value;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, next);
      this.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return this.value === next ? 'ok' : 'rejected';
    }`, [value, origin, a.clear !== false]);
    if (put === "moved" || this.epoch !== epoch) return failf("the field or its page changed before typing; nothing was typed");
    if (put === "rejected") {
      // the page reset the value: keys, one by one, each checked first
      await call(`function(){ const p = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(this, ''); this.dispatchEvent(new InputEvent('input', { bubbles: true })); }`);
      const check = `function(origin){
        let a = document.activeElement;
        for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 10; i++) a = a.shadowRoot.activeElement;
        return this.isConnected && this.ownerDocument.location.origin === origin && (a === this || this.ownerDocument.activeElement === this) && this.ownerDocument.hasFocus();
      }`;
      for (const ch of value) {
        if (this.epoch !== epoch || !(await call(check, [origin]))) return guardf("focus left the field while typing the secret; typing stopped");
        const k = charKey(ch);
        if (k) await this.keyEvent(k, k.shift ? MOD.shift : 0);
        else await this.callD(this.cdp, "Input.insertText", { text: ch });
      }
    }
    this.secretFields.set(`${r.w.key}:${r.local}`, a.secretText!.names);
    if (a.submit) await this.keyEvent(NAMED_KEYS.enter);
    return null;
  }

  private async perform(a: Action, pre: Snapshot | null, res: ActResult): Promise<Failure | null> {
    const pf = await this.purchaseCheck(a);
    if (pf) return pf;
    if (a.action === "navigate" && a.url) {
      const why = this.navAllowed(a.url);
      if (why) return guardf(`${why}; nothing was opened`);
    }
    if (a.action === "type" && a.secretText) {
      const { p, f } = await this.target(a.id!, false, false);
      if (f) return f;
      res.action = describe(a, p);
      return this.typeSecret(a);
    }
    switch (a.action) {
      case "click": {
        let mods = 0;
        for (const m of a.modifiers || []) {
          const k = MODIFIER_KEYS[m.toLowerCase()];
          if (!k) return failf(`unknown modifier "${m}"`);
          mods |= k.bit;
        }
        const clicks = a.double ? 2 : 1;
        if (!a.id) {
          await this.mouseMove(a.x!, a.y!, mods);
          await this.mousePress(a.x!, a.y!, !!a.right, clicks, mods);
          return null;
        }
        const t = await this.target(a.id, false, false);
        if (t.f) return t.f;
        return this.clickElement(a.id, pre, !!a.right, clicks, mods);
      }
      case "hover": {
        const t = await this.target(a.id!, true, false);
        if (t.f) return t.f;
        const p = await this.aim(a.id!, pre);
        if (p instanceof Failure) return p;
        await this.mouseMove(p.x, p.y);
        return null;
      }
      case "type": {
        const { p, f } = await this.target(a.id!, false, false);
        if (f) return f;
        res.action = describe(a, p);
        if (p.tag === "SELECT" || (p.tag === "INPUT" && /^(checkbox|radio|file|button|submit)$/.test(p.type))) return failf(`element [${a.id}] is not a text field`);
        const segmented = p.tag === "INPUT" && /^(date|time|datetime-local|month|week)$/.test(p.type);
        if (segmented) {
          const o = await this.objectOf(a.id!, "el");
          await this.call(o!.w.cdp, "DOM.scrollIntoViewIfNeeded", { objectId: o!.objectId }).catch(() => undefined);
          try { await this.call(o!.w.cdp, "DOM.focus", { objectId: o!.objectId }); } catch (e) { return failf("could not focus the field: " + (e as Error).message); }
        } else if (!p.focused) {
          const cf = await this.clickElement(a.id!, pre, false, 1, 0);
          if (cf) return cf;
          const p2 = await this.preInfo(a.id!);
          if (!p2.err && !p2.focused && !this.ref(a.id!)?.backend) {
            const o = await this.objectOf(a.id!, "el");
            if (o?.objectId) await this.call(o.w.cdp, "DOM.focus", { objectId: o.objectId }).catch(() => undefined);
            const p3 = await this.preInfo(a.id!);
            if (!p3.err && !p3.focused) return failf(`could not focus element [${a.id}]; nothing was typed`);
          }
        }
        if (!segmented && ((p.len || 0) > 0 || p.editable)) {
          if (a.clear) {
            const A: KeyDef = { key: "a", code: "KeyA", vk: 65 };
            await this.keyEvent(A, 0, ["selectAll"]);
            if (!p.editable) {
              const p2 = await this.preInfo(a.id!);
              if (!p2.err && (p2.len || 0) > 0 && !p2.selAll) await this.pressCombo({ mods: p.mac ? MOD.meta : MOD.ctrl, key: A });
            }
            await this.keyEvent(NAMED_KEYS.backspace);
          } else await this.keyEvent({ key: "End", code: "End", vk: 35 }, 0, ["moveToEndOfDocument"]);
        }
        await this.typeText(a.text || "");
        if (a.submit) await this.keyEvent(NAMED_KEYS.enter);
        return null;
      }
      case "press": {
        let combos: KeyCombo[];
        try { combos = parseKeys(a.keys || ""); } catch (e) { return failf((e as Error).message); }
        for (const c of combos) await this.pressCombo(c);
        return null;
      }
      case "select":
        return this.selectOption(a);
      case "check":
      case "uncheck": {
        const want = a.action === "check";
        const { p, f } = await this.target(a.id!, false, false);
        if (f) return f;
        if (p.checked === undefined) return failf(`element [${a.id}] is not a checkbox, radio or switch`);
        if (p.checked === want) return null;
        return this.clickElement(a.id!, pre, false, 1, 0);
      }
      case "scroll": {
        if (a.id) {
          const t = await this.target(a.id, true, false);
          if (t.f) return t.f;
          const o = await this.objectOf(a.id, "t");
          if (!o?.objectId) return failf("element gone");
          await this.scrollChain(o.w);
          await this.call(o.w.cdp, "DOM.scrollIntoViewIfNeeded", { objectId: o.objectId, centerIfNeeded: true });
          return null;
        }
        let dy = a.dy || 0;
        const to = (a.to || "").toLowerCase();
        if (to === "top") dy = -1e7;
        else if (to === "bottom") dy = 1e7;
        else if (to) return failf(`scroll to "${a.to}": use top or bottom`);
        else if (!dy) return failf("scroll needs dy, to (top|bottom) or an element id");
        const x = pre?.vw ? pre.vw / 2 : 400, y = pre?.vh ? pre.vh / 2 : 300;
        await this.callD(this.cdp, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy, pointerType: "mouse" });
        return null;
      }
      case "navigate": {
        if (!a.url) return failf("navigate needs a url");
        try {
          const nav: any = await this.call(this.cdp, "Page.navigate", { url: a.url }, 60000);
          if (nav.errorText && nav.errorText !== "net::ERR_ABORTED") return failf("navigation failed: " + nav.errorText);
        } catch (e) { return failf("navigation failed: " + (e as Error).message); }
        return null;
      }
      case "back":
      case "forward": {
        const h: any = await this.call(this.cdp, "Page.getNavigationHistory");
        const i = h.currentIndex + (a.action === "forward" ? 1 : -1);
        if (i < 0 || i >= h.entries.length) return failf(`no history entry to go ${a.action} to`);
        await this.call(this.cdp, "Page.navigateToHistoryEntry", { entryId: h.entries[i].id });
        return null;
      }
      case "reload":
        await this.call(this.cdp, "Page.reload");
        return null;
      case "wait":
        return this.wait(a);
      case "upload": {
        if (!a.files?.length) return failf("upload needs files");
        const { p, f } = await this.target(a.id!, false, true);
        if (f) return f;
        if (p.tag !== "INPUT" || p.type !== "file") return failf(`element [${a.id}] is not a file input`);
        const o = await this.objectOf(a.id!, "el");
        try { await this.call(o!.w.cdp, "DOM.setFileInputFiles", { files: a.files, objectId: o!.objectId }); } catch (e) { return failf("upload failed: " + (e as Error).message); }
        return null;
      }
    }
    return failf(`unknown action "${a.action}"`);
  }

  private async selectOption(a: Action): Promise<Failure | null> {
    const { p, f } = await this.target(a.id!, false, false);
    if (f) return f;
    if (p.tag !== "SELECT") return failf(`element [${a.id}] is not a <select>: open it with click and click the option`);
    if (p.multiple) return failf(`element [${a.id}] is a multiple select, which select does not handle`);
    const opts = p.opts || [];
    const want = (a.option || "").trim().toLowerCase();
    let idx = opts.findIndex(o => o.t.toLowerCase() === want);
    if (idx < 0) idx = opts.findIndex(o => o.v === a.option);
    if (idx < 0 && want) idx = opts.findIndex(o => o.t.toLowerCase().includes(want));
    if (idx < 0) {
      const names = opts.slice(0, 8).map(o => quote(cut(o.t, 30)));
      if (opts.length > 8) names.push("…");
      return failf(`no option ${quote(a.option || "")} (options: ${names.join(", ")})`);
    }
    if (opts[idx].d) return failf(`option ${quote(opts[idx].t)} is disabled`);
    if (p.sel === idx) return null;
    const o = await this.objectOf(a.id!, "el");
    try { await this.call(o!.w.cdp, "DOM.focus", { objectId: o!.objectId }); } catch (e) { return failf("could not focus the select: " + (e as Error).message); }
    const r = this.ref(a.id!)!;
    const read = async () => Number((await this.evalIn(r.w, `(()=>{const e=__pv.el(${r.local});return e?e.selectedIndex:-2})()`)).value);
    let cur = p.sel ?? -1;
    const since = Date.now() - this.lastTypeAhead;
    if (since < 1200) await sleep(1200 - since);
    for (const ch of opts[idx].t.trim().toLowerCase()) {
      if (cur === idx) break;
      const k = charKey(ch);
      if (k) await this.keyEvent(k);
      else await this.callD(this.cdp, "Input.dispatchKeyEvent", { type: "char", text: ch });
      this.lastTypeAhead = Date.now();
      cur = await read();
    }
    const steps = (from: number, to: number) => {
      let n = 0;
      const lo = Math.min(from, to), hi = Math.max(from, to);
      for (let i = lo + 1; i <= hi; i++) { const j = from > to ? i - 1 : i; if (j >= 0 && j < opts.length && !opts[j].d) n++; }
      return n;
    };
    for (let round = 0; round < 4 && cur !== idx; round++) {
      const key = idx < cur ? NAMED_KEYS.arrowup : NAMED_KEYS.arrowdown;
      const n = steps(cur, idx) || 1;
      for (let i = 0; i < n; i++) await this.keyEvent(key);
      const now = await read();
      if (now === cur) break;
      cur = now;
    }
    if (cur !== idx) return failf(`could not select ${quote(opts[idx].t)} with the keyboard (now selected: ${quote(opts[cur]?.t || "")})`);
    return null;
  }

  private async wait(a: Action): Promise<Failure | null> {
    const timeout = a.timeout && a.timeout > 0 ? a.timeout : 10000;
    const deadline = Date.now() + timeout;
    switch (a.for) {
      case undefined:
        await sleep(Math.min(a.ms || 0, 60000));
        return null;
      case "text": {
        if (!a.text) return failf("wait for text needs text");
        const want = a.text.toLowerCase();
        for (;;) {
          const sn = await this.snapshot(0);
          if (snapshotContains(sn, want)) return null;
          if (Date.now() > deadline) return failf(`timeout waiting for text ${quote(cut(a.text, 60))}`);
          await sleep(200);
        }
      }
      case "id-gone": {
        if (!a.id) return failf("wait for id-gone needs an element id");
        for (;;) {
          const p = await this.preInfo(a.id);
          if (p.err === "element gone" || p.err === "unknown id" || p.err === "not visible") return null;
          if (Date.now() > deadline) return failf(`timeout waiting for [${a.id}] to go away`);
          await sleep(100);
        }
      }
      case "url-change": {
        const start = this.url;
        for (;;) {
          if (this.url !== start) return null;
          if (Date.now() > deadline) return failf("timeout waiting for the URL to change");
          await sleep(50);
        }
      }
    }
    return failf(`wait for "${a.for}": use text, id-gone or url-change`);
  }
}

function safeOrigin(u: string): string {
  try { return new URL(u).origin; } catch { return u.slice(0, 80); }
}

// is `anc` a container (frame, shadow host) of element `id`?
function isAncestor(sn: Snapshot, anc: number, id: number): boolean {
  let p = sn.byId.get(id)?.parent;
  for (let i = 0; p && i < 200; i++) {
    if (p === anc) return true;
    p = sn.byId.get(p)?.parent;
  }
  return false;
}

function quadBounds(q: number[]): [number, number, number, number] {
  let x1 = q[0], y1 = q[1], x2 = q[0], y2 = q[1];
  for (let i = 2; i < 8; i += 2) { x1 = Math.min(x1, q[i]); x2 = Math.max(x2, q[i]); y1 = Math.min(y1, q[i + 1]); y2 = Math.max(y2, q[i + 1]); }
  return [x1, y1, x2, y2];
}

function challengeWhat(ch: Challenge): string {
  let l = `${ch.kind} ${ch.fullPage ? "full-page check" : "widget"}`;
  if (ch.box) l += `  frame ${ch.box.w}x${ch.box.h} at ${ch.box.x},${ch.box.y}`;
  return l;
}

function challengeView(ch: Challenge, title: string, url: string): View {
  const text = `page ${quote(cut(title, 100))} ${bareOrQuote(cut(url, 200))}\nchallenge: ${challengeWhat(ch)}\nno elements listed: nothing is read from a bot-check page`;
  return { state: "challenge", url, title, challenge: ch, scrollX: 0, scrollY: 0, viewportW: 0, viewportH: 0, pageW: 0, pageH: 0, scope: "viewport", elements: [], total: 0, totalInteractive: 0, degraded: 0, tokens: estimateTokens(text), collectMs: 0, text };
}

function dialogLine(d: JSDialog): string {
  let l = `dialog: ${d.type} ${quote(cut(d.message, 300))}`;
  if (d.type === "prompt" && d.default) l += "  default " + quote(cut(d.default, 80));
  return l + "  pending";
}

export function describe(a: Action, pre?: Pre): string {
  const id = a.id ? ` [${a.id}]` : "";
  switch (a.action) {
    case "click": {
      const s = a.double ? "double-click" : a.right ? "right-click" : "click";
      if (!a.id && a.x != null && a.y != null) return `${s} at ${Math.round(a.x)},${Math.round(a.y)}`;
      return s + id;
    }
    case "type": {
      let t = a.textShown !== undefined ? a.textShown : quote(cut(a.text || "", 60));
      if (pre?.type === "password" || a.secretText) t = "(hidden)";
      return `type${id} ${t}${a.clear ? ", clear first" : ""}${a.submit ? ", then Enter" : ""}`;
    }
    case "press": return "press " + a.keys;
    case "select": return `select${id} ${quote(cut(a.option || "", 60))}`;
    case "scroll": return a.id ? "scroll to" + id : a.to ? "scroll to " + a.to : `scroll ${(a.dy || 0) >= 0 ? "+" : ""}${a.dy || 0}`;
    case "navigate": return "navigate " + bareOrQuote(cut(a.url || "", 120));
    case "wait":
      if (a.for === "text") return "wait for text " + quote(cut(a.text || "", 60));
      if (a.for === "id-gone") return `wait for${id} to go away`;
      if (a.for === "url-change") return "wait for the URL to change";
      return `wait ${a.ms || 0} ms`;
    case "upload": return `upload${id} ${a.files?.length || 0} file(s)`;
    case "dialog": return a.accept ? "dialog accept" : "dialog dismiss";
  }
  return a.action + id;
}

function reqText(r: RequestInfo): string {
  return `${r.method} ${bareOrQuote(r.url)} → ${r.failed ? bareOrQuote(r.failed) : r.status ? r.status : "pending"}`;
}

function renderResult(r: ActResult): string {
  const lines = ["after: " + r.action];
  if (r.status === "failed") lines.push("failed: " + r.reason);
  if (r.status === "blocked") lines.push("blocked: " + r.reason);
  if (r.status === "challenge") lines.push("challenge: " + r.reason);
  if (r.dialog) lines.push(dialogLine(r.dialog) + "  (answer with dialog accept | dialog dismiss)");
  if (r.status !== "ok" && !r.settle.waitedMs) return lines.join("\n");
  if (r.navigation) {
    if (r.navigation.sameDocument) lines.push(`url → ${bareOrQuote(cut(r.navigation.url, 200))}  (same document)`);
    else if (r.view) lines.push(`navigated → ${bareOrQuote(cut(r.navigation.url, 200))}  (new page, ${plural(r.view.elements.length, "element")})`);
    else lines.push("navigated → " + bareOrQuote(cut(r.navigation.url, 200)));
  }
  if (r.view) {
    if (!r.navigation || r.navigation.sameDocument) lines.push(r.freshReason + ": fresh view");
    lines.push(r.view.text);
  } else if (!r.dialog && r.status === "ok") {
    for (const c of r.changes) lines.push(c.text);
    if (r.noChange) lines.push("no change");
  }
  if (r.volatileIgnored) lines.push(r.volatileIgnored === 1 ? "(1 element that keeps changing on its own left out)" : `(${r.volatileIgnored} elements that keep changing on their own left out)`);
  if (r.focus) lines.push("focus → " + ident(r.focus));
  for (const t of r.newTabs) lines.push("new tab → " + bareOrQuote(cut(t, 200)));
  for (const d of r.downloads) lines.push("download → " + quote(cut(d, 120)));
  if (r.errorCount) lines.push(`errors: ${r.errorCount} (first: ${quote(cut(r.errors[0], 160))})`);
  if (r.failedRequests.length) lines.push("failed requests: " + r.failedRequests.map(reqText).join(", "));
  let sl = r.settle.capHit ? `not settled after ${r.settle.waitedMs} ms (cap)` : `settled after ${r.settle.quietAfterMs} ms`;
  const n = r.settle.requestCount;
  if (n > 0) {
    sl += ", " + plural(n, "request");
    if (r.settle.requests.length) {
      const parts = r.settle.requests.slice(0, 3).map(reqText);
      if (r.settle.requests.length > 3) parts.push(`… ${n - 3} more`);
      sl += " (" + parts.join(", ") + ")";
    }
  } else sl += ", no requests";
  lines.push(sl);
  return lines.join("\n");
}
