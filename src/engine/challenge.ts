// Full-page bot checks, recognised from protocol data only (the page title
// and the URLs of its frames). Nothing is run in such a page.
import type { Box, Challenge } from "./view.js";

interface Rule { kind: string; titles?: string[]; frameHosts?: string[]; frameParts?: string[]; fullPageByFrame?: boolean }

export const CHALLENGE_RULES: Rule[] = [
  {
    kind: "cloudflare",
    titles: ["Just a moment", "Attention Required! | Cloudflare", "Checking your browser", "Please Wait... | Cloudflare", "Un instant", "Einen Moment", "Un momento", "Um momento", "Один момент", "请稍候", "しばらくお待ちください"],
    frameHosts: ["challenges.cloudflare.com"],
  },
  { kind: "datadome", frameHosts: ["captcha-delivery.com"], fullPageByFrame: true },
  { kind: "hcaptcha", frameHosts: ["hcaptcha.com"], fullPageByFrame: true },
  { kind: "recaptcha", frameParts: ["www.google.com/recaptcha", "www.recaptcha.net/recaptcha", "recaptcha.google.com/recaptcha"] },
  { kind: "perimeterx", titles: ["Access to this page has been denied"], frameParts: ["px-captcha", "captcha.px-cdn.net", "captcha.perimeterx.net"], fullPageByFrame: true },
  { kind: "arkose", frameHosts: ["arkoselabs.com", "funcaptcha.com"], fullPageByFrame: true },
  { kind: "aws-waf", titles: ["Human Verification"], frameHosts: ["captcha.awswaf.com"], fullPageByFrame: true },
  { kind: "akamai", titles: ["Access Denied - Akamai", "Pardon Our Interruption"] },
];

const FULL_PAGE_SHARE = 0.35;

export function matchTitle(title: string): Rule | undefined {
  const t = title.trim().toLowerCase();
  if (!t) return undefined;
  return CHALLENGE_RULES.find(r => r.titles?.some(p => t.startsWith(p.toLowerCase())));
}

export function matchFrame(url: string): Rule | undefined {
  if (!url) return undefined;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* none */ }
  return CHALLENGE_RULES.find(r =>
    r.frameHosts?.some(h => host === h || host.endsWith("." + h)) || r.frameParts?.some(p => url.includes(p)));
}

/** [substring of an iframe src, vendor] for the page script's captcha elements. */
export function captchaPatterns(): [string, string][] {
  const out: [string, string][] = [];
  for (const r of CHALLENGE_RULES) {
    for (const h of r.frameHosts || []) out.push([h, r.kind]);
    for (const p of r.frameParts || []) out.push([p, r.kind]);
  }
  return out;
}

export async function classifyChallenge(
  title: string,
  frames: string[],
  cover: (i: number) => Promise<{ share: number; box?: Box } | null>,
): Promise<Challenge | null> {
  const tr = matchTitle(title);
  if (tr) {
    const ch: Challenge = { kind: tr.kind, fullPage: true, reason: "title" };
    for (let i = 0; i < frames.length; i++) {
      if (matchFrame(frames[i])?.kind === tr.kind) {
        ch.frameURL = frames[i];
        const c = await cover(i);
        if (c?.box) ch.box = c.box;
        break;
      }
    }
    return ch;
  }
  for (let i = 0; i < frames.length; i++) {
    const r = matchFrame(frames[i]);
    if (!r?.fullPageByFrame) continue;
    const c = await cover(i);
    if (c && c.share >= FULL_PAGE_SHARE) return { kind: r.kind, fullPage: true, reason: "frame", frameURL: frames[i], box: c.box };
  }
  return null;
}
