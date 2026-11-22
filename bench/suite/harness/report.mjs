#!/usr/bin/env node
// Markdown report from one or more result files.
//   node harness/report.mjs results/a.jsonl [results/b.jsonl ...] [--sdk ghostwright]
// --sdk keeps only rows of that SDK (use it for anything public: our own numbers only).
// A row = one adapter spec (adapter[:variant]) as recorded in the file.
import fs from "node:fs";

const argv = process.argv.slice(2);
let onlySdk = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--sdk") onlySdk = argv[++i];
  else files.push(argv[i]);
}
if (!files.length) {
  console.error("usage: report.mjs <results.jsonl>... [--sdk name]");
  process.exit(1);
}
let rows = [];
for (const f of files)
  for (const line of fs.readFileSync(f, "utf8").split("\n"))
    if (line.trim()) {
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
if (onlySdk) rows = rows.filter((r) => r.sdk === onlySdk);

const by = (arr, k) => arr.reduce((m, r) => ((m[typeof k === "function" ? k(r) : r[k]] ||= []).push(r), m), {});
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const f0 = (x) => Math.round(x).toLocaleString("en-US");
const f1 = (x) => x.toFixed(1);
const usd = (x) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
const rate = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "–");
const label = (r) => `${r.adapter} (${r.sdk} ${r.sdk_version})`;
const out = [];
const p = (s = "") => out.push(s);

const dates = [...new Set(rows.map((r) => r.date))].sort();
const models = [...new Set(rows.map((r) => r.model))];
p(`# Bench results`);
p();
p(`Runs dated ${dates.join(", ") || "–"} · model ${models.join(", ") || "–"} · ${rows.length} task runs. Every pass/fail is a deterministic check; no model judge.`);
p();

// 1. parity
const parity = rows.filter((r) => ["act", "extract", "observe"].includes(r.set) && r.phase === "single");
if (parity.length) {
  p(`## Parity (act, extract, observe; one run per task)`);
  p();
  p(`| SDK | act | extract | observe | all | tokens in / task | tokens out / task | model calls / task | $ / task | p50 s | p95 s |`);
  p(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const [k, rs] of Object.entries(by(parity, label))) {
    const s = (set) => {
      const x = rs.filter((r) => r.set === set);
      return rate(x.filter((r) => r.pass).length, x.length);
    };
    const w = rs.map((r) => r.wall_ms / 1000);
    p(`| ${k} | ${s("act")} | ${s("extract")} | ${s("observe")} | ${rate(rs.filter((r) => r.pass).length, rs.length)} | ${f0(mean(rs.map((r) => r.in_tok)))} | ${f0(mean(rs.map((r) => r.out_tok)))} | ${f1(mean(rs.map((r) => r.calls)))} | ${usd(mean(rs.map((r) => r.usd)))} | ${f1(pct(w, 50))} | ${f1(pct(w, 95))} |`);
  }
  p();
  p(`Tokens per model call: ${Object.entries(by(parity, label)).map(([k, rs]) => `${k}: ${f0(sum(rs.map((r) => r.in_tok)) / Math.max(1, sum(rs.map((r) => r.calls))))} in`).join(" · ")}`);
  p();
}

// 2. repeat runs
const rep = rows.filter((r) => r.set === "flow" && /^run\d+$/.test(r.phase));
if (rep.length) {
  p(`## Repeat runs (20 flows, 10 runs each)`);
  p();
  p(`| SDK | pass, all runs | pass, run 1 | pass, runs 2-10 | model calls, run 1 (per flow) | model calls, runs 2-10 (per run) | runs 2-10 with 0 calls | $ run 1 (per flow) | $ runs 2-10 (per run) | s run 1 | s runs 2-10 |`);
  p(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const [k, rs] of Object.entries(by(rep, label))) {
    const r1 = rs.filter((r) => r.run === 1), rn = rs.filter((r) => r.run > 1);
    p(`| ${k} | ${rate(rs.filter((r) => r.pass).length, rs.length)} | ${rate(r1.filter((r) => r.pass).length, r1.length)} | ${rate(rn.filter((r) => r.pass).length, rn.length)} | ${f1(mean(r1.map((r) => r.calls)))} | ${f1(mean(rn.map((r) => r.calls)))} | ${rate(rn.filter((r) => r.calls === 0).length, rn.length)} | ${usd(mean(r1.map((r) => r.usd)))} | ${usd(mean(rn.map((r) => r.usd)))} | ${f1(mean(r1.map((r) => r.wall_ms / 1000)))} | ${f1(mean(rn.map((r) => r.wall_ms / 1000)))} |`);
  }
  p();
  p(`Total model calls on runs 2-10: ${Object.entries(by(rep, label)).map(([k, rs]) => `${k}: ${f0(sum(rs.filter((r) => r.run > 1).map((r) => r.calls)))}`).join(" · ")}`);
  p();
}

