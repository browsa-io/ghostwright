// Example 3: record a flow once with a model, then replay it with 0 model calls.
//   OPENAI_API_KEY=... npx tsx examples/replay.ts
import { z } from "zod";
import { Ghostwright } from "../src/index.js";

const gw = await Ghostwright.create({ model: process.env.GHOSTWRIGHT_MODEL ?? "openai/gpt-5.6-luna" });
try {
  // first time: the model reads the page and picks elements
  const flow = await gw.flow("travel-books", { params: { category: "Travel" } });
  await flow.goto("https://books.toscrape.com/");
  await flow.act("open the %category% category");
  const first = await flow.extract("every book title", z.object({ titles: z.array(z.object({ title: z.string() })) }));
  await flow.save(); // .ghostwright/flows/travel-books.json
  console.log(`recorded: ${first.data.titles.length} titles, extract compiled to "${first.meta.layer}", ${gw.usage().modelCalls} model calls`);

  // every later time: no model at all
  const run = await gw.run("travel-books", { category: "Travel" });
  console.log(`replayed: ${run.output.titles.length} titles, ${run.meta.modelCalls} model calls, ${run.meta.ms} ms`);
} finally {
  await gw.close();
}
