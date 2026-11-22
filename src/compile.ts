// Turning a model extract into a deterministic one. Tried in order: JSON the
// page fetched while the step ran, JSON embedded in the page, CSS. A
// compiled extractor is kept only when it gives back exactly the model's
// answer; replays then read the data with no model.
import type { CapturedResponse, PageSession } from "./engine/session.js";
import { jsonpath, pathOf, templatize, type Step } from "./recipe.js";
import { coerce, sameJSON, type JSONSchema, type SchemaLike } from "./schema.js";

interface Shape {
  list: boolean; into?: string; keys: string[]; rows: Record<string, unknown>[]; itemSchema: JSONSchema;
  /** a list of plain values: each is read as a row with this one field */
  pick?: string;
  /** fields that are a list of flat objects inside each row, with their keys */
  nested?: Record<string, string[]>;
}

const SCALAR = new Set(["string", "number", "integer", "boolean"]);
const typeOf = (s: JSONSchema) => (Array.isArray(s?.type) ? s.type.filter((t: string) => t !== "null")[0] : s?.type);

function shape(schema: JSONSchema, answer: unknown): Shape | null {
  if (typeOf(schema) !== "object" || !schema.properties || !answer || typeof answer !== "object") return null;
  const props = Object.entries(schema.properties as Record<string, JSONSchema>);
  if (props.length === 1 && typeOf(props[0][1]) === "array") {
    const [into, arr] = props[0];
    const item = arr.items as JSONSchema;
    const rows = (answer as any)[into];
    if (!Array.isArray(rows) || !rows.length) return null;
    // a list of plain values ("the author of every quote")
    if (item && SCALAR.has(typeOf(item)) && typeOf(item) !== "boolean") {
      if (rows.some(v => v == null || typeof v === "object")) return null;
      return { list: true, into, keys: ["value"], rows: rows.map(v => ({ value: v })), itemSchema: { type: "object", properties: { value: item }, required: ["value"] }, pick: "value" };
    }
    if (typeOf(item) !== "object" || !item.properties) return null;
    const keys: string[] = [], nested: Record<string, string[]> = {};
    for (const [k, s] of Object.entries(item.properties as Record<string, JSONSchema>)) {
      if (SCALAR.has(typeOf(s))) { keys.push(k); continue; }
      // one level of nesting: a list of flat objects inside each row
      const it = typeOf(s) === "array" ? (s.items as JSONSchema) : null;
      if (!it || typeOf(it) !== "object" || !it.properties || !Object.values(it.properties as Record<string, JSONSchema>).every(x => SCALAR.has(typeOf(x)))) return null;
      if (rows.some(r => !Array.isArray(r?.[k]))) return null;
      nested[k] = Object.keys(it.properties);
    }
    if (!keys.length) return null;
    return { list: true, into, keys, rows, itemSchema: item, ...(Object.keys(nested).length ? { nested } : {}) };
  }
  if (props.every(([, s]) => SCALAR.has(typeOf(s)))) return { list: false, keys: props.map(p => p[0]), rows: [answer as Record<string, unknown>], itemSchema: schema };
  return null;
}

const norm = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().toLowerCase() : v);
function eq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  if (typeof a === "number" || typeof b === "number") {
    const x = typeof a === "number" ? a : parseFloat(String(a)), y = typeof b === "number" ? b : parseFloat(String(b));
    return typeof a === typeof b ? x === y : false;
  }
  return norm(a) === norm(b) && norm(a) !== "";
}

/** Relative path inside `obj` (depth 3) whose value equals `v`. */
function findPath(obj: unknown, v: unknown, depth = 0, path: (string | number)[] = []): (string | number)[] | null {
  if (eq(obj, v)) return path;
  if (depth >= 3 || !obj || typeof obj !== "object") return null;
  for (const [k, x] of Object.entries(obj as object)) {
    if (Array.isArray(obj) && +k > 0) break;
    const p = findPath(x, v, depth + 1, [...path, Array.isArray(obj) ? +k : k]);
    if (p) return p;
  }
  return null;
}

