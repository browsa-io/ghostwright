// 0.2 regression tests: one per finding of the 0.1 benchmark, on local Chrome
// with a mock model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ghostwright, ModelRequest } from "../../src/index.js";
import { instructionOf, lines, mockModel, pageOf } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

/** Picks the control named `control` that comes after the heading named in the instruction ("... of Model C"). */
const inCard = (control: string, action: string) => (req: ModelRequest) => {
  const item = /Model [A-D]/.exec(instructionOf(req.prompt))?.[0] ?? "";
  const ls = lines(pageOf(req.prompt));
  const at = ls.findIndex(l => l.role === "heading" && l.name === item);
  const hit = at < 0 ? undefined : ls.slice(at + 1).find(l => l.name === control);
  return hit ? { action, id: hit.id } : { action: "none", why: `no ${control} for ${item}` };
};

describe("replay after a reorder: controls that are named alike", () => {
  it("finds each by its own card, with no model, instead of the one now in its place", async () => {
    const store = tempStore();
    const rec = await open({ model: mockModel({ act: inCard("Compare", "check") }), store });
    try {
      const flow = await rec.flow("v02-compare");
      await flow.goto(`${fx.url}/v02-items.html`);
      expect((await flow.act("tick the Compare box of Model A")).ok).toBe(true);
      expect((await flow.act("tick the Compare box of Model C")).ok).toBe(true);
      const saved = await flow.save();
      expect(saved.steps[1].target?.within).toContain("Model A");
      expect(saved.steps[2].target?.within).toContain("Model C");
      expect(await rec.page.textContent("#status")).toBe("Comparing: Model A, Model C");
    } finally { await rec.close(); }
    const gw = await open({ store }); // no model: a repair would throw
    try {
      fx.variant = "changed"; // D, B, A, C: by position the boxes are now Model D's and Model A's
      const run = await gw.run("v02-compare");
      expect(run.meta.modelCalls).toBe(0);
      expect(run.repaired).toEqual([]);
      expect(await gw.page.textContent("#status")).toBe("Comparing: Model A, Model C");
    } finally { fx.variant = "base"; await gw.close(); }
  });

  it("fails when the item is gone; it never acts on another item's control", async () => {
    const store = tempStore();
    const gw = await open({ model: mockModel({ act: inCard("Remove", "click") }), store });
    try {
      const flow = await gw.flow("v02-remove");
      await flow.goto(`${fx.url}/v02-items.html`);
      expect((await flow.act("remove Model B")).ok).toBe(true);
      await flow.save();
      expect(await gw.page.textContent("#left")).toBe("3 laptops");
      // again in the same browser session: Model B is gone, three other Remove buttons are there
      await expect(gw.run("v02-remove", {}, { repair: false })).rejects.toThrow(/site_changed|failed/);
      expect(await gw.page.textContent("#left")).toBe("3 laptops");
      // with a model: it says nothing fits, and still nothing else is removed
      await expect(gw.run("v02-remove")).rejects.toThrow(/could not be repaired/);
      expect(await gw.page.textContent("#left")).toBe("3 laptops");
    } finally { await gw.close(); }
  });
});

describe("a redesign that breaks every step", () => {
  it("is repaired step by step in one run (the cap is the number of steps, not 3)", async () => {
    const store = tempStore();
    const gw = await open({ model: mockModel({ act: inCard("Compare", "check") }), store });
    try {
      const flow = await gw.flow("v02-all");
      await flow.goto(`${fx.url}/v02-items.html`);
      for (const m of ["A", "B", "C", "D"]) expect((await flow.act(`tick the Compare box of Model ${m}`)).ok).toBe(true);
      const saved = await flow.save();
      expect(saved.repair?.max_steps).toBe(5);
      // break all four: locators that match nothing any more
      const file = gw.store.load("v02-all")!;
      for (const s of file.steps) if (s.target) s.target = { role: "checkbox", name: "Old label " + s.id, css: "#gone-" + s.id };
      gw.store.promote({ ...file, version: file.version + 1 });
      const run = await gw.run("v02-all");
      expect(run.repaired.length).toBe(4);
      expect(await gw.page.textContent("#status")).toBe("Comparing: Model A, Model B, Model C, Model D");
    } finally { await gw.close(); }
  });
});

describe("dates, times and fields read back", () => {
  let gw: Ghostwright;
  beforeAll(async () => { gw = await open({ store: tempStore() }); });
  afterAll(async () => { await gw?.close(); });

  it("a date field takes a date as a person writes it, a time field a time", async () => {
    await gw.goto(`${fx.url}/v02-form.html`);
    expect((await gw.do({ action: "type", role: "textbox", name: "Departure", text: "24 December 2026" })).ok).toBe(true);
    expect(await gw.page.inputValue("#dep")).toBe("2026-12-24");
    expect(await gw.page.textContent("#status")).toBe("DEP 2026-12-24");
    expect((await gw.do({ action: "type", role: "textbox", name: "Departure", text: "2027-01-05" })).ok).toBe(true);
    expect(await gw.page.inputValue("#dep")).toBe("2027-01-05");
    expect((await gw.do({ action: "type", role: "textbox", name: "Pick-up time", text: "2:30 pm" })).ok).toBe(true);
    expect(await gw.page.inputValue("#at")).toBe("14:30");
    const bad = await gw.do({ action: "type", role: "textbox", name: "Departure", text: "next week some time" });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/is not a date \(write it as YYYY-MM-DD\)/);
  });

  it("a field that throws the text away is a failure; one that reformats it is not", async () => {
    await gw.goto(`${fx.url}/v02-form.html`);
    const locked = await gw.do({ action: "type", role: "textbox", name: "Locked code", text: "ABC-123" });
    expect(locked.ok).toBe(false);
    expect(locked.reason).toBe("the field did not take the text");
    const phone = await gw.do({ action: "type", role: "textbox", name: "Phone", text: "5551234567" });
    expect(phone.ok, phone.reason).toBe(true);
    expect(await gw.page.inputValue("#phone")).toBe("(555) 123-4567");
  });
});

