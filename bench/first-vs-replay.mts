// First run vs replays: how long a flow takes, and how many model calls it makes, when it is recorded
// (run 1: the model reads each page) and when it is replayed (runs 2-5: the saved recipe runs).
//
//   OPENROUTER_API_KEY=... npx tsx bench/first-vs-replay.mts [--trials 3] [--model openrouter/google/gemini-3.1-flash-lite]
//
// The key may also come from a file: GHOSTWRIGHT_BENCH_KEY_FILE=~/.config/... (read here, never printed).
// Writes bench/results/first-vs-replay-<date>.json; `npx tsx bench/render-chart.mts` turns it into the
// README chart (assets/speed-dark.svg, assets/speed-light.svg) and prints the table.
//
// - Run 1 records the flow with the model and saves it. Runs 2-5 call run() on it with the same inputs and
//   default options (repair on): a step that broke would be repaired with the model, and counted.
//   --new-params replays with four other inputs instead (another category, tag or book).
// - A run passes only when every act() of the recording returned ok and the output is what the flow asks
//   for (books with prices, quotes with authors, the "logged into a secure area" message).
// - Every trial records each flow again under a new name, so no run reuses an earlier recording.
// - Times are wall clock from the first call of the run to its result, in one browser that is already
//   open (its start is counted in neither column), over the public internet to the sites below.
// - Cost is what usage() reports: the token counts the provider returned, at the SDK's price table.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Ghostwright, local, secret, type Flow } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const TRIALS = Number(arg("trials", "3"));
const MODEL = arg("model", "openrouter/google/gemini-3.1-flash-lite");
const MAX_USD = Number(arg("max-usd", "1"));
const NEW_PARAMS = process.argv.includes("--new-params");

function modelKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const file = process.env.GHOSTWRIGHT_BENCH_KEY_FILE;
  if (file) return readFileSync(file.replace(/^~/, homedir()), "utf8").trim();
  throw new Error("set OPENROUTER_API_KEY, or GHOSTWRIGHT_BENCH_KEY_FILE to a file that holds it");
}

/** act() that must have worked: a recording with a failed step is a failed run. */
async function must(flow: Flow, instruction: string) {
  const r = await flow.act(instruction);
  if (!r.ok) throw new Error(`act "${instruction}" was not ok: ${r.reason ?? r.result}`);
}

interface Bench {
  id: string;
  site: string;
  what: string;
  /** params[0] records; replays use params[0] again, or params[1..4] with --new-params */
  params: Record<string, string>[];
  record: (flow: Flow) => Promise<unknown>;
  valid: (out: any) => boolean;
}

const books = z.object({ books: z.array(z.object({ title: z.string(), price: z.number() })) });
const quotes = z.object({ quotes: z.array(z.object({ text: z.string(), author: z.string() })) });
const detail = z.object({ price: z.number(), inStock: z.boolean() });
const message = z.object({ message: z.string() });

const BENCHES: Bench[] = [
  {
    id: "books-category",
    site: "books.toscrape.com",
    what: "open a category, read every book with its price",
    params: ["Travel", "Poetry", "Mystery", "Humor", "Classics"].map(category => ({ category })),
    async record(flow) {
      await flow.goto("https://books.toscrape.com/");
      await must(flow, "open the %category% category");
      return (await flow.extract("every book with its price", books)).data;
    },
    valid: o => o?.books?.length > 0 && o.books.every((b: any) => b.title && b.price > 0),
  },
  {
    id: "books-detail",
    site: "books.toscrape.com",
    what: "open a book from the front page, read its price and whether it is in stock",
    params: ["Tipping the Velvet", "Soumission", "Sharp Objects", "The Requiem Red", "Olio"].map(title => ({ title })),
    async record(flow) {
      await flow.goto("https://books.toscrape.com/");
      await must(flow, "open the book %title%");
      return (await flow.extract("the book's price and whether it is in stock", detail)).data;
    },
    valid: o => o?.price > 0 && typeof o.inStock === "boolean",
  },
  {
    id: "quotes-tag",
    site: "quotes.toscrape.com",
    what: "open a tag, read every quote with its author",
    params: ["love", "inspirational", "life", "humor", "books"].map(tag => ({ tag })),
    async record(flow) {
      await flow.goto("https://quotes.toscrape.com/");
      await must(flow, "click the %tag% tag");
      return (await flow.extract("every quote with its author", quotes)).data;
    },
    valid: o => o?.quotes?.length > 0 && o.quotes.every((q: any) => q.text && q.author),
  },
  {
    id: "login",
    site: "the-internet.herokuapp.com",
    what: "sign in with the site's public demo account, read the message",
    params: [{}, {}, {}, {}, {}],
    async record(flow) {
      await flow.goto("https://the-internet.herokuapp.com/login");
      await must(flow, "type %username% into the username field");
      await must(flow, "type %password% into the password field");
      await must(flow, "click the Login button");
      return (await flow.extract("the message shown at the top of the page", message)).data;
    },
    valid: o => /logged into a secure area/i.test(o?.message ?? ""),
  },
];

