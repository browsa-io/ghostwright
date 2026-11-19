// Manual probe: prints the view and a few actions on one fixture page.
// npx tsx test/probe.ts frames.html
import { local } from "../src/browser.js";
import { PageSession } from "../src/engine/session.js";
import { startFixtures } from "./server.js";

const fx = await startFixtures();
const b = await local().open();
const s = await PageSession.attach(b.page);
const page = process.argv[2] || "login.html";
const r = await s.act({ action: "navigate", url: `${fx.url}/${page}` });
console.log(r.text);
const v = await s.observe({});
console.log("----\n" + v.text);
if (page === "frames.html") {
  for (const t of v.elements.filter(e => e.role === "textbox")) console.log((await s.act({ action: "type", id: t.id, text: "Ada " + t.id })).text);
  const btn = v.elements.find(e => e.name === "Use this card")!;
  console.log((await s.act({ action: "click", id: btn.id })).text);
  console.log(await s.locators(btn.id));
}
if (page === "shadow.html") {
  const like = v.elements.find(e => e.name === "Like this page");
  if (like) console.log((await s.act({ action: "click", id: like.id })).text);
  const sub = v.elements.find(e => e.name === "Join the list")!;
  console.log(await s.locators(sub.id));
}
await b.close();
await fx.close();
