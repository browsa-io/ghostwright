// Model meter: a local OpenAI-compatible endpoint that forwards to the real
// provider (OpenRouter by default), adds the key itself, and counts every call.
//
// Every SDK under test gets the same base URL shape:
//   http://127.0.0.1:<port>/m/<runKey>/v1
// so calls are attributed to one task run, whatever the SDK does internally.
// The SDK never sees the real key (it gets a placeholder).
//
// It also:
//   - enforces a spend cap (requests are refused once the cap is reached);
//   - scans every request body for secret canary values (a hit = a leak to the model);
//   - keeps a JSONL log of calls (no bodies, no keys) for audit.
import http from "node:http";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export function readKey(file) {
  return fs.readFileSync(file, "utf8").trim();
}

export class Meter {
  /**
   * @param {object} o
   * @param {string} o.upstream   e.g. https://openrouter.ai/api/v1
   * @param {string} o.apiKey     upstream key (never logged)
   * @param {number} o.budgetUsd  hard cap for this process + ledger
   * @param {string} [o.ledger]   JSON file that carries spend across processes
   * @param {string} [o.callLog]  JSONL of calls (metadata only)
   * @param {object} [o.pricing]  { [model]: {in, out} } USD per 1M tokens, fallback when the provider gives no cost
   */
  constructor(o) {
    this.o = o;
    this.runs = new Map(); // runKey -> stats
    this.canaries = new Map(); // lane -> [values]
    this.routes = new Map(); // lane -> current runKey (one session per lane at a time)
    this.ledger = o.ledger ? this.#readLedger() : { spentUsd: 0 };
    this.startSpent = this.ledger.spentUsd;
    this.server = null;
    this.port = 0;
  }

  #readLedger() {
    try {
      return JSON.parse(fs.readFileSync(this.o.ledger, "utf8"));
    } catch {
      return { spentUsd: 0, calls: 0 };
    }
  }
  #writeLedger() {
    if (!this.o.ledger) return;
    fs.writeFileSync(this.o.ledger, JSON.stringify(this.ledger, null, 2));
  }

  get spentUsd() {
    return this.ledger.spentUsd;
  }
  get remainingUsd() {
    return this.o.budgetUsd - this.ledger.spentUsd;
  }

  stats(runKey) {
    if (!this.runs.has(runKey))
      this.runs.set(runKey, { calls: 0, inTok: 0, outTok: 0, usd: 0, errors: 0, retries: 0, canaryHits: 0, ms: 0 });
    return this.runs.get(runKey);
  }
  setCanaries(lane, values) {
    this.canaries.set(lane, values.filter(Boolean));
  }
  /** Attribute calls arriving on `lane` to `runKey` from now on (e.g. one key per task step). */
  route(lane, runKey) {
    this.routes.set(lane, runKey);
  }
  baseURL(lane) {
    return `http://127.0.0.1:${this.port}/m/${encodeURIComponent(lane)}/v1`;
  }

  async start(port = 0) {
    this.server = http.createServer((req, res) => this.#handle(req, res).catch((e) => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(e?.message || e) } }));
      } catch {}
    }));
    await new Promise((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = this.server.address().port;
    return this.port;
  }
  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  #log(rec) {
    if (this.o.callLog) fs.appendFileSync(this.o.callLog, JSON.stringify(rec) + "\n");
  }

  #cost(model, usage) {
    if (usage && typeof usage.cost === "number") return usage.cost;
    const p = this.o.pricing?.[model];
    if (!p || !usage) return 0;
    const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
    return (inTok * p.in + outTok * p.out) / 1e6;
  }

  async #handle(req, res) {
    const m = req.url.match(/^\/m\/([^/]+)\/v1(\/.*)$/);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const lane = decodeURIComponent(m[1]);
    const runKey = this.routes.get(lane) ?? lane;
    const subpath = m[2];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const st = this.stats(runKey);

    // Secret canaries: the raw value must never reach a model.
    for (const v of this.canaries.get(lane) || []) {
      if (raw.includes(v)) st.canaryHits++;
    }

    if (req.method === "GET") {
      // e.g. /models; forward without counting
      const r = await fetch(this.o.upstream + subpath, { headers: { authorization: `Bearer ${this.o.apiKey}` } });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }

    if (this.ledger.spentUsd >= this.o.budgetUsd) {
      st.errors++;
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bench budget reached ($${this.o.budgetUsd})`, type: "budget" } }));
      return;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (body && typeof body === "object") {
      // Ask the provider for the real cost of the call.
      body.usage = { ...(body.usage || {}), include: true };
      if (body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      if (this.o.provider && !body.provider) body.provider = this.o.provider;
    }
    const t0 = Date.now();
    let r;
    // provider rate limits (429) and 5xx are infrastructure, not the SDK: wait and retry patiently
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        r = await fetch(this.o.upstream + subpath, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.o.apiKey}`,
            "content-type": "application/json",
            ...(this.o.headers || {}),
          },
          body: body ? JSON.stringify(body) : raw,
        });
      } catch (e) {
        r = null; // network failure: retry like a 5xx
      }
      if (r && r.status !== 429 && r.status < 500) break;
      if (attempt < 6) {
        st.retries = (st.retries || 0) + 1;
        if (r) await r.arrayBuffer().catch(() => {});
        await sleep(Math.min(30000, 2000 * 2 ** attempt));
      }
    }
    if (!r) {
      st.errors++;
      this.#log({ t: new Date().toISOString(), runKey, path: subpath, status: "network", ms: Date.now() - t0 });
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream unreachable (network) after retries" } }));
      return;
    }
    const ct = r.headers.get("content-type") || "application/json";
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Date.now() - t0;
    let usage = null;
    let model = body?.model;
    const text = buf.toString("utf8");
    if (ct.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const j = JSON.parse(line.slice(5));
          if (j.usage) usage = j.usage;
          if (j.model) model = j.model;
        } catch {}
      }
    } else {
      try {
        const j = JSON.parse(text);
        usage = j.usage || j.response?.usage || null;
      } catch {}
    }
    const usd = r.ok ? this.#cost(body?.model, usage) : 0;
    const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    if (r.ok) st.calls++; // a model call = an answered request; refused/failed ones are counted in errors
    st.inTok += inTok;
    st.outTok += outTok;
    st.usd += usd;
    st.ms += ms;
    if (!r.ok) st.errors++;
    this.ledger.spentUsd += usd;
    this.ledger.calls = (this.ledger.calls || 0) + 1;
    this.#writeLedger();
    this.#log({ t: new Date().toISOString(), runKey, path: subpath, model, status: r.status, inTok, outTok, usd, ms });
    res.writeHead(r.status, { "content-type": ct });
    res.end(buf);
  }
}
