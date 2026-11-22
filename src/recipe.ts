// Recipes: Browsa's replay recipe format (recipe-v1), stored as JSON.
import type { Target } from "./engine/session.js";
import type { JSONSchema } from "./schema.js";

export type StepKind = "navigate" | "click" | "type" | "select" | "press" | "scroll" | "wait" | "fetch" | "extract" | "assert" | "analyze";

/** What a step did when it was recorded; checked again on replay. */
export interface Effect {
  /** navigate: a new document; change: the page changed; value: a field took the text; none: nothing visible */
  kind: "navigate" | "change" | "value" | "none";
  /** navigate: the path it went to (templated) */
  path?: string;
  /** change: the state the target took (expanded, checked, pressed, selected) */
  state?: Record<string, string>;
}

export interface Step {
  id: string;
  kind: StepKind;
  url?: string;
  target?: Target;
  text?: string;
  value?: string;
  pages?: number;
  keys?: string;
  submit?: boolean;
  clear?: boolean;
  for?: { text?: string; url?: string; target?: Target };
  timeout_ms?: number;
  in_page?: true;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  mutation?: boolean;
  optional?: boolean;
  save_as?: string;
  from?: "page" | "page_json" | "saved";
  source?: string;
  how?: {
    jsonpath?: string; css?: string; fields?: Record<string, string>; model?: boolean; into?: string; limit?: number; allow_empty?: boolean;
    /** Ghostwright: per field, the part of the element's text that is the value (a pattern with one group), for a value that is not an element of its own ("Kestrel Sling — $45") */
    match?: Record<string, string>;
    /** Ghostwright: per field, the header of the table column the value was read from; a replay that finds another header there fails the step instead of returning shifted data */
    headers?: Record<string, string>;
    /** Ghostwright: a list of plain values: the one field of each row that is the value */
    pick?: string;
    /** Ghostwright: per field, a list inside each row: the rows' selector relative to the outer row, and their fields */
    nested?: Record<string, { css: string; fields: Record<string, string>; match?: Record<string, string> }>;
  };
  schema_ref?: "output";
  expr?: string;
  goal?: string;
  /** Ghostwright: the check after the action */
  effect?: Effect;
  /** Ghostwright: check / uncheck / hover on top of click / wait */
  state?: "checked" | "unchecked";
  hover?: boolean;
  /** Ghostwright: this step's action opens a JavaScript dialog (alert, confirm), answered this way */
  dialog?: "accept" | "dismiss";
  /** Ghostwright: the text typed into a prompt() when accepted ({{param}}, or a secret token) */
  dialog_text?: string;
  /** Ghostwright: how long after the step before it this step was done when recorded (ms); a replay waits about that long for its element before it gives up */
  after_ms?: number;
  /** Ghostwright: the output schema of this extract */
  output_schema?: JSONSchema;
}

export interface Recipe {
  name: string;
  version: number;
  params: JSONSchema;
  output: JSONSchema;
  start_url?: string;
  steps: Step[];
  fallbacks?: Record<string, string[]>;
  assertions?: { after: string; expr: string }[];
  repair?: { mode?: "auto" | "review" | "off"; max_steps?: number };
  meta?: Record<string, unknown>;
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "My invoices!" -> "my-invoices" */
export function recipeName(s: string): string {
  const n = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!NAME_RE.test(n)) throw new TypeError(`flow name "${s}" gives no usable recipe name (a-z, 0-9 and -)`);
  return n;
}

/** Fills {{param}} and {{json:param}}. {{secret:name}} is left to the caller. */
export function render(s: string, params: Record<string, unknown>): string {
  return s.replace(/\{\{\s*(json:)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, json: string | undefined, k: string) => {
    if (!(k in params)) return m;
    const v = params[k];
    return json ? JSON.stringify(v) : String(v);
  });
}

/** Replaces param values in a recorded string with {{param}}. */
export function templatize(s: string, params: Record<string, unknown>): string {
  let out = s;
  const entries = Object.entries(params).filter(([, v]) => v != null && String(v).length >= 2).sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [k, v] of entries) {
    const sv = String(v);
    for (const form of new Set([sv, encodeURIComponent(sv), encodeURIComponent(sv).replace(/%20/g, "+")])) {
      if (out.includes(form)) out = out.split(form).join(`{{${k}}}`);
    }
  }
  return out;
}

