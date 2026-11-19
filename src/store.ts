// The local store, a folder you can commit:
//   .ghostwright/flows/<name>.json            the version run() uses
//   .ghostwright/flows/<name>/v<N>.json       every promoted version (rollback)
//   .ghostwright/drafts/<name>.v<N>.json      repaired versions not yet proven or reviewed
//   .ghostwright/traces/<run>.jsonl           one line per step
// Files are written for the owner only (0600, folders 0700). A flow's name
// always comes from the name it was asked for, never from the file.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlowError } from "./errors.js";
import { NAME_RE, type Recipe } from "./recipe.js";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** mkdir -p with owner-only folders. */
export function ownerDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Writes a file for the owner only, atomically. */
export function ownerWrite(file: string, data: string): void {
  ownerDir(join(file, ".."));
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, data, { mode: FILE_MODE });
  renameSync(tmp, file);
  try { chmodSync(file, FILE_MODE); } catch { /* best effort */ }
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new FlowError("not_found", `bad flow name ${JSON.stringify(name)}: a-z, 0-9 and -`);
  return name;
}

function checkVersion(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1e6) throw new FlowError("not_found", `bad flow version ${JSON.stringify(v)}`);
  return v as number;
}

export class Store {
  constructor(readonly dir: string) {}

  private path(...p: string[]): string { return join(this.dir, ...p); }

  private read(file: string, name: string): Recipe {
    const r = JSON.parse(readFileSync(file, "utf8")) as Recipe;
    // the name the file says is not trusted: it decides where versions are written
    r.name = name;
    checkVersion(r.version);
    return r;
  }

  /** The active version, or null. */
  load(name: string): Recipe | null {
    checkName(name);
    const f = this.path("flows", name + ".json");
    if (!existsSync(f)) return null;
    return this.read(f, name);
  }

  /** Saves `r` as the active version and keeps a copy for rollback. */
  promote(r: Recipe): void {
    const name = checkName(r.name), v = checkVersion(r.version);
    const body = JSON.stringify(r, null, 2) + "\n";
    ownerWrite(this.path("flows", name, `v${v}.json`), body);
    ownerWrite(this.path("flows", name + ".json"), body);
    const d = this.path("drafts", `${name}.v${v}.json`);
    if (existsSync(d)) unlinkSync(d);
  }

  saveDraft(r: Recipe, why: string): string {
    const name = checkName(r.name), v = checkVersion(r.version);
    const f = this.path("drafts", `${name}.v${v}.json`);
    ownerWrite(f, JSON.stringify({ ...r, meta: { ...(r.meta || {}), draft_reason: why } }, null, 2) + "\n");
    return f;
  }

  drafts(name: string): number[] {
    checkName(name);
    const d = this.path("drafts");
    if (!existsSync(d)) return [];
    return readdirSync(d).map(f => new RegExp(`^${name}\\.v(\\d+)\\.json$`).exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  }

  /** Makes a draft (a reviewed repair) the active version. */
  promoteDraft(name: string, version?: number): Recipe {
    const ds = this.drafts(name);
    const v = version ?? ds[ds.length - 1];
    if (!v || !ds.includes(v)) throw new FlowError("not_found", `no draft${version != null ? " v" + version : ""} of ${name} to promote (${ds.length ? "drafts: " + ds.map(x => "v" + x).join(", ") : "no drafts"})`);
    const r = this.read(this.path("drafts", `${name}.v${v}.json`), name);
    if (r.meta) delete (r.meta as any).draft_reason;
    this.promote(r);
    return r;
  }

  versions(name: string): number[] {
    checkName(name);
    const d = this.path("flows", name);
    if (!existsSync(d)) return [];
    return readdirSync(d).map(f => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  }

  /** Makes an earlier version the active one again. */
  rollback(name: string, version?: number): Recipe {
    const cur = this.load(name);
    const vs = this.versions(name);
    const v = version ?? vs.filter(x => !cur || x < cur.version).pop();
    if (!v || !vs.includes(v)) {
      const have = vs.length ? `versions: ${vs.map(x => "v" + x + (x === cur?.version ? " (active)" : "")).join(", ")}` : "no saved versions";
      throw new FlowError("not_found", version != null ? `${name} has no v${version} (${have})` : `no earlier version of ${name} to roll back to (${have})`);
    }
    const r = this.read(this.path("flows", name, `v${v}.json`), name);
    ownerWrite(this.path("flows", name + ".json"), JSON.stringify(r, null, 2) + "\n");
    return r;
  }

  list(): { name: string; version: number; steps: number }[] {
    const d = this.path("flows");
    if (!existsSync(d)) return [];
    return readdirSync(d).filter(f => f.endsWith(".json") && NAME_RE.test(f.slice(0, -5))).map(f => {
      const r = this.read(join(d, f), f.slice(0, -5));
      return { name: r.name, version: r.version, steps: r.steps.length };
    });
  }

  /** Owner-only modes for a store an older version made (folders 0700, files 0600). */
  tighten(): void {
    const walk = (d: string, depth: number) => {
      if (!existsSync(d) || depth > 4) return;
      try { chmodSync(d, DIR_MODE); } catch { return; }
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile()) { try { chmodSync(p, FILE_MODE); } catch { /* best effort */ } }
      }
    };
    walk(this.dir, 0);
  }

  traceFile(run: string): string {
    ownerDir(this.path("traces"));
    return this.path("traces", run.replace(/[^a-z0-9._-]/gi, "_") + ".jsonl");
  }
}
