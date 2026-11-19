// Captchas. On Phantom (Browsa's browser) an in-session solver runs on the
// server: Ghostwright only reports a `captcha` event and waits. Locally,
// browsaCaptcha() solves token captchas (reCAPTCHA v2/v3, Turnstile)
// through captcha.browsa.io, paid with Browsa credits. Anything else
// raises ChallengeError.
import { secureBase } from "./browser.js";
import type { Page } from "playwright-core";

export interface CaptchaFound { kind: "recaptcha" | "turnstile"; sitekey: string; url: string; invisible?: boolean; action?: string }

export interface CaptchaSolver {
  /** solves one widget and returns the token */
  solve(c: CaptchaFound): Promise<string>;
}

export interface BrowsaCaptchaOptions {
  /** a Browsa API key; default BROWSA_API_KEY */
  apiKey?: string;
  /** default https://captcha.browsa.io */
  baseUrl?: string;
  /** give up after this long (default 120 s) */
  timeoutMs?: number;
}

/** Token captchas solved by Browsa's captcha API (credits). */
export function browsaCaptcha(o: BrowsaCaptchaOptions = {}): CaptchaSolver {
  const base = secureBase(o.baseUrl || process.env.BROWSA_CAPTCHA_URL || "https://captcha.browsa.io", "the captcha API URL");
  const call = async (method: string, body: Record<string, unknown>) => {
    const key = o.apiKey || process.env.BROWSA_API_KEY;
    if (!key) throw new Error("browsaCaptcha(): set apiKey or BROWSA_API_KEY");
    const r = await fetch(`${base}/${method}`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "ghostwright" },
      body: JSON.stringify({ clientKey: key, ...body }), signal: AbortSignal.timeout(30000),
    });
    const j: any = await r.json().catch(() => null);
    if (!j || j.errorId) throw new Error(`captcha API: ${j?.errorCode || "HTTP " + r.status} ${j?.errorDescription || ""}`.trim());
    return j;
  };
  return {
    async solve(c) {
      const task: Record<string, unknown> = c.kind === "turnstile"
        ? { type: "AntiTurnstileTaskProxyLess", websiteURL: c.url, websiteKey: c.sitekey, ...(c.action ? { metadata: { action: c.action } } : {}) }
        : { type: "ReCaptchaV2TaskProxyLess", websiteURL: c.url, websiteKey: c.sitekey, ...(c.invisible ? { isInvisible: true } : {}) };
      const created = await call("createTask", { task });
      if (created.solution) return created.solution.token || created.solution.gRecaptchaResponse;
      const deadline = Date.now() + (o.timeoutMs ?? 120000);
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const r = await call("getTaskResult", { taskId: created.taskId });
        if (r.status === "ready") return r.solution.token || r.solution.gRecaptchaResponse;
      }
      throw new Error("captcha API: no answer in time");
    },
  };
}

/** Token widgets on the page (main document), read from their markup. */
export async function findTokenCaptchas(page: Page): Promise<CaptchaFound[]> {
  return page.evaluate(() => {
    const out: { kind: "recaptcha" | "turnstile"; sitekey: string; url: string; invisible?: boolean; action?: string }[] = [];
    for (const el of Array.from(document.querySelectorAll(".cf-turnstile[data-sitekey]"))) {
      out.push({ kind: "turnstile", sitekey: el.getAttribute("data-sitekey")!, url: location.href, action: el.getAttribute("data-action") || undefined });
    }
    for (const el of Array.from(document.querySelectorAll(".g-recaptcha[data-sitekey]"))) {
      out.push({ kind: "recaptcha", sitekey: el.getAttribute("data-sitekey")!, url: location.href, invisible: el.getAttribute("data-size") === "invisible" });
    }
    if (!out.length) {
      for (const f of Array.from(document.querySelectorAll("iframe[src*='recaptcha'], iframe[src*='challenges.cloudflare.com']")) as HTMLIFrameElement[]) {
        const u = new URL(f.src);
        const k = u.searchParams.get("k") || u.searchParams.get("sitekey") || (/\/(0x[\w-]+)\//.exec(u.pathname)?.[1] ?? "");
        if (k) out.push({ kind: f.src.includes("recaptcha") ? "recaptcha" : "turnstile", sitekey: k, url: location.href, invisible: u.searchParams.get("size") === "invisible" });
      }
    }
    return out;
  });
}

/** Puts a token where the widget's form reads it and calls the page's callback. */
export async function injectToken(page: Page, c: CaptchaFound, token: string): Promise<void> {
  await page.evaluate(({ kind, token }) => {
    const names = kind === "turnstile" ? ["cf-turnstile-response", "g-recaptcha-response"] : ["g-recaptcha-response"];
    for (const n of names) {
      for (const el of Array.from(document.querySelectorAll(`[name="${n}"]`)) as HTMLInputElement[]) {
        el.value = token;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const w = document.querySelector(kind === "turnstile" ? ".cf-turnstile" : ".g-recaptcha");
    const cb = w?.getAttribute("data-callback");
    const fn = cb ? (window as any)[cb] : null;
    if (typeof fn === "function") fn(token);
  }, { kind: c.kind, token });
}
