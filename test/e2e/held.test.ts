// The cases the release gate failed 0.2.0 on (its held-out pages, rebuilt as fixtures), as
// tests: local Chrome, mock model. These pages are not in the benchmark task set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secret, type ModelRequest } from "../../src/index.js";
import * as P from "../../src/model/prompts.js";
import { patience } from "../../src/replay.js";
import { instructionOf, lines, mockModel, pageOf } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { fx.variant = "base"; await fx?.close(); });
const url = (c: string) => `${fx.url}/held-cases.html?case=${c}`;
const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props) });
const arr = (items: unknown) => ({ type: "array", items });
const str = { type: "string" }, num = { type: "number" };

describe("1. a compiled table read checks its column headers", () => {
  const sheet = [["Aoife Brennan", 31.5], ["Kwame Mensah", 40], ["Lucía Ferrer", 22.25], ["Jonas Weber", 37], ["Mei Tanaka", 12]];
  const people = (rows: (string | number)[][]) => ({ people: rows.map(([name, hours]) => ({ name, hours })) });
  const schema = obj({ people: arr(obj({ name: str, hours: num })) });

  it("reordered columns fail the step (and are repaired with a model); shifted data is never returned", async () => {
    const store = tempStore();
    let answer = people(sheet);
    const model = mockModel({ extract: () => answer });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("held-table");
      await flow.goto(url("table"));
      expect((await flow.extract("each person's name and hours worked", schema)).meta.layer).toBe("css");
      const saved = await flow.save();
      expect(saved.steps[1].how?.headers).toEqual({ name: "Name", hours: "Hours" });
      model.reset();
      const same = await gw.run("held-table");
      expect(same.meta.modelCalls).toBe(0);
      expect(same.output).toEqual(people(sheet));

      fx.variant = "changed"; // Team | Name | Rate | Hours, one more row
      // no model: the step fails and says why
      await expect(gw.run("held-table", {}, { repair: false })).rejects.toThrow(/the column read for "name" was under "Name" and is now under "Team"/);
      // with a model: repaired from the page as it is now
      answer = people([...sheet, ["Omar Haddad", 18.75]]);
      const run = await gw.run("held-table");
      expect(run.repaired.length).toBe(1);
      expect(run.output).toEqual(answer);
      // and the repaired version reads the new layout with no model
      model.reset();
      const again = await gw.run("held-table");
      expect(again.meta.modelCalls).toBe(0);
      expect(again.output).toEqual(answer);
    } finally { fx.variant = "base"; await gw.close(); }
  });
});

