// The API reference is written from the types: it must match the source it was written from.
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render } from "../../scripts/api-docs.mjs";

describe("docs", () => {
  it("docs/api.md is up to date with the exported types (npm run docs)", () => {
    expect(readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8")).toBe(render());
  }, 60_000);

  it("the README quickstart and the landing page show the script init writes, verbatim", () => {
    const quick = readFileSync(new URL("../../examples/quickstart.mjs", import.meta.url), "utf8").trimEnd();
    expect(readFileSync(new URL("../../README.md", import.meta.url), "utf8")).toContain("```js\n" + quick + "\n```");
    const page = new URL("../../../../apps/agents-landing/ghostwright.html", import.meta.url);
    if (!existsSync(page)) return; // the page lives outside the public repository
    const esc = quick.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(readFileSync(page, "utf8")).toContain(esc);
  });

  it("every guide the index links to exists, and links inside the docs resolve", () => {
    const dir = new URL("../../docs/", import.meta.url);
    for (const f of ["README.md", "record-replay.md", "secrets.md", "browsers.md", "safety.md", "recipe-format.md", "api.md"]) {
      const text = readFileSync(new URL(f, dir), "utf8");
      for (const m of text.matchAll(/\]\((?!https?:|#)([^)#]+)(#[^)]*)?\)/g)) {
        expect(() => statSync(new URL(m[1], new URL(f, dir))), `${f} links to ${m[1]}`).not.toThrow();
      }
    }
  });
});