/** Arrays of objects inside `doc` (depth 6) with at least `min` items. */
function* arrays(doc: unknown, min: number, path: (string | number)[] = [], depth = 0): Generator<{ path: (string | number)[]; arr: unknown[] }> {
  if (depth > 6 || !doc || typeof doc !== "object") return;
  if (Array.isArray(doc)) {
    if (doc.length >= min && doc[0] && typeof doc[0] === "object" && !Array.isArray(doc[0])) yield { path, arr: doc };
    if (doc.length && typeof doc[0] === "object") yield* arrays(doc[0], min, [...path, 0], depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(doc as object)) yield* arrays(v, min, [...path, k], depth + 1);
}

/** Applies `how` to a JSON document the way a replay does. */
export function readJSON(doc: unknown, how: NonNullable<Step["how"]>): unknown {
  let v = jsonpath(how.jsonpath || "$", doc);
  if (how.fields) {
    const pick = (item: unknown) => Object.fromEntries(Object.entries(how.fields!).map(([k, p]) => [k, jsonpath(p, item) ?? null]));
    v = Array.isArray(v) ? v.map(pick) : v != null ? pick(v) : v;
  }
  if (Array.isArray(v) && how.limit) v = v.slice(0, how.limit);
  return v;
}

function matchJSON(doc: unknown, sh: Shape): NonNullable<Step["how"]> | null {
  const row0 = sh.rows[0];
  const keys = sh.keys.filter(k => row0[k] != null);
  if (!keys.length) return null;
  const tryAt = (base: (string | number)[], item: unknown, list: boolean): NonNullable<Step["how"]> | null => {
    const fields: Record<string, string> = {};
    for (const k of keys) {
      const p = findPath(item, row0[k]);
      if (!p) return null;
      fields[k] = pathOf(p);
    }
    for (const k of sh.keys) if (!fields[k]) fields[k] = "$." + k;
    return { jsonpath: pathOf(list ? [...base, "*"] : base), fields, ...(sh.into ? { into: sh.into } : {}) };
  };
  if (sh.list) {
    for (const { path, arr } of arrays(doc, sh.rows.length)) {
      const how = tryAt(path, arr[0], true);
      if (how) return how;
    }
    return null;
  }
  return tryAt([], doc, false);
}

/** Text compared as a reader sees it: typographic quotes, dashes and spacing do not count. */
function canon(v: unknown): unknown {
  if (typeof v === "string") {
    return v.normalize("NFKC").replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
      .replace(/[‐-―]/g, "-").replace(/…/g, "...").replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)]));
  return v;
}

/**
 * Same data? Text the view cut short ("…" at the end, which the model then
 * copied) matches the full text it starts with; nothing else is loose.
 */
function matches(page: unknown, model: unknown): boolean {
  if (typeof page === "string" && typeof model === "string") {
    const p = canon(page) as string, m = canon(model) as string;
    if (p === m) return true;
    // "…" where it was cut, maybe with a bracket or quote the model closed after it
    const cut = /^(.*?)\s*\.\.\.[\s)\]}"'»]*$/s.exec(m);
    const cutAt = cut ? cut[1] : "";
    return cutAt.length >= 10 && p.startsWith(cutAt);
  }
  if (Array.isArray(page) && Array.isArray(model)) return page.length === model.length && page.every((x, i) => matches(x, model[i]));
  if (page && model && typeof page === "object" && typeof model === "object") {
    const kp = Object.keys(page).filter(k => (page as any)[k] !== undefined), km = Object.keys(model).filter(k => (model as any)[k] !== undefined);
    return kp.length === km.length && kp.every(k => matches((page as any)[k], (model as any)[k]));
  }
  return sameJSON(page, model);
}

function verify(value: unknown, sh: Shape, schema: SchemaLike, answer: unknown, how: NonNullable<Step["how"]>): { how: NonNullable<Step["how"]>; value: unknown } | null {
  if (value == null) return null;
  const v = coerce(sh.list ? { type: "array", items: sh.itemSchema } : sh.itemSchema, value);
  const wrap = (x: unknown) => (sh.list ? { [sh.into!]: sh.pick && Array.isArray(x) ? x.map(r => (r as any)?.[sh.pick!]) : x } : x);
  const ok = (x: unknown) => { const c = schema.check(wrap(x)); return c.ok && matches(c.value, answer) ? c.value : null; };
  let got = ok(v);
  if (got) return { how, value: got };
  if (sh.list && Array.isArray(v) && v.length > sh.rows.length) {
    got = ok(v.slice(0, sh.rows.length));
    if (got) return { how: { ...how, limit: sh.rows.length }, value: got };
  }
  return null;
}

