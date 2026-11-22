// 0.2: an extract whose values are parts of an element's text ("Kestrel Sling — $45",
// a sentence, a line of code) compiles to a page read, so replays need no model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowsaCloud } from "../../src/index.js";
import { mockModel } from "../mock-model.js";
import { recipeErrors } from "../recipe-schema.js";
import { startFixtures, type Fixtures } from "../server.js";
import { open, tempStore } from "./helpers.js";

let fx: Fixtures;
beforeAll(async () => { fx = await startFixtures(); });
afterAll(async () => { await fx?.close(); });

const obj = (props: Record<string, string>) => ({ type: "object", properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required: Object.keys(props), additionalProperties: false });

describe("values that are a part of an element's text", () => {
  it("one item, a sentence and a line of code replay with 0 model calls, and read the new data when it changes", async () => {
    const store = tempStore();
    const answers: Record<string, unknown> = {
      first: { name: "Kestrel Sling", price: 45 },
      booking: { room: "Garden Suite", checkin: "Fri 12 Dec", guests: 3 },
      code: { method: "POST", path: "/v1/hooks" },
    };
    const model = mockModel({ extract: i => answers[Object.keys(answers).find(k => i.includes(k))!] });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("v02-text");
      await flow.goto(`${fx.url}/v02-text.html`);
      const a = await flow.extract("the first bag and its price", obj({ name: "string", price: "number" }));
      const b = await flow.extract("the booking: room, check-in and guests", obj({ room: "string", checkin: "string", guests: "number" }));
      const c = await flow.extract("the code sample: method and path", obj({ method: "string", path: "string" }));
      expect(a.meta.layer).toBe("css");
      expect(b.meta.layer).toBe("css");
      expect(c.meta.layer).toBe("css");
      expect(a.data).toEqual(answers.first);
      expect(b.data).toEqual(answers.booking);
      const saved = await flow.save();
      expect(recipeErrors(saved)).toBe("");
      expect(saved.steps[1].how?.match).toBeTruthy();

      model.reset();
      const same = await gw.run("v02-text");
      expect(same.meta.modelCalls).toBe(0);
      expect(same.output).toEqual({ ...(answers.first as object), ...(answers.booking as object), ...(answers.code as object) });

      // the room is read from the booking sentence, not from the list of rooms that also names it
      expect(saved.steps[2].how?.fields?.room).toBe("#summary");
      // other data in the same layout: read from the page, still with no model
      fx.variant = "changed";
      const other = await gw.run("v02-text", {}, { repair: false });
      expect(other.meta.modelCalls).toBe(0);
      expect(other.output).toEqual({ name: "Harbor Tote", price: 1260, room: "Sea View", checkin: "Sat 3 Jan", guests: 2, method: "DELETE", path: "/v2/hooks/7" });

      // on Browsa such a step asks the model (the pattern is read by local replays only)
      const pushed = BrowsaCloud.toBrowsa(saved);
      expect(pushed.steps[1].how).toEqual({ model: true });
      expect(recipeErrors(pushed)).toBe("");
    } finally { fx.variant = "base"; await gw.close(); }
  });

  it("a list whose rows are one text each", async () => {
    const store = tempStore();
    const bags = { bags: [{ name: "Kestrel Sling", price: 45 }, { name: "Kestrel Duffel", price: 120 }, { name: "Harbor Tote", price: 1260 }] };
    const model = mockModel({ extract: () => bags });
    const gw = await open({ model, store });
    try {
      const flow = await gw.flow("v02-list");
      await flow.goto(`${fx.url}/v02-text.html`);
      const a = await flow.extract("every bag with its price", { type: "object", properties: { bags: { type: "array", items: obj({ name: "string", price: "number" }) } }, required: ["bags"] });
      expect(a.meta.layer).toBe("css");
      await flow.save();
      model.reset();
      fx.variant = "changed";
      const run = await gw.run("v02-list", {}, { repair: false });
      expect(run.meta.modelCalls).toBe(0);
      expect(run.output).toEqual({ bags: [{ name: "Harbor Tote", price: 1260 }, { name: "Kestrel Sling", price: 45 }] });
    } finally { fx.variant = "base"; await gw.close(); }
  });

  it("an answer the page does not hold stays a model extract", async () => {
    const model = mockModel({ extract: () => ({ name: "Kestrel Sling", price: 44 }) });
    const gw = await open({ model, store: tempStore(), warnings: false });
    try {
      const flow = await gw.flow("v02-wrong");
      await flow.goto(`${fx.url}/v02-text.html`);
      expect((await flow.extract("the first bag and its price", obj({ name: "string", price: "number" }))).meta.layer).toBe("model");
    } finally { await gw.close(); }
  });
});
