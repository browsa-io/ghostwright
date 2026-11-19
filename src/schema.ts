// Output schemas: a zod schema (v4) or a plain JSON Schema object.

export type JSONSchema = Record<string, any>;

export interface SchemaLike {
  json: JSONSchema;
  /** returns the parsed value or an error message */
  check(v: unknown): { ok: true; value: unknown } | { ok: false; error: string };
}

const isZod = (s: any) => !!s && typeof s === "object" && typeof s.safeParse === "function";

export async function toSchema(s: unknown): Promise<SchemaLike> {
  if (isZod(s)) {
    const z: any = await import("zod");
    const json = (z.toJSONSchema ?? z.z?.toJSONSchema)(s, { unrepresentable: "any" });
    delete json.$schema;
    return {
      json,
      check(v) {
        const r = (s as any).safeParse(v);
        return r.success ? { ok: true, value: r.data } : { ok: false, error: String(r.error?.message ?? r.error).slice(0, 600) };
      },
    };
  }
  if (!s || typeof s !== "object") throw new TypeError("schema must be a zod schema or a JSON Schema object");
  const json = s as JSONSchema;
  // checked before any model call, so a typo costs nothing
  const bad = schemaError(json, "schema");
  if (bad) throw new TypeError(bad);
  return { json, check: v => { const e = validate(json, v); return e ? { ok: false, error: e } : { ok: true, value: v }; } };
}

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SHAPE_KEYS = ["type", "properties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "$ref"];
// other JSON Schema words: an object of only these (or {}) is a schema that allows anything
const KEYWORDS = new Set(["description", "title", "default", "examples", "format", "nullable", "not", "additionalProperties", "$schema", "$defs", "definitions", "$id", "id", "pattern", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "propertyNames", "patternProperties", "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType", "prefixItems", "contains", "if", "then", "else", "dependentRequired", "minProperties", "maxProperties", "$comment"]);

/** Is this a JSON Schema? An error naming what is wrong, or "". */
export function schemaError(s: unknown, path: string): string {
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return `${path} must be a JSON Schema object${typeof s === "string" && TYPES.has(s) ? ` (write { type: "${s}" })` : ""}`;
  }
  const o = s as Record<string, any>;
  if (!SHAPE_KEYS.some(k => k in o) && Object.keys(o).some(k => !KEYWORDS.has(k))) {
    const keys = Object.keys(o).filter(k => !KEYWORDS.has(k));
    return `${path} is not a JSON Schema (it has none of type, properties, items, enum, anyOf): ${keys.length ? `for fields ${keys.slice(0, 3).join(", ")} write { type: "object", properties: { ${keys[0]}: { type: "string" } } }` : "write { type: \"object\" }"}, or pass a zod schema`;
  }
  const types = Array.isArray(o.type) ? o.type : o.type != null ? [o.type] : [];
  for (const t of types) if (!TYPES.has(t)) return `${path}.type "${t}" is not a JSON Schema type (${[...TYPES].join(", ")})`;
  if (o.properties != null) {
    if (typeof o.properties !== "object" || Array.isArray(o.properties)) return `${path}.properties must be an object of schemas`;
    for (const [k, v] of Object.entries(o.properties)) { const e = schemaError(v, `${path}.properties.${k}`); if (e) return e; }
  }
  if (o.items != null && !Array.isArray(o.items)) { const e = schemaError(o.items, `${path}.items`); if (e) return e; }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (o[k] == null) continue;
    if (!Array.isArray(o[k])) return `${path}.${k} must be a list of schemas`;
    for (const [i, v] of o[k].entries()) { const e = schemaError(v, `${path}.${k}[${i}]`); if (e) return e; }
  }
  if (o.required != null && !(Array.isArray(o.required) && o.required.every((x: unknown) => typeof x === "string"))) return `${path}.required must be a list of property names`;
  return "";
}

/** A small JSON Schema check: type, required, properties, items, enum, minItems. Returns an error or "". */
export function validate(s: JSONSchema, v: unknown, path = "$"): string {
  if (!s || typeof s !== "object") return "";
  if (s.anyOf || s.oneOf) {
    const opts: JSONSchema[] = s.anyOf || s.oneOf;
    return opts.some(o => !validate(o, v, path)) ? "" : `${path}: matches none of the allowed shapes`;
  }
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) return `${path}: not one of ${JSON.stringify(s.enum)}`;
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length) {
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
    const ok = types.some(x => x === t || (x === "number" && t === "integer"));
    if (!ok) return `${path}: expected ${types.join("|")}, got ${t}`;
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) return `${path}: needs at least ${s.minItems} items`;
    if (s.items) for (let i = 0; i < v.length; i++) { const e = validate(s.items, v[i], `${path}[${i}]`); if (e) return e; }
  } else if (v && typeof v === "object") {
    for (const r of s.required || []) if (!(r in (v as object))) return `${path}.${r}: missing`;
    for (const [k, ps] of Object.entries(s.properties || {})) {
      if (k in (v as object)) { const e = validate(ps as JSONSchema, (v as any)[k], `${path}.${k}`); if (e) return e; }
    }
  }
  return "";
}

/** Coerces text read from a page to the types a schema asks for (numbers, booleans). */
export function coerce(s: JSONSchema | undefined, v: unknown): unknown {
  if (!s || v == null) return v;
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (Array.isArray(v)) return v.map(x => coerce(s.items, x));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) out[k] = coerce(s.properties?.[k], x);
    return out;
  }
  if (typeof v === "string" && (types.includes("number") || types.includes("integer")) && !types.includes("string")) {
    const n = parseNumber(v);
    return n === undefined ? v : n;
  }
  if (typeof v === "string" && types.includes("boolean") && !types.includes("string")) {
    if (/^(true|yes)$/i.test(v.trim())) return true;
    if (/^(false|no)$/i.test(v.trim())) return false;
  }
  return v;
}

/**
 * The number in a price or count, decimals kept: "$1,234.50" 1234.5,
 * "12,50 €" 12.5, "1.234,56" 1234.56, "1 299,00" 1299, "-3" -3.
 */
export function parseNumber(s: string): number | undefined {
  // a space groups thousands only before exactly three digits ("1 299,00"; "4 5 stars" is 4)
  const m = /-?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?![\d])|-?\d[\d.,]*/.exec(s);
  if (!m) return undefined;
  let t = m[0].replace(/[   ]/g, "").replace(/[.,]+$/, "");
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // the later one separates the decimals
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "12,50" decimals; "1,234" or "1,234,567" thousands
    const after = t.length - lastComma - 1;
    t = after === 3 ? t.replace(/,/g, "") : (t.match(/,/g)!.length === 1 ? t.replace(",", ".") : t.replace(/,/g, ""));
  } else if (lastDot >= 0 && (t.match(/\./g)!.length > 1)) {
    t = t.replace(/\./g, ""); // "1.234.567"
  }
  const n = parseFloat(t);
  return Number.isNaN(n) ? undefined : n;
}

/** Deep equality for JSON values. */
export function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJSON(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object).filter(k => (a as any)[k] !== undefined), kb = Object.keys(b as object).filter(k => (b as any)[k] !== undefined);
    return ka.length === kb.length && ka.every(k => sameJSON((a as any)[k], (b as any)[k]));
  }
  return false;
}