const TOKEN_PARAM = /(^|[_-])(token|access[_-]?token|auth|authorization|key|api[_-]?key|sig|signature|secret|password|passwd|pass|session|sessionid|sid|jwt|code|nonce|csrf|xsrf|bearer|credential|otp)s?($|[_-])/i;

/**
 * A captured URL without query parameters that look like credentials (by
 * name, or a JWT or long random value): they are not saved in a recipe.
 * The page's cookies still go with the replayed fetch.
 */
export function stripTokens(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  for (const [k, v] of [...u.searchParams]) {
    const random = v.length >= 32 && /^[A-Za-z0-9_\-+/=.]+$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);
    if (TOKEN_PARAM.test(k) || /^eyJ[\w-]+\.[\w-]+/.test(v) || random) u.searchParams.delete(k);
  }
  return u.toString();
}

// ---- a value that is a part of an element's text -------------------------------

const NUM = "(-?\\d[\\d,]*(?:\\.\\d+)?)";
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Where `value` sits in `text`: [start, end), or null. A number matches a written number equal to it. */
export function spanOf(text: string, value: unknown): [number, number] | null {
  if (typeof value === "number") {
    for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) if (parseFloat(m[0].replace(/,/g, "")) === value) return [m.index!, m.index! + m[0].length];
    return null;
  }
  if (typeof value !== "string" || !flat(value)) return null;
  const v = flat(value);
  let i = text.indexOf(v);
  if (i < 0) i = text.toLowerCase().indexOf(v.toLowerCase());
  return i < 0 ? null : [i, i + v.length];
}

/**
 * A pattern with one group that reads the value at `span` out of `text`, held in place by what
 * stands right before and after it: its label and punctuation ("Check-in: ", " — $", " guests"),
 * up to 24 characters, never reaching into another value (`others`) or across a digit (digits
 * are data, not labels).
 */
export function spanPattern(text: string, span: [number, number], numeric: boolean, others: [number, number][] = []): string | null {
  const left = text.slice(0, span[0]), right = text.slice(span[1]);
  const W = /[\p{L}\p{N}]/u;
  const from = Math.max(0, span[0] - 24, ...others.filter(o => o[1] <= span[0]).map(o => o[1]));
  let l = left.slice(from);
  if (from > 0 && W.test(left[from - 1]) && W.test(l[0] || "")) l = l.replace(/^[\p{L}\p{N}]+/u, ""); // cut inside a word
  l = l.replace(/^.*\d/su, "");
  const to = Math.min(24, ...others.filter(o => o[0] >= span[1]).map(o => o[0] - span[1]));
  let r = right.slice(0, to);
  if (to < right.length && W.test(right[to]) && W.test(r[r.length - 1] || "")) r = r.replace(/[\p{L}\p{N}]+$/u, "");
  r = r.replace(/\d.*$/su, "");
  // something must hold a text value in place on each side that has text
  if (!numeric && ((left && !l.trim()) || (right && !r.trim()))) return null;
  const before = !left ? "^" : reEsc(l), after = !right ? "$" : reEsc(r);
  return before + (numeric ? NUM : after ? "(.+?)" : "(.+)") + after;
}

/** Reads a value out of an element's text with a recipe's pattern; null when it is not there. */
export function applyMatch(text: unknown, pattern: string): string | null {
  if (typeof text !== "string" || pattern.length > 400) return null;
  try {
    const m = new RegExp(pattern, "u").exec(flat(text).slice(0, 5000));
    if (!m || m[1] == null || !m[1].trim()) return null;
    // a written number: without its thousands separators
    return pattern.includes(NUM) ? m[1].replace(/,/g, "") : m[1].trim();
  } catch { return null; }
}

