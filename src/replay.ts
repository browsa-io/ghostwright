// Replaying a recipe. Each step finds its element with the locator chain,
// acts, and checks the effect. A step that breaks is repaired with one model
// call; the repaired recipe becomes the active version only after the whole
// run passed (output valid, assertions true).
import { compileExtract, readJSON } from "./compile.js";
import type { Action, Target } from "./engine/session.js";
import { FlowError, GhostwrightError, SecretOriginError } from "./errors.js";
import { checkEffect, type Ghostwright, type Meta } from "./ghostwright.js";
import * as P from "./model/prompts.js";
import { evaluate, pathMatches, render, type Recipe, type Step } from "./recipe.js";
import { coerce, toSchema, validate } from "./schema.js";
import { SecretNotAllowedError, TOKEN } from "./secrets.js";

export interface RunOptions {
  /** repair broken steps with the model (default: the recipe's repair mode, "auto") */
  repair?: boolean;
  /** at most this many repaired steps in one run (default: recipe repair.max_steps, 3) */
  maxRepairs?: number;
}

export interface StepReport { id: string; kind: string; layer: "replay" | "fetch" | "page_json" | "css" | "model" | "repair"; ms: number; by?: string; repaired?: boolean; skipped?: boolean }

export interface RunResult<T = any> {
  output: T;
  version: number;
  /** set when a repaired version was promoted by this run */
  promoted?: number;
  /** set when the repaired version waits for review (gw.promote(name) to use it) and why */
  draft?: { version: number; why: string };
  repaired: string[];
  steps: StepReport[];
  meta: Meta;
}

class StepFail extends Error { constructor(public why: string) { super(why); } }
/** A repair that may run only after a person looked at it. */
class NeedsReview { constructor(public steps: Step[], public why: string) {} }

