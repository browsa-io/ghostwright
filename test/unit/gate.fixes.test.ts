// What the release gate found, without a browser.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killMarked } from "../../src/browser.js";
import { BrowsaCloud } from "../../src/cloud.js";
import { controlBuys, purchaseReason } from "../../src/guard.js";
import { retryDelay } from "../../src/model/index.js";
import { isEmptyAnswer, notYet } from "../../src/ghostwright.js";
import { patience } from "../../src/replay.js";

describe("purchase guard words", () => {
  const b = (label: string, o: object = {}) => controlBuys({ tag: "button", type: "button", labels: [label], ids: [], ...o });
  it("matches whole words: \"Donated items\" is not \"Donate\"", () => {
    expect(b("Donated items")).toBeNull();
    expect(b("Donated items", { money: true })).toBeNull();
    expect(b("Donate")).not.toBeNull();
    expect(b("Donate $25")).not.toBeNull();
    expect(b("Payment methods")).toBeNull();
    expect(b("Pay now")).not.toBeNull();
    expect(b("Pay €12,50")).not.toBeNull();
    expect(b("Yes, charge my card")).not.toBeNull();
  });
  it("buy, purchase, pay, order and checkout on any clickable, where money is in play", () => {
    for (const l of ["Purchase", "Buy", "Pay", "Order", "Checkout", "Buy tickets", "Get it today", "Yes, buy it", "Confirm"]) {
      expect(b(l, { money: true }), l).not.toBeNull();
    }
    for (const l of ["Purchase", "Buy", "Order", "Get it today", "Confirm"]) expect(b(l), l + " (no money)").toBeNull();
  });
  it("words that look alike and pay nothing go through, with money in play too", () => {
    for (const l of ["Order by date", "Order history", "View order", "Track order", "Pay later", "Book a demo", "Subscribe to newsletter", "Confirm email", "Upgrade view", "Buyer protection", "Ordering guide"]) {
      expect(purchaseReason([{ tag: "button", type: "button", labels: [l], ids: [], money: true }]), l).toBeNull();
    }
  });
});

describe("second gate pass: new purchase words, both ways", () => {
  const m = (label: string, o: object = {}) => purchaseReason([{ tag: "button", type: "button", labels: [label], ids: [], money: true, ...o }]);
  it("refuses them where money is in play", () => {
    for (const l of ["Complete booking", "Send payment", "Submit payment", "Authorize $40.00", "Tip $5", "Add a tip", "Top up", "Top up $20", "Join now", "Reserve my place", "Buy ticket", "Checkout"]) expect(m(l), l).not.toBeNull();
  });
  it("lets the look-alikes through, with money in play too", () => {
    for (const l of ["Booking history", "Payment history", "Payment methods", "Authorize app access", "Tip of the day", "Tips and tricks", "Top up history", "Join our newsletter", "Join the waitlist", "Upgrade your browser", "Upgrade the app", "Reserve a demo slot"]) expect(m(l), l).toBeNull();
  });
  it("needs money in play for the soft ones", () => {
    for (const l of ["Complete booking", "Tip $5", "Top up", "Join now", "Reserve my place"]) expect(m(l, { money: false }), l).toBeNull();
  });
  it("a generic submit, or Enter with no submit button, where the form says it charges now", () => {
    expect(purchaseReason([{ tag: "button", type: "submit", submit: true, inForm: true, labels: ["Continue"], ids: [], chargeNow: true }])).not.toBeNull();
    expect(purchaseReason([{ tag: "button", type: "submit", submit: true, inForm: true, labels: ["Continue"], ids: [] }])).toBeNull();
    expect(purchaseReason([{ tag: "button", type: "submit", submit: true, labels: ["Booking history"], ids: [], chargeNow: true }])).toBeNull(); // no form: submits nothing
    expect(purchaseReason([{ tag: "form", type: "submit", submit: true, implicit: true, labels: [], ids: [], money: true }])).not.toBeNull();
    expect(purchaseReason([{ tag: "form", type: "submit", submit: true, implicit: true, labels: [], ids: [] }])).toBeNull();
  });
});

