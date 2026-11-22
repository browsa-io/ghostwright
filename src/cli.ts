#!/usr/bin/env node
// ghostwright list | run <flow> [k=v ...] | rollback <flow> [version] | view <url> | extract | init
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { Ghostwright } from "./ghostwright.js";
import { local } from "./browser.js";
import { Store } from "./store.js";

const HELP = `ghostwright: browser flows that replay without a model

  ghostwright list                          saved flows in .ghostwright
  ghostwright run <flow> [key=value ...]    replay a flow (no model: a broken step fails)
  ghostwright rollback <flow> [version]     make an earlier version the active one
  ghostwright view <url>                    print the page view a model reads (no model, no key)
  ghostwright init [file]                   write a quickstart script (default quickstart.mjs) to run with node
  ghostwright extract <url|file> "<what>"   read data off a page as JSON, with usage (needs --model or GHOSTWRIGHT_MODEL)
                                            --schema <file.json> for a JSON Schema of the answer

Options: --store <dir> (default .ghostwright), --headed, --model <provider/model> (repairs), --version`;

const version = (): string => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "unknown"; } };

async function main(argv: string[]): Promise<number> {
  const opts: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") opts.headed = true;
    else if (a === "--store" || a === "--model" || a === "--schema") opts[a.slice(2)] = argv[++i];
    else if (a === "-h" || a === "--help") { console.log(HELP); return 0; }
    else if (a === "-v" || a === "--version") { console.log(version()); return 0; }
    else args.push(a);
  }
  const store = String(opts.store || ".ghostwright");
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "list": {
      const flows = new Store(store).list();
      if (!flows.length) console.log(`no flows in ${store}`);
      for (const f of flows) console.log(`${f.name}  v${f.version}  ${f.steps} steps`);
      return 0;
    }
    case "rollback": {
      if (!rest[0]) break;
      const r = new Store(store).rollback(rest[0], rest[1] ? Number(rest[1]) : undefined);
      console.log(`${r.name} is now v${r.version}`);
      return 0;
    }
    case "run": {
      if (!rest[0]) break;
      const params = Object.fromEntries(rest.slice(1).map(kv => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      const gw = await Ghostwright.create({ browser: local({ headless: !opts.headed }), store, model: opts.model ? String(opts.model) : undefined });
      try {
        const r = await gw.run(rest[0], params);
        console.log(JSON.stringify(r.output, null, 2));
        console.error(`v${r.version}  ${r.steps.length} steps  ${r.meta.modelCalls} model calls  ${r.meta.ms} ms${r.promoted ? `  repaired: ${r.repaired.join(", ")} -> v${r.promoted}` : ""}`);
      } finally { await gw.close(); }
      return 0;
    }
    case "extract": {
      const [target, what] = rest;
      if (!target || !what) break;
      const model = opts.model ? String(opts.model) : process.env.GHOSTWRIGHT_MODEL;
      if (!model) { console.error("extract needs a model: --model provider/model or GHOSTWRIGHT_MODEL"); return 1; }
      const schema = opts.schema ? JSON.parse(readFileSync(String(opts.schema), "utf8")) : { type: "object" };
      const gw = await Ghostwright.create({ browser: local({ headless: !opts.headed }), store, model });
      try {
        const file = !/^[a-z]+:\/\//i.test(target) && existsSync(target);
        if (!file) await gw.goto(target);
        const r = await gw.extract(what, schema, file ? { file: target } : {});
        console.log(JSON.stringify(r.data, null, 2));
        const u = r.meta;
        console.error(`${u.modelCalls} model call${u.modelCalls === 1 ? "" : "s"}, ${u.inputTokens} tokens in, ${u.outputTokens} out, $${u.usd.toFixed(5)}${gw.usage().usdAssumed ? " (assumed price)" : ""}, ${u.ms} ms`);
      } finally { await gw.close(); }
      return 0;
    }
    case "init": {
      const file = rest[0] || "quickstart.mjs";
      if (existsSync(file)) { console.error(`${file} is already there; nothing was written`); return 1; }
      copyFileSync(new URL("../examples/quickstart.mjs", import.meta.url), file);
      console.log(`wrote ${file}\n\nRun it with a model key (it records a flow with the model, then replays it with none):\n  OPENAI_API_KEY=sk-... node ${file}\nAnother provider: GHOSTWRIGHT_MODEL=google/gemini-3.1-flash-lite with GEMINI_API_KEY, anthropic/... with ANTHROPIC_API_KEY, openrouter/... with OPENROUTER_API_KEY.\nNo key yet? This needs none:\n  npx ghostwright view https://books.toscrape.com`);
      return 0;
    }
    case "view": {
      if (!rest[0]) break;
      const gw = await Ghostwright.create({ browser: local({ headless: !opts.headed }), store });
      try {
        await gw.goto(rest[0]);
        console.log((await gw.observe()).view);
      } finally { await gw.close(); }
      return 0;
    }
  }
  console.log(HELP);
  return cmd ? 1 : 0;
}

main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(String(e?.message || e)); process.exit(1); });
