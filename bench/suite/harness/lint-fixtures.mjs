#!/usr/bin/env node
// Loads every fixture page (v1 and v2) in Chrome and reports script errors and inline
// handlers that do not compile. No model, no cost. Run after editing tasks/*.mjs.
import { launchChrome } from "./chrome.mjs";
import { startFixtureServer } from "./fixtures.mjs";
import { listPages, openSession } from "./cdp.mjs";
import { allPages } from "../tasks/index.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const pages = allPages();
const fx = await startFixtureServer(pages);
const chrome = await launchChrome();
const [target] = await listPages(chrome.cdpUrl);
const s = await openSession(target.webSocketDebuggerUrl);
await s.send("Page.enable");
await s.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
let bad = 0;
const HANDLERS = `(() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { for (const a of el.attributes) if (a.name.startsWith('on')) { try { new Function(a.value) } catch (e) { out.push(el.tagName + ' ' + a.name + ': ' + e.message) } } if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; })()`;
for (const variant of ["v1", "v2"]) {
  fx.state.variant = variant;
  for (const p of pages.keys()) {
    fx.state.events = [];
    await s.send("Page.navigate", { url: fx.O + p });
    await sleep(350);
    const r = await s.send("Runtime.evaluate", { expression: HANDLERS, returnByValue: true });
    const errs = fx.state.events.filter((e) => e.type === "jserror").map((e) => e.msg);
    const hand = r.result?.value || [];
    if (errs.length || hand.length) {
      bad++;
      console.log(`${variant} ${p}\n  ${[...errs, ...hand].join("\n  ")}`);
    }
  }
}
console.log(`${pages.size} pages × 2 variants checked, ${bad} with problems`);
s.close();
await chrome.close();
await fx.close();
process.exit(bad ? 1 : 0);
