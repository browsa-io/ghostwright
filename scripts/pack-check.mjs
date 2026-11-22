#!/usr/bin/env node
// Checks the package as npm will serve it: packs it, installs the tarball into an empty
// folder, and there
//   - imports it from an ES module and requires it from a CommonJS file;
//   - type-checks a TypeScript file in an ES module project and in a CommonJS project;
//   - runs the CLI (--version, --help, init) and the shipped quickstart up to the model key;
//   - on a Node that cannot require() an ES module, checks the error says what to do.
//   node scripts/pack-check.mjs [--keep] [--tarball <file.tgz>]
// Run it under each Node you support (CI does: 20, 22, 24).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const given = argv.includes("--tarball") ? resolve(argv[argv.indexOf("--tarball") + 1]) : null;
const sh = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: process.platform === "win32" });
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n     " + String(detail).trim().split("\n").slice(0, 6).join("\n     ")}`); if (!ok) failed++; };

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
let tarball = given;
if (!tarball) {
  const out = execFileSync(npm, ["pack", "--silent"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();
  tarball = join(root, out);
}
const dir = mkdtempSync(join(tmpdir(), "gw-pack-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", private: true }));
  const inst = sh(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, "zod@^4", "typescript@^5.9", "@types/node@^22"], dir);
  check("npm install of the tarball in an empty folder", inst.status === 0, inst.stderr);
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  for (const f of ["package/dist/index.js", "package/dist/index.cjs", "package/dist/index.d.ts", "package/dist/index.d.cts", "package/dist/cli.js", "package/dist/engine/pageview.js", "package/examples/quickstart.mjs", "package/docs/api.md", "package/schema/recipe-v1.json", "package/README.md", "package/LICENSE", "package/CHANGELOG.md"]) check(`ships ${f.slice(8)}`, files.includes(f + "\n"));
  check("ships no tests, sources or bench", !/package\/(test|src|bench)\//.test(files));

  // ESM
  writeFileSync(join(dir, "esm.mjs"), `import { Ghostwright, local, cdp, browsa, env, secret, PRICES, GhostwrightError } from "ghostwright";\nif (typeof Ghostwright.create !== "function" || typeof local !== "function" || !PRICES) throw new Error("exports missing");\nconsole.log("esm ok");\n`);
  const esm = sh(process.execPath, ["esm.mjs"], dir);
  check("import from an ES module", esm.status === 0 && /esm ok/.test(esm.stdout), esm.stderr);

  // CommonJS
  writeFileSync(join(dir, "cjs.cjs"), `let m;\ntry { m = require("ghostwright"); } catch (e) { console.log("cjs error: " + e.code + " " + e.message); process.exit(e.code === "ERR_GHOSTWRIGHT_ESM" ? 3 : 1); }\nif (typeof m.Ghostwright.create !== "function") throw new Error("exports missing");\nconsole.log("cjs ok");\n`);
  const cjs = sh(process.execPath, ["cjs.cjs"], dir);
  const [maj, min] = process.versions.node.split(".").map(Number);
  const canRequire = maj >= 23 || (maj === 22 && min >= 12) || (maj === 20 && min >= 19);
  if (canRequire) check("require() from a CommonJS file", cjs.status === 0 && /cjs ok/.test(cjs.stdout), cjs.stdout + cjs.stderr);
  else check(`require() on Node ${process.versions.node} fails with what to do`, cjs.status === 3 && /await import\("ghostwright"\)/.test(cjs.stdout), cjs.stdout + cjs.stderr);
  writeFileSync(join(dir, "dyn.cjs"), `import("ghostwright").then(m => { if (typeof m.Ghostwright.create !== "function") throw new Error("exports missing"); console.log("dyn ok"); });\n`);
  const dyn = sh(process.execPath, ["dyn.cjs"], dir);
  check("await import() from a CommonJS file", dyn.status === 0 && /dyn ok/.test(dyn.stdout), dyn.stderr);

  // types, both module kinds
  const code = `import { Ghostwright, type GhostwrightOptions, type RunResult, type Target } from "ghostwright";\nconst o: GhostwrightOptions = { model: "openai/gpt-5.6-luna", maxCostUsd: 1 };\nexport async function f(): Promise<RunResult<{ titles: { title: string }[] }>> { const gw = await Ghostwright.create(o); const t: Target = { role: "button", name: "Save" }; void t; return gw.run("x", {}); }\n`;
  const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
  for (const [kind, ext, type] of [["an ES module project", "mts", "module"], ["a CommonJS project", "cts", "commonjs"]]) {
    const d = join(dir, "types-" + ext);
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(d)})`]);
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "t", private: true, type }));
    writeFileSync(join(d, "index." + ext), code);
    writeFileSync(join(d, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, noEmit: true, skipLibCheck: true, types: ["node"] }, include: ["index." + ext] }));
    const r = sh(process.execPath, [tsc, "-p", d], dir);
    check(`types resolve in ${kind}`, r.status === 0, r.stdout + r.stderr);
  }

  // CLI and the shipped quickstart
  const bin = join(dir, "node_modules", "ghostwright", "dist", "cli.js");
  const v = sh(process.execPath, [bin, "--version"], dir);
  check("ghostwright --version", v.status === 0 && v.stdout.trim() === version, v.stdout + v.stderr);
  const h = sh(process.execPath, [bin, "--help"], dir);
  check("ghostwright --help", h.status === 0 && /ghostwright view <url>/.test(h.stdout), h.stderr);
  const init = sh(process.execPath, [bin, "init"], dir);
  check("ghostwright init writes quickstart.mjs", init.status === 0 && existsSync(join(dir, "quickstart.mjs")), init.stdout + init.stderr);
  const q = sh(process.execPath, ["quickstart.mjs"], dir, { OPENAI_API_KEY: "", GHOSTWRIGHT_MODEL: "" });
  check("the quickstart without a key says which variable to set (and starts nothing)", q.status === 1 && /^No API key for openai\/gpt-5\.6-luna: set OPENAI_API_KEY/.test(q.stderr.trim()), q.stdout + q.stderr);
} finally {
  if (!keep) { rmSync(dir, { recursive: true, force: true }); if (!given) rmSync(tarball, { force: true }); }
  else console.log(`kept ${dir} and ${tarball}`);
}
console.log(failed ? `\n${failed} check(s) failed on Node ${process.versions.node}` : `\nall checks passed on Node ${process.versions.node}`);
process.exit(failed ? 1 : 0);
