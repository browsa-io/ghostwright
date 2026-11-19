// Turning a model extract into a deterministic one. Tried in order: JSON the
// page fetched while the step ran, JSON embedded in the page, CSS. A
// compiled extractor is kept only when it gives back exactly the model's
// answer; replays then read the data with no model.
import type { CapturedResponse, PageSession } from "./engine/session.js";
import { jsonpath, pathOf, templatize, type Step } from "./recipe.js";
import { coerce, sameJSON, type JSONSchema, type SchemaLike } from "./schema.js";

interface Shape { list: boolean; into?: string; keys: string[]; rows: Record<string, unknown>[]; itemSchema: JSONSchema }

const SCALAR = new Set(["string", "number", "integer", "boolean"]);
const typeOf = (s: JSONSchema) => (Array.isArray(s?.type) ? s.type.filter((t: string) => t !== "null")[0] : s?.type);

function shape(schema: JSONSchema, answer: unknown): Shape | null {
  if (typeOf(schema) !== "object" || !schema.properties || !answer || typeof answer !== "object") return null;
  const props = Object.entries(schema.properties as Record<string, JSONSchema>);
  if (props.length === 1 && typeOf(props[0][1]) === "array") {
    const [into, arr] = props[0];
    const item = arr.items as JSONSchema;
    if (typeOf(item) !== "object" || !item.properties) return null;
    const keys = Object.keys(item.properties);
    if (!keys.every(k => SCALAR.has(typeOf(item.properties[k])))) return null;
    const rows = (answer as any)[into];
    if (!Array.isArray(rows) || !rows.length) return null;
    return { list: true, into, keys, rows, itemSchema: item };
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
  const wrap = (x: unknown) => (sh.list ? { [sh.into!]: x } : x);
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
  for (const r of [...o.captured].reverse()) {
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
    for (const d of await o.session.pageJson()) {
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
        const how: NonNullable<Step["how"]> = { ...(spec.css ? { css: spec.css } : {}), fields, ...(sh.into ? { into: sh.into } : {}) };
        const value = await o.session.domExtract({ css: spec.css, fields });
        const ok = verify(value, sh, o.schema, o.answer, how);
        if (ok) return { layer: "css", steps: [{ id: o.id, kind: "extract", from: "page", how: ok.how, schema_ref: "output", goal: o.goal }], value: ok.value };
      }
    }
  } catch { /* not compilable */ }
  return null;
}
