# API reference

Everything `ghostwright` exports, written from the types in `src/` by `scripts/api-docs.mts` (`npm run docs`). Do not edit by hand: change the source comments and run it again. The [README](../README.md) and the [guides](README.md) explain how the parts fit together.

## Classes

### BrowsaCloud

*class*

| Member | What it is |
|---|---|
| `static toBrowsa(r: Recipe, secrets?: Secrets): Recipe` | The recipe as Browsa runs it: secret tokens by Browsa name, only in `type` steps. Refused when it holds a known secret value. |
| `push(name: string, o?: PushOptions): Promise<PushResult>` | Uploads a saved flow to Browsa as a recipe (secret tokens by name, never values). |
| `run<T = any>(name: string, params?: Record<string, unknown>, o?: { timeoutMs?: number; proxy?: Record<string, unknown>; push?: PushOptions; }): Promise<CloudRun<T>>` | Runs a flow on Browsa (pushing it first when the local flow is newer) and waits for the result. Paid with Browsa credits. |
| `robot(name: string, o?: RobotOptions): Promise<Record<string, any>>` | Creates the flow's robot, or updates the same robot in place. Its runs type the recipe's secrets by name from Browsa Secrets (the robots API attaches them from the recipe; it takes no secret_ids). |
| `unpush(name: string): Promise<{ robotId?: string; recipeId?: string; }>` | Deletes what push() and robot() made on Browsa for a flow: its robot (with the robot's runs history kept by Browsa for billing), then its recipe, and forgets the link. Already gone is fine. The local flow stays. |
| `linked(name: string): Link \| undefined` | The Browsa recipe and robot a flow was pushed to, if any. |

### Flow

A flow being recorded. Each call is the same as on Ghostwright and is saved as a step.

*class*

| Member | What it is |
|---|---|
| `name: string` |  |
| `goto(url: string): Promise<ActOutcome>` | Opens a URL; the first one is the flow's start page. |
| `act(instruction: string, o?: { variables?: Record<string, unknown>; }): Promise<ActOutcome>` | Does one thing, described in plain words, and records it as a step when it worked. |
| `extract<T = any>(instruction: string, schema: unknown, o?: { budget?: number; waitMs?: number; }): Promise<ExtractOutcome<T>>` | Reads data into a schema and records how; `meta.layer` says whether replays will need a model for it. |
| `observe(request: string): Promise<Candidate[]>` | Finds elements that match a request (not recorded). |
| `agent(task: string, o?: AgentOptions): Promise<AgentOutcome>` | Runs a multi-step task; every action of the run is recorded as a step. |
| `steps: Step[]` | The steps so far (scrubbed). |
| `save(o?: { repair?: 'auto' \| 'review' \| 'off'; maxRepairs?: number; }): Promise<Recipe>` | Writes the recipe to the store and stops recording. Saving again makes a new version. |
| `discard(): void` | Stops recording without saving. |

### Ghostwright

*class*

| Member | What it is |
|---|---|
| `static create(o?: GhostwrightOptions): Promise<Ghostwright>` | Opens the browser (local Chrome unless `browser` says otherwise) and returns a Ghostwright on its tab. A model whose key is missing is reported here, before any browser starts. |
| `page: Page` | the tab Ghostwright works in: a link that opens a new tab moves it there, as a person would follow it |
| `browserKind: 'local' \| 'cdp' \| 'browsa'` |  |
| `close(): Promise<void>` | Closes a browser Ghostwright started; detaches from one it attached to (`cdp()`), which keeps running. |
| `usage(): Usage` | Total model use so far. |
| `metrics(): { total: Usage; byKind: Record<string, Usage>; calls: CallRecord[]; }` | Every model call, and totals per kind of call. |
| `hasModel: boolean` | Is a model configured? Without one, run() replays and nothing is repaired. |
| `last(): LastCall \| null` | Debug info for the last model call: the view and prompt sent, the answer, the plan, tokens and cost. Secrets masked. |
| `goto(url: string): Promise<ActOutcome>` | Opens a URL. In a flow, %param% placeholders are filled from the flow's params. |
| `check(statement: string): Promise<CheckOutcome>` | Is a statement about the page true? One model call. `ok` is true only when the model says so and the words it cites are on the page. |
| `waitForReady(o?: { timeoutMs?: number; }): Promise<{ ready: boolean; ms: number; reason?: string; }>` | Waits until the page can be read: requests and layout quiet, content shown. |
| `tabs(): Promise<{ url: string; title: string; current: boolean; }[]>` | The open tabs with their real titles (the first is the tab Ghostwright works in). |
| `act(instruction: string, o?: { variables?: Record<string, unknown>; }): Promise<ActOutcome>` | Does one thing on the page, described in plain words. %name% in the instruction refers to variables or secrets; the model sees only the name. |
| `do(a: Action): Promise<ActOutcome>` | Runs an action you spell out yourself (no model), e.g. { action: "click", role: "button", name: "Save" }. |
| `observe(): Promise<{ view: string; elements: { id: number; role: string; name: string; state?: Record<string, string>; }[]; }>` | With no request: the page view (no model). With one: matching elements, best first, with locators. |
| `observe(request: string): Promise<Candidate[]>` | With no request: the page view (no model). With one: matching elements, best first, with locators. |
| `extract<T = any>(instruction: string, schema: unknown, o?: ExtractOptions): Promise<ExtractOutcome<T>>` | Reads data off the page into a schema (zod or JSON Schema). In a flow, it is compiled for replay when possible. |
| `agent(task: string, o?: AgentOptions): Promise<AgentOutcome>` | Works on a task step by step until done. In a flow, every step is recorded. The model never sees a step budget; on the last allowed step it must answer with what it has. A run that repeats itself or keeps doing nothing is stopped as "stalled". |
| `flow(name: string, o?: { params?: Record<string, unknown>; }): Promise<Flow>` | Starts recording a flow. Its steps become a recipe on save(). |
| `run<T = any>(name: string, params?: Record<string, unknown>, o?: RunOptions): Promise<RunResult<T>>` | Replays a saved flow: no model calls while nothing changed; one call to repair a broken step. |
| `rollback(name: string, version?: number): Recipe` | Makes an earlier version of a flow the active one. |
| `promote(name: string, version?: number): Recipe` | Makes a repaired version that waits for review (run().draft) the active one. |
| `push(name: string, o?: PushOptions): Promise<PushResult>` | Browsa cloud: uploads a saved flow as a Browsa recipe. Returns its id and price per run. |
| `runOnBrowsa<T = any>(name: string, params?: Record<string, unknown>, o?: { timeoutMs?: number; proxy?: Record<string, unknown>; push?: PushOptions; }): Promise<CloudRun<T>>` | Browsa cloud: runs a flow on Phantom (captchas solved server-side, repairs on Browsa). Pushes it first when needed. |
| `robot(name: string, o?: RobotOptions): Promise<Record<string, any>>` | Browsa cloud: creates or updates a robot (scheduled runs, rows, alerts) from a flow. |
| `unpush(name: string): Promise<{ robotId?: string; recipeId?: string; }>` | Browsa cloud: deletes the flow's robot and recipe on Browsa (the local flow stays). |

### PageSession

*class*

| Member | What it is |
|---|---|
| `static attach(page: Page, o?: SessionOptions): Promise<PageSession>` |  |
| `page: Page` |  |
| `context: BrowserContext` |  |
| `last: Snapshot \| null` |  |
| `captured: CapturedResponse[]` |  |
| `purchaseGuard: ((facts: ControlFacts[]) => string \| null) \| null` | refuses clicks and submits that would buy; null = allowed |
| `submitGuard: { hard: string; exact: string; action: string; } \| null` | patterns for the page-side check of forms a script submits during an action (see guard.ts) |
| `allowedOrigins: string[] \| null` | origins the page may navigate to; null = any |
| `allowFileUrls: boolean` | file: pages may be opened (off by default) |
| `secretOnScreen: boolean` | a field with a secret is in the viewport (hybrid screenshots are skipped then) |
| `schemeAllowed(url: string): boolean` | Navigation to anything but http(s) and about:blank is refused; file: only when allowed. |
| `enforceOrigins(): Promise<void>` | Enforces allowedOrigins before requests: document requests of every frame and popup to another origin are aborted, and popups that end up elsewhere are closed. |
| `secretInUrl: ((url: string, names: string[]) => boolean) \| null` | set by Ghostwright: does this URL carry a whole value of one of these typed secrets? |
| `installRouter(): Promise<void>` | One request router for the context (all frames and popups), installed for allowedOrigins or once a secret was typed. It aborts page loads to refused addresses, and GET page loads whose address carries a typed secret. It never throws: whatever goes wrong, the request is aborted. |
| `follow(page: Page, o?: SessionOptions): Promise<PageSession>` | A session for another tab of the same browser that keeps this one's rules and state: allowed origins, the purchase guard, the secrets typed so far, the request router. |
| `close(): Promise<void>` |  |
| `currentURL: string` |  |
| `urlOf(id: number): string` | The URL of the document element `id` lives in (a frame's own URL for frame content). |
| `documentEpoch: number` |  |
| `snapshot(expand?: number): Promise<Snapshot>` | Reads the page: the main document, readable frames and closed shadow roots. |
| `observe(o?: ObserveOptions): Promise<View>` |  |
| `busy(): Promise<string \| null>` | Is the page still at work: a request of the page (XHR or fetch) still in flight, however long it has taken, or a loading indicator on screen ("Running…", a spinner, aria-busy)? The reason, or null. |
| `pageStamp(): Promise<string>` | A short fingerprint of what the page shows (its text), to tell whether it changed between two moments. |
| `waitReady(timeoutMs?: number): Promise<{ ready: boolean; ms: number; reason?: string; }>` |  |
| `bodyText(): Promise<string>` | document.body.innerText of the main document. |
| `evalMain(expr: string): Promise<any>` | Evaluates an expression in the main isolated world. |
| `locators(id: number): Promise<Target \| null>` | The locator chain of an element of the last read. |
| `selectorOf(id: number): Promise<string \| null>` | One CSS selector for an element of the last read, from the top document: the frames it is in come first, joined with " >>> " ("iframe#pay >>> input[name=card]"). Null when unknown. |
| `resolve(t: Target): Promise<{ id: number; by: string; } \| null>` | Finds the element a locator chain points to, reading the page first. Null when nothing matches. |
| `domExtract(spec: { css?: string \| null; fields?: Record<string, string>; limit?: number; headers?: Record<string, string>; wantHeaders?: boolean; nested?: Record<string, { css: string; fields: Record<string, string>; }>; }): Promise<unknown>` | Reads `fields` under `css` in the main document (a recipe's DOM extract). |
| `complete(prefixes: string[]): Promise<Record<string, string \| null>>` | The full page text for each prefix of a value the view cut short (null when not one). |
| `pageJson(): Promise<{ sel: string; json: unknown; }[]>` |  |
| `nest(css: string, inner: Record<string, string[]>[][], keys: string[]): Promise<{ css: string; fields: Record<string, string>; texts: Record<string, string>; } \| null>` | A list inside each row of a list (see locate.js nest). |
| `holders(rows: Record<string, string[]>[], keys: string[]): Promise<{ css: string \| null; fields: Record<string, string>; texts: Record<string, string>; } \| null>` | Where values that are a part of an element's text sit (see locate.js holders). |
| `compileCss(rows: unknown, keys: string[]): Promise<{ css: string \| null; fields: Record<string, string>; } \| null>` |  |
| `act(a: Action): Promise<ActResult>` |  |

### Store

*class*

| Member | What it is |
|---|---|
| `dir: string` |  |
| `load(name: string): Recipe \| null` | The active version, or null. |
| `promote(r: Recipe): void` | Saves `r` as the active version and keeps a copy for rollback. |
| `saveDraft(r: Recipe, why: string): string` |  |
| `drafts(name: string): number[]` |  |
| `promoteDraft(name: string, version?: number): Recipe` | Makes a draft (a reviewed repair) the active version. |
| `versions(name: string): number[]` |  |
| `rollback(name: string, version?: number): Recipe` | Makes an earlier version the active one again. |
| `list(): { name: string; version: number; steps: number; }[]` |  |
| `tighten(): void` | Owner-only modes for a store an older version made (folders 0700, files 0600). |
| `traceFile(run: string): string` |  |

## Functions

### browsa

Phantom, Browsa's own browser, created through the Browsa API (npm package `browsa`).

*function*

```ts
browsa(o?: BrowsaOptions): BrowserSource
```

### browsaCaptcha

Token captchas solved by Browsa's captcha API (credits).

*function*

```ts
browsaCaptcha(o?: BrowsaCaptchaOptions): CaptchaSolver
```

### browsaSecret

A secret kept in Browsa Secrets (POST /v1/secrets). Its value never leaves Browsa: on Browsa (runOnBrowsa, robots) it is typed there, with Browsa's origin check. On this machine it can be typed only from `local`.

*function*

```ts
browsaSecret(name: string, o?: BrowsaSecretOptions): SecretRef
```

### cdp

Attaches to any browser that speaks the Chrome DevTools Protocol.

*function*

```ts
cdp(url: string, o?: { headers?: Record<string, string>; }): BrowserSource
```

### env

A secret read from an environment variable when it is typed. An UPPER_CASE variable name is also its Browsa Secrets name.

*function*

```ts
env(name: string, o: SecretOptions): SecretRef
```

### local

Launches the Chrome installed on this machine.

*function*

```ts
local(o?: LocalOptions): BrowserSource
```

### secret

A secret given as a value, or as a function called at each keystroke (sync or async): plug in any vault CLI or one-time code source.

*function*

```ts
secret(value: string | ((): string | Promise<string>), o: SecretOptions & { browsaName?: string; }) => SecretRef
```

## Errors

### ActionError

An action could not be done, or did nothing.

*error class*

| Member | What it is |
|---|---|
| `detail?: string \| undefined` |  |
| `code: string` |  |

### ChallengeError

A bot check that was not passed (full-page check, or a widget with no solver).

*error class*

| Member | What it is |
|---|---|
| `kind: string` |  |
| `url: string` |  |
| `code: string` |  |

### CostLimitError

The next model call would pass maxCostUsd.

*error class*

| Member | What it is |
|---|---|
| `spentUsd: number` |  |
| `limitUsd: number` |  |
| `estimateUsd?: number \| undefined` | the most the refused call could have cost, and for which model |
| `model?: string \| undefined` |  |
| `code: string` |  |

### FlowError

A flow replay failed. `code`: site_changed, invalid_output, blocked (a safety guard refused a step), needs_review (a repair waits as a draft), params_invalid, not_found.

*error class*

| Member | What it is |
|---|---|
| `step?: string \| undefined` |  |
| `code: string` |  |

### GhostwrightError

*error class*

| Member | What it is |
|---|---|
| `code: string` |  |

### ModelError

The model provider refused or failed a call. `code`: model_auth (key missing or wrong), model_rate_limit (429), model_not_found (no such model), model_unavailable (5xx), model_error. The message says what to fix.

*error class*

| Member | What it is |
|---|---|
| `model: string` |  |
| `statusCode?: number \| undefined` |  |
| `isRetryable?: boolean \| undefined` |  |
| `code: string` |  |

### NoModelError

*error class*

| Member | What it is |
|---|---|
| `code: string` |  |

### SecretNotAllowedError

A secret the instruction or task did not name. Nothing was typed.

*error class*

| Member | What it is |
|---|---|
| `secret: string` |  |
| `code: string` |  |

### SecretOriginError

A secret was about to be typed on an origin it is not allowed on. Nothing was typed.

*error class*

| Member | What it is |
|---|---|
| `secret: string` |  |
| `origin: string` |  |
| `code: string` |  |

## Options and results

### Action

*interface*

| Member | What it is |
|---|---|
| `action: string` | click, type, press, select, check, uncheck, hover, scroll, navigate, back, forward, reload, wait, upload, dialog |
| `id?: number \| undefined` |  |
| `role?: string \| undefined` |  |
| `name?: string \| undefined` |  |
| `text?: string \| undefined` |  |
| `textShown?: string \| undefined` | shown instead of `text` in the echo (secrets) |
| `secretText?: { resolve(url: string): Promise<string>; names: string[]; } \| undefined` | Text that holds secrets: read only at the keystroke, for the document the field is in (`resolve(url)` applies the secrets' origin rules). Typed into the element itself, never as key events to whatever has focus. |
| `clear?: boolean \| undefined` |  |
| `submit?: boolean \| undefined` |  |
| `keys?: string \| undefined` |  |
| `option?: string \| undefined` |  |
| `double?: boolean \| undefined` |  |
| `right?: boolean \| undefined` |  |
| `modifiers?: string[] \| undefined` |  |
| `x?: number \| undefined` |  |
| `y?: number \| undefined` |  |
| `dy?: number \| undefined` |  |
| `to?: string \| undefined` |  |
| `url?: string \| undefined` |  |
| `ms?: number \| undefined` |  |
| `for?: 'text' \| 'id-gone' \| 'url-change' \| undefined` |  |
| `timeout?: number \| undefined` |  |
| `files?: string[] \| undefined` |  |
| `accept?: boolean \| undefined` |  |

### ActOutcome

*interface*

| Member | What it is |
|---|---|
| `ok: boolean` |  |
| `action: string` | what was done, e.g. `click [6]` |
| `result: string` | what the page did: the diff, or the new page's view |
| `reason?: string \| undefined` |  |
| `meta: Meta` |  |

### AgentOptions

*interface*

| Member | What it is |
|---|---|
| `maxSteps?: number \| undefined` | the most actions (default 20); the model is not told the number |
| `mode?: 'dom' \| 'hybrid' \| undefined` |  |
| `secrets?: string[] \| undefined` | secrets the agent may type besides the ones the task names as %name% |
| `stall?: { repeatNote?: number; repeatStop?: number; idleNote?: number; idleStop?: number; } \| undefined` | the stall guard: a note to the model, then a stop, after the same action repeats or actions keep changing nothing |

### AgentOutcome

*interface*

| Member | What it is |
|---|---|
| `status: 'done' \| 'stalled' \| 'max_steps'` | done: the model answered; stalled: it repeated itself or nothing changed; max_steps: no answer in the steps allowed |
| `success: boolean \| 'unknown'` | the model's own verdict; "unknown" when it gave none or its answer was empty. Never read "unknown" as success. |
| `answer: unknown` |  |
| `steps: number` |  |
| `history: string[]` |  |
| `evidence: { url: string; title: string; lastEffect: string; cited?: { text: string; found: boolean; }; }` | where the run ended, what its last action did, and the words the model cited for its answer (found on the page or not) |
| `meta: Meta` |  |

### BrowsaCaptchaOptions

*interface*

| Member | What it is |
|---|---|
| `apiKey?: string \| undefined` | a Browsa API key; default BROWSA_API_KEY |
| `baseUrl?: string \| undefined` | default https://captcha.browsa.io |
| `timeoutMs?: number \| undefined` | give up after this long (default 120 s) |

### BrowsaOptions

*interface*

| Member | What it is |
|---|---|
| `apiKey?: string \| undefined` | a Browsa API key (agt_...); default BROWSA_API_KEY |
| `baseUrl?: string \| undefined` |  |
| `proxy?: Record<string, unknown> \| undefined` | Browsa's proxy network, e.g. { network: "auto" } or { network: "residential", country: "us" } |
| `country?: string \| undefined` |  |
| `ttl?: string \| undefined` |  |
| `agentId?: string \| undefined` | reuse a running browser instead of creating one |
| `keep?: boolean \| undefined` | keep the browser running after close() |

### BrowsaSecretOptions

*interface*

| Member | What it is |
|---|---|
| `field?: 'username' \| 'password' \| undefined` | for a login secret: which part to type |
| `totp?: boolean \| undefined` | a one-time code generated from the secret's seed |
| `local?: SecretRef \| undefined` | where the same value comes from on this machine (local runs and recording); without it, only Browsa can type it |

### BrowserSource

*interface*

| Member | What it is |
|---|---|
| `kind: 'local' \| 'cdp' \| 'browsa'` |  |
| `open(): Promise<OpenedBrowser>` |  |

### CallRecord

*interface*

| Member | What it is |
|---|---|
| `kind: string` | act, observe, extract, agent, repair, two-step |
| `model: string` |  |
| `inputTokens: number` |  |
| `outputTokens: number` |  |
| `cachedInputTokens: number` |  |
| `usd: number` |  |
| `priceAssumed: boolean` | true when the model's price is unknown and ASSUMED_PRICE was used |
| `estimated?: boolean \| undefined` | the call timed out or failed after it was sent: counted at its estimate |
| `ms: number` |  |
| `at: string` |  |

### Candidate

*interface*

| Member | What it is |
|---|---|
| `id: number` |  |
| `role: string` |  |
| `name: string` |  |
| `action: string` |  |
| `description: string` |  |
| `target: Target \| null` |  |
| `selector?: string \| undefined` | one CSS selector from the top document; an element in a frame comes after its frames: "iframe >>> button" |
| `frame?: string \| undefined` | the frame the element is in (its address without the query), when it is in one |

### CaptchaFound

*interface*

| Member | What it is |
|---|---|
| `kind: 'recaptcha' \| 'turnstile'` |  |
| `sitekey: string` |  |
| `url: string` |  |
| `invisible?: boolean \| undefined` |  |
| `action?: string \| undefined` |  |

### CaptchaSolver

*interface*

| Member | What it is |
|---|---|
| `solve(c: CaptchaFound): Promise<string>` | solves one widget and returns the token |

### CloudOptions

*interface*

| Member | What it is |
|---|---|
| `apiKey?: string \| undefined` | a Browsa API key (agt_...); default BROWSA_API_KEY |
| `baseUrl?: string \| undefined` | default https://browsa.io |
| `secrets?: Secrets \| undefined` | the local secrets: legacy tokens are mapped to Browsa names, and a push that holds a known value is refused |
| `fetch?: { (input: RequestInfo \| URL, init?: RequestInit): Promise<Response>; (input: string \| URL \| Request, init?: RequestInit): Promise<Response>; } \| undefined` | for tests |

### CloudRun

*interface*

| Member | What it is |
|---|---|
| `id: string` |  |
| `status: 'ok' \| 'failed' \| 'cancelled' \| 'queued' \| 'running'` |  |
| `output: T \| null` |  |
| `errorCode: string \| null` |  |
| `errorMessage: string \| null` |  |
| `repaired: boolean` |  |
| `repairedSteps: string[]` |  |
| `newVersion: number \| null` |  |
| `credits: number` |  |
| `durationMs: number \| null` |  |
| `raw: Record<string, any>` |  |

### CompatibleModel

*interface*

| Member | What it is |
|---|---|
| `provider: 'openai-compatible'` |  |
| `baseURL: string` |  |
| `model: string` |  |
| `apiKey?: string \| undefined` |  |
| `headers?: Record<string, string> \| undefined` |  |
| `price?: Price \| undefined` |  |

### Effect

What a step did when it was recorded; checked again on replay.

*interface*

| Member | What it is |
|---|---|
| `kind: 'navigate' \| 'change' \| 'value' \| 'none'` | navigate: a new document; change: the page changed; value: a field took the text; none: nothing visible |
| `path?: string \| undefined` | navigate: the path it went to (templated) |
| `state?: Record<string, string> \| undefined` | change: the state the target took (expanded, checked, pressed, selected) |

### Element

*interface*

| Member | What it is |
|---|---|
| `id: number` | Stable for the life of the document. Text blocks and rows have none (0). |
| `kind: ElementKind` |  |
| `role: string` |  |
| `name: string` |  |
| `tag?: string \| undefined` |  |
| `state?: Record<string, string> \| undefined` |  |
| `options?: string[] \| undefined` |  |
| `cells?: string[] \| undefined` |  |
| `header?: boolean \| undefined` |  |
| `box: Box` |  |
| `inViewport: boolean` |  |
| `where?: 'above' \| 'below' \| 'side' \| undefined` |  |
| `frame?: string \| undefined` |  |
| `shadow?: boolean \| undefined` |  |
| `parent?: number \| undefined` |  |
| `interactive?: boolean \| undefined` |  |
| `behindDialog?: boolean \| undefined` |  |
| `coveredBy?: number \| undefined` |  |
| `coveredDesc?: string \| undefined` |  |
| `key: string` | identity for diffs |
| `index: number` | position in a list or table, -1 when none |
| `count: number` | number of items of a list |
| `world?: string \| undefined` | where the element lives: the world key and its id there (internal) |
| `local?: number \| undefined` |  |
| `backend?: number \| undefined` | backend node id, for elements read from the accessibility tree |

### ExtractOutcome

*interface*

| Member | What it is |
|---|---|
| `data: T` |  |
| `meta: Meta & { layer: 'model' \| 'fetch' \| 'page_json' \| 'css'; }` |  |

### GenerateCallback

Your own model: called with the system text, the prompt and optional images; return the text.

*interface*

| Member | What it is |
|---|---|
| `id?: string \| undefined` |  |
| `price?: Price \| undefined` |  |
| `generate(req: ModelRequest): Promise<ModelReply \| string>` |  |

### GhostwrightEvent

*type*

```ts
type GhostwrightEvent = | { type: "model-call"; kind: string; model: string; inputTokens: number; outputTokens: number; usd: number; priceAssumed: boolean; ms: number; hosted: boolean } | { type: "captcha"; kind: string; where: "phantom" | "local"; status: "waiting" | "solving" | "passed" | "failed"; ms?: number } | { type: "repair"; flow: string; step: string; ok: boolean } | { type: "promote"; flow: string; version: number } | { type: "warning"; flow?: string; step?: string; message: string }
```

### GhostwrightOptions

*interface*

| Member | What it is |
|---|---|
| `browser?: BrowserSource \| undefined` | local() (default), cdp(url) or browsa({ apiKey }) |
| `model?: ModelSpec \| ModelSpec[] \| undefined` | "openai/gpt-5.6-luna", "anthropic/...", "google/...", "openrouter/...", "deepseek/...", an openai-compatible endpoint, or { generate }; a list = fallbacks in order. No default. |
| `fallbackModels?: ModelSpec[] \| undefined` | models tried in order when the model fails (after one retry on a transient error) |
| `modelTimeoutMs?: number \| undefined` | the longest one model call may take (default 60000 ms) |
| `allowPurchases?: boolean \| undefined` | allow clicks and submits that place an order, pay, subscribe or start a paid trial (default false) |
| `allowedOrigins?: string[] \| undefined` | origins the page may go to ("example.com", "*.example.com", "https://app.example.com"); others are refused |
| `allowFileUrls?: boolean \| undefined` | let pages open file: addresses (off: only http, https and about:blank are ever opened) |
| `modelApiKey?: string \| undefined` | the model provider's key (default: the provider's usual environment variable) |
| `price?: Price \| undefined` | US$ per million tokens, for models without a known price |
| `secrets?: Record<string, SecretRef> \| undefined` | named secrets: the model sees only %name% |
| `store?: string \| undefined` | the local store folder (default ".ghostwright") |
| `maxCostUsd?: number \| undefined` | stop before model spend passes this many US$; a model with no known price counts at ASSUMED_PRICE |
| `livePrices?: boolean \| undefined` | look up a model missing from the built-in price table in OpenRouter's public catalog, cached a day (default true) |
| `cacheDir?: string \| undefined` | where the price catalog is cached (default ~/.cache/ghostwright, or GHOSTWRIGHT_CACHE_DIR) |
| `debug?: boolean \| ((line: string) => void) \| undefined` | print each step (true) or pass a function; silent by default |
| `captcha?: CaptchaSolver \| undefined` | local token captchas: browsaCaptcha({ apiKey }) |
| `maxCaptchaSolves?: number \| undefined` | the most local captcha solves in this Ghostwright (default 5; each costs credits) |
| `onEvent?: ((e: GhostwrightEvent) => void) \| undefined` | events: model-call, captcha, repair, promote, warning |
| `warnings?: boolean \| undefined` | print warnings (an extract that did not compile) with console.warn (default true) |
| `viewBudget?: number \| undefined` | view budget in approximate tokens (default 2000) |
| `selfHeal?: boolean \| undefined` | one more model call when an action fails or does nothing (default true) |
| `followNewTabs?: boolean \| undefined` | when an action opens a new tab, go on working in that tab, as a person would (default true); false stays in the first tab |
| `settle?: Partial<SettleConfig> \| undefined` |  |
| `browsaApiKey?: string \| undefined` | Browsa cloud calls (push, runOnBrowsa, robot): default BROWSA_API_KEY |
| `browsaBaseUrl?: string \| undefined` |  |

### LocalOptions

*interface*

| Member | What it is |
|---|---|
| `headless?: boolean \| undefined` |  |
| `channel?: string \| undefined` | "chrome" (default: the Chrome installed on this machine), "msedge", or a path to a browser binary |
| `executablePath?: string \| undefined` |  |
| `args?: string[] \| undefined` |  |
| `viewport?: { width: number; height: number; } \| undefined` |  |
| `userDataDir?: string \| undefined` | a profile folder to keep cookies between runs |
| `sandbox?: boolean \| undefined` | Chrome's sandbox (on by default). Some Linux containers cannot run it (no user namespaces): pass false there, knowing pages then run unsandboxed. |

### Meta

*interface*

| Member | What it is |
|---|---|
| `modelCalls: number` |  |
| `inputTokens: number` |  |
| `outputTokens: number` |  |
| `usd: number` |  |
| `ms: number` |  |

### ModelClient

*interface*

| Member | What it is |
|---|---|
| `id: string` | "provider/model" for reports |
| `price?: Price \| undefined` |  |
| `hosted?: boolean \| undefined` | true when the model runs on a hosted service that bills per step (see the billing hook in README) |
| `priceSource?: 'unknown' \| 'given' \| 'table' \| 'live' \| undefined` | where the price came from: given (yours), table (built in), live (the catalog), or unknown |
| `generate(req: ModelRequest): Promise<ModelReply>` |  |

### ModelReply

*interface*

| Member | What it is |
|---|---|
| `text: string` |  |
| `usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; } \| undefined` |  |

### ModelRequest

*interface*

| Member | What it is |
|---|---|
| `system: string` |  |
| `prompt: string` |  |
| `images?: Uint8Array<ArrayBufferLike>[] \| undefined` | PNG screenshots (hybrid agent mode) |
| `maxOutputTokens?: number \| undefined` |  |
| `signal?: AbortSignal \| undefined` | aborted when the call's time is up |

### ModelSpec

*type*

```ts
type ModelSpec = string | GenerateCallback | CompatibleModel | { languageModel: unknown; id?: string; price?: Price }
```

### Price

US dollars per million tokens.

*interface*

| Member | What it is |
|---|---|
| `input: number` |  |
| `output: number` |  |
| `cachedInput?: number \| undefined` |  |

### PushOptions

*interface*

| Member | What it is |
|---|---|
| `repairMode?: 'auto' \| 'review' \| 'off' \| undefined` | "auto" (default): Browsa repairs and promotes; "review": repairs wait for you; "off" |
| `keepOld?: boolean \| undefined` | keep the recipe an earlier push made (default: delete it when nothing uses it) |

### PushResult

*interface*

| Member | What it is |
|---|---|
| `recipeId: string` |  |
| `name: string` |  |
| `version: number` |  |
| `priceCredits: number` |  |
| `secretNames: string[]` | the Browsa Secrets the recipe types, by name (save them with POST /v1/secrets) |
| `unchanged?: boolean \| undefined` | true when Browsa already had this exact recipe from the last push: nothing was uploaded |
| `replaced?: { recipeId: string; deleted: boolean; keptFor?: string; } \| undefined` | the recipe this push replaced, and whether it was deleted (it is kept while a robot or schedule still uses it) |

### Recipe

*interface*

| Member | What it is |
|---|---|
| `name: string` |  |
| `version: number` |  |
| `params: JSONSchema` |  |
| `output: JSONSchema` |  |
| `start_url?: string \| undefined` |  |
| `steps: Step[]` |  |
| `fallbacks?: Record<string, string[]> \| undefined` |  |
| `assertions?: { after: string; expr: string; }[] \| undefined` |  |
| `repair?: { mode?: 'auto' \| 'review' \| 'off'; max_steps?: number; } \| undefined` |  |
| `meta?: Record<string, unknown> \| undefined` |  |

### RobotOptions

*interface*

| Member | What it is |
|---|---|
| `rows?: Record<string, unknown>[] \| undefined` | one params object per row; each scheduled run does every row |
| `schedule?: string \| number \| { interval_seconds: number; at?: string; weekday?: number; tz?: string; } \| null \| undefined` | "15m", "6h", "1d", "7d", seconds, or { interval_seconds, at?, weekday?, tz? }; null removes it |
| `alerts?: { field: string; op: string; value?: unknown; }[] \| undefined` | alert rules, e.g. [{ field: "items.price", op: "lt", value: 100 }] |
| `destinations?: Record<string, unknown>[] \| undefined` | where results go, e.g. [{ type: "webhook", url }] or [{ type: "email", to }] |
| `settings?: Record<string, unknown> \| undefined` | { model?, proxy?, browser? }; omitted = Auto |
| `description?: string \| undefined` |  |
| `name?: string \| undefined` | robot name on Browsa (default: the flow name) |

### RunOptions

*interface*

| Member | What it is |
|---|---|
| `repair?: boolean \| undefined` | repair broken steps with the model (default: the recipe's repair mode, "auto") |
| `maxRepairs?: number \| undefined` | at most this many repaired steps in one run (default: recipe repair.max_steps, else every step: a redesign may break them all) |

### RunResult

*interface*

| Member | What it is |
|---|---|
| `output: T` |  |
| `version: number` |  |
| `promoted?: number \| undefined` | set when a repaired version was promoted by this run |
| `draft?: { version: number; why: string; } \| undefined` | set when the repaired version waits for review (gw.promote(name) to use it) and why |
| `repaired: string[]` |  |
| `steps: StepReport[]` |  |
| `meta: Meta` |  |

### SecretOptions

*interface*

| Member | What it is |
|---|---|
| `origins: string[]` | hosts or origins the value may be typed on: "app.example.com", "https://app.example.com", "*.example.com" |

### SecretRef

*interface*

| Member | What it is |
|---|---|
| `kind: 'secret'` |  |
| `source: string` | where the value comes from, for messages (never the value) |
| `origins: string[]` |  |
| `browsaName?: string \| undefined` | the name in Browsa Secrets ([A-Z0-9_]); the recipe token uses it |
| `field?: 'username' \| 'password' \| undefined` | a part of a Browsa login secret |
| `totp?: boolean \| undefined` | a one-time code: the local value is the base32 seed |
| `local: boolean` | false when the value exists only in Browsa Secrets |
| `resolve(): string \| Promise<string>` | read at the keystroke; may be async (a vault CLI, a one-time code source) |

### Step

*interface*

| Member | What it is |
|---|---|
| `id: string` |  |
| `kind: StepKind` |  |
| `url?: string \| undefined` |  |
| `target?: Target \| undefined` |  |
| `text?: string \| undefined` |  |
| `value?: string \| undefined` |  |
| `pages?: number \| undefined` |  |
| `keys?: string \| undefined` |  |
| `submit?: boolean \| undefined` |  |
| `clear?: boolean \| undefined` |  |
| `for?: { text?: string; url?: string; target?: Target; } \| undefined` |  |
| `timeout_ms?: number \| undefined` |  |
| `in_page?: true \| undefined` |  |
| `method?: 'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| undefined` |  |
| `headers?: Record<string, string> \| undefined` |  |
| `body?: unknown` |  |
| `mutation?: boolean \| undefined` |  |
| `optional?: boolean \| undefined` |  |
| `save_as?: string \| undefined` |  |
| `from?: 'page_json' \| 'page' \| 'saved' \| undefined` |  |
| `source?: string \| undefined` |  |
| `how?: { jsonpath?: string; css?: string; fields?: Record<string, string>; model?: boolean; into?: string; limit?: number; allow_empty?: boolean; match?: Record<string, string>; headers?: Record<string, string>; pick?: string; nested?: Record<string, { css: string; fields: Record<string, string>; match?: Record<string, string>; }>; } \| undefined` |  |
| `schema_ref?: 'output' \| undefined` |  |
| `expr?: string \| undefined` |  |
| `goal?: string \| undefined` |  |
| `effect?: Effect \| undefined` | Ghostwright: the check after the action |
| `state?: 'checked' \| 'unchecked' \| undefined` | Ghostwright: check / uncheck / hover on top of click / wait |
| `hover?: boolean \| undefined` |  |
| `dialog?: 'accept' \| 'dismiss' \| undefined` | Ghostwright: this step's action opens a JavaScript dialog (alert, confirm), answered this way |
| `dialog_text?: string \| undefined` | Ghostwright: the text typed into a prompt() when accepted ({{param}}, or a secret token) |
| `after_ms?: number \| undefined` | Ghostwright: how long after the step before it this step was done when recorded (ms); a replay waits about that long for its element before it gives up |
| `output_schema?: JSONSchema \| undefined` | Ghostwright: the output schema of this extract |

### StepReport

*interface*

| Member | What it is |
|---|---|
| `id: string` |  |
| `kind: string` |  |
| `layer: 'model' \| 'fetch' \| 'page_json' \| 'css' \| 'replay' \| 'repair'` |  |
| `ms: number` |  |
| `by?: string \| undefined` |  |
| `repaired?: boolean \| undefined` |  |
| `skipped?: boolean \| undefined` |  |

### Target

A locator chain for one element, in the recipe's target shape.

*interface*

| Member | What it is |
|---|---|
| `role?: string \| undefined` |  |
| `name?: string \| undefined` |  |
| `css?: string \| undefined` |  |
| `text?: string \| undefined` |  |
| `xpath?: string \| undefined` |  |
| `near?: string \| undefined` | the heading, legend or label before the element |
| `within?: string \| undefined` | the text of the element's own item (its card, its row), recorded when other controls on the page say the same of themselves |
| `frame?: string \| undefined` |  |

### Usage

*interface*

| Member | What it is |
|---|---|
| `modelCalls: number` |  |
| `inputTokens: number` |  |
| `outputTokens: number` |  |
| `usd: number` |  |
| `usdAssumed: number` | the part of usd counted at ASSUMED_PRICE (models with no known price) |
| `modelMs: number` | time spent waiting for models |

### View

*interface*

| Member | What it is |
|---|---|
| `state: 'ok' \| 'challenge' \| 'dialog'` |  |
| `url: string` |  |
| `title: string` |  |
| `scrollX: number` |  |
| `scrollY: number` |  |
| `viewportW: number` |  |
| `viewportH: number` |  |
| `pageW: number` |  |
| `pageH: number` |  |
| `scope: 'page' \| 'viewport'` |  |
| `loading?: boolean \| undefined` |  |
| `elements: Element[]` |  |
| `total: number` |  |
| `totalInteractive: number` |  |
| `modal?: number \| undefined` |  |
| `dialog?: JSDialog \| undefined` |  |
| `challenge?: Challenge \| undefined` |  |
| `captchaWidgets?: CaptchaWidget[] \| undefined` |  |
| `frames?: FrameInfo[] \| undefined` |  |
| `focus?: number \| undefined` |  |
| `degraded: number` |  |
| `truncated?: boolean \| undefined` |  |
| `tokens: number` |  |
| `collectMs: number` |  |
| `text: string` |  |
| `snap?: Snapshot \| undefined` | the snapshot the view was built from (internal) |

## Values

### PRICES

Prices in US$ per million tokens, for usage() and maxCostUsd. The current generation is a snapshot of OpenRouter's public model catalog (it lists the providers' own prices) taken on PRICES_AS_OF. A model missing here is looked up in the live catalog (cached for a day, see livePrices); pass `price` to set it yourself.

*value*

```ts
PRICES: Record<string, Price>
```