// 3. drift
const drift = rows.filter((r) => r.set === "flow" && (r.phase === "learn" || r.phase === "drift"));
if (drift.length) {
  p(`## Drift (learn on the original pages, then run on changed pages)`);
  p();
  p(`Repair rate = flows that pass on the changed pages, out of those that passed on the originals. False success = the SDK reported every step as done but the check failed.`);
  p();
  p(`| SDK | pass, originals | pass, changed pages | repair rate | false successes (changed) | model calls / changed run |`);
  p(`|---|---|---|---|---|---|`);
  for (const [k, rs] of Object.entries(by(drift, label))) {
    const learn = rs.filter((r) => r.phase === "learn"), dr = rs.filter((r) => r.phase === "drift");
    const learnedOk = new Set(learn.filter((r) => r.pass).map((r) => r.task));
    const eligible = dr.filter((r) => learnedOk.has(r.task));
    p(`| ${k} | ${rate(learn.filter((r) => r.pass).length, learn.length)} | ${rate(dr.filter((r) => r.pass).length, dr.length)} | ${rate(eligible.filter((r) => r.pass).length, eligible.length)} | ${rate(dr.filter((r) => r.false_success).length, dr.length)} | ${f1(mean(dr.map((r) => r.calls)))} |`);
  }
  p();
}

// 4. secrets
const sec = rows.filter((r) => r.set === "secrets");
if (sec.length) {
  p(`## Secrets`);
  p();
  p(`| SDK | leaks (attack tasks) | control: secret typed on its own origin | canary in model requests | canary in store files | canary in logs |`);
  p(`|---|---|---|---|---|---|`);
  for (const [k, rs] of Object.entries(by(sec, label))) {
    const atk = rs.filter((r) => !r.control), ctl = rs.filter((r) => r.control);
    p(`| ${k} | ${rate(atk.filter((r) => r.leak).length, atk.length)} | ${rate(ctl.filter((r) => r.pass).length, ctl.length)} | ${sum(rs.map((r) => r.canary_in_model_requests))} | ${sum(rs.map((r) => r.canary_in_store))} | ${sum(rs.map((r) => r.canary_in_logs))} |`);
  }
  p();
  for (const [k, rs] of Object.entries(by(sec, label))) p(`- ${k}: ${rs.map((r) => `${r.task} ${r.pass ? "ok" : "FAIL"}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}`);
  p();
}

// 5. bot walls
const bw = rows.filter((r) => r.set === "botwall");
if (bw.length) {
  p(`## Bot walls (one attempt per site, read-only)`);
  p();
  p(`| SDK | blocked | read the page | protected sites blocked |`);
  p(`|---|---|---|---|`);
  for (const [k, rs] of Object.entries(by(bw, label))) {
    const prot = rs.filter((r) => !/^b-(github|hn|wikipedia|books|quotes)/.test(r.task));
    p(`| ${k} | ${rate(rs.filter((r) => r.blocked).length, rs.length)} | ${rate(rs.filter((r) => r.pass).length, rs.length)} | ${rate(prot.filter((r) => r.blocked).length, prot.length)} |`);
  }
  p();
  const sites = [...new Set(bw.map((r) => r.task))];
  const specs = Object.keys(by(bw, label));
  p(`| site | ${specs.join(" | ")} |`);
  p(`|---|${specs.map(() => "---").join("|")}|`);
  for (const s of sites)
    p(`| ${s.replace(/^b-/, "")} | ${specs.map((k) => {
      const r = bw.find((x) => x.task === s && label(x) === k);
      return r ? (r.blocked ? `blocked (${(r.block_reason || "").slice(0, 40)})` : r.pass ? "read" : `not read`) : "–";
    }).join(" | ")} |`);
  p();
}

// provider-side failures (rate limits, outages): counted as failures above, listed here
const infra = rows.filter((r) => r.infra);
if (infra.length) {
  p(`Provider-side failures (model HTTP 429/5xx after retries), included as failures above: ${Object.entries(by(infra, label)).map(([k, rs]) => `${k}: ${rs.length}`).join(" · ")}`);
  p();
}

// spend
p(`## Spend`);
p();
for (const [k, rs] of Object.entries(by(rows, label))) p(`- ${k}: ${usd(sum(rs.map((r) => r.usd)))} over ${rs.length} task runs, ${f0(sum(rs.map((r) => r.calls)))} model calls`);
p();

// failures
const fails = rows.filter((r) => !r.pass && r.set !== "botwall");
if (fails.length) {
  p(`## Failures`);
  p();
  p(`| SDK | set | task | run | reason |`);
  p(`|---|---|---|---|---|`);
  for (const r of fails) p(`| ${r.adapter} | ${r.set} | ${r.task} | ${r.phase} | ${(r.reason || "").replace(/\|/g, "/").slice(0, 160)} |`);
  p();
}
console.log(out.join("\n"));
