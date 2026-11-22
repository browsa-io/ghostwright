# Where it runs

Ghostwright drives a browser over the Chrome DevTools Protocol. Which browser is your choice, and the rest of the API is the same on all three. No browser extension and no browser download.

```ts
import { local, cdp, browsa } from "ghostwright";

local({ headless: false, userDataDir: "./profile" })   // the Chrome on this machine
cdp(wsUrl)                                              // a browser you started, by its exact ws:// address: drives its first open tab
browsa({ apiKey, proxy: { network: "auto" } })          // Phantom, Browsa's own browser (npm i browsa)
```

`cdp()` takes over the browser's current tab: the first open tab of its default context (a new tab only when there is none), with whatever that tab has open and its cookies. Attach only to a browser you started yourself, for this: launch it with `--remote-debugging-port=0` (a free port), read the exact `ws://` address it prints, and pass that. A fixed port such as 9222 may be another program's browser. `close()` disconnects and leaves that browser running.

Frames from other sites and closed shadow roots are part of the view: elements inside them get ids like any other and take clicks and typing.

A complete script that attaches to a running browser and acts with no model: [`examples/any-cdp.mjs`](../examples/any-cdp.mjs).

## Models

```ts
model: "openai/gpt-5.6-luna"                  // OPENAI_API_KEY
model: "anthropic/claude-sonnet-5.5"          // ANTHROPIC_API_KEY
model: "google/gemini-3.1-flash-lite"         // GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY
model: "openrouter/deepseek/deepseek-v4.1-flash"  // OPENROUTER_API_KEY
model: "deepseek/deepseek-chat"               // DEEPSEEK_API_KEY
model: { provider: "openai-compatible", baseURL: "http://localhost:11434/v1", model: "qwen3" }
model: { generate: async ({ system, prompt, images, signal }) => callMyModel(system, prompt) }
model: ["google/gemini-3.1-flash-lite", "openai/gpt-5.6-luna"]   // a list: fallbacks in order
```

- There is no default model. Without one, `run()` replays and everything else that needs a model throws `NoModelError`.
- Each call has `modelTimeoutMs` (default 60 s) and one retry on a transient error (a timeout, a rate limit, a 5xx, a dropped connection); then the next model of the list (or `fallbackModels`) is asked.
- Calls run at temperature 0 and never send a frequency or presence penalty: ids and names must be copied exactly.

A missing key is reported before anything starts: `Ghostwright.create()` throws `ModelError` `model_key_missing` naming the variable to set, and no browser is opened.

## Browsa cloud

These calls use Browsa's cloud and are paid with Browsa credits. Everything above is free and runs on your machine.

```ts
const gw = await Ghostwright.create({ browsaApiKey: process.env.BROWSA_API_KEY });

await gw.push("travel-books");                         // { recipeId, priceCredits, secretNames }
const r = await gw.runOnBrowsa("travel-books", { category: "Poetry" });
// on Phantom, captchas solved server-side, repairs on Browsa; r.output, r.credits
await gw.robot("travel-books", { rows: [{ category: "Poetry" }, { category: "Travel" }], schedule: "1d", alerts: [{ field: "titles", op: "changed" }] });
await gw.unpush("travel-books");                       // deletes its robot and recipe on Browsa; the local flow stays
```

- **Deleting**: `gw.unpush(name)` deletes the flow's robot (if `robot()` made one) and its Browsa recipe, and forgets the link in `browsa.json`. A robot or recipe made some other way is deleted with `DELETE /v1/robots/{id}` or `DELETE /v1/recipes/{id}`, or in the dashboard. Past runs stay in your Browsa history (billing).

- **Secrets**: a pushed recipe carries only tokens by name (`{{secret:APP_LOGIN:password}}`); save the values once in Browsa Secrets (`POST /v1/secrets`). `runOnBrowsa()` names them in `secret_ids`; robot runs attach them from the recipe. No value is ever sent: a push that would hold one is refused, and so is a token outside a `type` step.
- **Transport**: API keys go only over https (`baseUrl` and the `BROWSA_*` URLs; plain http only to localhost), and `browsa()` connects only to a browser endpoint on Browsa's own domain.
- **Versions**: pushing a flow that has not changed since its last push uploads nothing and returns the same recipe (`unchanged: true`). Browsa takes a recipe upload as a new recipe, so each push of a changed flow makes a new Browsa recipe (`runOnBrowsa()` pushes when the local flow is newer). The flow's robot is moved to it in place (same robot, same id). The recipe it replaces is deleted when no robot and no schedule uses it any more; otherwise it is kept and `push()` says what still uses it (`replaced.keptFor`). `push(name, { keepOld: true })` keeps it anyway.
