// Record a flow once with a model, then replay it with 0 model calls.
//
//   OPENAI_API_KEY=sk-... node quickstart.mjs
//
// Another provider: GHOSTWRIGHT_MODEL=google/gemini-3.1-flash-lite (GEMINI_API_KEY),
// anthropic/... (ANTHROPIC_API_KEY), openrouter/... (OPENROUTER_API_KEY), deepseek/... (DEEPSEEK_API_KEY).
// It drives the Chrome installed on this machine; nothing is downloaded.
import { fileURLToPath } from "node:url";
import { Ghostwright } from "ghostwright";

const Titles = { type: "object", properties: { titles: { type: "array", items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } }, required: ["titles"] };

export async function main(o = {}) {
  const gw = await Ghostwright.create({ model: process.env.GHOSTWRIGHT_MODEL || "openai/gpt-5.6-luna", ...o.options });
  try {
    // run 1: the model reads the page and picks the link
    const flow = await gw.flow("books", { params: { category: "Travel" } });
    await flow.goto(o.url ?? "https://books.toscrape.com/");
    await flow.act("open the %category% category");
    const first = await flow.extract("every book title", Titles);
    await flow.save(); // .ghostwright/flows/books.json
    console.log(`recorded: ${first.data.titles.length} titles with ${gw.usage().modelCalls} model calls`);

    // every later run: another category, no model
    const run = await gw.run("books", { category: o.other ?? "Poetry" });
    console.log(`replayed: ${run.output.titles.length} titles with ${run.meta.modelCalls} model calls in ${run.meta.ms} ms`);
    for (const t of run.output.titles.slice(0, 5)) console.log("  " + t.title);
    return { recorded: first.data, replayed: run.output, replayCalls: run.meta.modelCalls };
  } finally {
    await gw.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
