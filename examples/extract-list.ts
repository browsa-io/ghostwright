// Example 1: read a list off a page into a typed schema.
//   OPENAI_API_KEY=... npx tsx examples/extract-list.ts
// Any model works: GHOSTWRIGHT_MODEL=google/gemini-3.1-flash-lite, openrouter/..., deepseek/...
import { z } from "zod";
import { Ghostwright } from "../src/index.js";

const Books = z.object({
  books: z.array(z.object({ title: z.string(), price: z.number(), inStock: z.boolean() })),
});

const gw = await Ghostwright.create({ model: process.env.GHOSTWRIGHT_MODEL ?? "openai/gpt-5.6-luna" });
try {
  await gw.goto("https://books.toscrape.com/catalogue/category/books/travel_2/index.html");
  const { data, meta } = await gw.extract("every book on the page with its price and whether it is in stock", Books);
  console.log(data.books.slice(0, 5));
  console.log(`${data.books.length} books, ${meta.modelCalls} model call, ${meta.inputTokens} tokens in, $${meta.usd}`);
} finally {
  await gw.close();
}
