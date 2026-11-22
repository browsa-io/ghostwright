// 0.2: what the bench found, without a browser.
import { describe, expect, it } from "vitest";
import { fieldValue } from "../../src/engine/session.js";
import { checkEffect } from "../../src/ghostwright.js";
import { resolveModel } from "../../src/model/index.js";
import { applyMatch, matchRows, spanOf, spanPattern } from "../../src/compile.js";
import { holdsText, positionalCss, wordsFound } from "../../src/engine/session.js";
import type { ActResult } from "../../src/engine/session.js";

describe("date and time fields", () => {
  it("take what a person writes, in the field's own format", () => {
    expect(fieldValue("date", "24 December 2026")).toBe("2026-12-24");
    expect(fieldValue("date", "December 24, 2026")).toBe("2026-12-24");
    expect(fieldValue("date", "Dec 24th 2026")).toBe("2026-12-24");
    expect(fieldValue("date", "2026-12-24")).toBe("2026-12-24");
    expect(fieldValue("date", "24/12/2026")).toBe("2026-12-24");
    expect(fieldValue("date", "12/24/2026")).toBe("2026-12-24");
    expect(fieldValue("time", "10:30")).toBe("10:30");
    expect(fieldValue("time", "2:05 pm")).toBe("14:05");
    expect(fieldValue("datetime-local", "2026-12-24T09:15")).toBe("2026-12-24T09:15");
    expect(fieldValue("datetime-local", "24 December 2026 at 9:15 am")).toBe("2026-12-24T09:15");
    expect(fieldValue("month", "2026-03")).toBe("2026-03");
    expect(fieldValue("date", "soon")).toBeNull();
  });
});

describe("cost of a model behind an OpenAI-compatible endpoint", () => {
  it("is priced as the model it serves, not at the assumed price", async () => {
    const c = await resolveModel({ provider: "openai-compatible", baseURL: "http://127.0.0.1:1/v1", model: "openai/gpt-5.6-luna", apiKey: "x" }, { livePrices: false });
    expect(c.priceSource).toBe("table");
    expect(c.price?.input).toBe(0.2);
    const local = await resolveModel({ provider: "openai-compatible", baseURL: "http://127.0.0.1:1/v1", model: "qwen3", apiKey: "x" }, { livePrices: false });
    expect(local.priceSource).toBe("unknown");
  });
});

describe("a value that is a part of an element's text", () => {
  it("is read with a pattern held by its label and punctuation, never by another value or a digit", () => {
    const t = "Kestrel Sling — $45 (12 left)";
    const name = spanOf(t, "Kestrel Sling")!, price = spanOf(t, 45)!;
    const pn = spanPattern(t, name, false, [price])!, pp = spanPattern(t, price, true, [name])!;
    expect(applyMatch(t, pn)).toBe("Kestrel Sling");
    expect(applyMatch(t, pp)).toBe("45");
    // another item in the same layout
    expect(applyMatch("Harbor Tote — $1,260 (3 left)", pn)).toBe("Harbor Tote");
    expect(applyMatch("Harbor Tote — $1,260 (3 left)", pp)).toBe("1260");
    // a layout it does not fit reads nothing (the step then fails and is repaired), never something else
    expect(applyMatch("Harbor Tote, 1260 credits", pp)).toBeNull();
    expect(matchRows([{ name: t, price: t }], { name: pn, price: pp })).toEqual([{ name: "Kestrel Sling", price: "45" }]);
  });
  it("labels hold values in a sentence", () => {
    const t = "Room: Garden Suite · Check-in: Fri 12 Dec · Guests: 3";
    const room = spanOf(t, "Garden Suite")!, day = spanOf(t, "Fri 12 Dec")!, n = spanOf(t, 3)!;
    const pd = spanPattern(t, day, false, [room, n])!;
    expect(applyMatch("Room: Sea View · Check-in: Sat 3 Jan · Guests: 2", pd)).toBe("Sat 3 Jan");
    expect(applyMatch("Room: Sea View · Check-in: Sat 3 Jan · Guests: 2", spanPattern(t, n, true, [room, day])!)).toBe("2");
  });
  it("a text value with nothing to hold it in place is not compiled; a pattern from a file is bounded", () => {
    expect(spanPattern("alpha beta gamma", [6, 10], false, [[0, 5], [11, 16]])).toBeNull();
    expect(applyMatch("x", "(a+)+".repeat(200))).toBeNull();
    expect(spanOf("no numbers here", 4)).toBeNull();
  });
});