export async function runFlow<T>(gw: Ghostwright, name: string, params: Record<string, unknown>, o: RunOptions): Promise<RunResult<T>> {
  const b = gw.begin();
  const recipe = gw.store.load(name);
  if (!recipe) throw new FlowError("not_found", `no saved flow "${name}" in ${gw.store.dir}`);
  for (const k of recipe.params?.required || []) {
    if (!(k in params)) throw new FlowError("params_invalid", `flow "${name}" needs param "${k}"`);
  }
  const allowRepair = (o.repair ?? recipe.repair?.mode !== "off") && gw.hasModel;
  const maxRepairs = o.maxRepairs ?? recipe.repair?.max_steps ?? 3;
  const steps = recipe.steps.map(s => ({ ...s }));
  const reports: StepReport[] = [];
  const repaired: string[] = [];
  const saved: Record<string, unknown> = {};
  const output: Record<string, unknown> = {};
  const sparams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v]));
  // the hosts the flow knows: a repair that goes elsewhere waits for review
  const knownHosts = new Set<string>([...((recipe.meta?.hosts as string[] | undefined) || []), ...recipe.steps.flatMap(x => stepHosts(x, "")), ...(recipe.start_url ? hostsOf(recipe.start_url) : [])]);
  const reviewWhy = new Set<string>();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const t0 = Date.now();
    try {
      const rep = await runStep(gw, s, sparams, saved, output, steps.slice(0, i + 1).some(usesParams));
      reports.push({ id: s.id, kind: s.kind, ms: Date.now() - t0, ...rep });
      gw.tracer.write("step", { step: s.id, kind: s.kind, status: "ok", layer: rep.layer, by: rep.by, ms: Date.now() - t0 });
    } catch (e) {
      const why = e instanceof StepFail ? e.why : (e as Error).message;
      gw.tracer.write("step", { step: s.id, kind: s.kind, status: "failed", reason: why });
      // a guard or a secret rule said no: not repaired another way
      if (e instanceof FlowError || e instanceof SecretOriginError || e instanceof SecretNotAllowedError || (e instanceof GhostwrightError && e.code.startsWith("secret_"))) throw e;
      if (s.optional) { reports.push({ id: s.id, kind: s.kind, layer: "replay", ms: Date.now() - t0, skipped: true }); continue; }
      if (!allowRepair || repaired.length >= maxRepairs) {
        throw new FlowError("site_changed", `step ${s.id} (${s.goal || s.kind}) failed: ${why}${gw.hasModel ? "" : " (no model to repair it)"}`, s.id);
      }
      const fresh = await repairStep(gw, recipe, steps, i, why, sparams, saved, output);
      gw.emit({ type: "repair", flow: name, step: s.id, ok: !!fresh });
      if (!fresh) throw new FlowError("site_changed", `step ${s.id} (${s.goal || s.kind}) failed and could not be repaired: ${why}`, s.id);
      if (fresh instanceof NeedsReview) {
        const draftSteps = [...steps];
        draftSteps.splice(i, 1, ...fresh.steps);
        const v = nextVersion(gw, recipe);
        gw.store.saveDraft(gw.secrets.safeRecipe({ ...recipe, version: v, steps: draftSteps, meta: { ...(recipe.meta || {}), repaired_from: recipe.version, repaired_steps: [...repaired, s.id], repaired_at: new Date().toISOString() } }), fresh.why);
        gw.tracer.write("draft", { flow: name, version: v, reason: fresh.why });
        throw new FlowError("needs_review", `step ${s.id} (${s.goal || s.kind}) failed: ${why}. ${fresh.why}: nothing was typed; saved as draft v${v}, gw.promote("${name}") uses it`, s.id);
      }
      // what the repair reaches: hosts it goes to or acts on, secrets typed somewhere new
      for (const f of fresh) {
        for (const h of stepHosts(f, gw.session.currentURL)) if (!knownHosts.has(h)) reviewWhy.add(`a repaired step goes to a new host: ${h}`);
        if (f.kind === "type" && TOKEN_TEST.test(f.text || "") && !(s.kind === "type" && sameTarget(s.target, f.target))) reviewWhy.add(`a repaired step types a secret into another field (${f.target?.name || f.target?.css || "?"})`);
      }
      // the repaired steps take the broken one's place (and a fetch the extract read from)
      let at = i;
      if (s.kind === "extract" && s.from === "saved" && i > 0 && steps[i - 1].kind === "fetch" && steps[i - 1].save_as === s.source) {
        steps.splice(i - 1, 1);
        at = i - 1;
      }
      steps.splice(at, 1, ...fresh);
      i = at + fresh.length - 1;
      repaired.push(s.id);
      reports.push({ id: s.id, kind: s.kind, layer: "repair", ms: Date.now() - t0, repaired: true });
    }
  }

  // the whole run must pass before a repair is kept
  const out = coerce(recipe.output, output);
  const err = validate(recipe.output, out);
  const failedAssert = (recipe.assertions || []).find(a => {
    try { return !evaluate(a.expr, { output: out, saved, params }); } catch { return true; }
  });
  if (err || failedAssert) {
    const why = err || `assertion failed: ${failedAssert!.expr}`;
    if (repaired.length) gw.store.saveDraft({ ...recipe, version: recipe.version + 1, steps }, why);
    throw new FlowError("invalid_output", `flow "${name}": ${why}`);
  }
  let promoted: number | undefined;
  let draft: { version: number; why: string } | undefined;
  if (repaired.length) {
    const next: Recipe = gw.secrets.safeRecipe({ ...recipe, version: nextVersion(gw, recipe), steps, meta: { ...(recipe.meta || {}), repaired_from: recipe.version, repaired_steps: repaired, repaired_at: new Date().toISOString() } });
    if (recipe.repair?.mode === "review" || reviewWhy.size) {
      draft = { version: next.version, why: reviewWhy.size ? [...reviewWhy].join("; ") : "the flow's repairs are reviewed (repair.mode review)" };
      gw.store.saveDraft(next, draft.why);
      gw.tracer.write("draft", { flow: name, version: next.version, reason: draft.why });
    } else {
      gw.store.promote(next);
      promoted = next.version;
      gw.emit({ type: "promote", flow: name, version: next.version });
      gw.tracer.write("promote", { flow: name, version: next.version });
    }
  }
  gw.tracer.write("run", { flow: name, status: "ok", steps: reports.length, repaired });
  return { output: out as T, version: promoted ?? recipe.version, promoted, ...(draft ? { draft } : {}), repaired, steps: reports, meta: gw.end(b) };
}

