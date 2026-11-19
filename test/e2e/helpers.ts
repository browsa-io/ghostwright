import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ghostwright, local, type GhostwrightOptions } from "../../src/index.js";

export function tempStore(): string {
  return mkdtempSync(join(process.env.GHOSTWRIGHT_TMP || tmpdir(), "gw-store-"));
}

export async function open(o: GhostwrightOptions): Promise<Ghostwright> {
  const t0 = Date.now();
  const g = await Ghostwright.create({ browser: local({ headless: true }), ...o });
  if (Date.now() - t0 > 5000) console.warn(`slow create: ${Date.now() - t0} ms`);
  const close = g.close.bind(g);
  g.close = async () => {
    const t1 = Date.now();
    await close();
    if (Date.now() - t1 > 5000) console.warn(`slow close: ${Date.now() - t1} ms`);
  };
  return g;
}

/** Every file under dir, as text. */
export function allText(dir: string): string {
  let out = "";
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out += allText(p);
    else out += readFileSync(p, "utf8") + "\n";
  }
  return out;
}
