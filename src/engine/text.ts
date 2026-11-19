// Text helpers shared by the view, the diff and the action results.

/** Approximate tokens: characters / 4, rounded up. An estimate, not a tokenizer. */
export function estimateTokens(s: string): number {
  return Math.ceil([...s].length / 4);
}

/** Cut to `max` characters with an ellipsis. */
export function cut(s: string, max: number): string {
  if (max <= 0) return s;
  const r = [...s];
  if (r.length <= max) return s;
  return r.slice(0, max - 1).join("").trimEnd() + "…";
}

/** Page text in double quotes, on one line, with control and bidi characters dropped. */
export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n" || ch === "\r" || ch === "\t") out += " ";
    else if (
      c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0) || c === 0x2028 || c === 0x2029 ||
      (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff
    ) continue;
    else out += ch;
  }
  return out + '"';
}

const BARE = /^[A-Za-z0-9/_.\-~%?&=#:+@,;]+$/;

export function bareOrQuote(s: string): string {
  return s && BARE.test(s) ? s : quote(s);
}

export function plural(n: number, s: string): string {
  if (n === 1) return "1 " + s;
  return `${n} ${s.endsWith("x") ? s + "es" : s + "s"}`;
}

/** A URL as path+query when it is on the page's origin, else in full; cut to max. */
export function shortURL(raw: string, pageURL: string, max: number): string {
  let u: URL;
  try { u = new URL(raw); } catch { return cut(raw, max); }
  let p: URL | null = null;
  try { p = new URL(pageURL); } catch { /* none */ }
  let s = (u.pathname || "/") + u.search + u.hash;
  if (!p || u.host !== p.host || u.protocol !== p.protocol) s = u.protocol + "//" + u.host + s;
  return cut(s, max);
}
