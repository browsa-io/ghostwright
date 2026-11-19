// Secrets: the model only ever sees %name%. The value is read when it is
// typed, only on the origins the secret allows, and is scrubbed from every
// prompt, trace, result text and stored recipe. A recipe holds a token in
// Browsa's format ({{secret:NAME}}, {{secret:NAME:password}}, {{totp:NAME}}),
// so the same file runs here and on Browsa, where Browsa Secrets types it.
import { createHmac } from "node:crypto";
import { domainToASCII } from "node:url";
import { GhostwrightError, SecretOriginError } from "./errors.js";

export interface SecretRef {
  readonly kind: "secret";
  /** where the value comes from, for messages (never the value) */
  readonly source: string;
  readonly origins: string[];
  /** the name in Browsa Secrets ([A-Z0-9_]); the recipe token uses it */
  readonly browsaName?: string;
  /** a part of a Browsa login secret */
  readonly field?: "username" | "password";
  /** a one-time code: the local value is the base32 seed */
  readonly totp?: boolean;
  /** false when the value exists only in Browsa Secrets */
  readonly local: boolean;
  /** read at the keystroke; may be async (a vault CLI, a one-time code source) */
  resolve(): string | Promise<string>;
}

export interface SecretOptions {
  /** hosts or origins the value may be typed on: "app.example.com", "https://app.example.com", "*.example.com" */
  origins: string[];
}

const BROWSA_NAME = /^[A-Z0-9_]{1,64}$/;

/** A secret read from an environment variable when it is typed. An UPPER_CASE variable name is also its Browsa Secrets name. */
export function env(name: string, o: SecretOptions): SecretRef {
  if (!o?.origins?.length) throw new TypeError(`env("${name}") needs origins: the sites the value may be typed on`);
  return {
    kind: "secret", source: "env:" + name, origins: o.origins, local: true,
    browsaName: BROWSA_NAME.test(name) ? name : undefined,
    resolve() {
      const v = process.env[name];
      if (v == null || v === "") throw new GhostwrightError("secret_unset", `environment variable ${name} is not set (secret %${name}%); nothing was typed`);
      return v;
    },
  };
}

/**
 * A secret given as a value, or as a function called at each keystroke
 * (sync or async): plug in any vault CLI or one-time code source.
 */
export function secret(value: string | (() => string | Promise<string>), o: SecretOptions & { browsaName?: string }): SecretRef {
  if (!o?.origins?.length) throw new TypeError("secret() needs origins: the sites the value may be typed on");
  if (o.browsaName && !BROWSA_NAME.test(o.browsaName)) throw new TypeError(`browsaName "${o.browsaName}" must be A-Z, 0-9 and _`);
  return {
    kind: "secret", source: typeof value === "function" ? "value-fn" : "value", origins: o.origins, local: true, browsaName: o.browsaName,
    // a literal value is known at once (scrubbed from the start); a function is called when typed
    resolve: typeof value === "function"
      ? async () => {
        const v = await value();
        if (typeof v !== "string" || !v) throw new GhostwrightError("secret_unset", "the secret function returned no value; nothing was typed");
        return v;
      }
      : () => value,
  };
}

export interface BrowsaSecretOptions {
  /** for a login secret: which part to type */
  field?: "username" | "password";
  /** a one-time code generated from the secret's seed */
  totp?: boolean;
  /** where the same value comes from on this machine (local runs and recording); without it, only Browsa can type it */
  local?: SecretRef;
}

/**
 * A secret kept in Browsa Secrets (POST /v1/secrets). Its value never leaves
 * Browsa: on Browsa (runOnBrowsa, robots) it is typed there, with Browsa's
 * origin check. On this machine it can be typed only from `local`.
 */
export function browsaSecret(name: string, o: BrowsaSecretOptions = {}): SecretRef {
  const n = name.toUpperCase();
  if (!BROWSA_NAME.test(n)) throw new TypeError(`Browsa secret names are A-Z, 0-9 and _ (got "${name}")`);
  if (o.totp && o.field) throw new TypeError("a secret is either a login field or a one-time code");
  return {
    kind: "secret", source: "browsa:" + n, browsaName: n, field: o.field, totp: o.totp,
    origins: o.local?.origins ?? [], local: !!o.local,
    resolve() {
      if (!o.local) throw new GhostwrightError("secret_browsa_only", `secret ${n} is kept in Browsa Secrets and its value never leaves Browsa: run this flow on Browsa (runOnBrowsa), or give browsaSecret("${n}", { local: env(...) }) for local runs`);
      return o.local.resolve();
    },
  };
}

