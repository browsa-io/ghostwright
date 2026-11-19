// Typed errors. Each has a short `code` for programs to branch on.

export class GhostwrightError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GhostwrightError";
    this.code = code;
  }
}

/** A bot check that was not passed (full-page check, or a widget with no solver). */
export class ChallengeError extends GhostwrightError {
  kind: string;
  url: string;
  constructor(kind: string, url: string, message?: string) {
    super("challenge", message ?? `${kind} bot check on ${url}`);
    this.name = "ChallengeError";
    this.kind = kind;
    this.url = url;
  }
}

/** The next model call would pass maxCostUsd. */
export class CostLimitError extends GhostwrightError {
  spentUsd: number;
  limitUsd: number;
  /** the most the refused call could have cost, and for which model */
  estimateUsd?: number;
  model?: string;
  constructor(spent: number, limit: number, c?: { model: string; estimateUsd: number; price: { input: number; output: number }; assumed: boolean; maxOut: number }) {
    super("cost_limit", c
      ? `the next call to ${c.model} could cost up to $${c.estimateUsd.toFixed(4)} (the prompt plus ${c.maxOut} output tokens at $${c.price.input} in / $${c.price.output} out per million${c.assumed ? ", an assumed price: pass price for this model" : ""}); spent $${spent.toFixed(4)} of maxCostUsd $${limit}`
      : `model spend would pass maxCostUsd (spent $${spent.toFixed(4)} of $${limit})`);
    this.name = "CostLimitError";
    this.spentUsd = spent;
    this.limitUsd = limit;
    this.estimateUsd = c?.estimateUsd;
    this.model = c?.model;
  }
}

/** A secret was about to be typed on an origin it is not allowed on. Nothing was typed. */
export class SecretOriginError extends GhostwrightError {
  secret: string;
  origin: string;
  constructor(secret: string, origin: string) {
    super("secret_origin", `secret %${secret}% is not allowed on ${origin}; nothing was typed`);
    this.name = "SecretOriginError";
    this.secret = secret;
    this.origin = origin;
  }
}

export class NoModelError extends GhostwrightError {
  constructor(what: string) {
    super("no_model", `${what} needs a model: pass model to Ghostwright.create()`);
    this.name = "NoModelError";
  }
}

/**
 * The model provider refused or failed a call. `code`: model_auth (key
 * missing or wrong), model_rate_limit (429), model_not_found (no such
 * model), model_unavailable (5xx), model_error. The message says what to fix.
 */
export class ModelError extends GhostwrightError {
  model: string;
  statusCode?: number;
  isRetryable?: boolean;
  constructor(code: string, message: string, model: string, o: { statusCode?: number; isRetryable?: boolean; cause?: unknown } = {}) {
    super(code, message);
    this.name = "ModelError";
    this.model = model;
    this.statusCode = o.statusCode;
    this.isRetryable = o.isRetryable;
    if (o.cause !== undefined) (this as any).cause = o.cause;
  }
}

/** An action could not be done, or did nothing. */
export class ActionError extends GhostwrightError {
  constructor(message: string, public detail?: string) {
    super("action_failed", message);
    this.name = "ActionError";
  }
}

/** A flow replay failed. `code`: site_changed, invalid_output, blocked (a safety guard refused a step), needs_review (a repair waits as a draft), params_invalid, not_found. */
export class FlowError extends GhostwrightError {
  step?: string;
  constructor(code: string, message: string, step?: string) {
    super(code, message);
    this.name = "FlowError";
    this.step = step;
  }
}
