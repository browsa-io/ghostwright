// A JSONL trace per run: one line per step. Secrets are scrubbed before
// anything is written or printed. Silent unless debug is on.
import { appendFileSync } from "node:fs";
import type { Secrets } from "./secrets.js";

export interface TraceLine {
  t: string;
  /** act, observe, extract, agent, step, repair, promote, captcha, run */
  type: string;
  [k: string]: unknown;
}

export class Tracer {
  constructor(private file: string | null, private secrets: Secrets, private debug: boolean | ((line: string) => void)) {}

  write(type: string, data: Record<string, unknown>): void {
    const line = this.secrets.scrub(JSON.stringify({ t: new Date().toISOString(), type, ...data }));
    if (this.file) {
      try { appendFileSync(this.file, line + "\n", { mode: 0o600 }); } catch { /* tracing never breaks a run */ }
    }
    if (this.debug) {
      const short = `[ghostwright] ${type} ${this.secrets.scrub(summary(data))}`;
      if (typeof this.debug === "function") this.debug(short); else console.error(short);
    }
  }
}

function summary(d: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["instruction", "step", "kind", "action", "status", "layer", "by", "reason", "tokens", "usd", "ms"]) {
    if (d[k] === undefined) continue;
    const v = typeof d[k] === "object" ? JSON.stringify(d[k]) : String(d[k]);
    parts.push(`${k}=${v.length > 120 ? v.slice(0, 119) + "…" : v}`);
  }
  return parts.join(" ");
}