/** Applies the patterns of nested lists (`how.nested[k].match`) to rows read by css. */
export function nestRows(value: unknown, nested: NonNullable<NonNullable<Step["how"]>["nested"]>): unknown {
  const one = (row: any) => {
    if (!row || typeof row !== "object") return row;
    const out = { ...row };
    for (const [k, n] of Object.entries(nested)) if (n.match && Array.isArray(out[k])) out[k] = matchRows(out[k], n.match);
    return out;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/** The page changed under a compiled read (a column under another header): the step must fail. */
export class ReadChanged extends Error {}

/** Reads the page the way a compiled extract says: selectors, column headers checked, patterns, nested lists. */
export async function readDom(session: PageSession, how: NonNullable<Step["how"]>): Promise<unknown> {
  let v = await session.domExtract({ css: how.css ?? null, fields: how.fields, limit: how.limit, headers: how.headers, nested: how.nested });
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).__changed === "string") throw new ReadChanged((v as any).__changed);
  if (how.match) v = matchRows(v, how.match);
  if (how.nested) v = nestRows(v, how.nested);
  return v;
}

/** Adds what a compiled list read needs beyond its selectors: the nested lists, and the column headers to check on replay. */
async function complete(session: PageSession, sh: Shape, how: NonNullable<Step["how"]>): Promise<NonNullable<Step["how"]> | null> {
  const out = { ...how };
  if (sh.pick) out.pick = sh.pick;
  if (sh.nested) {
    if (!out.css) return null;
    out.nested = {};
    for (const [k, keys] of Object.entries(sh.nested)) {
      const inner = sh.rows.map(r => ((r[k] as Record<string, unknown>[]) || []).map(ir => Object.fromEntries(keys.map(f => [f, forms(ir[f])]))));
      if (inner.some(rows => rows.some(ir => keys.some(f => !ir[f].length)))) return null;
      const spec = await session.nest(out.css, inner, keys);
      if (!spec) return null;
      const first = (sh.rows.find(r => (r[k] as unknown[]).length)![k] as Record<string, unknown>[])[0];
      const spans: Record<string, [number, number]> = {};
      const match: Record<string, string> = {};
      for (const f of keys) { const sp = spanOf(spec.texts[f], first[f]); if (!sp) return null; spans[f] = sp; }
      for (const f of keys) {
        if (typeof first[f] === "string" && flat(spec.texts[f]) === flat(first[f] as string)) continue;
        const others = keys.filter(o => o !== f && spec.fields[o] === spec.fields[f]).map(o => spans[o]);
        const p = spanPattern(spec.texts[f], spans[f], typeof first[f] === "number", others);
        if (!p) return null;
        match[f] = p;
      }
      out.nested[k] = { css: spec.css, fields: spec.fields, ...(Object.keys(match).length ? { match } : {}) };
    }
  }
  if (out.css && out.fields) {
    const headers = (await session.domExtract({ css: out.css, fields: out.fields, wantHeaders: true })) as Record<string, string>;
    if (headers && Object.keys(headers).length) out.headers = headers;
  }
  return out;
}

/** Applies `how.match` to rows read by css (one object, or a list of them). */
export function matchRows(value: unknown, match: Record<string, string>): unknown {
  const one = (row: any) => (row && typeof row === "object" ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, match[k] ? applyMatch(v, match[k]) : v])) : row);
  return Array.isArray(value) ? value.map(one) : one(value);
}

const forms = (v: unknown): string[] => {
  if (typeof v === "number" && Number.isFinite(v)) return [...new Set([String(v), v.toFixed(2), v.toLocaleString("en-US"), v.toLocaleString("en-US", { minimumFractionDigits: 2 })])];
  return typeof v === "string" && flat(v) ? [flat(v)] : [];
};

async function compileText(session: PageSession, sh: Shape): Promise<NonNullable<Step["how"]> | null> {
  const rows = sh.rows.map(r => Object.fromEntries(sh.keys.map(k => [k, forms(r[k])])));
  if (rows.some(r => sh.keys.some(k => !r[k].length))) return null;
  const spec = await session.holders(rows, sh.keys);
  if (!spec) return null;
  const row0 = sh.rows[0];
  const spans: Record<string, [number, number]> = {};
  for (const k of sh.keys) {
    const sp = spanOf(spec.texts[k], row0[k]);
    if (!sp) return null;
    spans[k] = sp;
  }
  const match: Record<string, string> = {};
  for (const k of sh.keys) {
    const text = spec.texts[k];
    // the whole text is the value: no pattern needed
    if (typeof row0[k] === "string" && flat(text) === flat(row0[k] as string)) continue;
    const others = sh.keys.filter(o => o !== k && spec.fields[o] === spec.fields[k]).map(o => spans[o]);
    const p = spanPattern(text, spans[k], typeof row0[k] === "number", others);
    if (!p) return null;
    match[k] = p;
  }
  if (!Object.keys(match).length) return null;
  return { ...(spec.css ? { css: spec.css } : {}), fields: spec.fields, match, ...(sh.into ? { into: sh.into } : {}) };
}

