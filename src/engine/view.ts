// The view: what the page script collected, rendered as short text for a
// model inside a token budget. TypeScript port of Browsa's pageview engine.
import { bareOrQuote, cut, estimateTokens, plural, quote } from "./text.js";

export interface Box { x: number; y: number; w: number; h: number }

export type ElementKind = "element" | "text" | "row" | "group" | "list";

export interface Element {
  /** Stable for the life of the document. Text blocks and rows have none (0). */
  id: number;
  kind: ElementKind;
  role: string;
  name: string;
  tag?: string;
  state?: Record<string, string>;
  options?: string[];
  cells?: string[];
  header?: boolean;
  box: Box;
  inViewport: boolean;
  where?: "above" | "below" | "side";
  frame?: string;
  shadow?: boolean;
  parent?: number;
  interactive?: boolean;
  behindDialog?: boolean;
  coveredBy?: number;
  coveredDesc?: string;
  /** identity for diffs */
  key: string;
  /** position in a list or table, -1 when none */
  index: number;
  /** number of items of a list */
  count: number;
  /** where the element lives: the world key and its id there (internal) */
  world?: string;
  local?: number;
  /** backend node id, for elements read from the accessibility tree */
  backend?: number;
}

export interface FrameInfo { id: number; name?: string; sameOrigin: boolean; origin?: string; read?: boolean }

export interface CaptchaWidget { kind: string; version?: number; puzzle?: string; state: string; question?: string }

export interface Challenge { kind: string; fullPage: boolean; reason: string; frameURL?: string; box?: Box }

export interface JSDialog { type: string; message: string; default?: string }

export interface View {
  state: "ok" | "challenge" | "dialog";
  url: string;
  title: string;
  scrollX: number; scrollY: number;
  viewportW: number; viewportH: number;
  pageW: number; pageH: number;
  scope: "viewport" | "page";
  loading?: boolean;
  elements: Element[];
  total: number;
  totalInteractive: number;
  modal?: number;
  dialog?: JSDialog;
  challenge?: Challenge;
  captchaWidgets?: CaptchaWidget[];
  frames?: FrameInfo[];
  focus?: number;
  degraded: number;
  truncated?: boolean;
  tokens: number;
  collectMs: number;
  text: string;
  /** the snapshot the view was built from (internal) */
  snap?: Snapshot;
}

export interface ObserveOptions {
  scope?: "viewport" | "page";
  expand?: number;
  /** approximate tokens (characters / 4); 0 = 2000, -1 = none */
  budget?: number;
  /** keep link targets whole (used for extraction) */
  fullLinks?: boolean;
}

export const DEFAULT_BUDGET = 2000;

export interface Snapshot {
  url: string; title: string;
  sx: number; sy: number; vw: number; vh: number; pw: number; ph: number;
  focus: number; modal: number; epoch: number; collectMs: number; loading: boolean; rematched: number;
  items: Element[];
  byId: Map<number, Element>;
  frames: FrameInfo[];
  widgets: CaptchaWidget[];
}

export const INTERACTIVE_ROLES = new Set(
  "link button checkbox radio switch textbox searchbox combobox listbox slider spinbutton tab menuitem menuitemcheckbox menuitemradio option treeitem file color clickable video audio captcha".split(" "),
);
const FIELD_ROLES = new Set("checkbox radio switch textbox searchbox combobox listbox slider spinbutton file color".split(" "));

export interface RawItem {
  k: string; r: string; n: string; i?: number; key?: string; t?: string; s?: Record<string, unknown>;
  b?: number[]; v: number; p?: number; ix?: number; fr?: string; sh?: number; bd?: number; c?: string[];
  h?: number; o?: string[]; cov?: number; covd?: string; cnt?: number;
}

