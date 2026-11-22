// Every action type do() takes, once each, on local Chrome, with the effect
// checked on the page itself.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ghostwright } from "../../src/index.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
let gw: Ghostwright;
beforeAll(async () => { fx = await startFixtures(); gw = await open({ store: tempStore() }); });
afterAll(async () => { await gw?.close(); await fx?.close(); });
beforeEach(async () => { await gw.goto(`${fx.url}/v02-actions.html`); });

const status = () => gw.page.textContent("#status");
const ok = async (p: Promise<{ ok: boolean; reason?: string }>) => { const r = await p; expect(r.ok, r.reason).toBe(true); };

describe("every action type", () => {
  it("click, double click, right click", async () => {
    await ok(gw.do({ action: "click", role: "button", name: "Press me" }));
    expect(await status()).toBe("CLICKED");
    await ok(gw.do({ action: "click", role: "button", name: "Press me", double: true }));
    expect(await status()).toBe("DOUBLE");
    await ok(gw.do({ action: "click", role: "button", name: "Press me", right: true }));
    expect(await status()).toBe("RIGHT");
  });

  it("click at a point", async () => {
    const box = await gw.page.locator("#b").boundingBox();
    await ok(gw.do({ action: "click", x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }));
    expect(await status()).toBe("CLICKED");
  });

  it("type, type without clearing, press", async () => {
    await ok(gw.do({ action: "type", role: "textbox", name: "Note", text: "milk" }));
    expect(await status()).toBe("NOTE milk");
    await ok(gw.do({ action: "type", role: "textbox", name: "Note", text: " and eggs", clear: false }));
    expect(await gw.page.inputValue("#note")).toBe("milk and eggs");
    await ok(gw.do({ action: "type", role: "textbox", name: "Note", text: "bread", clear: true }));
    expect(await gw.page.inputValue("#note")).toBe("bread");
    await ok(gw.do({ action: "press", keys: "Escape" }));
    expect(await status()).toBe("ESCAPED");
  });

  it("select", async () => {
    await ok(gw.do({ action: "select", role: "combobox", name: "Size", option: "Large" }));
    expect(await status()).toBe("SIZE l");
    const bad = await gw.do({ action: "select", role: "combobox", name: "Size", option: "Huge" });
    expect(bad.ok).toBe(false);
  });

  it("check and uncheck (and neither clicks a box already in that state)", async () => {
    await ok(gw.do({ action: "check", role: "checkbox", name: "I agree" }));
    expect(await status()).toBe("AGREE true");
    await ok(gw.do({ action: "check", role: "checkbox", name: "I agree" }));
    expect(await gw.page.isChecked("#agree")).toBe(true);
    await ok(gw.do({ action: "uncheck", role: "checkbox", name: "I agree" }));
    expect(await status()).toBe("AGREE false");
  });

  it("hover", async () => {
    const v = await gw.observe();
    const el = v.elements.find(e => e.name === "Hover target")!;
    await ok(gw.do({ action: "hover", id: el.id }));
    expect(await status()).toBe("HOVERED");
  });

  it("scroll by pixels, to an element, to the bottom and back", async () => {
    await ok(gw.do({ action: "scroll", dy: 400 }));
    expect(await gw.page.evaluate("scrollY")).toBeGreaterThan(300);
    await ok(gw.do({ action: "scroll", to: "bottom" }));
    expect(await gw.page.evaluate("Math.round(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2")).toBe(true);
    await ok(gw.do({ action: "scroll", to: "top" }));
    expect(await gw.page.evaluate("scrollY")).toBe(0);
  });

  it("navigate, back, forward, reload", async () => {
    await ok(gw.do({ action: "navigate", url: `${fx.url}/v02-free.html` }));
    expect(gw.page.url()).toBe(`${fx.url}/v02-free.html`);
    await ok(gw.do({ action: "back" }));
    expect(gw.page.url()).toBe(`${fx.url}/v02-actions.html`);
    await ok(gw.do({ action: "forward" }));
    expect(gw.page.url()).toBe(`${fx.url}/v02-free.html`);
    await ok(gw.do({ action: "click", role: "button", name: "Save" }));
    expect(await status()).toBe("SAVED");
    await ok(gw.do({ action: "reload" }));
    expect(await status()).toBe("Nothing done");
  });

  it("a link click navigates", async () => {
    await ok(gw.do({ action: "click", role: "link", name: "Next page" }));
    expect(gw.page.url()).toBe(`${fx.url}/v02-free.html`);
  });

  it("wait for a time and for text", async () => {
    // its effect comes 700 ms later, after the page went quiet: the click itself has nothing to show yet
    expect((await gw.do({ action: "click", role: "button", name: "Slow thing" })).ok).toBe(false);
    await ok(gw.do({ action: "wait", for: "text", text: "ARRIVED", timeout: 5000 }));
    expect(await status()).toBe("ARRIVED");
    const t0 = Date.now();
    await ok(gw.do({ action: "wait", ms: 300 }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    const never = await gw.do({ action: "wait", for: "text", text: "NEVER SHOWN", timeout: 600 });
    expect(never.ok).toBe(false);
  });

  it("upload", async () => {
    const file = join(tempStore(), "receipt.txt");
    writeFileSync(file, "hello");
    const v = await gw.observe();
    const input = v.elements.find(e => e.name === "Attachment")!;
    await ok(gw.do({ action: "upload", id: input.id, files: [file] }));
    expect(await status()).toBe("FILE receipt.txt");
  });

  it("dialog: accept and dismiss", async () => {
    await gw.do({ action: "click", role: "button", name: "Ask me" });
    await ok(gw.do({ action: "dialog", accept: true }));
    expect(await status()).toBe("YES");
    await gw.do({ action: "click", role: "button", name: "Ask me" });
    await ok(gw.do({ action: "dialog", accept: false }));
    expect(await status()).toBe("NO");
    expect((await gw.do({ action: "dialog", accept: true })).ok).toBe(false); // none open
  });

  it("an unknown action and a missing element fail with a reason", async () => {
    const a = await gw.do({ action: "teleport" } as any);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/unknown action/);
    const b = await gw.do({ action: "click", role: "button", name: "Not on this page" });
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/no element with role/);
  });
});