describe("2. ok means the whole instruction", () => {
  const hoverThenOpen = (req: ModelRequest) => {
    const ls = lines(pageOf(req.prompt));
    const link = ls.find(l => l.role === "link" && l.name === "View profile");
    if (link && /open|click/i.test(instructionOf(req.prompt))) return { action: "click", id: link.id };
    if (/Already done: hover/.test(req.prompt)) return { action: "none", why: "nothing left" };
    const pic = ls.filter(l => /User \d picture/.test(l.name) || /User \d picture/.test(l.rest))[1] ?? ls.filter(l => l.role === "clickable" || l.role === "image")[1];
    return pic ? { action: "hover", id: pic.id } : { action: "none", why: "no picture" };
  };

  it("\"hover ... and open the link\" is not done after the hover", async () => {
    const model = mockModel({ act: hoverThenOpen });
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(url("hover"));
      const r = await gw.act("Hover over the second user picture and open the 'View profile' link that appears under it");
      expect(r.ok, r.reason).toBe(true);
      expect(r.action).toMatch(/^hover .*; click/);
      expect(gw.page.url()).toContain("case=profile&u=2");
      // a hover that is all that was asked is one action and one model call: nothing more is asked or done
      await gw.goto(url("hover"));
      model.reset();
      const h = await gw.act("Hover over the second user picture");
      expect(h.ok, h.reason).toBe(true);
      expect(h.action).toMatch(/^hover \[\d+\]$/);
      expect(model.calls.length).toBe(1);
      expect(gw.page.url()).toContain("case=hover");
      // an instruction that does not ask for a hover is not done by one: the model is asked what is left
      await gw.goto(url("hover"));
      model.reset();
      const o = await gw.act("Open the 'View profile' link of the second user picture");
      expect(o.ok, o.reason).toBe(true);
      expect(model.calls.length).toBe(2);
      expect(gw.page.url()).toContain("case=profile&u=2");
    } finally { await gw.close(); }
  });

  it("a blank \"next\" from the model is not a second step (it once sent a replay back a page)", async () => {
    const model = mockModel({ act: req => { const b = lines(pageOf(req.prompt)).find(l => l.name === "Generate code"); return b ? { action: "click", id: b.id, next: " " } : { action: "none" }; } });
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(url("late"));
      const r = await gw.act("click the Generate code button");
      expect(r.ok, r.reason).toBe(true);
      expect(r.action).not.toContain(";");
      expect(model.calls.length).toBe(1);
    } finally { await gw.close(); }
  });

  it("a confirmation box the instruction did not ask to confirm is left for the next instruction", async () => {
    const prompts: string[] = [];
    const act = (req: ModelRequest) => {
      prompts.push(req.prompt);
      const ins = instructionOf(req.prompt), ls = lines(pageOf(req.prompt));
      const yes = ls.find(l => l.name === "Remove draft");
      if (yes) return /confirm/i.test(ins) ? { action: "click", id: yes.id } : { action: "none", why: "the instruction did not say to confirm" };
      const at = ls.findIndex(l => /Hiring memo/.test(l.name) || /Hiring memo/.test(l.rest));
      const b = ls.filter(l => l.name === "Remove")[1];
      return b && at !== -2 ? { action: "click", id: b.id } : { action: "none" };
    };
    const gw = await open({ model: mockModel({ act }), store: tempStore() });
    try {
      await gw.goto(url("drafts"));
      const r = await gw.act("Remove the draft called 'Hiring memo'");
      expect(r.ok, r.reason).toBe(true);
      expect(prompts[1]).toContain('answer "none" unless the instruction says to confirm');
      expect(await gw.page.textContent("#status")).toBe("Nothing done");
      const c = await gw.act("Confirm the removal in the dialog");
      expect(c.ok, c.reason).toBe(true);
      expect(await gw.page.textContent("#status")).toBe("REMOVED Hiring memo");
    } finally { await gw.close(); }
  });

  it("a scroll that moved nothing is no effect", async () => {
    const gw = await open({ store: tempStore() });
    try {
      await gw.goto(url("short"));
      const r = await gw.do({ action: "scroll", to: "bottom" });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no effect: the page did not scroll/);
      // a list a timer fills in: each scroll to the bottom that moves is ok, until all 45 are there
      await gw.goto(url("scroll"));
      await gw.do({ action: "wait", for: "text", text: "Product 198", timeout: 5000 });
      for (let i = 0; i < 2; i++) {
        const s = await gw.do({ action: "scroll", to: "bottom" });
        expect(s.ok, s.reason).toBe(true);
        await gw.do({ action: "wait", ms: 600 });
      }
      expect(await gw.page.textContent("#status")).toBe("LOADED 45");
    } finally { await gw.close(); }
  });
});