export interface RawSnapshot {
  u: string; ti: string; sx: number; sy: number; vw: number; vh: number; pw: number; ph: number;
  foc: number; modal: number; rm: number; ms: number; ld: number; items: RawItem[];
  frames: { i: number; n: string; same: boolean; o: string }[];
  cw?: { k: string; v: number; p: string; st: string; q: string }[];
}

/** Turns one world's raw items into elements; `gid` maps a local id to a global one. */
export function parseItems(raw: RawSnapshot, gid: (local: number) => number, world: string): Element[] {
  const out: Element[] = [];
  for (const it of raw.items) {
    const kind: ElementKind = it.k === "el" ? "element" : it.k === "text" ? "text" : it.k === "row" ? "row" : it.k === "l" ? "list" : "group";
    const id = it.i ? gid(it.i) : 0;
    const e: Element = {
      id, kind, role: it.r, name: it.n || "", tag: it.t, options: it.o, cells: it.c, header: it.h === 1,
      inViewport: it.v === 1, frame: it.fr, shadow: it.sh === 1, parent: it.p ? gid(it.p) : 0,
      behindDialog: it.bd === 1, coveredBy: it.cov ? gid(it.cov) : 0, coveredDesc: it.covd,
      index: it.ix ?? -1, count: it.cnt ?? 0, box: { x: 0, y: 0, w: 0, h: 0 },
      key: (world === "main" ? "" : world + ":") + (it.key || "e" + (it.i || 0)),
      world, local: it.i || 0,
    };
    if (it.v === 2) e.where = "above";
    else if (it.v === 3) e.where = "below";
    else if (it.v === 4) e.where = "side";
    if (it.b && it.b.length === 4) e.box = { x: it.b[0], y: it.b[1], w: it.b[2], h: it.b[3] };
    if (it.s && Object.keys(it.s).length) {
      e.state = {};
      for (const [k, v] of Object.entries(it.s)) {
        if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") e.state[k] = String(v);
      }
    }
    if (e.kind === "element" && (INTERACTIVE_ROLES.has(e.role) || e.state?.clickable === "true")) e.interactive = true;
    out.push(e);
  }
  return out;
}

export function indexItems(sn: Snapshot): void {
  sn.byId = new Map();
  for (const e of sn.items) if (e.id) sn.byId.set(e.id, e);
}

/** First listed element with that role whose name equals `name`, else contains it. */
export function findIn(els: Element[], role: string, name: string): Element | undefined {
  const ln = name.toLowerCase();
  let partial: Element | undefined;
  for (const e of els) {
    if (!e.id || (role && e.role !== role)) continue;
    const en = e.name.toLowerCase();
    if (en === ln) return e;
    if (!partial && ln && en.includes(ln)) partial = e;
  }
  return partial;
}

/** All elements with that role and exactly that name (case-insensitive). */
export function findAll(els: Element[], role: string, name: string): Element[] {
  const ln = name.toLowerCase();
  return els.filter(e => e.id && (!role || e.role === role) && e.name.toLowerCase() === ln);
}

// ---- rendering --------------------------------------------------------------

interface Level { n: number; textMax: number; hrefMax: number; rowMax: number; listMax: number; inlineOpts: number; hints: boolean; viewport?: boolean }

const LEVELS: Level[] = [
  { n: 0, textMax: 4000, hrefMax: 60, rowMax: 6, listMax: 20, inlineOpts: 10, hints: true },
  { n: 1, textMax: 240, hrefMax: 60, rowMax: 6, listMax: 20, inlineOpts: 10, hints: true },
  { n: 2, textMax: 90, hrefMax: 32, rowMax: 6, listMax: 20, inlineOpts: 10, hints: true },
  { n: 3, textMax: 90, hrefMax: 32, rowMax: 3, listMax: 6, inlineOpts: 0, hints: false },
  { n: 4, textMax: 60, hrefMax: 0, rowMax: 3, listMax: 6, inlineOpts: 0, hints: false, viewport: true },
];

export const DIFF_LEVEL: Level = { n: 0, textMax: 160, hrefMax: 60, rowMax: 6, listMax: 20, inlineOpts: 0, hints: true };

