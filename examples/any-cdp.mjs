// Attach to a browser that is already running (any CDP endpoint) and act in it
// with no model: observe() lists what is on the page, do() runs an action you
// spell out.
//
//   1. start a browser with a debugging port, for example
//      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/gw-demo
//   2. CDP_URL=http://127.0.0.1:9222 node examples/any-cdp.mjs https://books.toscrape.com
//
// The same call takes a ws:// address from a remote browser service. For a
// browser this script starts itself, leave `browser` out (local Chrome), and
// for Browsa cloud browsers use browsa() (BROWSA_API_KEY).
import { fileURLToPath } from "node:url";
import { Ghostwright, cdp } from "ghostwright";

export async function main(o = {}) {
  const endpoint = o.cdpUrl ?? process.env.CDP_URL;
  if (!endpoint) throw new Error("set CDP_URL to the browser's address (http://127.0.0.1:9222 or the ws:// address it prints)");
  const gw = await Ghostwright.create({ browser: cdp(endpoint), ...o.options });
  try {
    const url = o.url ?? process.argv[2];
    if (url) await gw.goto(url);
    await gw.waitForReady({ timeoutMs: 10000 });
    const { view, elements } = await gw.observe();
    console.log(view.split("\n").slice(0, 25).join("\n"));
    const link = elements.find(e => e.role === "link" && e.name === (o.click ?? "Travel"));
    if (link) {
      const r = await gw.do({ action: "click", id: link.id });
      console.log(r.ok ? `clicked "${link.name}": now at ${gw.page.url()}` : `click failed: ${r.reason}`);
    }
    return { url: gw.page.url(), elements: elements.length, modelCalls: gw.usage().modelCalls };
  } finally {
    await gw.close(); // detaches; the browser keeps running
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
