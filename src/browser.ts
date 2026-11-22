// Where the browser comes from: local Chrome, any CDP endpoint, or Phantom
// (Browsa's own browser) created through the Browsa API.
import type { Browser, BrowserContext, Page } from "playwright-core";
import { GhostwrightError } from "./errors.js";

export interface OpenedBrowser {
  kind: "local" | "cdp" | "browsa";
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Browsa only: the browser's id, for a live link or the captcha events */
  agentId?: string;
  close(): Promise<void>;
}

export interface BrowserSource {
  kind: "local" | "cdp" | "browsa";
  open(): Promise<OpenedBrowser>;
}

export interface LocalOptions {
  headless?: boolean;
  /** "chrome" (default: the Chrome installed on this machine), "msedge", or a path to a browser binary */
  channel?: string;
  executablePath?: string;
  args?: string[];
  viewport?: { width: number; height: number };
  /** a profile folder to keep cookies between runs */
  userDataDir?: string;
  /**
   * Chrome's sandbox (on by default). Some Linux containers cannot run it
   * (no user namespaces): pass false there, knowing pages then run unsandboxed.
   */
  sandbox?: boolean;
}

async function pw() {
  return (await import("playwright-core")).chromium;
}

/** A launch failure with what to do about it: Chrome missing, or no sandbox here. */
export function launchError(e: unknown, o: LocalOptions): unknown {
  const msg = String((e as Error)?.message ?? e);
  if (/is not found at|install chrome|playwright install|Executable doesn't exist|ENOENT|distribution .* is not found/i.test(msg)) {
    const what = o.executablePath ? `no browser at ${o.executablePath}` : `${o.channel ?? "Chrome"} is not installed on this machine`;
    return new GhostwrightError("browser_missing", `${what}: install Google Chrome (https://www.google.com/chrome/), or pass local({ executablePath: "/path/to/chrome" }) or local({ channel: "msedge" }); or use cdp() or browsa()`);
  }
  if (/sandbox|zygote|user namespace/i.test(msg)) {
    return new GhostwrightError("browser_sandbox", "Chrome could not start its sandbox here (common in Linux containers and as root): pass local({ sandbox: false }) (pages then run without the sandbox), or local({ executablePath }) for a browser that can, or run as a normal user with user namespaces on");
  }
  return e;
}

/** How long a local browser may take to start and give a page before it is killed and started once more. */
export const LAUNCH_TIMEOUT_MS = 30000;

/**
 * Kills a browser this process started (found by the marker put on its command line) and removes
 * the temporary profile it was given. A browser that hung while starting never reaches close(),
 * so this is what keeps it from being left behind.
 */
export async function killMarked(marker: string): Promise<number> {
  if (process.platform === "win32" || !/^--gw-launch=[a-z0-9]+$/.test(marker)) return 0;
  const { execFileSync } = await import("node:child_process");
  const { rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  let n = 0;
  try {
    const ps = execFileSync("ps", ["-axww", "-o", "pid=", "-o", "args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const dirs = new Set<string>();
    for (const line of ps.split("\n")) {
      if (!line.includes(marker)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      const dir = /--user-data-dir=(\S+)/.exec(line)?.[1];
      if (dir) dirs.add(dir);
      if (pid && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); n++; } catch { /* already gone */ } }
    }
    // only a throwaway profile under the temp folder is removed, never a profile someone chose
    const tmp = tmpdir();
    for (const d of dirs) if (d.startsWith(tmp) || d.startsWith("/private" + tmp) || d.startsWith("/tmp/") || d.startsWith("/var/folders/")) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  } catch { /* no ps here: nothing to do */ }
  return n;
}

/** Launches the Chrome installed on this machine. */
export function local(o: LocalOptions = {}): BrowserSource {
  return {
    kind: "local",
    async open() {
      const chromium = await pw();
      const viewport = o.viewport ?? { width: 1280, height: 800 };
      const start = async (marker: string): Promise<OpenedBrowser> => {
        const launch = {
          headless: o.headless ?? true,
          chromiumSandbox: o.sandbox ?? true,
          channel: o.executablePath ? undefined : (o.channel ?? "chrome"),
          executablePath: o.executablePath,
          args: [...(o.args || []), marker],
          timeout: LAUNCH_TIMEOUT_MS,
        };
        if (o.userDataDir) {
          const context = await chromium.launchPersistentContext(o.userDataDir, { ...launch, viewport }).catch(e => { throw launchError(e, o); });
          const page = context.pages()[0] ?? (await context.newPage());
          return { kind: "local", browser: context.browser()!, context, page, close: () => context.close() };
        }
        const browser = await chromium.launch(launch).catch(e => { throw launchError(e, o); });
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        return { kind: "local", browser, context, page, close: () => browser.close() };
      };
      // Chrome now and then hangs while starting, before it answers at all. It gets 30 s, is
      // killed (with its temporary profile), and is started once more; a second hang is an error.
      for (let attempt = 0; ; attempt++) {
        const marker = "--gw-launch=" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        let timer: NodeJS.Timeout | undefined;
        const starting = start(marker);
        try {
          return await Promise.race([
            starting,
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new GhostwrightError("browser_start", `the local browser did not start within ${LAUNCH_TIMEOUT_MS / 1000} s`)), LAUNCH_TIMEOUT_MS + 5000); }),
          ]);
        } catch (e) {
          const hung = (e instanceof GhostwrightError && e.code === "browser_start") || /Timeout \d+ms exceeded/i.test(String((e as Error)?.message ?? e));
          if (!hung) throw e;
          starting.then(b => b.close()).catch(() => undefined); // if it comes up after all, it is closed
          await killMarked(marker);
          if (attempt >= 1) throw new GhostwrightError("browser_start", `the local browser did not start within ${LAUNCH_TIMEOUT_MS / 1000} s, twice; what was started was stopped. Check that Chrome opens by hand, close other heavy programs, or use cdp() to attach to a browser you started`);
        } finally { clearTimeout(timer); }
      }
    },
  };
}