/** State as short words. `only` names the keys to print; with it, an "off" flag prints its off word. */
export function stateTokens(e: Element, lv: Level, only?: Set<string>): string[] {
  const out: string[] = [];
  const st = e.state || {};
  const has = (k: string) => (only ? only.has(k) : k in st);
  const flag = (k: string, on: string, off: string) => {
    if (!has(k)) return;
    const v = st[k];
    if (v === "true") out.push(on);
    else if (v === "mixed") out.push("mixed");
    else if (only && off) out.push(off);
  };
  if (has("level") && st.level) out.push("h" + st.level);
  if (has("type") && st.type) out.push("type " + bareOrQuote(st.type));
  // a password's length is not shown; a field a secret was typed into is only "value hidden"
  if (has("secret") && st.secret) out.push("value hidden");
  else if (has("pw")) out.push(!st.pw || st.pw === "0" ? "empty" : "value hidden");
  if (has("value")) out.push(st.value ? "value " + quote(st.value) : "empty");
  flag("checked", "checked", "unchecked");
  flag("selected", "selected", "not selected");
  flag("current", "current", "not current");
  if (has("expanded")) { if (st.expanded === "true") out.push("expanded"); else if (st.expanded === "false") out.push("collapsed"); }
  if (has("pressed")) { if (st.pressed === "true") out.push("pressed"); else if (st.pressed === "false") out.push("not pressed"); else if (st.pressed === "mixed") out.push("mixed"); }
  flag("disabled", "disabled", "enabled");
  flag("readonly", "readonly", "editable");
  flag("required", "required", "not required");
  if (has("invalid")) {
    const v = st.invalid;
    out.push(!v ? "valid" : v === "true" ? "invalid" : "invalid: " + quote(v));
  }
  if (!only) flag("focused", "focused", "");
  if (has("href") && st.href) {
    if (lv.hrefMax > 0) out.push("→ " + bareOrQuote(lv.hrefMax >= 10000 ? st.href : cut(st.href, lv.hrefMax)));
    else if (!e.name) out.push("→ " + bareOrQuote(cut(st.href, 32)));
  }
  flag("newtab", "opens new tab", "opens in this tab");
  flag("download", "download", "");
  if (has("options")) {
    const n = e.options?.length ?? 0;
    if (n > 0 && n <= lv.inlineOpts && st.options === String(n)) out.push("options: " + e.options!.map(o => quote(cut(o, 30))).join(" | "));
    else out.push(`(${st.options} options)`);
  }
  if (has("files")) out.push(st.files ? "files " + quote(st.files) : "no file");
  flag("multiple", "multiple", "");
  if (has("accept") && st.accept) out.push("accepts " + quote(st.accept));
  if (has("maxlen") && st.maxlen) out.push(`max ${st.maxlen} chars`);
  if (has("min") && st.min) out.push("min " + bareOrQuote(st.min));
  if (has("max") && st.max) out.push("max " + bareOrQuote(st.max));
  if (has("popup") && st.popup) out.push("has popup");
  if (has("paused")) out.push(st.paused === "true" ? "paused" : "playing");
  if (has("rows") && st.rows) out.push(`(${st.rows} rows × ${st.cols} cols)`);
  if (has("size") && st.size) out.push(bareOrQuote(st.size));
  if (has("origin") && st.origin) out.push("origin " + bareOrQuote(st.origin));
  flag("clickable", "clickable", "");
  flag("multiline", "multiline", "");
  flag("opaque", "not readable", "");
  flag("modal", "modal", "not modal");
  if (lv.hints && has("hint") && st.hint) out.push("hint " + quote(st.hint));
  if (!only) {
    if (e.shadow) out.push("in shadow");
    if (e.coveredBy) out.push(`covered by [${e.coveredBy}]`);
    else if (e.coveredDesc) out.push("covered by " + quote(e.coveredDesc));
  } else if (only.has("covered")) {
    if (e.coveredBy) out.push(`covered by [${e.coveredBy}]`);
    else if (e.coveredDesc) out.push("covered by " + quote(e.coveredDesc));
    else out.push("no longer covered");
  }
  return out;
}

