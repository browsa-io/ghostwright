import act from "./act.mjs";
import extract from "./extract.mjs";
import observe from "./observe.mjs";
import flows from "./flows.mjs";
import secrets from "./secrets.mjs";

// "parity" = act + extract + observe. "repeat" and "drift" reuse the flows.
export const SETS = { act, extract, observe, flow: flows, secrets };

// More task sets of your own: BENCH_EXTRA_TASKS lists module files (separated like PATH), each
// with a default export of tasks; a task's `set` names the set it joins or starts.
export async function loadExtraTasks() {
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  for (const f of (process.env.BENCH_EXTRA_TASKS || "").split(path.delimiter).filter(Boolean)) {
    const list = (await import(pathToFileURL(path.resolve(f)).href)).default || [];
    for (const t of list) (SETS[t.set] ||= []).push(t);
  }
}

export function tasksFor(setNames) {
  const out = [];
  for (const s of setNames) {
    if (s === "parity") out.push(...act, ...extract, ...observe);
    else if (s === "repeat" || s === "drift") out.push(...flows);
    else if (SETS[s]) out.push(...SETS[s]);
    else throw new Error(`unknown set ${s}`);
  }
  return out;
}

export function allPages() {
  const m = new Map();
  for (const list of Object.values(SETS))
    for (const t of list)
      for (const [p, page] of Object.entries(t.pages || {})) {
        if (m.has(p)) throw new Error(`duplicate fixture path ${p}`);
        m.set(p, page);
      }
  return m;
}
