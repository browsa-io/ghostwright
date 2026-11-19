// Manual probe: what a model extracts on a public list page, and whether it compiles.
// npx tsx test/probe-compile.ts   (GOOGLE_GENERATIVE_AI_API_KEY set)
import { z } from "zod";
import { Ghostwright, local } from "../src/index.js";

const gw = await Ghostwright.create({ browser: local(), model: process.env.MODEL || "google/gemini-3.1-flash-lite", store: "node_modules/.gw-probe" });
try {
  await gw.goto("https://books.toscrape.com/catalogue/category/books/travel_2/index.html");
  const page: string[] = await gw.page.evaluate(() => Array.from(document.querySelectorAll("article.product_pod h3 a")).map(a => a.getAttribute("title")!));
  const flow = await gw.flow("probe");
  const ex = await flow.extract("every book title", z.object({ titles: z.array(z.object({ title: z.string() })) }));
  console.log("layer", ex.meta.layer);
  ex.data.titles.forEach((t: { title: string }, i: number) => { if (t.title !== page[i]) console.log("diff", JSON.stringify(t.title), JSON.stringify(page[i])); });
  console.log("count", ex.data.titles.length, page.length);
  flow.discard();
} finally { await gw.close(); }
