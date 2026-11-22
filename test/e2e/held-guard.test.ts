// The release gate's held-out purchase guard table, as tests, both ways: what must go
// through, what must be refused (with nothing done on the page), and a form a script submits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ghostwright } from "../../src/index.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
let gw: Ghostwright;
beforeAll(async () => { fx = await startFixtures(); gw = await open({ store: tempStore() }); });
afterAll(async () => { await gw?.close(); await fx?.close(); });

const go = (c: string) => gw.goto(`${fx.url}/held-guard.html?case=${c}`);
const status = () => gw.page.textContent("#status");

const ALLOW: [string, string, string, string][] = [
  ["newsletter", "button", "Subscribe to newsletter", "newsletter"],
  ["confirm-email", "button", "Confirm email", "confirm-email"],
  ["demo", "button", "Book a demo", "demo"],
  ["upgrade-view", "button", "Upgrade view", "upgrade-view"],
  ["sub-plain", "button", "Subscribe", "sub-plain"],
  ["donated", "button", "Donated items", "donated"],
  ["confirm-appt", "button", "Confirm", "confirm-appt"],
  ["order-by", "button", "Order by date", "order-by"],
  ["order-by", "button", "View order", "view-order"],
  ["order-by", "button", "Order history", "order-history"],
  ["buy-now", "button", "Add to cart", "add-cart"],
  // second table, and a negative for every word added after it
  ["po-nav", "link", "Purchase orders", "po-nav"],
  ["order-details", "link", "Order details", "order-details"],
  ["pay-stubs", "button", "Pay stubs", "pay-stubs"],
  ["charge-status", "button", "Charge status", "charge-status"],
  ["upgrade-browser", "button", "Upgrade your browser", "upgrade-browser"],
  ["apply-filter", "button", "Apply", "apply"],
  ["view-cart", "button", "View cart", "view-cart"],
  ["view-cart", "button", "Compare prices", "compare-prices"],
  ["complete-booking", "button", "Booking history", "booking-history"],
  ["send-payment", "button", "Payment history", "payment-history"],
  ["authorize", "button", "Authorize app access", "authorize-app"],
  ["tip", "button", "Tip of the day", "tip-day"],
  ["top-up", "button", "Top up history", "top-up-history"],
  ["join-paid", "button", "Join our newsletter", "join-newsletter"],
  ["join-free", "button", "Join now", "join-free"],
];
const REFUSE: [string, string, string][] = [
  ["place-order", "button", "Place order"],
  ["pay-now", "button", "Pay now"],
  ["buy-now", "button", "Buy now"],
  ["sub-paid", "button", "Subscribe"],
  ["upgrade-paid", "button", "Upgrade"],
  ["purchase-typebutton", "button", "Purchase"],
  ["pay-divbutton", "button", "Pay €12,50"],
  ["complete-link", "link", "Complete purchase"],
  ["confirm-money", "button", "Confirm"],
  ["charge-card", "button", "Yes, charge my card"],
  ["get-it", "button", "Get it today"],
  ["complete-booking", "button", "Complete booking"],
  ["send-payment", "button", "Send payment"],
  ["authorize", "button", "Authorize $40.00"],
  ["tip", "button", "Tip $5"],
  ["checkout-cart", "button", "Checkout"],
  ["top-up", "button", "Top up"],
  ["join-paid", "button", "Join now"],
  ["reserve-place", "button", "Reserve my place"],
  ["buy-ticket", "link", "Buy ticket"],
  ["continue-charge", "button", "Continue"],
];

describe("held-out guard table", () => {
  it.each(ALLOW)("%s: \"%s %s\" goes through", async (c, role, name, done) => {
    await go(c);
    const r = await gw.do({ action: "click", role, name });
    expect(r.ok, r.reason).toBe(true);
    expect(await status()).toBe("DONE " + done);
  });

  it.each(REFUSE)("%s: \"%s %s\" is refused and nothing happens", async (c, role, name) => {
    await go(c);
    const r = await gw.do({ action: "click", role, name });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/purchase_blocked/);
    expect(await status()).toBe("Nothing done");
  });

  it("Enter in an order form with no submit button is refused; in a search form it goes through", async () => {
    await go("enter-order");
    const r = await gw.do({ action: "type", role: "textbox", name: "Coupon", text: "SPRING", submit: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/purchase_blocked/);
    expect(await status()).toBe("Nothing done");
    await go("enter-search");
    const q = await gw.do({ action: "type", role: "textbox", name: "Search lamps", text: "arc", submit: true });
    expect(q.ok, q.reason).toBe(true);
    expect(await status()).toBe("DONE searched");
  });

  it("a Continue where the page says the card is not charged goes through", async () => {
    await go("continue-nocharge");
    const r = await gw.do({ action: "click", role: "button", name: "Continue" });
    expect(r.ok, r.reason).toBe(true);
    expect(await status()).toBe("DONE trial-started");
  });

  it("a click on a box whose script submits the order form is stopped before the order is placed", async () => {
    await go("script-submit");
    const r = await gw.do({ action: "click", role: "button", name: "Order summary: 1 × Lamp — $49.00" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/purchase_blocked: the page tried to submit an order or payment form \("place order"\)/);
    expect(await status()).toBe("Nothing done");
    // Enter in the form's field is refused too, as before
    const e = await gw.do({ action: "type", role: "textbox", name: "Name on order", text: "Ada", submit: true });
    expect(e.ok).toBe(false);
    expect(await status()).toBe("Nothing done");
  });

  it("the same kind of box on a form that pays nothing works", async () => {
    await go("script-submit-free");
    const r = await gw.do({ action: "click", role: "button", name: "Send my feedback" });
    expect(r.ok, r.reason).toBe(true);
    expect(await status()).toBe("DONE feedback-sent");
  });

  it("allowPurchases lets the script-submitted order through", async () => {
    const g = await open({ store: tempStore(), allowPurchases: true });
    try {
      await g.goto(`${fx.url}/held-guard.html?case=script-submit`);
      expect((await g.do({ action: "click", role: "button", name: "Order summary: 1 × Lamp — $49.00" })).ok).toBe(true);
      expect(await g.page.textContent("#status")).toBe("DONE order-placed");
    } finally { await g.close(); }
  });
});
