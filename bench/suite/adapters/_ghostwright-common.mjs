// Shared code for the ghostwright-local and ghostwright-phantom adapters.
//
// The SDK is loaded from this package (built: dist/index.js), or from the folder or
// file in GHOSTWRIGHT_PKG (an installed copy, to measure exactly what npm serves). Each task is recorded as a flow named after the task the first
// time it runs with an empty store; later runs of the same task replay the saved flow with
// gw.run(), which is how a user runs a saved flow (the model is only used to repair).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..", "..");

export function sdkEntry() {
  const p = process.env.GHOSTWRIGHT_PKG || pkgRoot;
  if (p.endsWith(".js") || p.endsWith(".mjs")) return p;
  return path.join(p, "dist", "index.js");
}
export function sdkVersion() {
  try {
    const dir = path.dirname(path.dirname(sdkEntry()));
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch {
    return "missing";
  }
}
export async function sdkAvailable() {
  const e = sdkEntry();
  if (!fs.existsSync(e)) return `the SDK is not built at ${path.relative(process.cwd(), e)} (run npm run build, or set GHOSTWRIGHT_PKG)`;
  return true;
}

const flowName = (id) => `bench-${id}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();

/**
 * @param {object} opts  harness open() options
 * @param {"local"|"phantom"} where
 */
export async function openGhostwright(opts, where) {
  const gwmod = await import(pathToFileURL(sdkEntry()).href);
  const { Ghostwright, cdp, browsa, secret } = gwmod;
  const { model, secrets, storeDir, log } = opts;

  // Secrets pinned to origins go in as secrets; values allowed everywhere are plain variables.
  const gwSecrets = {};
  const variables = {};
  for (const [k, v] of Object.entries(secrets || {})) {
    if (v.origins.includes("*")) variables[k] = v.value;
    else gwSecrets[k] = secret(v.value, { origins: v.origins });
  }

  const browser =
    where === "phantom"
      ? browsa({ apiKey: process.env.BROWSA_API_KEY, ...(process.env.BENCH_PHANTOM_PROXY ? { proxy: JSON.parse(process.env.BENCH_PHANTOM_PROXY) } : {}) })
      : cdp(opts.cdpUrl);

  const gw = await Ghostwright.create({
    browser,
    model: { provider: "openai-compatible", baseURL: model.baseURL, model: model.id, apiKey: model.apiKey },
    secrets: gwSecrets,
    store: storeDir,
    debug: (line) => log(line),
  });

  let name = null;
  let mode = "plain"; // "record" | "replay" | "plain"
  let flow = null;
  let ran = null;
  const vars = Object.keys(variables).length ? { variables } : undefined;

  const replayNow = async () => {
    if (ran) return ran;
    ran = await gw.run(name, {});
    log({ replay: name, version: ran.version, repaired: ran.repaired, steps: ran.steps, meta: ran.meta });
    return ran;
  };

  return {
    // harness hook: called once before goto with the task id and its steps
    async begin({ task, record }) {
      if (!record) return;
      name = flowName(task);
      let saved = null;
      try {
        saved = gw.store.load(name);
      } catch {}
      if (saved) mode = "replay";
      else {
        mode = "record";
        flow = await gw.flow(name);
      }
      log({ mode, name });
    },
    async goto(url) {
      if (mode === "replay") return; // the recipe opens its own start page
      await (flow || gw).goto(url);
    },
    async act(text) {
      if (mode === "replay") return { ok: true, message: "deferred to replay" };
      const r = await (flow || gw).act(text, vars);
      log({ act: text, ok: r.ok, action: r.action, reason: r.reason, meta: r.meta });
      return { ok: r.ok, message: r.reason || r.action };
    },
    async extract(text, schema) {
      if (mode === "replay") return (await replayNow()).output;
      const r = await (flow || gw).extract(text, schema);
      log({ extract: text, layer: r.meta?.layer, data: r.data, meta: r.meta });
      return r.data;
    },
    async observe(text) {
      const cands = await gw.observe(text);
      log({ observe: text, cands });
      // a target inside a frame is recorded relative to that frame: prefix the frame selector (piercing syntax)
      return (cands || []).map((c) => {
        const t = c.target || {};
        const inner = t.css || t.xpath || "";
        const frame = t.frame && !/^https?:/.test(t.frame) ? t.frame : null;
        // 0.2+: c.selector is the full selector from the top document, frames included
        return { selector: c.selector || (frame ? `${frame} >>> ${inner}` : inner), description: c.description, frame: t.frame };
      });
    },
    async evaluate(js) {
      return await gw.page.evaluate(js);
    },
    // harness hook: after the last step, before the check
    async finish() {
      if (mode === "record" && flow) {
        try {
          const rec = await flow.save();
          log({ saved: name, version: rec.version });
        } catch (e) {
          log({ save_failed: String(e.message || e) });
        }
      } else if (mode === "replay") await replayNow();
    },
    async close() {
      try {
        log({ usage: gw.usage() });
      } catch {}
      await gw.close();
    },
  };
}
