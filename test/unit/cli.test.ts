import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", env: { ...process.env, GHOSTWRIGHT_MODEL: "" }, timeout: 30000 });

describe("cli", () => {
  it("lists the extract playground in its help", () => {
    const r = run("--help");
    expect(r.stdout).toMatch(/ghostwright extract <url\|file> "<what>"/);
  });
  it("asks for a model before opening a browser", () => {
    const r = run("extract", "https://example.com", "the title");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/extract needs a model/);
  });
});
