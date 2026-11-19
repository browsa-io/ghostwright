// Browsa cloud calls against a mocked API (the Secrets API is mocked too:
// it is not deployed yet).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowsaCloud, parseSchedule } from "../../src/cloud.js";
import { Store } from "../../src/store.js";
import type { Recipe } from "../../src/recipe.js";
import { env, Secrets } from "../../src/secrets.js";

function fakeApi() {
  const calls: { method: string; path: string; body: any; key: string | null }[] = [];
  const robots: { id: string; recipe_id: string; name: string }[] = [];
  const schedules: { id: string; recipe_id: string }[] = [];
  const recipes = new Set<string>();
  let n = 0;
  let runPolls = 0;
  const f = (async (url: string, init: any) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname + u.search, body, key: init.headers["X-API-Key"] ?? null });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    const m = init.method, p = u.pathname;
    if (m === "POST" && p === "/v1/recipes") { const id = "rcp-" + ++n; recipes.add(id); return json(201, { id, name: body.name, price_credits: 4, current_version: 1 }); }
    if (m === "POST" && /\/v1\/recipes\/[^/]+\/run$/.test(p)) return json(202, { id: "run-1", status: "queued" });
    if (m === "GET" && p === "/v1/recipe-runs/run-1") {
      runPolls++;
      return json(200, runPolls < 2 ? { id: "run-1", status: "running" } : { id: "run-1", status: "ok", output: { titles: ["A"] }, repaired: false, repaired_steps: [], credits: 4, duration_ms: 2100 });
    }
    if (m === "GET" && p === "/v1/robots") return json(200, { robots });
    if (m === "GET" && p === "/v1/schedules") return json(200, { schedules });
    if (m === "POST" && p === "/v1/robots") { const rb = { id: "rb-" + ++n, name: body.name, recipe_id: body.recipe_id }; robots.push(rb); return json(201, rb); }
    const rbm = /^\/v1\/robots\/([^/]+)$/.exec(p);
    if (m === "DELETE" && rbm) { const i = robots.findIndex(r => r.id === rbm[1]); if (i < 0) return json(404, { error: { code: "ROBOT_NOT_FOUND", message: "no robot" } }); robots.splice(i, 1); return new Response(null, { status: 204 }); }
    if (m === "PATCH" && rbm) {
      const rb = robots.find(r => r.id === rbm[1]);
      if (!rb) return json(404, { error: { code: "ROBOT_NOT_FOUND", message: "no robot" } });
      if (body.recipe_id) rb.recipe_id = body.recipe_id;
      return json(200, rb);
    }
    const rcm = /^\/v1\/recipes\/([^/]+)$/.exec(p);
    if (m === "DELETE" && rcm) { recipes.delete(rcm[1]); return new Response(null, { status: 204 }); }
    if (m === "GET" && rcm && recipes.has(rcm[1])) return json(200, { id: rcm[1], name: "titles", price_credits: 4 });
    return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
  }) as unknown as typeof fetch;
  return { f, calls, robots, schedules, recipes };
}

function storeWith(r: Partial<Recipe> = {}): Store {
  const s = new Store(mkdtempSync(join(tmpdir(), "gw-cloud-")));
  s.promote({ name: "titles", version: 1, params: { type: "object", properties: {} }, output: { type: "object", properties: { titles: { type: "array" } } }, steps: [{ id: "s1", kind: "navigate", url: "https://books.test/" }], ...r });
  return s;
}

const opts = (api: ReturnType<typeof fakeApi>, more = {}) => ({ apiKey: "agt_test", baseUrl: "https://api.test", fetch: api.f, ...more });