/** The ways a value shows up in a URL path: as is, encoded, or as a slug in any case. */
function pathForms(v: string): string[] {
  const low = v.toLowerCase().trim();
  return [...new Set([v, encodeURIComponent(v), low, encodeURIComponent(low), low.replace(/\s+/g, "-"), low.replace(/\s+/g, "_"), low.replace(/\s+/g, "+"), low.replace(/\s+/g, "")])].filter(f => f.length >= 2);
}

/** A recorded path with each param value (also as a slug, any case) written as {{param}}. */
export function templatizePath(path: string, params: Record<string, unknown>): string {
  return path.split("/").map(seg => {
    let out = seg;
    const entries = Object.entries(params).filter(([, v]) => v != null && String(v).length >= 2).sort((a, b) => String(b[1]).length - String(a[1]).length);
    for (const [k, v] of entries) {
      for (const f of pathForms(String(v)).sort((a, b) => b.length - a.length)) {
        const i = out.toLowerCase().indexOf(f.toLowerCase());
        if (i >= 0) { out = out.slice(0, i) + `{{${k}}}` + out.slice(i + f.length); break; }
      }
    }
    return out;
  }).join("/");
}

/**
 * Does the path a step went to fit the recorded one? Segments must match,
 * except digits (ids, page numbers) and {{param}} parts, which must hold
 * this run's value. `loose` lets one other segment differ: the step acted on
 * a page that depends on the params (a search result opens another item).
 */
export function pathMatches(want: string, got: string, params: Record<string, unknown>, loose = false): boolean {
  const a = want.split("/"), b = got.split("/");
  if (a.length !== b.length) return false;
  let free = loose ? 1 : 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i] || segmentRe(a[i], params).test(b[i])) continue;
    if (free-- > 0) continue;
    return false;
  }
  return true;
}

function segmentRe(seg: string, params: Record<string, unknown>): RegExp {
  let re = "", last = 0;
  for (const m of seg.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\d+/g)) {
    re += escapeRe(seg.slice(last, m.index));
    if (m[1]) re += m[1] in params ? `(?:${pathForms(String(params[m[1]])).map(escapeRe).join("|")})` : "[^/]+";
    else re += "\\d+";
    last = m.index! + m[0].length;
  }
  return new RegExp(`^${re}${escapeRe(seg.slice(last))}$`, "i");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function paramsSchema(params: Record<string, unknown>): JSONSchema {
  const props: Record<string, JSONSchema> = {};
  for (const [k, v] of Object.entries(params)) props[k] = { type: typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string" };
  return { type: "object", properties: props, required: Object.keys(params) };
}

// ---- a JSONPath subset: $ .key ['key'] [n] [*] ----------------------------

type Op = { key: string } | { index: number } | { all: true };

export function parsePath(p: string): Op[] {
  if (!p.startsWith("$")) throw new Error(`jsonpath must start with $: ${p}`);
  const ops: Op[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]|\[\s*(\d+)\s*\]|\[\s*\*\s*\]|\.\*/gy;
  re.lastIndex = 1;
  while (re.lastIndex < p.length) {
    const m = re.exec(p);
    if (!m) throw new Error(`unsupported jsonpath: ${p}`);
    if (m[1] !== undefined) ops.push({ key: m[1] });
    else if (m[2] !== undefined) ops.push({ key: m[2] });
    else if (m[3] !== undefined) ops.push({ key: m[3] });
    else if (m[4] !== undefined) ops.push({ index: +m[4] });
    else ops.push({ all: true });
  }
  return ops;
}

/** A list for paths with [*], else the single value (undefined when nothing matched). */
export function jsonpath(p: string, data: unknown): unknown {
  const ops = parsePath(p);
  let cur: unknown[] = [data];
  for (const op of ops) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v == null) continue;
      if ("key" in op) { if (typeof v === "object" && op.key in (v as object)) next.push((v as any)[op.key]); }
      else if ("index" in op) { if (Array.isArray(v) && op.index < v.length) next.push(v[op.index]); }
      else if (Array.isArray(v)) next.push(...v);
      else if (typeof v === "object") next.push(...Object.values(v as object));
    }
    cur = next;
  }
  return ops.some(o => "all" in o) ? cur : cur[0];
}