describe("3. JavaScript dialogs", () => {
  it("the model is offered the dialog action, sees the dialog's text, and the answer is recorded and replayed", async () => {
    expect(P.ACT_SYSTEM).toContain('"dialog"');
    expect(P.AGENT_SYSTEM).toContain('"dialog"');
    const prompts: string[] = [];
    const act = (req: ModelRequest) => {
      prompts.push(req.prompt);
      const page = pageOf(req.prompt);
      if (/^dialog: (?!none)/m.test(page)) return { action: "dialog", accept: true };
      const b = lines(page).find(l => l.name === "Delete draft");
      return b ? { action: "click", id: b.id } : { action: "none" };
    };
    const store = tempStore();
    const gw = await open({ model: mockModel({ act }), store });
    try {
      const flow = await gw.flow("held-dialog");
      await flow.goto(url("dialog"));
      const r = await flow.act("Click the 'Delete draft' button and accept the confirmation dialog");
      expect(r.ok, r.reason).toBe(true);
      expect(r.action).toMatch(/click .*; dialog accept/);
      expect(prompts[1]).toContain("Delete the draft for good?");
      expect(await gw.page.textContent("#result")).toBe("You clicked: Ok");
      const saved = await flow.save();
      expect(saved.steps[1]).toMatchObject({ kind: "click", dialog: "accept" });
    } finally { await gw.close(); }
    const again = await open({ store }); // no model
    try {
      const run = await again.run("held-dialog");
      expect(run.meta.modelCalls).toBe(0);
      expect(await again.page.textContent("#result")).toBe("You clicked: Ok");
    } finally { await again.close(); }
  });

  it("a click that only opens the dialog leaves it for the next instruction, which can dismiss it", async () => {
    const act = (req: ModelRequest) => {
      const page = pageOf(req.prompt);
      if (/^dialog: (?!none)/m.test(page)) return /dismiss|cancel/i.test(instructionOf(req.prompt)) ? { action: "dialog", accept: false } : { action: "none", why: "only asked to click" };
      const b = lines(page).find(l => l.name === "Delete draft");
      return b ? { action: "click", id: b.id } : { action: "none" };
    };
    const gw = await open({ model: mockModel({ act }), store: tempStore() });
    try {
      await gw.goto(url("dialog"));
      expect((await gw.act("Click the 'Delete draft' button")).ok).toBe(true);
      const d = await gw.act("Dismiss the dialog");
      expect(d.ok, d.reason).toBe(true);
      expect(await gw.page.textContent("#result")).toBe("You clicked: Cancel");
    } finally { await gw.close(); }
  });
});

