// Read a list off a page into a schema, and see what it cost.
//
//   OPENAI_API_KEY=sk-... node examples/extract-list.mjs
//
// The schema is JSON Schema here; a zod schema works the same way.
import { fileURLToPath } from "node:url";
import { Ghostwright } from "ghostwright";

const Books = {
  type: "object",
  properties: { books: { type: "array", items: { type: "object", properties: { title: { type: "string" }, price: { type: "number" } }, required: ["title", "price"] } } },
  required: ["books"],
};

export async function main(o = {}) {
  const gw = await Ghostwright.create({ model: process.env.GHOSTWRIGHT_MODEL || "openai/gpt-5.6-luna", ...o.options });
  try {
    await gw.goto(o.url ?? "https://books.toscrape.com/catalogue/category/books/travel_2/index.html");
    const { data, meta } = await gw.extract(o.what ?? "every book on the page with its price", o.schema ?? Books);
    console.log(JSON.stringify(data, null, 2).slice(0, 600));
    console.log(`${meta.modelCalls} model call, ${meta.inputTokens} tokens in, ${meta.outputTokens} out, $${meta.usd.toFixed(5)}`);
    return data;
  } finally {
    await gw.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