export function isSecret(v: unknown): v is SecretRef {
  return !!v && typeof v === "object" && (v as SecretRef).kind === "secret" && typeof (v as SecretRef).resolve === "function";
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** A host as the URL parser writes it: lower case, punycode, no trailing dot. */
function asciiHost(h: string): string {
  const s = h.trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.startsWith("[")) return s;
  return domainToASCII(s) || "";
}

/**
 * Does url's origin match one of the patterns? Only http and https pages
 * ever match.
 * - "example.com", "*.example.com": https on the default port only
 * - "example.com:8443": https on that port
 * - "https://example.com", "http://example.com:8080": that scheme and port
 * - "localhost", "127.0.0.1" (no port): http or https, any port; "localhost:3000": that port
 * Unicode hosts are matched in punycode; "" matches nothing.
 */
export function originAllowed(patterns: string[], url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = asciiHost(u.hostname);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return patterns.some(raw => {
    let p = String(raw ?? "").trim();
    if (!p) return false;
    let scheme = "";
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(p);
    if (m) { scheme = m[1].toLowerCase() + ":"; p = m[2]; }
    if (scheme && scheme !== "https:" && scheme !== "http:") return false;
    p = p.replace(/[/?#].*$/, "");
    const pm = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(p);
    if (!pm) return false;
    let phost = pm[1];
    const pport = pm[2] || "";
    const wildcard = phost.startsWith("*.");
    if (wildcard) phost = phost.slice(2);
    phost = asciiHost(phost);
    if (!phost || phost.includes("*")) return false;
    const local = !wildcard && LOCAL_HOST.test(phost);
    if (scheme) { if (u.protocol !== scheme) return false; }
    else if (!local && u.protocol !== "https:") return false;
    if (pport) { if (port !== pport) return false; }
    else if (!local) {
      if (port !== ((scheme || "https:") === "https:" ? "443" : "80")) return false;
    }
    return wildcard ? host === phost || host.endsWith("." + phost) : host === phost;
  });
}

/** RFC 6238 code (SHA1, 6 digits, 30 s) from a base32 seed. */
export function totpCode(seed: string, now = Date.now()): string {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of seed.replace(/[\s=-]/g, "").toUpperCase()) {
    const i = alpha.indexOf(c);
    if (i < 0) throw new Error("the one-time-code seed is not base32");
    bits += i.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1e6).padStart(6, "0");
}

const PLACEHOLDER = /%([A-Za-z_][A-Za-z0-9_]*)%/g;
/** a secret token in a recipe */
export const TOKEN = /\{\{\s*(secret|totp)\s*:\s*([A-Za-z0-9_]{1,64})(?::(username|password))?\s*\}\}/g;

export class Secrets {
  private refs = new Map<string, SecretRef>();
  private tokens = new Map<string, string>(); // canonical token -> local name
  private seen = new Map<string, string>(); // value -> name, for scrubbing

  constructor(secrets: Record<string, SecretRef> = {}) {
    for (const [k, v] of Object.entries(secrets)) {
      if (!isSecret(v)) throw new TypeError(`secrets.${k} must be env(...), secret(...) or browsaSecret(...)`);
      this.refs.set(k, v);
      const t = this.tokenOf(k);
      if (this.tokens.has(t)) throw new TypeError(`secrets.${k} and secrets.${this.tokens.get(t)} are the same Browsa secret (${t})`);
      this.tokens.set(t, k);
      // known values are scrubbed from the start; a function is read only when typed
      if (v.local && v.source !== "value-fn") {
        try {
          const x = v.resolve();
          if (typeof x === "string") this.remember(k, x);
        } catch { /* resolved later */ }
      }
    }
  }

  /**
   * Reads every local value once (callbacks too) so it is scrubbed from the
   * first prompt on. Nothing is typed; a value that cannot be read yet (an
   * unset variable) is read again when it is typed.
   */
  async prime(): Promise<void> {
    for (const [k, v] of this.refs) {
      if (!v.local) continue;
      try {
        const x = await v.resolve();
        if (typeof x === "string") this.remember(k, x);
        if (typeof x === "string" && v.totp) this.remember(k, totpCode(x));
      } catch { /* read again when typed */ }
    }
  }

  names(): string[] { return [...this.refs.keys()]; }
  has(name: string): boolean { return this.refs.has(name); }

  /** The recipe token of a local secret name: its Browsa Secrets name, else the name upper-cased. */
  tokenOf(name: string): string {
    const r = this.refs.get(name);
    if (!r) throw new Error(`unknown secret %${name}%`);
    const n = r.browsaName ?? name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
    return r.totp ? `{{totp:${n}}}` : `{{secret:${n}${r.field ? ":" + r.field : ""}}}`;
  }

  /** The local name a recipe token refers to (tokens written before 0.1 used the local name). */
  nameOfToken(kind: string, name: string, field?: string): string | undefined {
    const canon = kind === "totp" ? `{{totp:${name.toUpperCase()}}}` : `{{secret:${name.toUpperCase()}${field ? ":" + field : ""}}}`;
    return this.tokens.get(canon) ?? (this.refs.has(name) ? name : undefined);
  }

  private remember(name: string, value: string): void {
    if (value && value.length >= 3) this.seen.set(value, name);
  }

  /** The value of a secret for a field on `url`. Throws SecretOriginError when not allowed. */
  async valueFor(name: string, url: string): Promise<string> {
    const r = this.refs.get(name);
    if (!r) throw new Error(`unknown secret %${name}%`);
    if (r.local && !originAllowed(r.origins, url)) {
      let origin = url;
      try { origin = new URL(url).origin; } catch { /* keep */ }
      throw new SecretOriginError(name, origin);
    }
    const v = await r.resolve();
    this.remember(name, v);
    if (r.totp) {
      const code = totpCode(v);
      this.remember(name, code);
      return code;
    }
    return v;
  }

  /**
   * Replaces every known secret value in text with %name%: as typed, JSON-
   * escaped, URL- and form-encoded (the whole value in any letter case), and
   * any run of 12 or more characters of it as written (a value cut short, or
   * shown in part). Placeholders (%name%) and recipe tokens ({{...}}) are
   * never touched, so a label such as "Password" stays as it is.
   */
  scrub(text: string): string {
    if (!text || !this.seen.size) return text;
    // keep tokens and placeholders whole: scrub only the text between them
    let out = "", last = 0;
    for (const m of text.matchAll(PROTECTED)) {
      // a span that only wraps a value ("%hunter2x%") is not a placeholder
      const inner = m[1] ?? m[2];
      if (!this.isName(inner) && this.scrubPlain(inner) !== inner) continue;
      out += this.scrubPlain(text.slice(last, m.index)) + m[0];
      last = m.index! + m[0].length;
    }
    return out + this.scrubPlain(text.slice(last));
  }

  /** a declared secret name, or the name in one of their tokens */
  private isName(s: string): boolean {
    if (this.refs.has(s)) return true;
    for (const t of this.tokens.keys()) if (new RegExp(`[:{]${escapeRe(s)}[:}]`).test(t)) return true;
    return false;
  }

  private scrubPlain(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [v, n] of [...this.seen].sort((a, b) => b[0].length - a[0].length)) {
      const mark = `%${n}%`;
      for (const f of valueForms(v)) {
        if (f.length < 3) continue;
        out = out.replace(new RegExp(escapeRe(f), "gi"), mark);
      }
      for (const f of valueForms(v)) if (f.length >= PART) out = scrubRuns(out, f, mark);
    }
    return out;
  }

  /** Scrubs every string inside a JSON value (prompts, traces, results; recipes use safeRecipe). */
  scrubJSON<T>(v: T): T {
    if (!this.seen.size) return v;
    return JSON.parse(this.scrub(JSON.stringify(v))) as T;
  }

  /**
   * A recipe made safe to store without rewriting it: a locator that holds a
   * secret value is dropped from its target (the others stay), and any other
   * text that holds one is refused. Tokens, placeholders, selectors and
   * labels that only look like a secret's name are kept as they are.
   */
  safeRecipe<T extends { steps: any[] }>(recipe: T): T {
    const r = JSON.parse(JSON.stringify(recipe)) as T;
    if (!this.seen.size) return r;
    const clean = (t: any) => {
      if (!t || typeof t !== "object") return;
      for (const k of ["name", "css", "text", "xpath", "near", "frame"]) if (typeof t[k] === "string" && this.leaks(t[k])) delete t[k];
    };
    for (const s of r.steps) { clean(s?.target); clean(s?.for?.target); }
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === "string") { if (this.leaks(v)) bad.push(path); return; }
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(r, "");
    if (bad.length) throw new GhostwrightError("secret_in_recipe", `the recipe would hold a secret value at ${bad.slice(0, 5).join(", ")}; nothing was saved`);
    return r;
  }

  /**
   * True when a URL's query or fragment holds the whole value of one of these
   * secrets, in any encoding or case. (Whole values only: a page address that
   * shares a few characters with a secret, a domain, is not stopped.)
   */
  inUrl(url: string, names?: string[]): boolean {
    let q = url;
    try { const u = new URL(url); q = u.search + u.hash; } catch { /* the whole string */ }
    if (!q) return false;
    const low = q.toLowerCase();
    for (const [v, n] of this.seen) {
      if (names && !names.includes(n)) continue;
      for (const f of valueForms(v)) if (f.length >= 3 && low.includes(f.toLowerCase())) return true;
    }
    return false;
  }

  /** True when text holds a known secret value, whole or in part (12+ characters as written). */
  leaks(text: string): boolean {
    return !!text && this.scrub(text) !== text;
  }
}