interface RunRow {
  flow: string; trial: number; run: number; kind: "record" | "replay";
  params: Record<string, string>; ok: boolean; ms: number; repaired: string[];
  modelCalls: number; inputTokens: number; outputTokens: number; usd: number; error?: string;
}

// the site prints this demo account on its own login page
const demo = ["the-internet.herokuapp.com"];
const gw = await Ghostwright.create({
  browser: local({ headless: true }),
  model: MODEL,
  modelApiKey: modelKey(),
  maxCostUsd: MAX_USD,
  store: mkdtempSync(join(tmpdir(), "gw-bench-")),
  warnings: false,
  secrets: { username: secret(() => "tomsmith", { origins: demo }), password: secret(() => "SuperSecretPassword!", { origins: demo }) },
});

const rows: RunRow[] = [];
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const log = (r: RunRow) => console.log(
  `${pad(r.flow, 15)} trial ${r.trial}  run ${r.run}  ${pad(r.kind, 7)} ${pad(`${r.modelCalls} model calls`, 15)} ${pad(`$${r.usd.toFixed(5)}`, 9)} ${(r.ms / 1000).toFixed(1).padStart(5)} s  ${r.ok ? "ok" : `FAILED ${r.error ?? "unexpected output"}`}${r.repaired.length ? `  repaired ${r.repaired.join(",")}` : ""}`,
);
const errText = (e: any) => `${e?.code ?? e?.name}: ${e?.message}`.slice(0, 240);

try {
  for (let trial = 1; trial <= TRIALS; trial++) {
    for (const b of BENCHES) {
      const name = `${b.id}-t${trial}`;
      const u0 = gw.usage();
      const t0 = performance.now();
      let out: unknown, error: string | undefined;
      try {
        const flow = await gw.flow(name, { params: b.params[0] });
        try { out = await b.record(flow); await flow.save(); } catch (e) { flow.discard(); throw e; }
      } catch (e) { error = errText(e); }
      const u1 = gw.usage();
      const rec: RunRow = {
        flow: b.id, trial, run: 1, kind: "record", params: b.params[0], ok: !error && b.valid(out), ms: Math.round(performance.now() - t0), repaired: [],
        modelCalls: u1.modelCalls - u0.modelCalls, inputTokens: u1.inputTokens - u0.inputTokens, outputTokens: u1.outputTokens - u0.outputTokens, usd: u1.usd - u0.usd, error,
      };
      rows.push(rec); log(rec);
      if (error) continue;
      for (let run = 2; run <= 5; run++) {
        const params = NEW_PARAMS ? b.params[run - 1] : b.params[0];
        const v0 = gw.usage();
        const s0 = performance.now();
        let output: unknown, err: string | undefined, repaired: string[] = [];
        try {
          const r = await gw.run(name, params);
          output = r.output; repaired = r.repaired ?? [];
        } catch (e) { err = errText(e); }
        const v1 = gw.usage();
        const row: RunRow = {
          flow: b.id, trial, run, kind: "replay", params, ok: !err && b.valid(output), ms: Math.round(performance.now() - s0), repaired,
          modelCalls: v1.modelCalls - v0.modelCalls, inputTokens: v1.inputTokens - v0.inputTokens, outputTokens: v1.outputTokens - v0.outputTokens, usd: v1.usd - v0.usd, error: err,
        };
        rows.push(row); log(row);
      }
    }
  }
} finally {
  await gw.close();
}

const date = new Date().toISOString().slice(0, 10);
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const result = {
  date,
  ghostwright: pkg.version,
  model: MODEL,
  trials: TRIALS,
  replayInputs: NEW_PARAMS ? "new" : "same",
  machine: { cpu: cpus()[0]?.model, os: `${platform()} ${release()}`, node: process.version, browser: "local Chrome, headless" },
  flows: BENCHES.map(b => ({ id: b.id, site: b.site, what: b.what })),
  totals: { runs: rows.length, ok: rows.filter(r => r.ok).length, usd: rows.reduce((a, r) => a + r.usd, 0), modelCalls: rows.reduce((a, r) => a + r.modelCalls, 0) },
  runs: rows,
};
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `first-vs-replay-${date}${NEW_PARAMS ? "-new-params" : ""}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.log(`\n${result.totals.ok}/${rows.length} runs ok, ${result.totals.modelCalls} model calls, $${result.totals.usd.toFixed(4)} in all`);
console.log(`wrote ${file}`);
