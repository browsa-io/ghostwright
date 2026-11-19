// act / observe / agent on the fixture site, local Chrome, mock model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChallengeError, secret, type Ghostwright } from "../../src/index.js";
import { mockModel } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
let gw: Ghostwright;
const model = mockModel();

beforeAll(async () => {
  fx = await startFixtures();
  gw = await open({
    model, store: tempStore(),
    secrets: { email: secret("ada@example.com", { origins: ["localhost"] }), password: secret("pw", { origins: ["localhost"] }) },
  });
});
afterAll(async () => { await gw?.close(); await fx?.close(); });

describe("act", () => {
  it("signs in with secrets and a click", async () => {
    await gw.goto(`${fx.url}/login.html`);
    expect((await gw.act("type %email% into the email field")).ok).toBe(true);
    const pw = await gw.act("type %password% into the password field");
    expect(pw.ok).toBe(true);
    expect(pw.action).not.toContain('"pw"');
    const r = await gw.act("click the sign in button");
    expect(r.ok).toBe(true);
    expect(r.result).toContain("navigated");
    expect(gw.page.url()).toContain("/account.html?user=Ada");
    expect(r.meta.modelCalls).toBe(1);
  });

  it("checks a checkbox", async () => {
    await gw.goto(`${fx.url}/login.html`);
    const r = await gw.act("check keep me signed in");
    expect(r.ok).toBe(true);
    expect(await gw.page.isChecked("#remember")).toBe(true);
  });

  it("acts inside a frame of another site and of another origin", async () => {
    await gw.goto(`${fx.url}/frames.html`);
    const v = await gw.observe();
    expect(v.view).toContain('frame "payment"');
    expect(v.view).toContain('button "Use this card"');
    expect(v.view).toContain('button "Apply coupon"');
    const pay = v.elements.find(e => e.name === "Use this card")!;
    const field = v.elements.filter(e => e.role === "textbox")[1];
    expect((await gw.do({ action: "type", id: field.id, text: "Ada L" })).ok).toBe(true);
    expect((await gw.do({ action: "click", id: pay.id })).ok).toBe(true);
    expect(await gw.page.textContent("#status")).toBe("Paid by Ada L");
    const coupon = await gw.act("click apply coupon");
    expect(coupon.ok).toBe(true);
  });

  it("reads and clicks inside open and closed shadow roots", async () => {
    await gw.goto(`${fx.url}/shadow.html`);
    const v = await gw.observe();
    expect(v.view).toContain('button "Join the list"  in shadow');
    expect(v.view).toContain('button "Like this page"');
    expect((await gw.act("type 'me@other.test' into your email field")).ok).toBe(true);
    expect((await gw.act("click join the list")).ok).toBe(true);
    expect(await gw.page.textContent("#out")).toBe("Joined me@other.test");
    expect((await gw.act("click like this page")).ok).toBe(true);
    expect(await gw.page.textContent("#out")).toBe("Liked");
  });

  it("picks from a native select and from a custom dropdown in two steps", async () => {
    await gw.goto(`${fx.url}/dropdown.html`);
    const a = await gw.act("select 'France' in the country dropdown");
    expect(a.ok).toBe(true);
    model.reset();
    const b = await gw.act("choose 'Express' speed");
    expect(b.ok).toBe(true);
    expect(b.action).toContain(";");
    expect(model.calls.length).toBe(2);
    expect(await gw.page.textContent("#summary")).toBe("Country: France, speed: express");
  });

  it("does not report success for a click that changes nothing", async () => {
    await gw.goto(`${fx.url}/books.html`);
    const r = await gw.do({ action: "click", role: "heading", name: "Books" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no visible effect");
  });

  it("observe returns candidates with locators", async () => {
    await gw.goto(`${fx.url}/login.html`);
    const c = await gw.observe("the sign in button");
    expect(c[0].name).toBe("Sign in");
    expect(c[0].target?.role).toBe("button");
    expect(c[0].target?.css).toBe("#signin");
  });

  it("raises ChallengeError on a full-page bot check with no solver", async () => {
    await expect(gw.goto(`${fx.url}/challenge.html`)).rejects.toBeInstanceOf(ChallengeError);
  });
});

describe("agent", () => {
  it("runs a task in dom mode", async () => {
    const m = mockModel();
    const g = await open({ model: m, store: tempStore(), secrets: { email: secret("ada@example.com", { origins: ["localhost"] }), password: secret("pw", { origins: ["localhost"] }) } });
    try {
      await g.goto(`${fx.url}/login.html`);
      // the agent's answers, in order; ids come from the login view
      const v = await g.observe();
      const id = (n: string) => v.elements.find(e => e.name === n && e.role !== "heading")!.id;
      m.reset();
      const agentModel = mockModel({
        agent: [
          { action: "type", id: id("Email"), text: "%email%" },
          { action: "type", id: id("Password"), text: "%password%" },
          { action: "click", id: id("Sign in") },
          { action: "done", success: true, answer: "Signed in as Ada", evidence: { text: "Signed in as Ada" } },
        ],
      });
      (m as any).generate = agentModel.generate;
      const r = await g.agent("sign in and tell me who I am", { secrets: ["email", "password"] });
      expect(r.success).toBe(true);
      expect(r.status).toBe("done");
      expect(r.answer).toBe("Signed in as Ada");
      expect(r.steps).toBe(4);
      expect(r.evidence.url).toContain("account.html");
      expect(r.evidence.cited).toEqual({ text: "Signed in as Ada", found: true });
      expect(g.page.url()).toContain("account.html");
      // each step says what it did; typed secrets are masked
      expect(r.history[0]).toMatch(/-> the field now holds a value \(hidden\)/);
      expect(r.history[1]).toMatch(/-> the field now holds a value \(hidden\)/);
      expect(r.history[2]).toMatch(/-> navigated to .*account\.html/);
      expect(r.history.join("\n")).not.toContain("ada@example.com");
    } finally { await g.close(); }
  });
});
