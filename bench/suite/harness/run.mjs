#!/usr/bin/env node
// Bench runner.
//
//   node harness/run.mjs --adapter <name[:variant]> --set parity|act|extract|observe|repeat|drift|secrets
//        [--runs 10] [--lanes 2] [--only id1,id2] [--out results/x.jsonl] [--budget 5] [--ledger file]
//        [--model openai/gpt-5.6-luna] [--upstream https://openrouter.ai/api/v1] [--key-env OPENROUTER_API_KEY | --key-file path]
//        [--headful] [--dry]
//
// The model key is read from the environment (BENCH_API_KEY, else OPENROUTER_API_KEY) or from
// --key-file, and is never printed or handed to the SDK under test.
//
// Writes one JSON line per task run (see README for the fields).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Meter, readKey } from "./meter.mjs";
import { launchChrome } from "./chrome.mjs";
import { startFixtureServer } from "./fixtures.mjs";
import { evaluate as cdpEval, pageSnapshot } from "./cdp.mjs";
import { RESOLVE_JS } from "./resolve.mjs";
import { tasksFor, allPages, loadExtraTasks } from "../tasks/index.mjs";
import { blockVerdict } from "./blocked.mjs";
import { execFileSync } from "node:child_process";
import { loadAdapter } from "../adapters/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// Model prices (USD per 1M tokens) used only when the provider returns no cost.
const PRICING = {
  "openai/gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "openai/gpt-6-luna": { in: 0.1, out: 0.5 },
  "deepseek/deepseek-v4.1-flash": { in: 0.3, out: 1.2 },
};

function args() {
  const a = process.argv.slice(2);
  const o = { runs: 1, lanes: 2, budget: 5, model: "openai/gpt-5.6-luna", upstream: "https://openrouter.ai/api/v1", keyFile: null, keyEnv: null, stepTimeout: 120000 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, "");
    const v = a[i + 1];
    switch (k) {
      case "adapter": o.adapter = v; i++; break;
      case "set": o.set = v.split(","); i++; break;
      case "runs": o.runs = Number(v); i++; break;
      case "lanes": o.lanes = Math.min(2, Number(v)); i++; break;
      case "only": o.only = v.split(","); i++; break;
      case "skip": o.skip = v.split(","); i++; break;
      case "out": o.out = v; i++; break;
      case "budget": o.budget = Number(v); i++; break;
      case "ledger": o.ledger = v; i++; break;
      case "model": o.model = v; i++; break;
      case "upstream": o.upstream = v; i++; break;
      case "key-file": o.keyFile = v.replace(/^~/, os.homedir()); i++; break;
      case "key-env": o.keyEnv = v; i++; break;
      case "step-timeout": o.stepTimeout = Number(v); i++; break;
      case "headful": o.headful = true; break;
      case "dry": o.dry = true; break;
      case "label": o.label = v; i++; break;
      default: throw new Error(`unknown option ${a[i]}`);
    }
  }
  if (!o.adapter || !o.set) throw new Error("usage: run.mjs --adapter <name> --set <set>[,<set>] [options]");
  return o;
}

// The model key: --key-file, else --key-env, else BENCH_API_KEY, else OPENROUTER_API_KEY.
function modelKey(o) {
  if (o.keyFile) return readKey(o.keyFile);
  const name = o.keyEnv || (process.env.BENCH_API_KEY ? "BENCH_API_KEY" : "OPENROUTER_API_KEY");
  const k = (process.env[name] || "").trim();
  if (!k) throw new Error(`no model key: set ${o.keyEnv || "OPENROUTER_API_KEY"} (or BENCH_API_KEY with --upstream for another OpenAI-compatible provider), or pass --key-file <path>`);
  return k;
}

// The commit of the code under test, when the harness runs from a git checkout.
function commitOf(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms))]);

// Wait until the fixture page has been quiet for 700 ms (at most 4 s). Live pages: a fixed 1.5 s.
async function settle(state, live) {
  if (live) return sleep(1500);
  const t0 = Date.now();
  let n = state.events.length, quietSince = Date.now();
  while (Date.now() - t0 < 4000) {
    await sleep(100);
    if (state.events.length !== n) {
      n = state.events.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 700) return;
  }
}

const shortErr = (e) => String(e?.message || e).replace(/\s+/g, " ").slice(0, 300);

function scanDir(dir, values) {
  let hits = 0;
  if (!dir || !fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else {
        try {
          const s = fs.readFileSync(p, "utf8");
          for (const v of values) if (s.includes(v)) hits++;
        } catch {}
      }
    }
  };
  walk(dir);
  return hits;
}