describe("3b. the text typed into a prompt()", () => {
  const answering = (text: string) => (req: ModelRequest) => {
    const page = pageOf(req.prompt);
    if (/^dialog: (?!none)/m.test(page)) return { action: "dialog", accept: true, text };
    const b = lines(page).find(l => l.name === "Rename the draft");
    return b ? { action: "click", id: b.id } : { action: "none" };
  };

  it("is recorded and replayed, as a param when it came from one", async () => {
    const store = tempStore();
    const gw = await open({ model: mockModel({ act: answering("%title%") }), store });
    try {
      const flow = await gw.flow("held-prompt", { params: { title: "Q3 plan" } });
      await flow.goto(url("prompt"));
      const r = await flow.act("Click 'Rename the draft' and enter %title% in the prompt");
      expect(r.ok, r.reason).toBe(true);
      expect(await gw.page.textContent("#result")).toBe("You entered: Q3 plan");
      const saved = await flow.save();
      expect(saved.steps[1]).toMatchObject({ kind: "click", dialog: "accept", dialog_text: "{{title}}" });
    } finally { await gw.close(); }
    const again = await open({ store }); // no model
    try {
      const run = await again.run("held-prompt", { title: "Hiring memo" });
      expect(run.meta.modelCalls).toBe(0);
      expect(await again.page.textContent("#result")).toBe("You entered: Hiring memo");
    } finally { await again.close(); }
  });

  it("a literal answer is kept as typed", async () => {
    const store = tempStore();
    const gw = await open({ model: mockModel({ act: answering("Offsite agenda") }), store });
    try {
      const flow = await gw.flow("held-prompt-lit");
      await flow.goto(url("prompt"));
      expect((await flow.act("Click 'Rename the draft' and enter 'Offsite agenda'")).ok).toBe(true);
      expect((await flow.save()).steps[1].dialog_text).toBe("Offsite agenda");
      const run = await gw.run("held-prompt-lit");
      expect(await gw.page.textContent("#result")).toBe("You entered: Offsite agenda");
      expect(run.meta.modelCalls).toBe(0);
    } finally { await gw.close(); }
  });

  it("a secret goes through the secrets path: a token in the recipe, its value typed only on its origin", async () => {
    const store = tempStore();
    const value = "Kq7-wPv2-Lx9m-Rt4b";
    const secrets = { code: secret(value, { origins: ["localhost"] }) };
    const model = mockModel({ act: answering("%code%") });
    const gw = await open({ model, store, secrets });
    try {
      const flow = await gw.flow("held-prompt-secret");
      await flow.goto(url("prompt"));
      expect((await flow.act("Click 'Rename the draft' and enter %code% in the prompt")).ok).toBe(true);
      expect(await gw.page.textContent("#result")).toBe("You entered: " + value);
      const saved = await flow.save();
      expect(saved.steps[1].dialog_text).toMatch(/^\{\{secret:/);
      expect(JSON.stringify(saved)).not.toContain(value);
      expect(JSON.stringify(model.calls)).not.toContain(value);
      await gw.goto(url("short"));
      await gw.run("held-prompt-secret");
      expect(await gw.page.textContent("#result")).toBe("You entered: " + value);
    } finally { await gw.close(); }
  });
});

describe("5. an extract that would come back empty while the page is still at work", () => {
  const want = ["Genoa North", "Lyon Est", "Porto Sul"];
  const schema = obj({ warehouses: arr(str) });
  // the mock reads the list off the page it is shown: empty while the report runs
  const reader = () => mockModel({ extract: (_i, page) => ({ warehouses: want.filter(w => page.includes(w)) }) });
  for (const c of ["report", "reportnet"]) {
    it(`waits and reads again (${c === "report" ? "\"Running…\" on screen" : "a request still in flight, nothing on screen"})`, async () => {
      const model = reader();
      const gw = await open({ model, store: tempStore() });
      try {
        await gw.goto(url(c));
        expect((await gw.do({ action: "click", role: "button", name: "Run report" })).ok).toBe(true);
        const r = await gw.extract("the warehouses in the report", schema);
        expect(r.data).toEqual({ warehouses: want });
        expect(model.calls.length).toBe(2);
      } finally { await gw.close(); }
    });
  }
  // the gate's N2b shape: a model slower than the request, so the list has arrived (and the request is
  // over) by the time the answer comes back; the answer was read from the view taken while it was running
  const slowReader = () => {
    const m = reader();
    const inner = m.generate.bind(m);
    (m as any).generate = async (req: ModelRequest) => { await new Promise(r => setTimeout(r, 3500)); return inner(req); };
    return m;
  };
  it("a request that finishes while the model answers: the empty answer is read again", async () => {
    const model = slowReader();
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(url("reportnet"));
      expect((await gw.do({ action: "click", role: "button", name: "Run report" })).ok).toBe(true);
      const r = await gw.extract("the warehouses in the report", schema);
      expect(r.data).toEqual({ warehouses: want });
      expect(model.calls.length).toBe(2);
    } finally { await gw.close(); }
  });
  it("a slow model on a page that is not at work and does not change: one call, the empty answer stands", async () => {
    const model = slowReader();
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(url("reportnet"));
      expect((await gw.extract("the warehouses in the report", schema)).data).toEqual({ warehouses: [] });
      expect(model.calls.length).toBe(1);
    } finally { await gw.close(); }
  });
  it("an empty answer on a page that is not at work comes back at once, with one call", async () => {
    const model = reader();
    const gw = await open({ model, store: tempStore() });
    try {
      await gw.goto(url("report"));
      const t0 = Date.now();
      expect((await gw.extract("the warehouses in the report", schema)).data).toEqual({ warehouses: [] });
      expect(model.calls.length).toBe(1);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally { await gw.close(); }
  });
});

describe("also: a \"none\" whose reason says the work is not finished", () => {
  const act = (req: ModelRequest) => {
    const ls = lines(pageOf(req.prompt));
    const field = ls.find(l => l.role === "textbox" && l.name === "Note");
    if (/Already done: click/.test(req.prompt)) {
      if (field && /disabled/.test(field.rest)) return { action: "none", why: "still processing; the field is not enabled yet" };
      return field ? { action: "type", id: field.id, text: "hello" } : { action: "none" };
    }
    const en = ls.find(l => l.name === "Enable");
    return en ? { action: "click", id: en.id } : { action: "none" };
  };
  it("waits and asks again; it is ok only once the rest is done", async () => {
    const gw = await open({ model: mockModel({ act }), store: tempStore() });
    try {
      await gw.goto(url("enable"));
      const r = await gw.act("Click Enable and then type 'hello' into the note field");
      expect(r.ok, r.reason).toBe(true);
      expect(await gw.page.inputValue("#note")).toBe("hello");
    } finally { await gw.close(); }
  });
  it("a second \"not yet\" is not done", async () => {
    const gw = await open({ model: mockModel({ act }), store: tempStore() });
    try {
      await gw.goto(url("enable") + "&never=1");
      const r = await gw.act("Click Enable and then type 'hello' into the note field");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^not done yet: still processing/);
    } finally { await gw.close(); }
  });
});

