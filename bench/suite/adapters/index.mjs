// Adapter registry.
//
// An adapter wraps one SDK behind the same small interface, so every SDK runs the
// same tasks, on the same pages, with the same model, through the same meter.
//
// export default {
//   name: "my-sdk",
//   describe(variant) -> { sdk, version, notes? },
//   available(variant) -> Promise<true | "reason it cannot run">,
//   ownsBrowser?: boolean,      // true: the adapter opens its own (remote) browser; the harness launches none
//   fixtures?: boolean,         // false: cannot reach the local fixture server (skip fixture tasks)
//   open(opts) -> Promise<Session>
// }
// opts = {
//   variant,                    // text after ":" in --adapter name:variant
//   cdpUrl, cdpWsUrl,           // the harness's Chrome (http://127.0.0.1:port and its browser ws:// URL), unless ownsBrowser
//   model: { id, baseURL, apiKey },   // OpenAI-compatible endpoint (the meter); apiKey is a placeholder
//   storeDir,                   // where the SDK may keep recipes/caches; kept across runs of one task
//   secrets: { name: { value, origins: ["http://host:port" | "*"] } },
//   log(line),                  // adapter/SDK log sink (scanned for secret canaries)
// }
// Session = {
//   goto(url),
//   act(text) -> { ok: boolean, message? },      // throw or ok:false when the SDK reports failure
//   extract(text, jsonSchema) -> data,           // plain JSON matching the schema
//   observe(text) -> [{ selector, description? }],
//   evaluate?(js) -> value,                      // only needed when ownsBrowser
//   begin?({ task, run, phase, record, steps }), // before goto; record=true for repeat/drift runs
//   finish?(),                                   // after the last step, before the check
//   close(),
// }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// adapters of your own: BENCH_ADAPTERS lists more folders (separated like PATH)
const SEARCH = [here, ...(process.env.BENCH_ADAPTERS || "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d))];

export async function loadAdapter(spec) {
  const [name, variant = ""] = spec.split(":");
  for (const dir of SEARCH) {
    const f = path.join(dir, `${name}.mjs`);
    if (fs.existsSync(f)) {
      const mod = (await import(f)).default;
      return { adapter: mod, variant, name, spec };
    }
  }
  throw new Error(`no adapter named ${name} (looked in ${SEARCH.join(", ")})`);
}

export function listAdapters() {
  const out = [];
  for (const dir of SEARCH) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".mjs") && f !== "index.mjs" && !f.startsWith("_")) out.push(f.replace(/\.mjs$/, ""));
  }
  return out;
}
