// What changed between two reads of the page, by element identity.
import { cut, quote } from "./text.js";
import { DIFF_LEVEL, elementLine, ident, stateTokens, type Element, type Snapshot } from "./view.js";

export interface Change {
  op: "changed" | "added" | "removed";
  id?: number;
  kind: string;
  role: string;
  name?: string;
  was?: string;
  fields?: Record<string, string>;
  text: string;
}

/** A diff longer than this is replaced by a fresh view. */
export const MAX_DIFF_LINES = 40;

const OFF_WORDS: Record<string, string> = {
  disabled: "enabled", checked: "unchecked", required: "not required", invalid: "valid", readonly: "editable",
  selected: "not selected", current: "not current", expanded: "not expandable", pressed: "not pressed", value: "no value",
  pw: "empty", newtab: "opens in this tab", modal: "not modal", href: "no link target", files: "no file",
  clickable: "not clickable", opaque: "readable",
};
const DIFF_IGNORE = new Set(["focused", "size", "hint"]);

function stateSig(e: Element): string {
  const st = e.state || {};
  const keys = Object.keys(st).filter(k => !DIFF_IGNORE.has(k)).sort();
  let s = `${e.kind}|${e.role}|${e.name}`;
  for (const k of keys) s += `|${k}=${st[k]}`;
  for (const c of e.cells || []) s += "|c=" + c;
  return s;
}

function changedKeys(a: Element, b: Element, withCover: boolean): { keys: string[]; nameChanged: boolean } {
  const keys: string[] = [];
  const as = a.state || {}, bs = b.state || {};
  for (const [k, v] of Object.entries(bs)) if (!DIFF_IGNORE.has(k) && (!(k in as) || as[k] !== v)) keys.push(k);
  for (const k of Object.keys(as)) if (!DIFF_IGNORE.has(k) && !(k in bs)) keys.push(k);
  if (withCover && (a.coveredBy !== b.coveredBy || a.coveredDesc !== b.coveredDesc)) keys.push("covered");
  keys.sort();
  const nameChanged = a.name !== b.name || a.role !== b.role || (a.cells || []).join("\x1f") !== (b.cells || []).join("\x1f");
  return { keys, nameChanged };
}

function changeLine(a: Element, b: Element, keys: string[], nameChanged: boolean): Change {
  const c: Change = { op: "changed", id: b.id || undefined, kind: b.kind, role: b.role, name: b.name, text: "" };
  if (b.kind === "text") {
    c.was = a.name;
    c.text = `~ text ${quote(cut(a.name, 40))} → ${quote(cut(b.name, DIFF_LEVEL.textMax))}`;
    return c;
  }
  if (b.kind === "row") {
    const was = elementLine(a, DIFF_LEVEL).replace(/^(row|cols) /, "");
    c.text = `~ ${elementLine(b, DIFF_LEVEL)}  (was ${was})`;
    return c;
  }
  let s = "~ ";
  if (nameChanged) {
    s += ident(a) + " → " + (a.role !== b.role ? b.role + " " : "") + quote(b.name);
    c.was = a.name;
  } else s += ident(b);
  if (keys.length) {
    c.fields = {};
    const only = new Set<string>();
    const gone: string[] = [];
    for (const k of keys) {
      if (k === "covered") { only.add(k); c.fields[k] = String(b.coveredBy || 0); continue; }
      const v = b.state?.[k];
      c.fields[k] = v ?? "";
      if (v !== undefined) only.add(k);
      // a field that now holds a secret lost its value and length on purpose: say nothing about them
      else if (OFF_WORDS[k] && !(b.state?.secret && (k === "value" || k === "pw"))) gone.push(OFF_WORDS[k]);
    }
    if (only.has("rows") || only.has("cols")) only.add("rows");
    const toks = [...stateTokens(b, DIFF_LEVEL, only), ...gone];
    if (toks.length) s += "  " + toks.join(", ");
  }
  c.text = s;
  return c;
}

export interface DiffResult { changes: Change[]; changed: number; added: number; removed: number; volatile: number }

export function diffSnapshots(a: Snapshot, b: Snapshot, volatile: ((key: string) => boolean) | null, target: number): DiffResult {
  const res: DiffResult = { changes: [], changed: 0, added: 0, removed: 0, volatile: 0 };
  const modalChanged = a.modal !== b.modal;
  const old = new Map(a.items.map(e => [e.key, e]));
  const seen = new Set<string>();
  let added: Element[] = [];
  const changes: Change[] = [];
  for (const e of b.items) {
    seen.add(e.key);
    const o = old.get(e.key);
    if (!o) { if (e.kind !== "list") added.push(e); continue; }
    if (e.kind === "list") continue;
    const { keys, nameChanged } = changedKeys(o, e, !modalChanged);
    if (!keys.length && !nameChanged) continue;
    if (volatile && volatile(e.key) && (!e.id || e.id !== target)) { res.volatile++; continue; }
    changes.push(changeLine(o, e, keys, nameChanged));
    res.changed++;
  }
  let removed = a.items.filter(e => !seen.has(e.key) && e.kind !== "list");
  if (added.length && removed.length) {
    const pool = new Map<string, number>();
    for (const e of removed) pool.set(stateSig(e), (pool.get(stateSig(e)) || 0) + 1);
    const cancelled = new Map<string, number>();
    added = added.filter(e => {
      const s = stateSig(e);
      if ((pool.get(s) || 0) > 0) { pool.set(s, pool.get(s)! - 1); cancelled.set(s, (cancelled.get(s) || 0) + 1); return false; }
      return true;
    });
    removed = removed.filter(e => {
      const s = stateSig(e);
      if ((cancelled.get(s) || 0) > 0) { cancelled.set(s, cancelled.get(s)! - 1); return false; }
      return true;
    });
  }
  for (const e of added) {
    if (volatile && volatile(e.key)) { res.volatile++; continue; }
    changes.push({ op: "added", id: e.id || undefined, kind: e.kind, role: e.role, name: e.name, text: "+ " + elementLine(e, DIFF_LEVEL) });
    res.added++;
  }
  for (const e of removed) {
    if (volatile && volatile(e.key)) { res.volatile++; continue; }
    const line = e.kind === "text" ? "- text " + quote(cut(e.name, 80)) : e.kind === "row" ? "- " + elementLine(e, DIFF_LEVEL) : "- " + ident(e);
    changes.push({ op: "removed", id: e.id || undefined, kind: e.kind, role: e.role, name: e.name, text: line });
    res.removed++;
  }
  res.changes = changes;
  return res;
}

/** Elements that change with no action between two reads, twice, are volatile. */
export class Volatility {
  private epoch = -1;
  private seen = new Map<string, number>();

  note(a: Snapshot | null, b: Snapshot | null): void {
    if (!a || !b || a.epoch !== b.epoch) return;
    if (this.epoch !== b.epoch) { this.seen = new Map(); this.epoch = b.epoch; }
    const old = new Map(a.items.map(e => [e.key, e]));
    for (const e of b.items) {
      const o = old.get(e.key);
      if (!o || e.kind === "list") continue;
      const { keys, nameChanged } = changedKeys(o, e, false);
      if (keys.length || nameChanged) this.seen.set(e.key, (this.seen.get(e.key) || 0) + 1);
    }
  }

  is(epoch: number): (key: string) => boolean {
    return key => this.epoch === epoch && (this.seen.get(key) || 0) >= 2;
  }
}