describe("menus that open on hover, scrolling by share, long tables", () => {
  it("act hovers the menu, then clicks the item in it", async () => {
    const act = (req: ModelRequest) => {
      const ls = lines(pageOf(req.prompt));
      const item = ls.find(l => l.name === "Laptops");
      if (item) return { action: "click", id: item.id };
      const menu = ls.find(l => l.name === "Products");
      return menu ? { action: "hover", id: menu.id, next: "click Laptops" } : { action: "none", why: "no menu" };
    };
    const gw = await open({ model: mockModel({ act }), store: tempStore() });
    try {
      await gw.goto(`${fx.url}/v02-form.html`);
      // the closed menu's items are not in the view; the menu itself is listed as something to act on
      const v = (await gw.observe()).view;
      expect(v).not.toContain('"Laptops"');
      expect(lines(v).some(l => l.name === "Products")).toBe(true);
      const r = await gw.act("open Laptops in the Products menu");
      expect(r.ok, r.reason).toBe(true);
      expect(await gw.page.textContent("#status")).toBe("NAV laptops");
    } finally { await gw.close(); }
  });

  it("scrolls the page and a scrolling box to a share of the way", async () => {
    const gw = await open({ store: tempStore() });
    try {
      await gw.goto(`${fx.url}/v02-form.html`);
      expect((await gw.do({ action: "scroll", to: "50%" })).ok).toBe(true);
      const page = await gw.page.evaluate("scrollY / (document.documentElement.scrollHeight - innerHeight)") as number;
      expect(page).toBeGreaterThan(0.45);
      expect(page).toBeLessThan(0.55);
      expect((await gw.do({ action: "scroll", to: "top" })).ok).toBe(true);
      const box = (await gw.observe()).elements.find(e => e.role === "scrollbox");
      expect(box, "the scrolling box is listed").toBeTruthy();
      expect((await gw.do({ action: "scroll", id: box!.id, to: "bottom" })).ok).toBe(true);
      const inBox = await gw.page.evaluate("(() => { const e = document.getElementById('log'); return e.scrollTop / (e.scrollHeight - e.clientHeight); })()") as number;
      expect(inBox).toBeGreaterThan(0.95);
      expect((await gw.do({ action: "scroll", to: "sideways" })).ok).toBe(false);
    } finally { await gw.close(); }
  });

  it("an extract reads every row of a table the view folds", async () => {
    let seen = "";
    const model = mockModel({ extract: (_i, page) => { seen = page; return { people: [] }; } });
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(`${fx.url}/v02-form.html`);
      // the view an act reads folds the table
      expect((await gw.observe()).view).not.toContain("Lea");
      await gw.extract("everyone and their team", { type: "object", properties: { people: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } });
      for (const n of ["Ada", "Fay", "Gus", "Kai", "Lea"]) expect(seen, n).toContain(n);
    } finally { await gw.close(); }
  });
});

describe("frames inside frames, and observe selectors", () => {
  it("types and clicks in a frame of another origin inside a frame of another site", async () => {
    const gw = await open({ store: tempStore() });
    try {
      await gw.goto(`${fx.url}/v02-nested.html`);
      const v = await gw.observe();
      expect(v.view).toContain('button "Apply coupon"');
      const field = v.elements.find(e => e.role === "textbox")!;
      const typed = await gw.do({ action: "type", id: field.id, text: "SPRING25" });
      expect(typed.ok, typed.reason).toBe(true);
      const clicked = await gw.do({ action: "click", role: "button", name: "Apply coupon" });
      expect(clicked.ok, clicked.reason).toBe(true);
      expect(await gw.page.textContent("#status")).toBe("Coupon SPRING25");
    } finally { await gw.close(); }
  });

  it("observe gives one selector from the top document, frames first", async () => {
    const gw = await open({ model: mockModel(), store: tempStore() });
    try {
      await gw.goto(`${fx.url}/frames.html`);
      const c = await gw.observe("the save note button");
      expect(c[0].name).toBe("Save note");
      expect(c[0].selector).toBe("#same >>> #pay");
      // a frame of another site runs in its own process: the selector still starts at the top document
      const far = await gw.observe("the use this card button");
      expect(far[0].name).toBe("Use this card");
      expect(far[0].selector).toBe("#site >>> #pay");
      expect(far[0].frame).toContain("/frame-inner.html");
      const top = await gw.observe("the status paragraph");
      expect(top.every(x => !x.selector || !x.selector.includes(">>>"))).toBe(true);
    } finally { await gw.close(); }
  });
});

describe("a link that opens a new tab", () => {
  it("the next action happens in the new tab", async () => {
    const gw = await open({ model: mockModel(), store: tempStore() });
    try {
      await gw.goto(`${fx.url}/regress.html`);
      expect((await gw.act("click the account in a new tab link")).ok).toBe(true);
      expect(gw.page.url()).toBe(`${fx.url}/account.html`);
      expect((await gw.observe()).view).toContain("Your account");
      expect((await gw.tabs()).length).toBe(2);
    } finally { await gw.close(); }
  });
});
