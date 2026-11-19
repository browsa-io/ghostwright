import { describe, expect, it } from "vitest";
import { diffSnapshots, Volatility } from "../../src/engine/diff.js";
import { parseKeys, MOD } from "../../src/engine/keys.js";
import { NetTracker, QuietTracker, DEFAULT_SETTLE } from "../../src/engine/settle.js";
import { cut, estimateTokens, quote, shortURL } from "../../src/engine/text.js";
import { buildView, indexItems, parseItems, type RawSnapshot, type Snapshot } from "../../src/engine/view.js";
import { matchFrame, matchTitle } from "../../src/engine/challenge.js";

function snap(items: RawSnapshot["items"], extra: Partial<RawSnapshot> = {}): Snapshot {
  const raw: RawSnapshot = { u: "https://shop.test/a", ti: "Shop", sx: 0, sy: 0, vw: 1280, vh: 800, pw: 1280, ph: 3000, foc: 0, modal: 0, rm: 0, ms: 1, ld: 0, items, frames: [], ...extra };
  const sn: Snapshot = {
    url: raw.u, title: raw.ti, sx: 0, sy: 0, vw: 1280, vh: 800, pw: 1280, ph: 3000, focus: 0, modal: 0, epoch: 1, collectMs: 1, loading: false, rematched: 0,
    items: parseItems(raw, l => l, "main"), byId: new Map(), frames: [], widgets: [],
  };
  indexItems(sn);
  return sn;
}

describe("text", () => {
  it("quotes page text on one line and drops bidi controls", () => {
    expect(quote('a "b"\nc‮d')).toBe('"a \\"b\\" cd"');
  });
  it("cuts with an ellipsis", () => {
    expect(cut("abcdefghij", 5)).toBe("abcd…");
    expect(estimateTokens("12345678")).toBe(2);
  });
  it("shortens same-origin URLs", () => {
    expect(shortURL("https://shop.test/api/x?q=1", "https://shop.test/a", 70)).toBe("/api/x?q=1");
    expect(shortURL("https://cdn.test/x", "https://shop.test/a", 70)).toBe("https://cdn.test/x");
  });
});

describe("view", () => {
  const items: RawSnapshot["items"] = [
    { k: "el", r: "heading", n: "Checkout", i: 1, v: 1, s: { level: 2 } },
    { k: "c", r: "form", n: "", i: 2, v: 1 },
    { k: "el", r: "textbox", n: "Postcode", i: 3, v: 1, p: 2, s: { value: "", required: true } },
    { k: "el", r: "button", n: "Continue", i: 4, v: 1, p: 2, s: { disabled: true } },
    { k: "el", r: "link", n: "Terms", i: 5, v: 3, s: { href: "/terms" } },
  ];
  it("renders elements with state and counts what is below the fold", () => {
    const v = buildView(snap(items));
    expect(v.text).toContain('[1] heading "Checkout"  h2');
    expect(v.text).toContain('  [3] textbox "Postcode"  empty, required');
    expect(v.text).toContain('  [4] button "Continue"  disabled');
    expect(v.text).toContain("below the fold: 1 link");
    expect(v.elements.map(e => e.id)).toEqual([1, 2, 3, 4]);
  });
  it("lists the whole page with scope page", () => {
    expect(buildView(snap(items), { scope: "page" }).text).toContain('[5] link "Terms"  → /terms');
  });
  it("degrades to fit the budget and says what it dropped", () => {
    const many: RawSnapshot["items"] = Array.from({ length: 300 }, (_, i) => ({ k: "el", r: "button", n: "Button number " + i, i: i + 1, v: 1 }));
    const v = buildView(snap(many), { budget: 400 });
    expect(v.tokens).toBeLessThanOrEqual(400);
    expect(v.truncated).toBe(true);
    expect(v.text).toMatch(/… \d+ more elements, \d+ of them interactive in the viewport/);
  });
});

describe("diff", () => {
  it("reports changed state, added and removed elements", () => {
    const a = snap([{ k: "el", r: "button", n: "Pay", i: 1, v: 1, s: { disabled: true } }, { k: "text", r: "text", n: "Old", key: "t1.0", v: 1 }]);
    const b = snap([{ k: "el", r: "button", n: "Pay", i: 1, v: 1 }, { k: "text", r: "text", n: "New total", key: "t2.0", v: 1 }]);
    const d = diffSnapshots(a, b, null, 0);
    expect(d.changes.map(c => c.text)).toEqual(['~ [1] button "Pay"  enabled', '+ text "New total"', '- text "Old"']);
  });
  it("leaves out elements that change on their own", () => {
    const v = new Volatility();
    const s1 = snap([{ k: "text", r: "text", n: "12:00:01", key: "t1.0", v: 1 }]);
    const s2 = snap([{ k: "text", r: "text", n: "12:00:02", key: "t1.0", v: 1 }]);
    const s3 = snap([{ k: "text", r: "text", n: "12:00:03", key: "t1.0", v: 1 }]);
    v.note(s1, s2); v.note(s2, s3);
    expect(diffSnapshots(s2, s3, v.is(1), 0).volatile).toBe(1);
  });
});

describe("keys and settle", () => {
  it("parses combos and sequences", () => {
    const k = parseKeys("Control+A Tab Enter");
    expect(k[0].mods).toBe(MOD.ctrl);
    expect(k[0].key.text).toBeUndefined();
    expect(k.map(x => x.key.code)).toEqual(["KeyA", "Tab", "Enter"]);
    expect(() => parseKeys("Hyper+X")).toThrow();
  });
  it("ignores analytics beacons and long-lived requests", () => {
    const n = new NetTracker(2500);
    n.onRequest("1", "XHR", "GET", "https://www.google-analytics.com/collect?x", false, 0);
    n.onRequest("2", "Fetch", "GET", "https://shop.test/api", false, 0);
    expect(n.blocking(100)).toBe(1);
    expect(n.blocking(3000)).toBe(0);
  });
  it("settles after a quiet window and stops at the cap", () => {
    const q = new QuietTracker(DEFAULT_SETTLE, 0);
    q.feed(100, { inflight: 0, netLast: 0, loading: false, mutAgo: 50, shiftAgo: -1, scrollX: 0, scrollY: 0, haveScroll: false, animations: 0 });
    expect(q.done(100).settled).toBe(false);
    expect(q.done(210).settled).toBe(true);
    const busy = new QuietTracker(DEFAULT_SETTLE, 0);
    busy.feed(10, { inflight: 1, netLast: 0, loading: false, mutAgo: -1, shiftAgo: -1, scrollX: 0, scrollY: 0, haveScroll: false, animations: 0 });
    expect(busy.done(5000)).toEqual({ settled: true, capHit: true });
  });
});

describe("bot checks", () => {
  it("recognises titles and vendor frames", () => {
    expect(matchTitle("Just a moment...")?.kind).toBe("cloudflare");
    expect(matchFrame("https://geo.captcha-delivery.com/captcha/?x")?.kind).toBe("datadome");
    expect(matchFrame("https://example.com/")).toBeUndefined();
  });
});
