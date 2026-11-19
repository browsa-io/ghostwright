// Deciding when a page went quiet after an action: requests in flight,
// DOM mutations, layout shifts, scrolling, short animations, loading.

export interface SettleConfig {
  /** how long nothing may happen before the page counts as settled (ms) */
  quiet: number;
  /** the longest wait (ms) */
  cap: number;
  /** the cap while a new document has no DOM yet (ms) */
  navigationCap: number;
  /** a request in flight longer than this stops blocking (ms) */
  longLived: number;
  /** sampling interval (ms) */
  poll: number;
}

export const DEFAULT_SETTLE: SettleConfig = { quiet: 150, cap: 5000, navigationCap: 15000, longLived: 2500, poll: 30 };

/** Requests whose URL contains one of these never block settling (analytics, telemetry). */
const BEACON_PARTS = [
  "google-analytics.com", "analytics.google.com", "googletagmanager.com", "doubleclick.net", "googlesyndication.com",
  "facebook.com/tr", "connect.facebook.net", "segment.io", "segment.com/v1", "sentry.io", "hotjar.com", "clarity.ms",
  "mixpanel.com", "amplitude.com", "fullstory.com", "newrelic.com", "nr-data.net", "datadoghq.com", "bugsnag.com",
  "cloudflareinsights.com", "/cdn-cgi/rum", "plausible.io", "/collect?", "/collect/", "/beacon", "/telemetry", "/pixel",
  "optimizely.com", "google.com/pagead", "google.com/ads", "bat.bing.com", "px.ads.linkedin.com",
];
const BLOCKING_TYPES = new Set(["Document", "XHR", "Fetch", "Script", "Stylesheet", "Font"]);

export const isBeacon = (u: string) => BEACON_PARTS.some(p => u.includes(p));

export interface RequestInfo { method: string; url: string; type?: string; status?: number; failed?: string }

interface ReqRec {
  id: string; method: string; url: string; type: string; status: number; failed: string;
  start: number; end: number; done: boolean; blocking: boolean; mainDoc: boolean; mime?: string;
}

/** Follows requests from Network.* events. No clock of its own. */
export class NetTracker {
  inflight = new Map<string, ReqRec>();
  log: ReqRec[] = [];
  last = 0;
  constructor(private longLived: number) {}

  onRequest(id: string, type: string, method: string, url: string, mainDoc: boolean, t: number): void {
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const old = this.inflight.get(id);
    if (old) { old.url = url; old.method = method; return; }
    const r: ReqRec = { id, method, url, type, status: 0, failed: "", start: t, end: 0, done: false, mainDoc, blocking: BLOCKING_TYPES.has(type) && !isBeacon(url) };
    if (type === "Document" && !mainDoc) r.blocking = false;
    this.inflight.set(id, r);
    this.log.push(r);
    if (r.blocking) this.last = t;
  }

  onResponse(id: string, status: number, type: string, mime?: string): void {
    const r = this.inflight.get(id);
    if (!r) return;
    r.status = status;
    r.mime = mime;
    if (type === "EventSource") { r.blocking = false; r.type = type; }
  }

  onDone(id: string, failed: string, t: number): void {
    const r = this.inflight.get(id);
    if (!r) return;
    this.inflight.delete(id);
    r.done = true; r.end = t; r.failed = failed;
    if (r.blocking) this.last = t;
  }

  blocking(now: number): number {
    let c = 0;
    for (const r of this.inflight.values()) {
      if (!r.blocking) continue;
      if (!r.mainDoc && now - r.start > this.longLived) continue;
      c++;
    }
    return c;
  }

  mainDocPending(): boolean {
    for (const r of this.inflight.values()) if (r.mainDoc && r.blocking) return true;
    return false;
  }

  reset(): void { this.log = []; this.last = 0; }
}

export interface Sample {
  inflight: number; netLast: number; loading: boolean;
  mutAgo: number; shiftAgo: number; scrollX: number; scrollY: number; haveScroll: boolean; animations: number;
}

export class QuietTracker {
  last: number;
  busy = false;
  loading = false;
  private sx = 0; private sy = 0; private haveScroll = false;
  constructor(private cfg: SettleConfig, private start: number) { this.last = start; }

  bump(t: number): void { if (t > this.last) this.last = t; }

  feed(now: number, s: Sample): void {
    this.busy = s.inflight > 0 || s.loading || s.animations > 0;
    this.loading = s.loading;
    if (this.busy) this.bump(now);
    if (s.netLast) this.bump(s.netLast);
    if (s.mutAgo >= 0) this.bump(now - s.mutAgo);
    if (s.shiftAgo >= 0) this.bump(now - s.shiftAgo);
    if (s.haveScroll) {
      if (this.haveScroll && (s.scrollX !== this.sx || s.scrollY !== this.sy)) this.bump(now);
      this.sx = s.scrollX; this.sy = s.scrollY; this.haveScroll = true;
    }
  }

  done(now: number): { settled: boolean; capHit: boolean } {
    if (!this.busy && now - this.last >= this.cfg.quiet) return { settled: true, capHit: false };
    const limit = this.loading ? this.cfg.navigationCap : this.cfg.cap;
    if (now - this.start >= limit) return { settled: true, capHit: true };
    return { settled: false, capHit: false };
  }

  quietAfter(): number { return Math.max(0, this.last - this.start); }
}