describe("also: a repair identical to the current version is not promoted", () => {
  it("the element only came late: the run passes on the repaired step, and the version stays", async () => {
    const store = tempStore();
    const model = mockModel({ extract: () => ({ code: "7F3K-PQ92" }) });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("held-same");
      await flow.goto(url("late"));
      expect((await flow.act("click the Generate code button")).ok).toBe(true);
      await gw.do({ action: "wait", for: "text", text: "Accept code", timeout: 6000 });
      expect((await flow.act("click the Accept code button")).ok).toBe(true);
      await flow.save();
    } finally { await gw.close(); }
    // the replay waits only 1.5 s for "Accept code" (it comes 2.4 s after the click), and the model takes
    // 1.5 s to answer, by which time the button is there: the repair finds the very step the flow has
    const probe = await open({ store });
    const file = probe.store.load("held-same")!;
    await probe.close();
    for (const s of file.steps) if (s.after_ms != null) s.after_ms = 0;
    const slow = mockModel();
    const inner = slow.generate.bind(slow);
    (slow as any).generate = async (req: ModelRequest) => { await new Promise(r => setTimeout(r, 1500)); return inner(req); };
    const g2 = await open({ model: slow, store });
    try {
      g2.store.promote(file);
      const run = await g2.run("held-same");
      expect(run.repaired.length).toBe(1);
      expect(run.promoted).toBeUndefined();
      expect(run.draft).toBeUndefined();
      expect(run.version).toBe(file.version);
      expect(g2.store.versions("held-same")).toEqual([file.version]);
      expect(await g2.page.textContent("#status")).toBe("ACCEPTED 7F3K-PQ92");
    } finally { await g2.close(); }
  });
});

describe("4. replays wait for what comes late", () => {
  it("a button and a value that appear seconds after a click replay with 0 model calls", async () => {
    const store = tempStore();
    const model = mockModel({ extract: () => ({ code: "7F3K-PQ92" }) });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("held-late");
      await flow.goto(url("late"));
      expect((await flow.act("click the Generate code button")).ok).toBe(true);
      await gw.do({ action: "wait", for: "text", text: "Accept code", timeout: 6000 });
      expect((await flow.act("click the Accept code button")).ok).toBe(true);
      expect((await flow.extract("the new access code", obj({ code: str }))).meta.layer).toBe("css");
      const saved = await flow.save();
      // how long the step took when recorded is kept, and is what a replay waits by
      expect(saved.steps[2].after_ms).toBeGreaterThan(2000);
      expect(patience(saved.steps[2])).toBeGreaterThan(3000);
      expect(patience({ id: "x", kind: "click" })).toBe(3000);
      expect(patience({ id: "x", kind: "click", after_ms: 100 })).toBe(1500);
      expect(patience({ id: "x", kind: "click", after_ms: 60000 })).toBe(15000);
    } finally { await gw.close(); }
    for (let i = 0; i < 2; i++) {
      const again = await open({ store }); // no model: a step that did not wait would fail
      try {
        const run = await again.run("held-late");
        expect(run.meta.modelCalls).toBe(0);
        expect(run.repaired).toEqual([]);
        expect(run.version).toBe(1);
        expect(run.output).toEqual({ code: "7F3K-PQ92" });
        expect(await again.page.textContent("#status")).toBe("ACCEPTED 7F3K-PQ92");
      } finally { await again.close(); }
    }
  });
});

describe("a repair of an instruction that took two actions", () => {
  it("replaces both of its steps; the second is not run again on top of the repair", async () => {
    const store = tempStore();
    const model = mockModel();
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("held-dropdown");
      await flow.goto(`${fx.url}/dropdown.html`);
      expect((await flow.act("choose 'Express' speed")).ok).toBe(true);
      const saved = await flow.save();
      expect(saved.steps.filter(x => x.goal === "choose 'Express' speed").length).toBe(2);
      // a redesign: neither recorded element is found any more
      const file = gw.store.load("held-dropdown")!;
      for (const st of file.steps) if (st.target) st.target = { role: st.target.role, name: "Gone " + st.id, css: "#gone-" + st.id };
      gw.store.promote({ ...file, version: file.version + 1 });
      model.reset();
      const run = await gw.run("held-dropdown");
      expect(run.repaired).toEqual([saved.steps[1].id, saved.steps[2].id]);
      expect(await gw.page.textContent("#summary")).toBe("Country: Choose…, speed: express");
      model.reset();
      const again = await gw.run("held-dropdown");
      expect(again.meta.modelCalls).toBe(0);
      expect(await gw.page.textContent("#summary")).toBe("Country: Choose…, speed: express");
    } finally { await gw.close(); }
  });
});

