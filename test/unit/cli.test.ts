import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", env: { ...process.env, GHOSTWRIGHT_MODEL: "" }, timeout: 30000 });

describe("cli", () => {
  it("lists the extract playground in its help", () => {
    const r = run("--help");
    expect(r.stdout).toMatch(/ghostwright extract <url\|file> "<what>"/);
  });
  it("prints its version", () => {
    const r = run("--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stdout).not.toMatch(/ghostwright list/);
  });
  it("init writes the quickstart, says how to run it, and never overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-init-"));
    const r = spawnSync(process.execPath, ["--import", TSX, cli, "init"], { encoding: "utf8", cwd: dir, timeout: 30000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OPENAI_API_KEY=sk-\.\.\. node quickstart\.mjs/);
    expect(readFileSync(join(dir, "quickstart.mjs"), "utf8")).toContain('from "ghostwright"');
    const again = spawnSync(process.execPath, ["--import", TSX, cli, "init"], { encoding: "utf8", cwd: dir, timeout: 30000 });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already there/);
  });
  it("a missing model key is said once, before any browser starts", async () => {
    const { Ghostwright } = await import("../../src/index.js");
    const keep = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      let opened = false;
      const browser = { kind: "local" as const, async open(): Promise<never> { opened = true; throw new Error("the browser was started"); } };
      const e: any = await Ghostwright.create({ model: "openai/gpt-5.6-luna", browser }).catch(x => x);
      expect(e.code).toBe("model_key_missing");
      expect(e.message).toBe("No API key for openai/gpt-5.6-luna: set OPENAI_API_KEY in the environment, or pass modelApiKey to Ghostwright.create(). Nothing was started.");
      expect(opened).toBe(false);
    } finally { if (keep !== undefined) process.env.OPENAI_API_KEY = keep; }
  });
  it("asks for a model before opening a browser", () => {
    const r = run("extract", "https://example.com", "the title");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/extract needs a model/);
  });
});