// a part of a value is caught from this many characters on, as written: a
// shorter or re-cased part is too often an ordinary word ("Password")
const PART = 12;
// recipe tokens / params and %name% placeholders: group 1 or 2 is the name
const PROTECTED = /\{\{\s*(?:(?:secret|totp|json)\s*:\s*)?([A-Za-z0-9_]{1,64})(?::(?:username|password))?\s*\}\}|%([A-Za-z_][A-Za-z0-9_]*)%/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a value takes when it leaks: as is, JSON-escaped, URL- and form-encoded. */
function valueForms(v: string): string[] {
  const uri = encodeURIComponent(v);
  // URLSearchParams (forms) also encodes ! ' ( ) ~ and writes spaces as +
  const form = new URLSearchParams({ x: v }).toString().slice(2);
  return [...new Set([v, JSON.stringify(v).slice(1, -1), uri, uri.replace(/%20/g, "+"), form, encodeURI(v)])];
}

/** Replaces every run of PART or more characters of `form` in text (as written). */
function scrubRuns(text: string, form: string, mark: string): string {
  const windows = new Set<string>();
  for (let i = 0; i + PART <= form.length; i++) windows.add(form.slice(i, i + PART));
  let out = "", i = 0, last = 0;
  while (i + PART <= text.length) {
    if (!windows.has(text.slice(i, i + PART))) { i++; continue; }
    let j = i + PART;
    while (j < text.length && form.includes(text.slice(i, j + 1))) j++;
    out += text.slice(last, i) + mark;
    last = i = j;
  }
  return out + text.slice(last);
}