export function elementLine(e: Element, lv: Level): string {
  if (e.kind === "text") return "text " + quote(cut(e.name, lv.textMax));
  if (e.kind === "row") return (e.header ? "cols " : "row ") + (e.cells || []).map(quote).join(" | ");
  let s = e.id ? `[${e.id}] ` : "";
  s += e.role;
  if (e.name) s += " " + quote(e.name);
  const toks = stateTokens(e, lv);
  if (toks.length) s += "  " + toks.join(", ");
  return s;
}

export function ident(e: { id: number; role: string; name: string }): string {
  let s = e.id ? `[${e.id}] ` : "";
  s += e.role;
  if (e.name) s += " " + quote(e.name);
  return s;
}

function category(e: Element): string {
  if (e.kind === "text") return "text block";
  if (e.kind === "row") return "table row";
  if (e.role === "heading") return "heading";
  if (e.role === "link") return "link";
  if (e.role === "button") return "button";
  if (FIELD_ROLES.has(e.role)) return "field";
  if (e.role === "img") return "image";
  if (e.interactive) return "control";
  return "other";
}

const CATEGORY_ORDER = ["heading", "field", "button", "link", "control", "image", "table row", "text block", "other"];

function countsLine(c: Map<string, number>): string {
  return CATEGORY_ORDER.filter(k => (c.get(k) || 0) > 0).map(k => plural(c.get(k)!, k)).join(", ");
}

interface OutLine { text: string; el?: Element; cls: number }
interface Rendered { lines: OutLine[]; shown: Element[]; header: string; footer: string[] }

const str = (r: Rendered) => [r.header, ...r.lines.map(l => l.text), ...r.footer].join("\n");

function header(sn: Snapshot): string {
  let h = `page ${quote(cut(sn.title, 100))} ${bareOrQuote(cut(sn.url, 200))}  scroll ${sn.sy} of ${sn.ph}, viewport ${sn.vw}x${sn.vh}`;
  // said outright, so a reader does not scroll for more that is not there
  if (sn.sy + sn.vh >= sn.ph - 2) h += sn.sy <= 0 ? "  (whole page in view)" : "  (end of page in view)";
  if (sn.loading) h += "  (still loading: read again, or wait)";
  return h;
}

function isInside(sn: Snapshot, e: Element, container: number | undefined): boolean {
  if (!container) return false;
  if (e.id === container) return true;
  let p = e.parent;
  for (let i = 0; p && i < 200; i++) {
    if (p === container) return true;
    const pe = sn.byId.get(p);
    if (!pe) return false;
    p = pe.parent;
  }
  return false;
}