const TOKEN_TEST = /\{\{\s*(secret|totp)\s*:/;

export function hostsOf(url: string): string[] {
  try { const u = new URL(url); return u.host ? [u.host.toLowerCase()] : []; } catch { return []; }
}

/** The hosts a step goes to (navigate, fetch) or acts on (the page it ran on). */
function stepHosts(s: Step, pageURL: string): string[] {
  if ((s.kind === "navigate" || s.kind === "fetch") && s.url && !/^\{\{/.test(s.url)) return hostsOf(s.url);
  if (["click", "type", "select", "press"].includes(s.kind) && pageURL) return hostsOf(pageURL);
  return [];
}

function sameTarget(a?: Step["target"], b?: Step["target"]): boolean {
  if (!a || !b) return false;
  return (!!a.role && a.role === b.role && a.name === b.name) || (!!a.css && a.css === b.css);
}

function nextVersion(gw: Ghostwright, r: Recipe): number {
  return Math.max(r.version, ...gw.store.versions(r.name)) + 1;
}

/** The local secret names a step's text types. */
export function stepSecrets(gw: Ghostwright, s: string): string[] {
  return [...new Set([...s.matchAll(TOKEN)].map(m => gw.secrets.nameOfToken(m[1], m[2], m[3])).filter((x): x is string => !!x))];
}

/**
 * Fills {{param}} now and {{secret:...}} at the keystroke: a text with
 * secrets comes back as `secretText`, resolved for the field's own document.
 */
function fillText(gw: Ghostwright, s: string, params: Record<string, unknown>): { text?: string; secretText?: NonNullable<Action["secretText"]>; shown?: string } {
  // params first, so a secret's value is never read as a placeholder
  const withParams = render(s, params);
  const tokens = [...withParams.matchAll(TOKEN)];
  if (!tokens.length) return { text: withParams };
  const names: string[] = [];
  for (const m of tokens) {
    const local = gw.secrets.nameOfToken(m[1], m[2], m[3]);
    if (!local) throw new FlowError("secret_missing", `the flow types secret ${m[0].replace(/\s/g, "")}, which is not in this Ghostwright's secrets: add it to secrets (env(), secret() or browsaSecret() with that name)`);
    names.push(local);
  }
  const resolve = async (url: string) => {
    let value = "", last = 0;
    for (const m of withParams.matchAll(TOKEN)) {
      value += withParams.slice(last, m.index) + (await gw.secrets.valueFor(gw.secrets.nameOfToken(m[1], m[2], m[3])!, url));
      last = m.index! + m[0].length;
    }
    return value + withParams.slice(last);
  };
  return { secretText: { resolve, names }, shown: JSON.stringify(shownTokens(withParams)) };
}

/** {{secret:NAME:password}} -> %NAME:password%, for echoes. */
export function shownTokens(s: string): string {
  return s.replace(TOKEN, (_m, kind: string, n: string, field?: string) => `%${kind === "totp" ? "TOTP:" : ""}${n}${field ? ":" + field : ""}%`);
}

async function runStep(gw: Ghostwright, s: Step, params: Record<string, unknown>, saved: Record<string, unknown>, output: Record<string, unknown>, loose = false): Promise<Omit<StepReport, "id" | "kind" | "ms">> {
  const session = gw.session;
  const act = async (a: Action) => {
    const r = await session.act(a);
    // a safety guard said no: the run stops there, it is not repaired another way
    if (r.guard) throw new FlowError("blocked", `step ${s.id} (${s.goal || s.kind}) was refused: ${r.reason}`, s.id);
    if (r.status === "challenge") await gw.handleChallenge(r.challenge?.kind || "unknown");
    else {
      const chk = checkEffect(a, r, s.effect ?? null);
      if (!chk.ok) throw new StepFail(chk.reason || "failed");
      // it went where it went when recorded
      const want = s.effect?.kind === "navigate" ? s.effect.path : undefined;
      if (want && r.navigation && !r.navigation.sameDocument) {
        let got = "";
        try { got = new URL(r.navigation.url).pathname; } catch { /* none */ }
        if (!pathMatches(want, got, params, loose)) throw new StepFail(`it went to ${got}, not ${want} as when the flow was recorded`);
      }
    }
    return r;
  };
  const find = async (target = s.target) => {
    if (!target) throw new StepFail("the step has no target");
    const tpl = templated(target);
    if (tpl.length) {
      // a locator with a param must match with this run's value: the recorded
      // position (css, xpath) points at the recorded item, so it is not used
      const r = renderTarget(target, params);
      const strict: Target = { role: r.role, frame: r.frame, near: r.near };
      for (const k of tpl) (strict as any)[k] = (r as any)[k];
      // only the context has the param ("Add" near "{{item}}"): the label and text still count
      if (!tpl.some(k => k !== "near")) { strict.name = r.name; strict.text = r.text; }
      const hit = await session.resolve(strict);
      if (!hit) throw new StepFail(`no element matches ${tpl.map(k => `${k} "${(r as any)[k]}"`).join(" or ")} (the params of this run)`);
      return hit;
    }
    const hit = await session.resolve(renderTarget(target, params));
    if (!hit) throw new StepFail("the element was not found");
    return hit;
  };
  switch (s.kind) {
    case "navigate": {
      const url = render(s.url!, params);
      const r = await session.act({ action: "navigate", url });
      if (r.guard) throw new FlowError("blocked", `step ${s.id} (navigate) was refused: ${r.reason}`, s.id);
      if (r.status === "challenge") await gw.handleChallenge(r.challenge?.kind || "unknown");
      else if (r.status !== "ok") throw new StepFail(r.reason || "navigation failed");
      return { layer: "replay" };
    }
    case "click": {
      const hit = await find();
      const action = s.state === "checked" ? "check" : s.state === "unchecked" ? "uncheck" : "click";
      await act({ action, id: hit.id });
      return { layer: "replay", by: hit.by };
    }
    case "type": {
      const hit = await find();
      const t = fillText(gw, s.text || "", params);
      // a secret goes only into the field its label or selector names, never one found by position
      if (t.secretText && !["role", "css"].includes(hit.by)) throw new StepFail(`the field for the secret was found only by its position (${hit.by}); nothing was typed`);
      await act({ action: "type", id: hit.id, text: t.text, secretText: t.secretText, textShown: t.shown, clear: s.clear ?? true, submit: s.submit });
      return { layer: "replay", by: hit.by };
    }
    case "select": {
      const hit = await find();
      await act({ action: "select", id: hit.id, option: render(s.value || "", params) });
      return { layer: "replay", by: hit.by };
    }
    case "press":
      await act({ action: "press", keys: s.keys || "Enter" });
      return { layer: "replay" };
    case "scroll": {
      const v = s.value || "down";
      const dy = /^-?\d+$/.test(v) ? +v : (v === "up" ? -1 : 1) * 700 * (s.pages || 1);
      await act({ action: "scroll", dy });
      return { layer: "replay" };
    }
    case "wait": {
      if (s.hover && s.for?.target) {
        const hit = await find(s.for.target);
        await act({ action: "hover", id: hit.id });
        return { layer: "replay", by: hit.by };
      }
      if (s.for?.text) { await act({ action: "wait", for: "text", text: render(s.for.text, params), timeout: s.timeout_ms }); return { layer: "replay" }; }
      if (s.for?.target) {
        const end = Date.now() + (s.timeout_ms ?? 10000);
        for (;;) {
          try { await find(s.for.target); break; } catch (e) {
            if (!(e instanceof StepFail)) throw e;
            if (Date.now() > end) throw new StepFail("timeout waiting for the element");
          }
          await new Promise(r => setTimeout(r, 250));
        }
        return { layer: "replay" };
      }
      await act({ action: "wait", ms: s.timeout_ms ?? 500 });
      return { layer: "replay" };
    }
    case "fetch": {
      if (s.mutation) throw new StepFail("mutations are not replayed by fetch");
      const url = render(s.url!, params);
      const r = await gw.session.evalMain(`fetch(${JSON.stringify(url)}, {method: ${JSON.stringify(s.method || "GET")}, credentials: "include", headers: ${JSON.stringify(s.headers || {})}}).then(r => r.text().then(t => JSON.stringify({status: r.status, text: t.slice(0, 5000000)}))).catch(e => JSON.stringify({error: String(e)}))`);
      const j = JSON.parse(r);
      if (j.error || j.status >= 400) throw new StepFail(`fetch failed: ${j.error || "HTTP " + j.status}`);
      try { saved[s.save_as!] = JSON.parse(j.text); } catch { throw new StepFail("fetch did not return JSON"); }
      return { layer: "fetch" };
    }
    case "extract": {
      const how = s.how || {};
      let value: unknown;
      let layer: StepReport["layer"] = "replay";
      if (how.model) {
        if (!gw.hasModel) throw new FlowError("no_model", `step ${s.id} is an extract that did not compile, so it reads with a model on every run: pass model to Ghostwright.create()`, s.id);
        const sch = await toSchema(s.output_schema || { type: "object" });
        value = (await gw.modelExtract(s.goal || "the data", sch)).value;
        layer = "model";
      } else if (s.from === "saved") {
        value = readJSON(saved[s.source!], how);
        layer = "fetch";
      } else if (s.from === "page_json") {
        const docs = await gw.session.pageJson();
        const d = docs.find(x => x.sel === (s.source || "script#__NEXT_DATA__"));
        if (!d) throw new StepFail("the page JSON is gone");
        value = readJSON(d.json, how);
        layer = "page_json";
      } else {
        value = await gw.session.domExtract({ css: how.css ?? null, fields: how.fields, limit: how.limit });
        if (Array.isArray(value)) value = value.filter(v => v && (typeof v !== "object" || Object.values(v as object).some(x => x != null && x !== "")));
        if (Array.isArray(value) && how.limit) value = value.slice(0, how.limit);
        layer = "css";
      }
      if (value == null || (Array.isArray(value) && !value.length && !how.allow_empty) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length)) {
        throw new StepFail("the extract found nothing");
      }
      if (how.fields && !how.model) {
        // a field that no longer resolves anywhere means the page changed
        const rows = Array.isArray(value) ? value : [value];
        for (const k of Object.keys(how.fields)) if (rows.every(r => (r as any)?.[k] == null)) throw new StepFail(`field "${k}" was not found`);
      }
      place(output, value, how.into);
      if (s.output_schema) {
        const e = validate(s.output_schema, coerce(s.output_schema, how.into ? { [how.into]: value } : value));
        if (e) throw new StepFail("the extracted data no longer fits: " + e);
      }
      return { layer };
    }
    case "assert": {
      let ok = false;
      try { ok = !!evaluate(s.expr || "true", { output, saved, params }); } catch { ok = false; }
      if (!ok) throw new StepFail(`assertion failed: ${s.expr}`);
      return { layer: "replay" };
    }
  }
  throw new StepFail(`step kind ${s.kind} is not supported by this version`);
}

const PARAM = /\{\{\s*(?:json:)?[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

/** Does a step put a param into the page (an address, typed text, a locator)? */
function usesParams(s: Step): boolean {
  return PARAM.test(JSON.stringify([s.url, s.text, s.value, s.target, s.for]));
}

/** The locators of a target that hold a {{param}}. */
function templated(t: Target): (keyof Target)[] {
  return (["name", "css", "text", "near"] as const).filter(k => typeof t[k] === "string" && PARAM.test(t[k]!));
}

function renderTarget(t: Target, params: Record<string, unknown>): Target {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, render(String(v), params)])) as Target;
}

function place(output: Record<string, unknown>, value: unknown, into?: string): void {
  if (into) output[into] = value;
  else if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(output, value);
  else output.value = value;
}

/** One model call for the broken step; returns the steps that replace it, or null. */
async function repairStep(gw: Ghostwright, recipe: Recipe, steps: Step[], i: number, why: string, params: Record<string, unknown>, saved: Record<string, unknown>, output: Record<string, unknown>): Promise<Step[] | NeedsReview | null> {
  const s = steps[i];
  const goal = s.goal || `${s.kind} step`;
  try {
    if (s.kind === "extract") {
      const props = s.output_schema?.properties ?? (s.how?.into ? { [s.how.into]: recipe.output.properties?.[s.how.into] } : recipe.output.properties);
      const sch = await toSchema(s.output_schema ?? { type: "object", properties: props, required: Object.keys(props || {}) });
      const { value } = await gw.modelExtract(goal, sch);
      const compiled = await compileExtract({ session: gw.session, id: s.id, goal, answer: value, schema: sch, captured: gw.session.captured, params });
      place(output, compiled ? compiled.value : value, undefined);
      if (compiled) return compiled.steps;
      return [{ id: s.id, kind: "extract", from: "page", how: { model: true }, schema_ref: "output", goal, output_schema: sch.json }];
    }
    const view = await gw.view();
    const vars: Record<string, string> = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const shown = gw.showVars(goal, vars);
    const d = (await gw.ask("repair", P.ACT_SYSTEM, P.actPrompt(shown, view.text, P.REPAIR_NOTE(shown, why)))) as any;
    if (!d || d.action === "none") return null;
    // a secret goes into a field it was not recorded for only after review:
    // the repaired step is kept as a draft, and nothing is typed now
    const secrets = stepSecrets(gw, s.text || "");
    if (d.action === "type" && secrets.length && d.id != null && gw.session.last?.byId.has(Number(d.id))) {
      const target = (await gw.session.locators(Number(d.id))) ?? {};
      if (!(s.kind === "type" && sameTarget(s.target, target))) {
        return new NeedsReview([{ ...s, target }], `the repaired step would type a secret into another field (${target.name || target.css || "?"})`);
      }
    }
    // a repair may type only the secrets the broken step typed
    const ex = await gw.execute(d, vars, goal, params, new Set(secrets));
    if (!ex.ok || !ex.steps.length) return null;
    ex.steps[0].id = s.id;
    return ex.steps;
  } catch (e) {
    gw.tracer.write("repair", { step: s.id, status: "failed", reason: (e as Error).message });
    return null;
  }
}