/** The %name% placeholders in a text. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]))];
}

/**
 * Fills %name% placeholders. Variables are plain values; secrets are
 * resolved for `url` (their origin rule applies). Returns the text to type
 * and the recipe form ({{name}} / the secret's token).
 */
export async function fill(text: string, vars: Record<string, string>, secrets: Secrets, url: string, allowed?: Set<string>): Promise<{ value: string; recipe: string; usedSecrets: string[] }> {
  const p = planText(text, vars, secrets, allowed);
  return { value: await p.resolve(url), recipe: p.recipe, usedSecrets: p.usedSecrets };
}

/**
 * The text to type, planned now and resolved later: `resolve(url)` reads
 * the secrets for the document the value goes into, at the keystroke.
 * A secret not in `allowed` (the ones the instruction names) is refused.
 */
export function planText(text: string, vars: Record<string, string>, secrets: Secrets, allowed?: Set<string>): { recipe: string; usedSecrets: string[]; resolve(url: string): Promise<string> } {
  const used = [...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]).filter(n => secrets.has(n)))];
  for (const n of used) if (allowed && !allowed.has(n)) throw new SecretNotAllowedError(n);
  const recipe = text.replace(PLACEHOLDER, (m, n: string) => (secrets.has(n) ? secrets.tokenOf(n) : n in vars ? `{{${n}}}` : m));
  return {
    recipe, usedSecrets: used,
    async resolve(url: string) {
      let value = "", last = 0;
      for (const m of text.matchAll(PLACEHOLDER)) {
        const n = m[1];
        value += text.slice(last, m.index);
        if (secrets.has(n)) value += await secrets.valueFor(n, url);
        else value += n in vars ? String(vars[n]) : m[0];
        last = m.index! + m[0].length;
      }
      return value + text.slice(last);
    },
  };
}

/** A secret the instruction or task did not name. Nothing was typed. */
export class SecretNotAllowedError extends GhostwrightError {
  secret: string;
  constructor(name: string) {
    super("secret_not_named", `secret %${name}% was not named in the instruction (or in agent({ secrets })); nothing was typed`);
    this.name = "SecretNotAllowedError";
    this.secret = name;
  }
}
