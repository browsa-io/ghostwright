// Local Chrome for one task run: a fresh profile, a CDP port, headless by default.
// The harness owns the browser, so every SDK gets the same browser and flags,
// and the harness can read page state over its own CDP connection.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const MAC_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
];
const LINUX_PATHS = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];

export function findChrome() {
  if (process.env.BENCH_CHROME) return process.env.BENCH_CHROME;
  for (const p of process.platform === "darwin" ? MAC_PATHS : LINUX_PATHS) if (fs.existsSync(p)) return p;
  throw new Error("Chrome not found; set BENCH_CHROME");
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

export async function launchChrome({ headless = true, width = 1280, height = 900, extraArgs = [] } = {}) {
  const exe = findChrome();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--password-store=basic",
    "--use-mock-keychain",
    // Lets an SDK that ships a browser extension load it over CDP; harmless otherwise.
    "--enable-unsafe-extension-debugging",
    "--remote-allow-origins=*",
    `--window-size=${width},${height}`,
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const child = spawn(exe, args, { stdio: "ignore", detached: process.platform !== "win32" });
  const cdpUrl = `http://127.0.0.1:${port}`;
  let ver = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${cdpUrl}/json/version`);
      if (r.ok) {
        ver = await r.json();
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!ver) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    throw new Error("Chrome did not open its CDP port");
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
    try {
      if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { cdpUrl, wsUrl: ver.webSocketDebuggerUrl, port, close, userDataDir: dir };
}
