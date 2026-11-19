// A model stand-in for tests: it reads the view like a model would and
// picks elements by matching words. No network, no cost.
import type { GenerateCallback, ModelRequest } from "../src/index.js";

export interface Line { id: number; role: string; name: string; rest: string }

export function lines(view: string): Line[] {
  const out: Line[] = [];
  for (const l of view.split("\n")) {
    const m = /^\s*(?:[~+] )?\[(\d+)\] (\w+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(l);
    if (m) out.push({ id: +m[1], role: m[2], name: (m[3] || "").replace(/\\"/g, '"'), rest: m[4] || "" });
  }
  return out;
}

const ROLE_WORDS: Record<string, string[]> = {
  textbox: ["field", "box", "input", "textbox"], button: ["button"], link: ["link"], checkbox: ["checkbox", "box"],
  combobox: ["dropdown", "select", "menu"], option: ["option"],
};

/** The element whose name shares the most words with `text`. */
export function pick(view: string, text: string, roles?: string[]): Line | undefined {
  const words = text.toLowerCase().replace(/%\w+%/g, " ").match(/[a-z0-9]+/g) || [];
  let best: Line | undefined, score = 0;
  for (const l of lines(view)) {
    if (roles && !roles.includes(l.role)) continue;
    if (["form", "frame", "heading", "list", "region", "group", "navigation"].includes(l.role)) continue;
    const name = l.name.toLowerCase();
    let s = 0;
    for (const w of words) if (w.length > 2 && name.includes(w)) s += 2;
    for (const w of ROLE_WORDS[l.role] || []) if (words.includes(w)) s += 1;
    if (s > score) { score = s; best = l; }
  }
  return score >= 2 ? best : undefined;
}

export function instructionOf(prompt: string): string {
  return /^(?:Instruction|Request|Task|What to read): (.*)$/m.exec(prompt)?.[1] ?? "";
}

export function pageOf(prompt: string): string {
  const i = prompt.search(/\n(?:Page|Current page):\n/);
  return i < 0 ? prompt : prompt.slice(prompt.indexOf("\n", i + 1) + 1);
}

/** Default act brain: type / select / check / click by words. */
export function actBrain(req: ModelRequest): object {
  const ins = instructionOf(req.prompt).toLowerCase();
  const view = pageOf(req.prompt);
  const ph = /%(\w+)%/.exec(ins)?.[0];
  const quoted = /"([^"]+)"|'([^']+)'/.exec(instructionOf(req.prompt));
  if (/^(type|enter|fill)/.test(ins)) {
    const t = pick(view, ins, ["textbox", "searchbox", "combobox"]);
    return t ? { action: "type", id: t.id, text: ph ?? quoted?.[1] ?? quoted?.[2] ?? "" } : { action: "none", why: "no field" };
  }
  if (/^(select|choose|pick)/.test(ins)) {
    const sel = pick(view, ins, ["combobox"]);
    const opt = quoted?.[1] ?? quoted?.[2] ?? "";
    if (sel && /options/.test(sel.rest)) return { action: "select", id: sel.id, option: opt };
    const opener = pick(view, ins, ["button"]) ?? lines(view).find(l => l.role === "button" && /has popup/.test(l.rest));
    const option = lines(view).find(l => l.role === "option" && l.name.toLowerCase().includes(opt.toLowerCase()));
    if (option) return { action: "click", id: option.id };
    if (opener) return { action: "click", id: opener.id, next: `choose "${opt}"` };
    return { action: "none", why: "no dropdown" };
  }
  if (/^check/.test(ins)) {
    const c = pick(view, ins, ["checkbox"]);
    return c ? { action: "check", id: c.id } : { action: "none" };
  }
  const t = pick(view, ins.replace(/^(click|press|open|tap)( on)?( the)?/, ""));
  return t ? { action: "click", id: t.id } : { action: "none", why: "nothing fits" };
}

export interface Mock extends GenerateCallback {
  calls: ModelRequest[];
  reset(): void;
}

/** A mock model. `extract` answers extract prompts; `agent` answers agent prompts in order. */
export function mockModel(o: { extract?: (instruction: string, page: string) => unknown; agent?: object[]; act?: (req: ModelRequest) => object; check?: (statement: string, page: string) => object } = {}): Mock {
  const calls: ModelRequest[] = [];
  let agentStep = 0;
  const m: Mock = {
    id: "mock/brain",
    price: { input: 1, output: 2 },
    calls,
    reset() { calls.length = 0; agentStep = 0; },
    async generate(req) {
      calls.push(req);
      let answer: unknown;
      if (req.system.startsWith("You read data")) answer = o.extract ? o.extract(instructionOf(req.prompt), pageOf(req.prompt)) : {};
      else if (req.system.startsWith("You complete a task")) answer = o.agent?.[agentStep++] ?? { action: "done", success: false };
      else if (req.system.startsWith("You check one statement")) answer = o.check ? o.check(/^Statement: (.*)$/m.exec(req.prompt)?.[1] ?? "", pageOf(req.prompt)) : { ok: false, evidence: "" };
      else if (req.system.startsWith("You help a program find")) {
        const l = pick(pageOf(req.prompt), instructionOf(req.prompt));
        answer = { matches: l ? [{ id: l.id, action: "click", description: l.name }] : [] };
      } else answer = (o.act ?? actBrain)(req);
      const text = JSON.stringify(answer);
      return { text, usage: { inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(text.length / 4) } };
    },
  };
  return m;
}
