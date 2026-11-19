// Manual probe with a real model (key read from a file, never printed):
// npx tsx test/probe-model.ts dropdown.html "set the shipping speed to Express"
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Ghostwright, local } from "../src/index.js";
import { startFixtures } from "./server.js";

const fx = await startFixtures();
const key = readFileSync((process.env.GHOSTWRIGHT_GEMINI_KEY_FILE || "~/.config/browsa/gemini-key").replace(/^~/, homedir()), "utf8").trim();
const gw = await Ghostwright.create({ browser: local(), model: process.env.MODEL || "google/gemini-3.1-flash-lite", modelApiKey: key, debug: true, store: join(tmpdir(), "gw-probe") });
try {
  await gw.goto(`${fx.url}/${process.argv[2]}`);
  const r = await gw.act(process.argv[3]);
  console.log(JSON.stringify(r, null, 2));
} finally {
  await gw.close();
  await fx.close();
}
