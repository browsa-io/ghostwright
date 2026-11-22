// Shared helpers for task definitions.
//
// A task:
// {
//   id, set: "act"|"extract"|"observe"|"flow"|"secrets"|"botwall",
//   pages?: { [path]: page | (ctx) => page },   // fixture pages, page = { title, body, head?, css? }
//   start: "/path" (fixture) or "https://..." (live),
//   steps: [ { op: "act", text, variables? } | { op: "extract", text, schema } | { op: "observe", text } | { op: "wait", ms } ],
//   check: (c) => true | "failure reason"     // c = { state, results, snap, cdp }
//   expect?, match?                            // for extract tasks (see matches())
// }

export const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*×\s*/g, " x ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const isNullish = (v) => v === null || v === undefined || (typeof v === "string" && /^(|null|none|n\/a|not (found|available|listed|provided))$/i.test(v.trim()));

function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

/**
 * Deterministic comparison of an extraction against the truth.
 * Strings: equal after normalisation (or contained, with opts.contains).
 * Numbers: within opts.tol (default 0.011); numeric strings accepted.
 * Arrays: same length and element-wise (opts.unordered for set semantics, opts.minLen to allow extra items).
 * Objects: every expected key must match; extra keys are ignored.
 * null: the answer must be empty/null.
 */
export function matches(actual, expected, opts = {}, path = "$") {
  if (expected === null) return isNullish(actual) ? true : `${path}: expected null, got ${JSON.stringify(actual)?.slice(0, 80)}`;
  if (typeof expected === "number") {
    const a = toNum(actual);
    return Math.abs(a - expected) <= (opts.tol ?? 0.011) ? true : `${path}: expected ${expected}, got ${JSON.stringify(actual)}`;
  }
  if (typeof expected === "boolean") {
    const a = typeof actual === "string" ? /^(true|yes)$/i.test(actual.trim()) : actual;
    return a === expected ? true : `${path}: expected ${expected}, got ${JSON.stringify(actual)}`;
  }
  if (typeof expected === "string") {
    const a = norm(actual), e = norm(expected);
    const ok = opts.contains ? a.includes(e) : a === e || a.replace(/[.:\s]+$/, "") === e.replace(/[.:\s]+$/, "");
    return ok ? true : `${path}: expected "${expected}", got ${JSON.stringify(actual)?.slice(0, 120)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${typeof actual}`;
    if (opts.minLen ? actual.length < expected.length : actual.length !== expected.length)
      return `${path}: expected ${expected.length} items, got ${actual.length}`;
    if (opts.unordered) {
      const used = new Set();
      for (let i = 0; i < expected.length; i++) {
        const j = actual.findIndex((a, k) => !used.has(k) && matches(a, expected[i], opts) === true);
        if (j < 0) return `${path}[${i}]: no match for ${JSON.stringify(expected[i]).slice(0, 100)}`;
        used.add(j);
      }
      return true;
    }
    for (let i = 0; i < expected.length; i++) {
      const r = matches(actual[i], expected[i], opts, `${path}[${i}]`);
      if (r !== true) return r;
    }
    return true;
  }
  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object") return `${path}: expected an object, got ${JSON.stringify(actual)?.slice(0, 80)}`;
    for (const k of Object.keys(expected)) {
      const r = matches(actual[k], expected[k], opts, `${path}.${k}`);
      if (r !== true) return r;
    }
    return true;
  }
  return `${path}: unsupported expectation`;
}

// JSON Schema shorthands
export const S = {
  str: (d) => ({ type: "string", ...(d ? { description: d } : {}) }),
  num: (d) => ({ type: "number", ...(d ? { description: d } : {}) }),
  bool: (d) => ({ type: "boolean", ...(d ? { description: d } : {}) }),
  url: (d) => ({ type: "string", format: "uri", ...(d ? { description: d } : {}) }),
  nstr: (d) => ({ type: ["string", "null"], ...(d ? { description: d } : {}) }),
  arr: (items, d) => ({ type: "array", items, ...(d ? { description: d } : {}) }),
  obj: (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false }),
};

// Check helpers
export const all = (...rs) => {
  for (const r of rs) if (r !== true) return r;
  return true;
};
export const kvIs = (state, k, v) =>
  JSON.stringify(state.kv[k]) === JSON.stringify(v) ? true : `state ${k}=${JSON.stringify(state.kv[k])}, want ${JSON.stringify(v)}`;
export const valueIs = (state, eid, v, { contains = false } = {}) => {
  const got = state.valueOf(eid);
  if (got === null) return `no input on ${eid}`;
  return (contains ? norm(got).includes(norm(v)) : norm(got) === norm(v)) ? true : `${eid}=${JSON.stringify(got)}, want ${JSON.stringify(v)}`;
};
export const loaded = (state, pathRe) =>
  state.loads().some((l) => pathRe.test(l.path)) ? true : `no load of ${pathRe}`;

export const lorem = (n, seed = 1) => {
  const words = "river stone lantern harbor maple quiet copper meadow signal orbit velvet canyon ember willow summit pocket ribbon timber falcon prism".split(" ");
  let out = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    out.push(words[x % words.length]);
  }
  const s = out.join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
};
export const paras = (n, seed = 1) => Array.from({ length: n }, (_, i) => `<p>${lorem(60, seed + i)}</p>`).join("\n");
