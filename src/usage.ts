// What model calls cost: tokens, dollars, time; and the maxCostUsd cap.
import { CostLimitError } from "./errors.js";
import { ASSUMED_PRICE, type ModelClient, type Price } from "./model/index.js";
import { estimateTokens } from "./engine/text.js";

export interface CallRecord {
  /** act, observe, extract, agent, repair, two-step */
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  usd: number;
  /** true when the model's price is unknown and ASSUMED_PRICE was used */
  priceAssumed: boolean;
  /** the call timed out or failed after it was sent: counted at its estimate */
  estimated?: boolean;
  ms: number;
  at: string;
}

/** The output limit of every model call (also what the cap assumes a call may use). */
export const MAX_OUTPUT_TOKENS = 2000;

export interface Usage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** the part of usd counted at ASSUMED_PRICE (models with no known price) */
  usdAssumed: number;
  /** time spent waiting for models */
  modelMs: number;
}

export const emptyUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0, usdAssumed: 0, modelMs: 0 });

export function addUsage(u: Usage, r: CallRecord): void {
  u.modelCalls++;
  u.inputTokens += r.inputTokens;
  u.outputTokens += r.outputTokens;
  u.usd += r.usd;
  if (r.priceAssumed) u.usdAssumed += r.usd;
  u.modelMs += r.ms;
}

const priceOf = (m: ModelClient): { p: Price; assumed: boolean } => (m.price ? { p: m.price, assumed: false } : { p: ASSUMED_PRICE, assumed: true });

export class Meter {
  calls: CallRecord[] = [];
  total = emptyUsage();
  constructor(private maxCostUsd?: number) {}

  /** The most a call can cost: its prompt plus the whole output limit. */
  estimate(model: ModelClient, promptText: string, maxOut = MAX_OUTPUT_TOKENS): number {
    const { p } = priceOf(model);
    return (estimateTokens(promptText) * p.input + maxOut * p.output) / 1e6;
  }

  /** Refuses a call that could pass the cap (an unknown price counts at ASSUMED_PRICE). */
  before(model: ModelClient, promptText: string, maxOut = MAX_OUTPUT_TOKENS): void {
    if (this.maxCostUsd == null) return;
    const est = this.estimate(model, promptText, maxOut);
    if (this.total.usd + est > this.maxCostUsd) {
      const { p, assumed } = priceOf(model);
      throw new CostLimitError(this.total.usd, this.maxCostUsd, { model: model.id, estimateUsd: est, price: p, assumed, maxOut });
    }
  }

  /** A call that timed out or failed after it was sent: the provider may bill it, so it counts at the estimate. */
  charged(kind: string, model: ModelClient, promptText: string, ms: number): CallRecord {
    return this.record(kind, model, { inputTokens: estimateTokens(promptText), outputTokens: MAX_OUTPUT_TOKENS }, promptText, "", ms, true);
  }

  record(kind: string, model: ModelClient, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined, promptText: string, replyText: string, ms: number, estimated = false): CallRecord {
    // a provider's numbers are clamped: finite and not below zero
    const n = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
    const inT = n(usage?.inputTokens, estimateTokens(promptText));
    const outT = n(usage?.outputTokens, estimateTokens(replyText));
    const cached = Math.min(n(usage?.cachedInputTokens, 0), inT);
    const { p, assumed } = priceOf(model);
    const usd = ((inT - cached) * p.input + cached * (p.cachedInput ?? p.input) + outT * p.output) / 1e6;
    const r: CallRecord = { kind, model: model.id, inputTokens: inT, outputTokens: outT, cachedInputTokens: cached, usd, priceAssumed: assumed, ms, at: new Date().toISOString(), ...(estimated ? { estimated: true } : {}) };
    this.calls.push(r);
    addUsage(this.total, r);
    return r;
  }
}