describe("what counts as not finished, and as an empty read", () => {
  it("knows a \"not yet\" reason", () => {
    for (const w of ["still processing; the field is not enabled yet", "The button is disabled", "waiting for the results", "the list has not loaded"]) expect(notYet(w), w).toBe(true);
    for (const w of ["done", "the instruction is fully carried out", "nothing left to do", "", undefined]) expect(notYet(w), String(w)).toBe(false);
  });
  it("knows an empty answer", () => {
    for (const v of [null, {}, { a: [] }, { a: null, b: "" }, { rows: [{ x: null }] }, "  "]) expect(isEmptyAnswer(v), JSON.stringify(v)).toBe(true);
    for (const v of [{ a: [1] }, { n: 0 }, { ok: false }, "x"]) expect(isEmptyAnswer(v), JSON.stringify(v)).toBe(false);
  });
});

describe("a rate-limited model call waits as long as the provider asks", () => {
  it("reads Retry-After in seconds, as a date, and retry-after-ms; caps it; falls back to 0.8 s", () => {
    expect(retryDelay({ responseHeaders: { "retry-after": "3" } })).toBe(3000);
    expect(retryDelay({ responseHeaders: { "retry-after-ms": "1500" } })).toBe(1500);
    expect(retryDelay({ responseHeaders: { "retry-after": "600" } })).toBe(20000);
    const now = Date.parse("2026-11-21T10:00:00Z");
    expect(retryDelay({ responseHeaders: { "retry-after": "Sat, 21 Nov 2026 10:00:05 GMT" } }, now)).toBe(5000);
    expect(retryDelay({ cause: { responseHeaders: { "retry-after": "2" } } })).toBe(2000);
    expect(retryDelay(new Error("boom"))).toBe(800);
  });
});

describe("a browser that hung while starting is not left behind", () => {
  it.skipIf(process.platform === "win32")("killMarked stops the process with that marker and removes its temporary profile", async () => {
    const marker = "--gw-launch=test" + Date.now().toString(36);
    const profile = mkdtempSync(join(tmpdir(), "gw-profile-"));
    writeFileSync(join(profile, "x"), "1");
    const script = join(mkdtempSync(join(tmpdir(), "gw-wait-")), "wait.cjs");
    writeFileSync(script, "setTimeout(() => {}, 60000)");
    const p = spawn(process.execPath, [script, marker, `--user-data-dir=${profile}`], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 300));
    const exited = new Promise<void>(r => p.on("exit", () => r()));
    expect(await killMarked(marker)).toBe(1);
    await exited;
    expect(p.killed || p.exitCode !== 0).toBe(true);
    expect(existsSync(profile)).toBe(false);
    // a marker that is not ours is refused
    expect(await killMarked("Google Chrome")).toBe(0);
  });
});

describe("replay patience and what a push leaves out", () => {
  it("waits about one and a half times what the step took when recorded, within bounds", () => {
    expect(patience({ id: "s", kind: "click", after_ms: 4000 })).toBe(6000);
    expect(patience({ id: "s", kind: "click" })).toBe(3000);
  });
  it("an extract read as a list of plain values or with a nested list asks the model on Browsa", () => {
    const r: any = { recipe_version: 1, name: "x", version: 1, output: { type: "object", properties: { authors: { type: "array" } } }, steps: [
      { id: "s1", kind: "extract", from: "page", how: { css: "small.author", fields: { value: "." }, pick: "value", into: "authors" } },
      { id: "s2", kind: "extract", from: "page", how: { css: "table tr", fields: { name: "td" }, headers: { name: "Name" }, into: "people" } },
    ] };
    const body = BrowsaCloud.toBrowsa(r);
    expect(body.steps[0].how).toEqual({ model: true });
    expect(body.steps[1].how?.headers).toEqual({ name: "Name" });
  });
});
