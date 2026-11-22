// 0.2 purchase guard precision, both ways, in a real browser: ordinary buttons
// are never refused where no money is in play, and real purchases are never
// let through where it is.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ghostwright } from "../../src/index.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
let gw: Ghostwright;
beforeAll(async () => { fx = await startFixtures(); gw = await open({ store: tempStore() }); });
afterAll(async () => { await gw?.close(); await fx?.close(); });

const status = () => gw.page.textContent("#status");
const click = (name: string, role = "button") => gw.do({ action: "click", role, name });

describe("no false blocks: a page where nothing is paid", () => {
  it("a newsletter Subscribe, an appointment Confirm, Book now, Reserve, Upgrade, a free trial and plain buttons all go through", async () => {
    for (const [name, want] of [
      ["Subscribe", "SUBSCRIBED"], ["Confirm", "CONFIRMED"], ["Book now", "BOOKED"], ["Reserve", "RESERVED"], ["Upgrade", "UPGRADED"],
      ["Start free trial", "TRIAL"], ["Save", "SAVED"], ["Continue", "CONTINUED"], ["Submit", "SUBMITTED"],
    ] as const) {
      await gw.goto(`${fx.url}/v02-free.html`);
      const r = await click(name);
      expect(r.ok, `${name}: ${r.reason}`).toBe(true);
      expect(await status(), name).toBe(want);
    }
  });

  it("Enter in the newsletter form submits it", async () => {
    await gw.goto(`${fx.url}/v02-free.html`);
    expect((await gw.do({ action: "type", role: "textbox", name: "Email", text: "rita@example.test", submit: true })).ok).toBe(true);
    expect(await status()).toBe("SUBSCRIBED");
  });
});

describe("no misses: the same words where money is in play", () => {
  it("next to a price: Subscribe, a free trial, Upgrade to Pro, Book now and Confirm are refused and nothing happens", async () => {
    for (const name of ["Subscribe", "Start your 14-day free trial", "Upgrade to Pro", "Book now", "Confirm"]) {
      await gw.goto(`${fx.url}/v02-tiers.html`);
      const r = await click(name);
      expect(r.ok, name).toBe(false);
      expect(r.reason, name).toMatch(/purchase_blocked/);
      expect(await status(), name).toBe("Nothing done");
    }
  });

  it("on a billing page: Confirm and Renew are refused, and any submit of a form with a card field", async () => {
    for (const name of ["Confirm", "Renew", "Continue"]) {
      await gw.goto(`${fx.url}/v02-billing.html`);
      const r = await click(name);
      expect(r.ok, name).toBe(false);
      expect(r.reason, name).toMatch(/purchase_blocked/);
      expect(await status(), name).toBe("Nothing done");
    }
  });

  it("allowPurchases lifts it", async () => {
    const g = await open({ store: tempStore(), allowPurchases: true });
    try {
      await g.goto(`${fx.url}/v02-tiers.html`);
      expect((await g.do({ action: "click", role: "button", name: "Subscribe" })).ok).toBe(true);
      expect(await g.page.textContent("#status")).toBe("PAID-SUBSCRIBE");
    } finally { await g.close(); }
  });
});

describe("no false blocks where money is in play either", () => {
  it("next to a price: a details button, a compare button, 'Book reviews', 'Book a demo' and a newsletter button go through", async () => {
    for (const [name, role, want] of [
      ["See details", "button", "DETAILS"], ["Compare", "button", "COMPARED"], ["Book reviews", "link", "REVIEWS"], ["Book a demo", "link", "DEMO"],
      ["Subscribe to our newsletter", "button", "NEWSLETTER"],
    ] as const) {
      await gw.goto(`${fx.url}/v02-tiers.html`);
      const r = await click(name, role);
      expect(r.ok, `${name}: ${r.reason}`).toBe(true);
      expect(await status(), name).toBe(want);
    }
  });

  it("a 'Confirm password' field takes text, a 'Pay with card' radio button is chosen, a newsletter box is ticked", async () => {
    await gw.goto(`${fx.url}/v02-tiers.html`);
    const typed = await gw.do({ action: "type", role: "textbox", name: "Confirm password", text: "hunter2-hunter2" });
    expect(typed.ok, typed.reason).toBe(true);
    expect(await gw.page.inputValue("#pw2")).toBe("hunter2-hunter2");
    const radio = await gw.do({ action: "check", role: "radio", name: "Pay with card" });
    expect(radio.ok, radio.reason).toBe(true);
    expect(await gw.page.isChecked("#bycard")).toBe(true);
    const box = await gw.do({ action: "check", role: "checkbox", name: "Subscribe to our newsletter" });
    expect(box.ok, box.reason).toBe(true);
    expect(await gw.page.isChecked("#nl")).toBe(true);
  });

  it("on a billing page: going back and downloading an invoice go through", async () => {
    for (const [name, want] of [["Back to settings", "BACK"], ["Download invoice", "INVOICE"]] as const) {
      await gw.goto(`${fx.url}/v02-billing.html`);
      const r = await click(name);
      expect(r.ok, `${name}: ${r.reason}`).toBe(true);
      expect(await status(), name).toBe(want);
    }
  });
});