async function main() {
  const o = args();
  const date = new Date().toISOString().slice(0, 10);
  await loadExtraTasks();
  const { adapter, variant, spec } = await loadAdapter(o.adapter);
  const avail = await adapter.available(variant);
  if (avail !== true) {
    console.error(`adapter ${spec} cannot run: ${avail}`);
    process.exit(2);
  }
  const desc = adapter.describe(variant);
  const commit = process.env.BENCH_SDK_COMMIT || commitOf(here);
  const mode = o.set.includes("repeat") ? "repeat" : o.set.includes("drift") ? "drift" : "single";
  let tasks = tasksFor(o.set);
  if (o.only) tasks = tasks.filter((t) => o.only.some((x) => t.id.startsWith(x)));
  if (o.skip) tasks = tasks.filter((t) => !o.skip.some((x) => t.id.startsWith(x)));
  if (adapter.fixtures === false) tasks = tasks.filter((t) => t.live);
  const runsPerTask = mode === "repeat" ? o.runs : mode === "drift" ? 2 : o.runs;
  const out = o.out || path.join(root, "results", `${spec.replace(/[:/]/g, "-")}-${o.set.join("+")}-${date}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const workDir = path.join(path.dirname(out), ".work", `${path.basename(out, ".jsonl")}-${spec.replace(/[:/]/g, "-")}-${o.set.join("+")}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  console.log(`${spec} (${desc.sdk} ${desc.version}) · sets ${o.set.join(",")} · ${tasks.length} tasks × ${runsPerTask} · model ${o.model} · lanes ${o.lanes} · out ${path.relative(process.cwd(), out)}`);
  if (o.dry) {
    for (const t of tasks) console.log(`  ${t.set.padEnd(8)} ${t.id}  (${t.steps.length} steps${t.live ? ", live" : ""})`);
    return;
  }

  const meter = new Meter({
    upstream: o.upstream,
    apiKey: modelKey(o),
    budgetUsd: o.budget,
    ledger: o.ledger || path.join(path.dirname(out), `.spend-${date}.json`),
    callLog: path.join(workDir, "calls.jsonl"),
    pricing: PRICING,
    provider: { data_collection: "deny" },
    headers: { "X-Title": "bench" },
  });
  await meter.start();
  console.log(`spend so far on this ledger: $${meter.spentUsd.toFixed(4)} of $${o.budget}`);

  const pages = allPages();
  const lanes = [];
  for (let i = 0; i < o.lanes; i++) lanes.push({ id: `lane${i}`, fx: await startFixtureServer(pages) });

  // job list: drift and repeat keep the store across runs of one task
  const jobs = tasks.map((t) => ({ task: t, runs: runsPerTask }));
  let done = 0, stopped = null;
  const totalRuns = jobs.reduce((s, j) => s + j.runs, 0);
  const costs = [];

  async function runOnce(lane, task, run, storeDir) {
    const fx = lane.fx;
    const st = fx.state;
    st.reset();
    const phase = mode === "drift" ? (run === 1 ? "learn" : "drift") : mode === "repeat" ? `run${run}` : "single";
    st.variant = mode === "drift" && run === 2 ? "v2" : "v1";
    const runKey = `${task.id}#${run}`;
    const secrets = typeof task.secrets === "function" ? task.secrets(fx.O) : task.secrets || null;
    const canaries = secrets ? Object.values(secrets).map((s) => s.value).filter((v) => v.length > 12 && !v.includes("@")) : [];
    meter.setCanaries(lane.id, canaries);
    const logFile = path.join(workDir, "logs", `${task.id}.${run}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = (line) => fs.appendFileSync(logFile, (typeof line === "string" ? line : JSON.stringify(line)) + "\n");

    const rec = { date, adapter: spec, sdk: desc.sdk, sdk_version: desc.version, sdk_commit: desc.commit ?? commit, model: o.model, set: task.set, task: task.id, run, phase, variant: st.variant, live: !!task.live };
    const t0 = Date.now();
    let chrome = null, session = null;
    const results = [];
    const stepStats = [];
    let finishError = null;
    try {
      if (!adapter.ownsBrowser) chrome = await launchChrome({ headless: !o.headful });
      meter.route(lane.id, `${runKey}/open`);
      session = await withTimeout(
        adapter.open({ variant, cdpUrl: chrome?.cdpUrl, cdpWsUrl: chrome?.wsUrl, model: { id: o.model, baseURL: meter.baseURL(lane.id), apiKey: "bench-local-placeholder" }, storeDir, secrets, log }),
        60000,
        "open",
      );
      // optional hook: lets an SDK record the task as a named flow (repeat/drift) and replay it later
      if (session.begin) await withTimeout(Promise.resolve(session.begin({ task: task.id, run, phase, record: mode !== "single", steps: task.steps })), 30000, "begin");
      const startUrl = task.live ? task.start : (task.startOrigin === "X" ? fx.X : fx.O) + task.start;
      await withTimeout(session.goto(startUrl), 60000, "goto");
      await sleep(task.live ? 1500 : 300);
      for (let i = 0; i < task.steps.length; i++) {
        const s = task.steps[i];
        const key = `${runKey}/s${i}`;
        meter.route(lane.id, key);
        const ts = Date.now();
        const r = { op: s.op };
        try {
          if (s.op === "wait") await sleep(s.ms);
          else if (s.op === "act") {
            const a = await withTimeout(session.act(s.text), o.stepTimeout, "act");
            r.ok = a?.ok !== false;
            if (!r.ok) r.error = `sdk reported failure: ${String(a?.message || "").slice(0, 200)}`;
          } else if (s.op === "extract") {
            r.data = await withTimeout(session.extract(s.text, s.schema), o.stepTimeout, "extract");
            r.ok = true;
          } else if (s.op === "observe") {
            const obs = await withTimeout(session.observe(s.text), o.stepTimeout, "observe");
            r.ok = true;
            r.observed = (obs || []).map((x) => ({ selector: x.selector, description: x.description }));
            const js = RESOLVE_JS(r.observed.map((x) => x.selector));
            r.resolved = session.evaluate ? await session.evaluate(js) : await cdpEval(chrome.cdpUrl, js, (u) => u.startsWith(fx.O) || u.startsWith(fx.X));
          }
        } catch (e) {
          r.ok = false;
          r.error = shortErr(e);
        }
        r.ms = Date.now() - ts;
        // let the page finish what the step started (smooth scroll, navigation, timers), same for every SDK
        if (s.op === "act") await settle(st, task.live);
        const m = meter.stats(key);
        r.calls = m.calls;
        r.in_tok = m.inTok;
        r.out_tok = m.outTok;
        r.usd = m.usd;
        results.push(r);
        stepStats.push({ op: r.op, ok: r.ok, ms: r.ms, calls: r.calls, in_tok: r.in_tok, out_tok: r.out_tok, error: r.error });
        if (meter.remainingUsd <= 0) throw new Error("budget reached");
      }
      // optional hook: an SDK that defers work (e.g. replays a saved flow) finishes it here
      if (session.finish) {
        meter.route(lane.id, `${runKey}/finish`);
        const tf = Date.now();
        try {
          await withTimeout(Promise.resolve(session.finish()), o.stepTimeout * 2, "finish");
        } catch (e) {
          finishError = shortErr(e);
        }
        stepStats.push({ op: "finish", ok: !finishError, error: finishError, ms: Date.now() - tf, calls: meter.stats(`${runKey}/finish`).calls });
      }
      await settle(st, task.live);
      // checks
      if (task.set === "botwall") {
        const snap = session.evaluate ? await session.evaluate(`(() => ({url: location.href, title: document.title, text: (document.body?document.body.innerText:'').slice(0,6000), html: document.documentElement.outerHTML.slice(0,20000)}))()`) : await pageSnapshot(chrome.cdpUrl);
        let blocked = blockVerdict(snap);
        if (!blocked && task.widget) {
          const sel = task.widget === "turnstile" ? "[name=cf-turnstile-response]" : "#g-recaptcha-response";
          const js = `(() => { const e = document.querySelector('${sel}'); return e ? e.value : null })()`;
          const tok = session.evaluate ? await session.evaluate(js) : await cdpEval(chrome.cdpUrl, js);
          if (!tok) blocked = `${task.widget} not cleared without interaction`;
        }
        const data = results.find((r) => r.op === "extract")?.data;
        const v = data?.[task.field];
        const nonEmpty = Array.isArray(v) ? v.length > 0 && v.some((x) => x && Object.values(x).some((y) => String(y || "").trim())) : !!String(v ?? "").trim();
        rec.blocked = !!blocked;
        rec.block_reason = blocked || null;
        rec.final_url = snap?.url;
        rec.final_title = snap?.title?.slice(0, 120);
        rec.pass = !blocked && nonEmpty;
        rec.reason = blocked ? `blocked: ${blocked}` : nonEmpty ? null : `nothing read (${results.find((r) => r.op === "extract")?.error || "empty"})`;
      } else {
        const c = await task.check({ state: st, results, fixture: fx });
        rec.pass = c === true;
        rec.reason = c === true ? null : String(c);
        if (task.expectActFailure) rec.sdk_said_failed = results.some((r) => r.ok === false);
      }
    } catch (e) {
      rec.pass = false;
      rec.reason = `harness: ${shortErr(e)}`;
      // an SDK that recognises the wall and stops (e.g. a challenge error) was blocked
      if (task.set === "botwall" && /bot check|challenge|captcha|access denied|blocked/i.test(String(e?.message || e))) {
        rec.blocked = true;
        rec.block_reason = `sdk reported: ${shortErr(e).slice(0, 80)}`;
        rec.reason = `blocked: ${rec.block_reason}`;
      }
    } finally {
      if (session) await withTimeout(Promise.resolve(session.close()), 15000, "close").catch(() => {});
      if (chrome) await chrome.close();
    }
    rec.wall_ms = Date.now() - t0;
    rec.sdk_ok = results.length === task.steps.length && results.every((r) => r.ok !== false) && !finishError;
    rec.false_success = rec.sdk_ok && !rec.pass;
    rec.steps = stepStats;
    // whole-run model usage (including calls during open/goto)
    const keys = [...meter.runs.keys()].filter((k) => k.startsWith(`${runKey}/`));
    const agg = keys.reduce((a, k) => {
      const s = meter.stats(k);
      a.calls += s.calls; a.retries += s.retries || 0; a.in_tok += s.inTok; a.out_tok += s.outTok; a.usd += s.usd; a.errors += s.errors; a.canary_hits += s.canaryHits;
      return a;
    }, { calls: 0, retries: 0, in_tok: 0, out_tok: 0, usd: 0, errors: 0, canary_hits: 0 });
    Object.assign(rec, { calls: agg.calls, in_tok: agg.in_tok, out_tok: agg.out_tok, usd: Number(agg.usd.toFixed(6)), model_errors: agg.errors, model_retries: agg.retries });
    // a failure caused by the model provider (rate limit, outage), not by the SDK
    rec.infra = !rec.pass && /HTTP (429|5\d\d)|rate limit|budget|fetch failed|unreachable/i.test(JSON.stringify(stepStats) + (rec.reason || ""));
    if (task.set === "secrets") {
      rec.canary_in_model_requests = agg.canary_hits;
      rec.canary_in_store = scanDir(storeDir, canaries);
      rec.canary_in_logs = scanDir(path.dirname(logFile), canaries);
      rec.leak = !rec.pass && !task.control && /LEAK/.test(rec.reason || "");
      rec.control = !!task.control;
    }
    return rec;
  }

  async function worker(lane) {
    while (jobs.length && !stopped) {
      const job = jobs.shift();
      const storeDir = path.join(workDir, "store", job.task.id);
      fs.mkdirSync(storeDir, { recursive: true });
      for (let run = 1; run <= job.runs && !stopped; run++) {
        // budget projection: stop before a run that would likely cross the cap
        const avg = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
        if (meter.spentUsd + avg * 1.5 > o.budget) {
          stopped = `budget: spent $${meter.spentUsd.toFixed(2)}, next run ~$${avg.toFixed(3)}, cap $${o.budget}`;
          break;
        }
        const rec = await runOnce(lane, job.task, run, storeDir);
        costs.push(rec.usd);
        fs.appendFileSync(out, JSON.stringify(rec) + "\n");
        done++;
        console.log(`[${String(done).padStart(4)}/${totalRuns}] ${rec.pass ? "PASS" : "FAIL"} ${job.task.id} #${run} ${rec.phase} ${(rec.wall_ms / 1000).toFixed(1)}s calls=${rec.calls} tok=${rec.in_tok}/${rec.out_tok} $${rec.usd.toFixed(4)}${rec.reason ? "  · " + rec.reason.slice(0, 140) : ""}`);
      }
    }
  }
  await Promise.all(lanes.map((l) => worker(l)));
  for (const l of lanes) await l.fx.close();
  await meter.stop();
  console.log(`done ${done}/${totalRuns}. spend this ledger: $${meter.spentUsd.toFixed(4)} (this process $${(meter.spentUsd - meter.startSpent).toFixed(4)})`);
  if (stopped) {
    console.log(`STOPPED: ${stopped}`);
    process.exitCode = 3;
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error(/^(no model key|usage:|unknown (option|set)|no adapter)/.test(String(e?.message)) ? e.message : e);
  process.exit(1);
});