export interface Compiled {
  layer: "fetch" | "page_json" | "css";
  steps: Step[];
  /** the data the compiled extractor reads (the page's own text) */
  value: unknown;
}

export async function compileExtract(o: {
  session: PageSession; id: string; goal: string; answer: unknown; schema: SchemaLike;
  captured: CapturedResponse[]; params: Record<string, unknown>;
}): Promise<Compiled | null> {
  const sh = shape(o.schema.json, o.answer);
  if (!sh) return null;
  // 1. JSON the page fetched (GET only: it is fetched again on replay)
  for (const r of sh.pick || sh.nested ? [] : [...o.captured].reverse()) {
    if (r.method !== "GET" || r.status >= 400) continue;
    let doc: unknown;
    try { doc = JSON.parse(r.body); } catch { continue; }
    const how = matchJSON(doc, sh);
    const ok = how && verify(readJSON(doc, how), sh, o.schema, o.answer, how);
    if (ok) {
      const save = `data_${o.id.replace(/[^a-z0-9_]/gi, "").toLowerCase()}`.slice(0, 40);
      return {
        layer: "fetch",
        steps: [
          { id: o.id + "-f", kind: "fetch", in_page: true, method: "GET", url: templatize(stripTokens(r.url), o.params), save_as: save, mutation: false, goal: o.goal },
          { id: o.id, kind: "extract", from: "saved", source: save, how: ok.how, schema_ref: "output", goal: o.goal },
        ],
        value: ok.value,
      };
    }
  }
  // 2. JSON embedded in the page
  try {
    for (const d of sh.pick || sh.nested ? [] : await o.session.pageJson()) {
      const how = matchJSON(d.json, sh);
      const ok = how && verify(readJSON(d.json, how), sh, o.schema, o.answer, how);
      if (ok) return { layer: "page_json", steps: [{ id: o.id, kind: "extract", from: "page_json", source: d.sel, how: ok.how, schema_ref: "output", goal: o.goal }], value: ok.value };
    }
  } catch { /* no page JSON */ }
  // 3. CSS
  try {
    const spec = await o.session.compileCss(sh.list ? sh.rows : sh.rows[0], sh.keys);
    if (spec && (spec.css || !sh.list)) {
      // a field read from an attribute (the full title) may not be what the
      // model copied (the text the page shows, cut short): try the text too
      const textFields = Object.fromEntries(Object.entries(spec.fields).map(([k, f]) => [k, f.replace(/\s*@(title|alt|aria-label)$/, "")]));
      const tries = [spec.fields, ...(JSON.stringify(textFields) !== JSON.stringify(spec.fields) ? [textFields] : [])];
      for (const fields of tries) {
        const how = await complete(o.session, sh, { ...(spec.css ? { css: spec.css } : {}), fields, ...(sh.into ? { into: sh.into } : {}) });
        if (!how) continue;
        const value = await readDom(o.session, how);
        const ok = verify(value, sh, o.schema, o.answer, how);
        if (ok) return { layer: "css", steps: [{ id: o.id, kind: "extract", from: "page", how: ok.how, schema_ref: "output", goal: o.goal }], value: ok.value };
      }
    }
  } catch { /* not compilable */ }
  // 4. a part of an element's text, read with a pattern (kept, like the others, only when it
  //    reads back the model's answer)
  try {
    const text = await compileText(o.session, sh);
    const how = text && (await complete(o.session, sh, text));
    if (how) {
      const value = await readDom(o.session, how);
      const ok = verify(value, sh, o.schema, o.answer, how);
      if (ok) return { layer: "css", steps: [{ id: o.id, kind: "extract", from: "page", how: ok.how, schema_ref: "output", goal: o.goal }], value: ok.value };
    }
  } catch { /* not compilable */ }
  return null;
}