function render(sn: Snapshot, o: ObserveOptions, lv: Level): Rendered {
  let scope = o.scope || "viewport";
  if (lv.viewport) scope = "viewport";
  const show = new Array<boolean>(sn.items.length).fill(false);
  const hidden = new Set<number>();
  const desc = new Map<number, number>();
  const above = new Map<string, number>(), below = new Map<string, number>(), side = new Map<string, number>(), behind = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

  sn.items.forEach((e, i) => {
    const expanded = isInside(sn, e, o.expand);
    let cutAway = false;
    const p = e.parent ? sn.byId.get(e.parent) : undefined;
    if (p) {
      if (hidden.has(p.id)) cutAway = true;
      else if (e.index >= 0 && !expanded) {
        if (p.role === "table" && !e.header && e.index >= lv.rowMax) cutAway = true;
        if (p.kind === "list" && e.index >= lv.listMax) cutAway = true;
      }
    }
    if (e.kind === "group" || e.kind === "list") { if (cutAway) hidden.add(e.id); return; }
    if (cutAway) return;
    if (sn.modal && e.behindDialog && scope !== "page" && !expanded) { inc(behind, category(e)); return; }
    if (!e.inViewport && scope !== "page" && !expanded) {
      inc(e.where === "above" ? above : e.where === "side" ? side : below, category(e));
      return;
    }
    show[i] = true;
    let q = e.parent;
    for (let k = 0; q && k < 200; k++) {
      desc.set(q, (desc.get(q) || 0) + 1);
      const pe = sn.byId.get(q);
      if (!pe) break;
      q = pe.parent;
    }
  });
  sn.items.forEach((e, i) => {
    if (e.kind === "row" && e.header && !show[i] && (desc.get(e.parent!) || 0) > 0 && !hidden.has(e.parent!)) show[i] = true;
  });

  const r: Rendered = { header: header(sn), lines: [], shown: [], footer: [] };
  const stack: { id: number; printed: boolean }[] = [];
  let depth = 0;
  const indent = () => "  ".repeat(depth);
  const closeTop = () => {
    const top = stack.pop()!;
    const c = sn.byId.get(top.id);
    if (c && !isInside(sn, c, o.expand)) {
      if (c.role === "table") {
        const rows = parseInt(c.state?.rows || "0", 10);
        if (rows > lv.rowMax) r.lines.push({ text: indent() + `… ${rows - lv.rowMax} more rows (expand [${c.id}])`, cls: -1 });
      } else if (c.kind === "list" && c.count > lv.listMax) {
        r.lines.push({ text: indent() + `… ${c.count - lv.listMax} more items (expand [${c.id}])`, cls: -1 });
      }
    }
    if (top.printed) depth--;
  };
  sn.items.forEach((e, i) => {
    while (stack.length && !isInside(sn, e, stack[stack.length - 1].id)) closeTop();
    if (e.kind === "group" || e.kind === "list") {
      if (!desc.get(e.id) || hidden.has(e.id)) return;
      let printed = false;
      if (e.kind === "group" && (["table", "frame", "dialog", "alertdialog"].includes(e.role) || (desc.get(e.id) || 0) >= 2)) {
        printed = true;
        r.lines.push({ text: indent() + elementLine(e, lv), el: e, cls: -1 });
        r.shown.push(e);
      }
      stack.push({ id: e.id, printed });
      if (printed) depth++;
      return;
    }
    if (!show[i]) return;
    let cls = 3;
    if (e.interactive && e.inViewport) cls = 0;
    else if (e.role === "heading" && e.inViewport) cls = 1;
    else if (e.interactive || e.role === "heading") cls = 2;
    r.lines.push({ text: indent() + elementLine(e, lv), el: e, cls });
    r.shown.push(e);
    if (e.id === o.expand && (e.options?.length || 0) > lv.inlineOpts) {
      r.lines.push({ text: indent() + "  options: " + e.options!.map(quote).join(" | "), cls: -1 });
    }
  });
  while (stack.length) closeTop();

  const add = (label: string, m: Map<string, number>) => { const s = countsLine(m); if (s) r.footer.push(label + s); };
  add("above the fold: ", above);
  add("below the fold: ", below);
  add("off to the side: ", side);
  add("behind dialog: ", behind);
  let dl = "dialog: none";
  if (sn.modal) {
    dl = `dialog: [${sn.modal}] modal, the rest of the page is behind it`;
    const m = sn.byId.get(sn.modal);
    if (m) r.header += `\ndialog [${m.id}] ${quote(m.name)} is open (modal)`;
  }
  let fl = "frames: none";
  if (sn.frames.length) {
    const ps: string[] = [];
    sn.frames.forEach((f, i) => {
      if (i === 4) { ps.push(`… ${sn.frames.length - 4} more`); return; }
      if (i > 4) return;
      const kind = f.sameOrigin ? "same-origin" : f.read ? "cross-origin" : "cross-origin, not readable";
      ps.push(`[${f.id}] ${quote(cut(f.name || f.origin || "", 40))}, ${kind}`);
    });
    fl = `frames: ${sn.frames.length} (${ps.join("; ")})`;
  }
  r.footer.push(dl + "  " + fl);
  return r;
}