describe("Browsa cloud", () => {
  it("pushes, runs and polls, and pushes again only when the flow changed", async () => {
    const api = fakeApi();
    const store = storeWith();
    const c = new BrowsaCloud(store, opts(api));
    const p = await c.push("titles");
    expect(p).toEqual({ recipeId: "rcp-1", name: "titles", version: 1, priceCredits: 4, secretNames: [] });
    expect(api.calls[0].body.recipe.name).toBe("titles");
    expect(api.calls[0].key).toBe("agt_test");
    const run = await c.run("titles", {});
    expect(run.status).toBe("ok");
    expect(run.output).toEqual({ titles: ["A"] });
    expect(run.credits).toBe(4);
    expect(api.calls.filter(x => x.method === "POST" && x.path === "/v1/recipes").length).toBe(1);
    expect(api.calls.find(x => x.path.startsWith("/v1/recipes/rcp-1/run"))?.body).toEqual({ params: {}, wait: 60 });
    // a new local version is pushed before the next run, and the old recipe (unused) is deleted
    store.promote({ ...store.load("titles")!, version: 2 });
    await c.run("titles", {});
    expect(api.calls.filter(x => x.method === "POST" && x.path === "/v1/recipes").length).toBe(2);
    expect(api.recipes.has("rcp-1")).toBe(false);
  });

  it("sends secret tokens and names, never values", async () => {
    const api = fakeApi();
    process.env.GW_CLOUD_TEST_PW = "very-secret-pw-123";
    const secrets = new Secrets({ pw: env("GW_CLOUD_TEST_PW", { origins: ["books.test"] }) });
    const store = storeWith({ steps: [
      { id: "s1", kind: "navigate", url: "https://books.test/login" },
      { id: "s2", kind: "type", target: { role: "textbox", name: "Password" }, text: "{{secret:SHOP_LOGIN:password}}" },
      { id: "s3", kind: "type", target: { role: "textbox", name: "Code" }, text: "{{totp:SHOP_TOTP}}" },
    ] });
    const c = new BrowsaCloud(store, opts(api, { secrets }));
    const p = await c.push("titles");
    expect(p.secretNames).toEqual(["SHOP_LOGIN", "SHOP_TOTP"]);
    await c.run("titles", {});
    const run = api.calls.find(x => x.path.endsWith("/run"))!;
    expect(run.body.secret_ids).toEqual(["SHOP_LOGIN", "SHOP_TOTP"]);
    const wire = JSON.stringify(api.calls.map(x => x.body));
    expect(wire.includes("very-secret-pw-123")).toBe(false);
    expect(wire).toContain("{{secret:SHOP_LOGIN:password}}");
  });

  it("updates the flow's robot in place and keeps an old recipe a schedule still uses", async () => {
    const api = fakeApi();
    const store = storeWith();
    const c = new BrowsaCloud(store, opts(api));
    const rb = await c.robot("titles", { rows: [{}], schedule: "6h", alerts: [{ field: "titles", op: "changed" }] });
    const create = api.calls.find(x => x.method === "POST" && x.path === "/v1/robots")!;
    expect(create.body).toMatchObject({ name: "titles", recipe_id: "rcp-1", inputs: [{}], schedule: { interval_seconds: 21600 }, monitors: [{ field: "titles", op: "changed" }] });
    await c.robot("titles", { schedule: null });
    const patch = api.calls.find(x => x.method === "PATCH")!;
    expect(patch.path).toBe(`/v1/robots/${rb.id}`);
    expect(patch.body).toEqual({ recipe_id: "rcp-1", schedule: null });
    // a schedule of its own still runs rcp-1: a new push keeps it, and moves the robot
    api.schedules.push({ id: "sch-1", recipe_id: "rcp-1" });
    store.promote({ ...store.load("titles")!, version: 2 });
    const p2 = await c.push("titles");
    expect(p2.replaced).toEqual({ recipeId: "rcp-1", deleted: false, keptFor: "schedule sch-1" });
    expect(api.robots[0].recipe_id).toBe(p2.recipeId);
    expect(api.recipes.has("rcp-1")).toBe(true);
    // once nothing uses it, the next push deletes the recipe it replaces
    api.schedules.length = 0;
    store.promote({ ...store.load("titles")!, version: 3 });
    const p3 = await c.push("titles");
    expect(p3.replaced).toEqual({ recipeId: p2.recipeId, deleted: true });
    expect(api.robots.length).toBe(1);
  });

  it("makes a new robot when the old one was deleted on Browsa", async () => {
    const api = fakeApi();
    const c = new BrowsaCloud(storeWith(), opts(api));
    await c.robot("titles", {});
    api.robots.length = 0;
    const rb = await c.robot("titles", { rows: [{}] });
    expect(api.robots.map(r => r.id)).toEqual([rb.id]);
  });

  it("reports API errors with their code", async () => {
    const api = fakeApi();
    const c = new BrowsaCloud(storeWith(), opts(api));
    await c.push("titles");
    const err: any = await (c as any).http("GET", "/v1/nothing").catch((e: unknown) => e);
    expect(err.code).toBe("not_found");
  });

  it("parses schedules", () => {
    expect(parseSchedule("15m")).toEqual({ interval_seconds: 900 });
    expect(parseSchedule("1d")).toEqual({ interval_seconds: 86400 });
    expect(parseSchedule(3600)).toEqual({ interval_seconds: 3600 });
    expect(() => parseSchedule("soon")).toThrow();
  });

  it("an unchanged push uploads nothing and keeps the same recipe", async () => {
    const api = fakeApi();
    const store = storeWith();
    const c = new BrowsaCloud(store, opts(api));
    const p1 = await c.push("titles");
    const p2 = await c.push("titles");
    expect(p2).toMatchObject({ recipeId: p1.recipeId, unchanged: true, priceCredits: 4 });
    expect(api.calls.filter(x => x.method === "POST" && x.path === "/v1/recipes").length).toBe(1);
    // changed content: a new recipe
    store.promote({ ...store.load("titles")!, version: 2, steps: [{ id: "s1", kind: "navigate", url: "https://books.test/new" }] });
    const p3 = await c.push("titles");
    expect(p3.recipeId).not.toBe(p1.recipeId);
    expect(p3.unchanged).toBeUndefined();
    // deleted on Browsa meanwhile: uploaded again
    api.recipes.clear();
    expect((await c.push("titles")).unchanged).toBeUndefined();
  });

  it("unpush deletes the robot and the recipe on Browsa, keeps the local flow", async () => {
    const api = fakeApi();
    const store = storeWith();
    const c = new BrowsaCloud(store, opts(api));
    const p = await c.push("titles");
    const rb = await c.robot("titles", { rows: [{}] });
    expect(await c.unpush("titles")).toEqual({ robotId: rb.id, recipeId: p.recipeId });
    expect(api.robots).toEqual([]);
    expect(api.recipes.has(p.recipeId)).toBe(false);
    expect(c.linked("titles")).toBeUndefined();
    expect(store.load("titles")).toBeTruthy();
    expect(await c.unpush("titles")).toEqual({});
  });
});
