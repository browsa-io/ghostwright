import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { Ghostwright, local, type GhostwrightOptions } from "../../src/index.js";

// every temporary store a test made is removed when the test process ends
const made: string[] = [];
process.on("exit", () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

export function tempStore(): string {
  const d = mkdtempSync(join(process.env.GHOSTWRIGHT_TMP || tmpdir(), "gw-store-"));
  made.push(d);
  return d;
}

export async function open(o: GhostwrightOptions): Promise<Ghostwright> {
  const t0 = Date.now();
  // a browser that does not come up is said as that, not as a test that timed out somewhere
  let timer: NodeJS.Timeout | undefined;
  const g = await Promise.race([
    Ghostwright.create({ browser: local({ headless: true }), ...o }),
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`Ghostwright.create() did not finish in 45 s (load ${loadavg()[0].toFixed(1)})`)), 45000); }),
  ]).finally(() => clearTimeout(timer));
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