function truncate(r: Rendered, budget: number): Rendered {
  const len = (s: string) => [...s].length;
  let runes = len(r.header) + r.lines.reduce((n, l) => n + len(l.text) + 1, 0) + r.footer.reduce((n, f) => n + len(f) + 1, 0);
  const drop = new Array<boolean>(r.lines.length).fill(false);
  let dropped = 0, droppedInteractive = 0;
  const trailer = () =>
    !dropped ? "" : droppedInteractive
      ? `… ${dropped} more elements, ${droppedInteractive} of them interactive in the viewport (expand or raise budget)`
      : `… ${dropped} more elements (expand or raise budget)`;
  const fits = () => { const t = trailer(); return Math.ceil((runes + (t ? len(t) + 1 : 0)) / 4) <= budget; };
  for (const cls of [3, 2, 1, 0, -1]) {
    for (let i = r.lines.length - 1; i >= 0 && !fits(); i--) {
      const l = r.lines[i];
      if (l.cls !== cls || drop[i]) continue;
      drop[i] = true;
      runes -= len(l.text) + 1;
      if (l.el && l.cls >= 0) { dropped++; if (cls === 0) droppedInteractive++; }
    }
    if (fits()) break;
  }
  const out: Rendered = { header: r.header, footer: r.footer, lines: [], shown: [] };
  r.lines.forEach((l, i) => { if (!drop[i]) { out.lines.push(l); if (l.el) out.shown.push(l.el); } });
  const t = trailer();
  if (t) out.lines.push({ text: t, cls: -1 });
  return out;
}

/** Renders the snapshot inside the budget, degrading step by step. */
export function buildView(sn: Snapshot, o: ObserveOptions = {}): View {
  const budget = o.budget || DEFAULT_BUDGET;
  const scope = o.scope || "viewport";
  const v: View = {
    state: "ok", url: sn.url, title: sn.title, scrollX: sn.sx, scrollY: sn.sy, viewportW: sn.vw, viewportH: sn.vh,
    pageW: sn.pw, pageH: sn.ph, scope, loading: sn.loading || undefined, modal: sn.modal || undefined, frames: sn.frames,
    focus: sn.focus || undefined, collectMs: sn.collectMs, captchaWidgets: sn.widgets.length ? sn.widgets : undefined,
    elements: [], total: 0, totalInteractive: 0, degraded: 0, tokens: 0, text: "", snap: sn,
  };
  for (const e of sn.items) {
    if (e.kind === "group" || e.kind === "list") continue;
    v.total++;
    if (e.interactive) v.totalInteractive++;
  }
  let r: Rendered | undefined;
  let text = "";
  for (const base of LEVELS) {
    const lv = o.fullLinks && base.n < 4 ? { ...base, hrefMax: 100000 } : base;
    r = render(sn, o, lv);
    text = str(r);
    v.degraded = lv.n;
    if (budget < 0 || estimateTokens(text) <= budget) break;
  }
  if (budget >= 0 && estimateTokens(text) > budget) {
    v.degraded = 5;
    v.truncated = true;
    r = truncate(r!, budget);
    text = str(r);
  }
  if (v.degraded >= 4) v.scope = "viewport";
  v.elements = r!.shown.slice();
  v.text = text;
  v.tokens = estimateTokens(text);
  return v;
}

export function snapshotContains(sn: Snapshot, lower: string): boolean {
  for (const e of sn.items) {
    if (e.name.toLowerCase().includes(lower) || (e.state?.value || "").toLowerCase().includes(lower)) return true;
    if (e.cells?.some(c => c.toLowerCase().includes(lower))) return true;
  }
  return false;
}