describe("6. more extract shapes compile", () => {
  it("a list of plain values, with repeats, replays with 0 model calls and reads new data", async () => {
    const store = tempStore();
    const answers: Record<string, unknown> = {
      author: { authors: ["Albert Einstein", "J.K. Rowling", "Albert Einstein", "Jane Austen", "Albert Einstein"] },
      tags: { tags: ["love", "inspirational", "life"] },
    };
    const model = mockModel({ extract: i => answers[i.includes("author") ? "author" : "tags"] });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("held-authors");
      await flow.goto(url("authors"));
      const a = await flow.extract("the author of every quote, in order", obj({ authors: arr(str) }));
      const t = await flow.extract("the tags listed under Top tags, without the counts", obj({ tags: arr(str) }));
      expect(a.meta.layer).toBe("css");
      expect(t.meta.layer).toBe("css");
      expect(a.data).toEqual(answers.author);
      await flow.save();
      model.reset();
      const same = await gw.run("held-authors");
      expect(same.meta.modelCalls).toBe(0);
      expect(same.output).toEqual({ ...(answers.author as object), ...(answers.tags as object) });
      fx.variant = "changed";
      const other = await gw.run("held-authors", {}, { repair: false });
      expect(other.output).toEqual({ authors: ["Jane Austen", "Mark Twain", "Jane Austen"], tags: ["life", "books"] });
    } finally { fx.variant = "base"; await gw.close(); }
  });

  it("a list inside each row of a list (orders with line items)", async () => {
    const store = tempStore();
    const orders = { orders: [
      { id: "A-1042", customer: "Priya Nair", items: [{ sku: "TR-200", quantity: 2 }, { sku: "BX-17", quantity: 1 }] },
      { id: "A-1043", customer: "Tomás Rey", items: [{ sku: "LM-9", quantity: 4 }] },
      { id: "A-1047", customer: "Ingrid Solberg", items: [{ sku: "TR-200", quantity: 1 }, { sku: "QC-55", quantity: 6 }, { sku: "BX-18", quantity: 3 }] },
    ] };
    const model = mockModel({ extract: () => orders });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("held-orders");
      await flow.goto(url("orders"));
      const schema = obj({ orders: arr(obj({ id: str, customer: str, items: arr(obj({ sku: str, quantity: num })) })) });
      const r = await flow.extract("every order with its id, customer and line items", schema);
      expect(r.meta.layer).toBe("css");
      expect(r.data).toEqual(orders);
      await flow.save();
      model.reset();
      expect((await gw.run("held-orders")).meta.modelCalls).toBe(0);
      fx.variant = "changed";
      const other = await gw.run("held-orders", {}, { repair: false });
      expect(other.output).toEqual({ orders: [
        { id: "A-2001", customer: "Noor Haddad", items: [{ sku: "QC-55", quantity: 2 }] },
        { id: "A-2002", customer: "Priya Nair", items: [{ sku: "TR-200", quantity: 9 }, { sku: "LM-9", quantity: 1 }] },
      ] });
    } finally { fx.variant = "base"; await gw.close(); }
  });
});

describe("also: a failed instruction while recording", () => {
  it("flow.save() says it is not in the flow", async () => {
    const warnings: string[] = [];
    const gw = await open({ model: mockModel(), store: tempStore(), warnings: false, onEvent: e => { if (e.type === "warning") warnings.push((e as any).message); } });
    try {
      const flow = await gw.flow("held-warn");
      await flow.goto(url("dialog"));
      expect((await flow.act("click the button that is not on this page at all")).ok).toBe(false);
      await flow.save();
      expect(warnings.join("\n")).toMatch(/1 instruction failed while recording and is not in the saved flow/);
    } finally { await gw.close(); }
  });
});