/** Builds "$.a.b[*]" from keys. */
export function pathOf(keys: (string | number | "*")[]): string {
  return "$" + keys.map(k => (k === "*" ? "[*]" : typeof k === "number" ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? "." + k : `['${k}']`)).join("");
}

// ---- assertions: a small, safe expression language ------------------------
// output.items.length >= 1 && output.items[0].price > 0

export function evaluate(expr: string, scope: Record<string, unknown>): unknown {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (t: string) => { if (next() !== t) throw new Error(`expected ${t} in: ${expr}`); };
  const primary = (): unknown => {
    const t = next();
    if (t === undefined) throw new Error("unexpected end of: " + expr);
    if (t === "(") { const v = or(); expect(")"); return v; }
    if (t === "!") return !primary();
    if (t === "-") return -(primary() as number);
    if (/^\d/.test(t)) return parseFloat(t);
    if (t[0] === '"' || t[0] === "'") return JSON.parse('"' + t.slice(1, -1).replace(/"/g, '\\"') + '"');
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (!/^[A-Za-z_]\w*$/.test(t)) throw new Error(`unexpected "${t}" in: ${expr}`);
    if (!(t in scope)) throw new Error(`unknown name "${t}" in: ${expr}`);
    let v: any = scope[t];
    for (;;) {
      if (peek() === ".") {
        next();
        const k = next();
        if (!k || k.startsWith("__")) throw new Error("bad member in: " + expr);
        v = v == null ? undefined : k === "length" && (Array.isArray(v) || typeof v === "string") ? v.length : v[k];
      } else if (peek() === "[") {
        next();
        const k = or() as any;
        expect("]");
        if (typeof k === "string" && k.startsWith("__")) throw new Error("bad member in: " + expr);
        v = v == null ? undefined : v[k];
      } else break;
    }
    return v;
  };
  const mul = (): unknown => { let v: any = primary(); while (["*", "/", "%"].includes(peek())) { const o = next(); const r: any = primary(); v = o === "*" ? v * r : o === "/" ? v / r : v % r; } return v; };
  const add = (): unknown => { let v: any = mul(); while (["+", "-"].includes(peek())) { const o = next(); const r: any = mul(); v = o === "+" ? v + r : v - r; } return v; };
  const cmp = (): unknown => {
    let v: any = add();
    while (["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(peek())) {
      const o = next(); const r: any = add();
      v = o === "<" ? v < r : o === "<=" ? v <= r : o === ">" ? v > r : o === ">=" ? v >= r : o === "==" || o === "===" ? v === r : v !== r;
    }
    return v;
  };
  const and = (): unknown => { let v = cmp(); while (peek() === "&&") { next(); const r = cmp(); v = v && r; } return v; };
  const or = (): unknown => { let v = and(); while (peek() === "||") { next(); const r = and(); v = v || r; } return v; };
  const v = or();
  if (i < toks.length) throw new Error(`unexpected "${toks[i]}" in: ${expr}`);
  return v;
}

function tokenize(s: string): string[] {
  const re = /\s*(===|!==|==|!=|<=|>=|&&|\|\||[()[\].!<>+\-*/%]|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_]\w*)/gy;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while (re.lastIndex < s.length && (m = re.exec(s))) out.push(m[1]);
  if (s.slice(re.lastIndex).trim()) throw new Error("cannot read: " + s);
  return out;
}