/** Attaches to any browser that speaks the Chrome DevTools Protocol. */
export function cdp(url: string, o: { headers?: Record<string, string> } = {}): BrowserSource {
  return {
    kind: "cdp",
    async open() {
      const chromium = await pw();
      let browser: Browser;
      try { browser = await chromium.connectOverCDP(url, { headers: o.headers }); } catch (e) {
        let where = url;
        try { const u = new URL(url); where = `${u.protocol}//${u.host}${u.pathname}`; } catch { /* as given */ }
        const why = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
        throw new GhostwrightError("browser_unreachable", `could not attach to a browser at ${where}: ${why}. Check that the browser is running and that the address is exact: start a browser of your own with --remote-debugging-port=0 and pass the ws:// address it prints (or http://127.0.0.1:<port>)`);
      }
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      // leaves the remote browser running
      return { kind: "cdp", browser, context, page, close: async () => { await browser.close().catch(() => undefined); } };
    },
  };
}

export interface BrowsaOptions {
  /** a Browsa API key (agt_...); default BROWSA_API_KEY */
  apiKey?: string;
  baseUrl?: string;
  /** Browsa's proxy network, e.g. { network: "auto" } or { network: "residential", country: "us" } */
  proxy?: Record<string, unknown>;
  country?: string;
  ttl?: string;
  /** reuse a running browser instead of creating one */
  agentId?: string;
  /** keep the browser running after close() */
  keep?: boolean;
}

/** Phantom, Browsa's own browser, created through the Browsa API (npm package `browsa`). */
export function browsa(o: BrowsaOptions = {}): BrowserSource {
  return {
    kind: "browsa",
    async open() {
      const apiKey = o.apiKey || process.env.BROWSA_API_KEY;
      if (!apiKey) throw new Error("browsa(): set apiKey or BROWSA_API_KEY");
      let mod: any;
      try { mod = await import("browsa" as string); } catch {
        throw new Error("browsa() needs the Browsa client: npm install browsa");
      }
      const base = secureBase(o.baseUrl || process.env.BROWSA_BASE_URL || "https://browsa.io", "browsa({ baseUrl })");
      const client = new mod.Client({ apiKey, baseUrl: base });
      let agent: Record<string, any>;
      let created = false;
      if (o.agentId) agent = await client.getAgent(o.agentId);
      else {
        agent = await client.createAgent({ proxy: o.proxy, country: o.country, ttl: o.ttl });
        created = true;
      }
      const id = String(agent.id ?? agent.agent_id ?? "");
      for (let i = 0; i < 60 && !agent.cdp_http && agent.status !== "running"; i++) {
        await new Promise(r => setTimeout(r, 1000));
        agent = { ...agent, ...(await client.getAgent(id)) };
      }
      const cdpHttp = agent.cdp_http as string | undefined;
      // the API key goes to the browser's endpoint: only on the API's own domain
      if (cdpHttp && !sameService(cdpHttp, base)) throw new Error(`Browsa returned a browser endpoint on another domain (${safeHost(cdpHttp)}); not connecting`);
      if (!cdpHttp) throw new Error(`Browsa browser ${id} has no CDP endpoint (status ${agent.status ?? "unknown"})`);
      const chromium = await pw();
      const browser = await chromium.connectOverCDP(cdpHttp, { headers: { "X-API-Key": apiKey } });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      return {
        kind: "browsa", browser, context, page, agentId: id,
        async close() {
          await browser.close().catch(() => undefined);
          if (created && !o.keep) await client.destroyAgent(id).catch(() => undefined);
        },
      };
    },
  };
}

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** A service URL that carries an API key: https only (http on localhost, for tests). */
export function secureBase(url: string, what: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new TypeError(`${what}: not a URL`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.test(u.hostname))) {
    throw new TypeError(`${what} must use https (the API key travels with every request)`);
  }
  return url.replace(/\/+$/, "");
}

/** Is `url` on the service `base` is on (its host, or a subdomain of its domain), over https or wss? */
export function sameService(url: string, base: string): boolean {
  let u: URL, b: URL;
  try { u = new URL(url); b = new URL(base); } catch { return false; }
  const local = LOCAL.test(b.hostname);
  if (!local && u.protocol !== "https:" && u.protocol !== "wss:") return false;
  const root = b.hostname.split(".").slice(-2).join(".");
  return u.hostname === b.hostname || u.hostname === root || u.hostname.endsWith("." + root);
}

function safeHost(u: string): string {
  try { return new URL(u).host; } catch { return "?"; }
}