describe("locators", () => {
  it("knows a selector that only says where an element is", () => {
    expect(positionalCss("div.card:nth-of-type(2) > button")).toBe(true);
    expect(positionalCss("main > form > button")).toBe(true);
    expect(positionalCss("#signin")).toBe(false);
    expect(positionalCss('input[name="email"]')).toBe(false);
    expect(positionalCss("x-app >>> #save")).toBe(false);
  });
  it("an item reads as it did when most of its recorded words are there", () => {
    expect(wordsFound("Model B 14-inch, 16 GB 1299 credits", "Model B 14-inch, 16 GB 1199 credits Sale")).toBeGreaterThanOrEqual(0.8);
    expect(wordsFound("Model B 14-inch, 16 GB 1299 credits", "Model C 15-inch, 16 GB 1499 credits")).toBeLessThan(0.8);
    expect(wordsFound("", "anything")).toBe(0);
  });
  it("a field holds the typed text when only its formatting differs", () => {
    expect(holdsText("(555) 123-4567", "5551234567")).toBe(true);
    expect(holdsText("4242 4242 4242 4242", "4242424242424242")).toBe(true);
    expect(holdsText("", "abc")).toBe(false);
    expect(holdsText("ab", "abc")).toBe(false);
  });
});

describe("effects", () => {
  const base: ActResult = { action: "click", status: "ok", changes: [], newTabs: [], downloads: [], errors: [], errorCount: 0, failedRequests: [], settle: { quietAfterMs: 0, waitedMs: 1, capHit: false, requests: [], requestCount: 0 }, text: "" };
  it("a click that left the page as it was and sent nothing did nothing, on a control too (no exception is not a success)", () => {
    expect(checkEffect({ action: "click", id: 4 }, base, null, { control: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/no effect/) });
    expect(checkEffect({ action: "click", id: 4 }, base, null).ok).toBe(false);
    // replaying a step that was recorded with no visible change: the same rule
    expect(checkEffect({ action: "click", id: 4 }, base, { kind: "none" }, { control: true }).ok).toBe(false);
  });
  it("a click on a control that changed the page without anything new to read worked (a star that fills in, a save that only sends)", () => {
    expect(checkEffect({ action: "click", id: 4 }, { ...base, mutations: 2 }, null, { control: true })).toMatchObject({ ok: true, effect: { kind: "none" } });
    expect(checkEffect({ action: "click", id: 4 }, { ...base, settle: { ...base.settle, requestCount: 1 } }, null, { control: true }).ok).toBe(true);
    expect(checkEffect({ action: "click", id: 4 }, { ...base, mutations: 2 }, { kind: "none" }, { control: true }).ok).toBe(true);
    // something that is not a control: only a visible change counts
    expect(checkEffect({ action: "click", id: 4 }, { ...base, mutations: 2 }, null).ok).toBe(false);
  });
  it("records the state a toggle took, and a replay that leaves it otherwise fails", () => {
    const r = { ...base, changes: [{ op: "changed" as const, id: 4, kind: "element", role: "group", fields: { expanded: "true" }, text: "~" }] };
    const e = checkEffect({ action: "click", id: 4 }, r, null, { control: true });
    expect(e.effect).toEqual({ kind: "change", state: { expanded: "true" } });
    expect(checkEffect({ action: "click", id: 4 }, r, e.effect, { stateAfter: { expanded: "false" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/expanded=true/) });
    expect(checkEffect({ action: "click", id: 4 }, r, e.effect, { stateAfter: { expanded: "true" } }).ok).toBe(true);
  });
});
