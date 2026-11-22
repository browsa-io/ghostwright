<p align="center">
  <a href="https://browsa.io/ghostwright">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/browsa-io/ghostwright/main/assets/logo-dark.svg">
      <img alt="Ghostwright" src="https://raw.githubusercontent.com/browsa-io/ghostwright/main/assets/logo-light.svg" width="360">
    </picture>
  </a>
</p>

<p align="center"><b>Browser agents that replay without a model.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/ghostwright"><img alt="npm" src="https://img.shields.io/npm/v/ghostwright?color=1a8f4c"></a>
  <a href="https://github.com/browsa-io/ghostwright/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/browsa-io/ghostwright/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/browsa-io/ghostwright/ci.yml?branch=main&label=ci"></a>
  <img alt="Node 20 or newer" src="https://img.shields.io/node/v/ghostwright">
  <a href="https://browsa.io"><img alt="Made by Browsa" src="https://img.shields.io/badge/made%20by-Browsa-1a8f4c"></a>
</p>

<p align="center">
  <a href="https://github.com/browsa-io/ghostwright/tree/main/docs">Docs</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="https://github.com/browsa-io/ghostwright/blob/main/docs/api.md">API reference</a> ·
  <a href="#benchmark">Benchmark</a>
</p>

Ghostwright is a TypeScript SDK for browser agents you run more than once. Tell it what to do on a page in plain words; a model does it the first time, and Ghostwright saves what worked. Later runs replay the saved flow in a real browser, check that each step had its effect, and call the model only to repair a step when the site changed. A flow whose reads compile to page reads replays with **no model calls** at all; a read that takes judgment, or has a shape that does not compile, still asks the model once per run, and `flow.save()` tells you which.

```js
const flow = await gw.flow("books", { params: { category: "Travel" } });
await flow.goto("https://books.toscrape.com/");
await flow.act("open the %category% category");          // the model picks the link, once
await flow.extract("every book title", Titles);
await flow.save();

const run = await gw.run("books", { category: "Poetry" });   // replay: run.meta.modelCalls is 0
```

## Why

- **Replay with 0 model calls, for flows whose extracts compile.** Actions always replay without a model, on new inputs too. An extract does when it compiles to a page read (one object of plain values, a list of such objects (each may hold one more list of such objects), or a list of plain values, read from the main page (not from inside a frame)); `meta.layer` and a warning from `flow.save()` say when one does not. When a site changes, the broken step is repaired with the model and kept only after the whole flow passes, or held as a draft for your review.
- **Done means done.** A click that changed nothing, a field that did not take the text, a step that landed somewhere else: each is a failure, not a success. The benchmark below counts how often a run says "done" when it was not.
- **Secrets by reference, locked to their sites.** The model sees `%password%`, never the value. The value is typed only into a field on an origin you allowed, and never reaches a prompt, a trace or a saved flow.
- **Runs where your browser is.** Your local Chrome, any CDP endpoint, or Browsa's cloud browsers. Any model: OpenAI, Anthropic, Google, OpenRouter, DeepSeek, or an OpenAI-compatible endpoint. MIT licensed.

## Quickstart

**1. No key needed: see a page the way a model will.**

```sh
npx ghostwright view https://books.toscrape.com
```

It opens the Chrome installed on your machine (nothing is downloaded) and prints the page as a short list of what a person can see and act on.

**2. Record a flow and replay it.** This step calls a model, so it needs a model key: `OPENAI_API_KEY` for the default model below, or pick another provider with `GHOSTWRIGHT_MODEL` (`google/gemini-3.1-flash-lite` with `GEMINI_API_KEY`, `anthropic/...` with `ANTHROPIC_API_KEY`, `openrouter/...` with `OPENROUTER_API_KEY`, `deepseek/...` with `DEEPSEEK_API_KEY`).

```sh
mkdir try-ghostwright && cd try-ghostwright
npm init -y && npm install ghostwright
npx ghostwright init            # writes quickstart.mjs
OPENAI_API_KEY=sk-... node quickstart.mjs
```

`quickstart.mjs` is the script below, exactly as `init` writes it (its body is a function so that the test suite can run it against a local page). The `.mjs` name matters: Ghostwright is an ES module and the script uses `import` and top-level `await`, which a plain `.js` file in a new `npm init -y` project does not allow (there, set `"type": "module"` in `package.json`, or keep the `.mjs` name; in TypeScript use `.mts` or `"type": "module"`). `require("ghostwright")` works on Node 20.19+ and 22.12+.

```js
// Record a flow once with a model, then replay it with 0 model calls.
//
//   OPENAI_API_KEY=sk-... node quickstart.mjs
//
// Another provider: GHOSTWRIGHT_MODEL=google/gemini-3.1-flash-lite (GEMINI_API_KEY),
// anthropic/... (ANTHROPIC_API_KEY), openrouter/... (OPENROUTER_API_KEY), deepseek/... (DEEPSEEK_API_KEY).
// It drives the Chrome installed on this machine; nothing is downloaded.
import { fileURLToPath } from "node:url";
import { Ghostwright } from "ghostwright";

const Titles = { type: "object", properties: { titles: { type: "array", items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } }, required: ["titles"] };

export async function main(o = {}) {
  const gw = await Ghostwright.create({ model: process.env.GHOSTWRIGHT_MODEL || "openai/gpt-5.6-luna", ...o.options });
  try {
    // run 1: the model reads the page and picks the link
    const flow = await gw.flow("books", { params: { category: "Travel" } });
    await flow.goto(o.url ?? "https://books.toscrape.com/");
    await flow.act("open the %category% category");
    const first = await flow.extract("every book title", Titles);
    await flow.save(); // .ghostwright/flows/books.json
    console.log(`recorded: ${first.data.titles.length} titles with ${gw.usage().modelCalls} model calls`);

    // every later run: another category, no model
    const run = await gw.run("books", { category: o.other ?? "Poetry" });
    console.log(`replayed: ${run.output.titles.length} titles with ${run.meta.modelCalls} model calls in ${run.meta.ms} ms`);
    for (const t of run.output.titles.slice(0, 5)) console.log("  " + t.title);
    return { recorded: first.data, replayed: run.output, replayCalls: run.meta.modelCalls };
  } finally {
    await gw.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
```

What it printed here on 2026-11-21 (one real run with `openai/gpt-5.6-luna`; the time is one sample and depends on the site and your connection, see the medians and ranges below):

```
recorded: 11 titles with 2 model calls
replayed: 19 titles with 0 model calls in 1074 ms
  A Light in the Attic
  The Black Maria
  Shakespeare's Sonnets
  Olio
  You can't bury them all: Poems
```

Without a key nothing is started: `Ghostwright.create()` says `No API key for openai/gpt-5.6-luna: set OPENAI_API_KEY in the environment, or pass modelApiKey to Ghostwright.create().`

More scripts to run, each covered by a test: [`examples/`](examples) (read a list into a schema, sign in with secrets, attach to a running browser over CDP). They ship in the npm package: `node node_modules/ghostwright/examples/extract-list.mjs`.

## Benchmark

<!-- bench:start -->
Our own task set, on local fixture pages, with checks written in code. Measured 2026-11-22 with `openai/gpt-5.6-luna`, Ghostwright 0.2.0 (commit `3c82037e879c`, installed from the packed tarball), 321 task runs, every one listed in [`bench/suite/results/ghostwright-0.2.0-2026-11-22.jsonl`](bench/suite/results/ghostwright-0.2.0-2026-11-22.jsonl).

| | Ghostwright 0.2.0 | Ghostwright 0.1.0 (2026-11-19) |
|---|---|---|
| Single tasks done right (40 act, 25 extract, 12 observe) | 77/77 (100%) | 63/77 (82%) |
| Input tokens per single task | 871 | 682 |
| Flows that pass when replayed (20 flows, runs 2 to 10) | 180/180 (100%) | 152/180 (84%) |
| Replays that made no model call (every flow in this set has extracts that compile) | 180/180 (100%) | 153/180 (85%) |
| Model calls in all 180 replays | 0 | 27 |
| Redesigned pages: flows repaired (of those that passed before the redesign) | 20/20 (100%) | 14/18 (78%) |
| Runs that said "done" when the check failed (redesigned pages) | 0/20 (0%) | 5/20 (25%) |
| Secrets leaked in 3 attack tasks | 0 of 3 | 0 of 3 |

This is the second full run of this commit. The first, the same day, passed 309 of 321 ([`ghostwright-0.2.0-2026-11-22-run1.jsonl`](bench/suite/results/ghostwright-0.2.0-2026-11-22-run1.jsonl)): replays 169/180. While `f11-orders` was being recorded the model provider was slow (one call timed out after 60 s, others took 16 s instead of about 2), and the recording clicked a link that did not open the order it was asked to; `act()` reported it done, so its 9 replays repeated it, and the recording run counts as a failure too. Two other replays never started because the browser the harness launched for them closed. Recording `f11-orders` again three times right after passed every time. Both runs are published; the table shows the second.

Read it for what it is. These are fixture pages built to cover what goes wrong on real sites, with one model and one run per single task. 0.2.0 was built against the failures this set found in 0.1.0, so a clean run says those are fixed, not that nothing is left to find: it is a regression measure, not a pass rate on the open web. An independent held-out check before release found failures this set did not (listed in the CHANGELOG); they are fixed and tested, but were not added to this set. In this set every flow's extracts compile, which is why no replay calls a model; a flow with an extract that does not compile calls it once per run for that extract. The method, every failure with its reason, and how to run it with your own key (`npm run bench`): [bench/suite/README.md](bench/suite/README.md).
<!-- bench:end -->

## First run vs replay on public sites

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/browsa-io/ghostwright/main/assets/speed-dark.svg">
  <img alt="Median seconds per run. books-category: run 1 8.0 s with 2 model calls, replay 2.7 s with 0. books-detail: 5.4 s with 2, replay 4.1 s with 1. quotes-tag: 11.7 s with 2, replay 2.8 s with 0. login: 12.2 s with 4, replay 5.3 s with 0." src="https://raw.githubusercontent.com/browsa-io/ghostwright/main/assets/speed-light.svg" width="880">
</picture>

| Flow | Run 1 (records), median | Runs 2-5 (replay), median and range | Model calls per run: run 1 / replay | Model cost per run: run 1 / replay | Passed: run 1, replays |
|---|---|---|---|---|---|
| `books-category` books.toscrape.com: open a category, read every book with its price | 8.0 s | 2.7 s (0.6 s to 3.8 s) | 2 / 0 | $0.0018 / $0 | 3/3, 12/12 |
| `books-detail` books.toscrape.com: open a book from the front page, read its price and whether it is in stock | 5.4 s | 4.1 s (1.4 s to 5.3 s) | 2 / 1 | $0.00081 / $0.00029 | 3/3, 12/12 |
| `quotes-tag` quotes.toscrape.com: open a tag, read every quote with its author | 11.7 s | 2.8 s (1.5 s to 2.9 s) | 2 / 0 | $0.0023 / $0 | 3/3, 12/12 |
| `login` the-internet.herokuapp.com: sign in with the site's public demo account, read the message | 12.2 s | 5.3 s (5.2 s to 7.9 s) | 4 / 0 | $0.00091 / $0 | 3/3, 12/12 |

**How this was measured** (2026-11-21, Ghostwright 0.2.0 at commit `1a4d20134cd1`, [`bench/first-vs-replay.mts`](bench/first-vs-replay.mts), raw runs in [`bench/results/first-vs-replay-2026-11-21.json`](bench/results/first-vs-replay-2026-11-21.json), which records the version and commit measured):

- Run 1 records the flow with `google/gemini-3.1-flash-lite` through OpenRouter. Runs 2-5 call `run()` on it with the same inputs and default options (a broken step would be repaired with the model, and counted). Each of 3 trials records every flow again under a new name. Medians are over 3 recordings and 12 replays; the range is the fastest and the slowest replay.
- Wall clock from the first call to the result, in one headless local Chrome that was already open, on an Apple M2 laptop, over the internet to the public sites. Site load time is included, and it varies from run to run and day to day: quote a median with its range, not the fastest run. Most of the login replay is the site itself.
- Model cost is what `usage()` reports: the provider's token counts at the SDK's price table. The whole benchmark (60 runs, 60 passed) made 42 model calls for $0.021.
- One flow keeps one model call per replay: `books-detail` reads "in stock" as a yes or no, which takes judgment, so that extract asks the model each run and `flow.save()` warns about it. (With 0.1 the login message needed a model on every replay too; it now compiles to a page read.)
- The same measurement with 0.1 code on 2026-11-19 is in [`bench/results/first-vs-replay-2026-11-19.json`](bench/results/first-vs-replay-2026-11-19.json). That file says 0.1.0; the code measured that day already had the replay fix released as 0.1.1.

Reproduce it: `OPENROUTER_API_KEY=... npx tsx bench/first-vs-replay.mts`, then `npx tsx bench/render-chart.mts` to redraw the chart. `--new-params` replays with other inputs (another category, book or tag) instead of the same ones.

## How it works

Describe a step in plain words once. Ghostwright asks a model, does it with real input, checks that it worked, and saves it as a recipe. Every later run replays the recipe, with **0 model calls** when its extracts compiled (see "Extracts that compile"). When the site changes, the one broken step is repaired with one model call, and the fix is kept only after the whole flow passes.

- Works on your local Chrome, any CDP endpoint, or Phantom, Browsa's own browser. No browser extension.
- Any model: OpenAI, Anthropic, Google, OpenRouter, DeepSeek, any OpenAI-compatible endpoint, or your own function.
- Small views: a page is a compact list of what a person can see, inside a token budget (`viewBudget`, 2,000 by default); the benchmark reports the tokens each task took.
- Secrets: the model sees `%password%`, never the value.
- A purchase guard on by default: clicks and submits that look like an order, a payment or a paid subscription are refused unless you allow them. It is a filter on words and context, not a proof (see Purchases).
- MIT licensed.

### Without a flow

`act`, `extract` and the rest work on their own too; only a flow is saved and replayed.

```ts
const gw = await Ghostwright.create({ model: "openai/gpt-5.6-luna" });
await gw.goto("https://books.toscrape.com");
await gw.act("open the Travel category");
const { data } = await gw.extract("every book with its price", z.object({ books: z.array(z.object({ title: z.string(), price: z.number() })) }));
console.log(data.books, gw.usage());
await gw.close();
```

## Record once, replay with no model

```ts
const flow = await gw.flow("travel-books", { params: { category: "Travel" } });
await flow.goto("https://books.toscrape.com/");
await flow.act("open the %category% category");
await flow.extract("every book title", z.object({ titles: z.array(z.object({ title: z.string() })) }));
await flow.save();                                   // .ghostwright/flows/travel-books.json

const run = await gw.run("travel-books", { category: "Poetry" });
run.output;               // the titles
run.meta.modelCalls;      // 0
```

What a replay does for each step:

1. **Finds the element** with the step's locators, used together. What names it decides: its role and name, its text, a selector by id or attribute. What tells it apart from controls named alike comes next: the text of its own item (`within`: "Model A 13-inch…" for one of four "Compare" boxes) and the heading before it. Position (an `nth-of-type` selector, the XPath) only breaks a tie that is left and never decides for an element that has a name, so after a reorder a step finds the same item in its new place, and when the item is gone it fails and is repaired instead of acting on its neighbour. A locator that holds a param (`{{category}}`) must match with this run's value: `{ category: "Nonexistent" }` fails instead of clicking the first item. A field for a secret must match by its label or selector, never by position.
   An element that comes late (a button a script adds, a result that loads) is waited for before the step fails: about one and a half times what the step took when the flow was recorded, at least 1.5 s and at most 15 s. A compiled extract waits the same way for its content.
2. **Acts with trusted input** (real mouse and key events), after checking that nothing covers the element. A JavaScript dialog the step opened when recorded is answered the same way (accepted or dismissed, with the text typed into a `prompt()`: a param's value of this run, or a secret, typed only on its origins); one the flow has no answer for fails the step.
3. **Checks the effect.** A click that left the page as it was, a field that did not take the text, a toggle that did not end up open, checked or pressed as it did, or a page that did not navigate like it did when recorded is a failure, not a success. A toggle already in the state the step left it in (a section already open) is not clicked again. A link that opens a new tab is followed into it, as a person would. A step that navigated must land on the path it went to when recorded (digits, and the parts that held a param, may differ; on a page the params shaped, one more part may).
4. **Repairs** a failed step with the model on the current page (told what the step did when it was recorded); each step may be repaired once per run. An instruction that took several actions was recorded as several steps; its repair carries the instruction out again and replaces them together. The repaired recipe becomes a new version only when the whole run passes (output valid, assertions true), and only when it differs from the version it repaired. `gw.rollback(name)` goes back. A step a safety guard refused (purchase, origin, secret rules) is never repaired: the run fails with `FlowError` `blocked`.

A repair stays a draft for you to review (`run().draft`, then `gw.promote(name)`) when it goes to a host the flow never used. A repair that would type a secret into a field the step did not type it into types nothing: the run fails with `FlowError` `needs_review` and the repaired step waits as a draft until `gw.promote(name)`. Flows that type secrets keep every repair for review unless saved with `flow.save({ repair: "auto" })`. A repair may type only the secrets the broken step typed.

A flow with no model configured never calls one: a broken step fails with `FlowError` (`site_changed`).

### Extracts that compile

After a model extract in a flow, Ghostwright tries to build an extractor that needs no model, in this order:

1. the JSON the page fetched while you worked (replayed as an in-page `fetch` with your cookies; `GET` only),
2. JSON embedded in the page (`__NEXT_DATA__`, `application/ld+json`),
3. CSS selectors (text, or the `title`, `alt` or `aria-label` attribute when that holds the full value),
4. a selector plus a pattern, for a value that is a part of an element's text ("Kestrel Sling — $45", "Guests: 3"); the pattern is held in place by the label and punctuation around the value.

**The shapes that compile** (3 and 4): one object of plain values, a list of such objects (each may hold one more list of such objects), or a list of plain values, read from the main page (not from inside a frame). Booleans, deeper nesting, values the model worded differently from the page, and content inside frames stay `model` extracts.

**A compiled table read checks its columns.** The header of each column a value was read from is saved with the step; a replay that finds another header there (columns reordered) fails the step and repairs it, instead of returning the values of another column.

It keeps one only when the data it reads matches the model's answer: same items, in the same order, every field equal. Only these differences are allowed, all of them in text fields:

- **Typography**: curly quotes and straight quotes are the same, so are dashes and hyphens, `…` and `...`, and runs of spaces or line breaks. Text is compared after Unicode NFKC normalisation.
- **Text cut short**: the view shows at most 80 characters of a name and ends a longer one with `…`, and sites cut titles with `...`. A model can only copy what it saw, so its value ending in `…` or `...` (at least 10 characters before it) matches the page's full text when that text starts with it.

Numbers must be equal, booleans and nulls too, and nothing else is loose. When an extractor is kept, `extract()` returns what it read (the page's own, complete text), and replays read the same way. `meta.layer` says which one was kept: `fetch`, `page_json`, `css`, or `model` when none matched; `flow.save()` warns (a `warning` event, and `console.warn` unless `warnings: false`) about each extract that stays `model`, since it calls the model on every run.

An extract reads every row of a table and every item of a list (the view an act uses folds long ones). Outside a flow, `extract()` also returns full text: a value the model copied cut short is completed from the page when exactly one text there starts with it.

## The API

```ts
Ghostwright.create(options)                            // see Options below

gw.goto(url)
gw.act("click the sign in button", { variables })      // { ok, action, result, reason, meta }
gw.observe()                                           // the page view, no model
gw.observe("the search box")                           // candidates with locators and one CSS selector from the top document (frames: "iframe >>> button")
gw.extract("what to read", zodSchema | jsonSchema)     // { data, meta }; a JSON Schema is checked before any model call
gw.extract("what to read", schema, { html })           // from HTML of your own (or { file }): a separate context, scripts off, offline
gw.check("the cart shows 2 items")                     // { ok, evidence } from one model call
gw.agent("task", { maxSteps, mode: "dom" | "hybrid" }) // { status, success, answer, evidence, history, meta }
gw.do({ action: "click", role: "button", name: "Save" })  // an exact action, no model; text "%password%" types that secret

gw.waitForReady({ timeoutMs })   // requests and layout quiet, content shown
gw.tabs()                        // open tabs with their real titles
gw.last()                        // the last model call: prompt (view included), answer, plan, tokens, $; secrets masked

gw.flow(name, { params })  ->  flow.goto / act / extract / observe / agent / save({ repair }) / discard(); flow.steps
gw.run(name, params, { repair, maxRepairs })   // replay (each step may be repaired once): { output, version, repaired, promoted?, draft?, steps, meta }
gw.promote(name)           // use the draft a repair left for review
gw.rollback(name, version?)
gw.usage(), gw.metrics()   // tokens, $, ms; per kind of call and per call
gw.page                    // the page, for your own code
gw.close()

gw.push(name), gw.runOnBrowsa(name, params), gw.robot(name, o), gw.unpush(name)   // Browsa cloud, see below
```

Actions (`do()` and what the model picks): `click` (also double, right, at x,y), `type` (clear, submit), `press` (`Control+A`, `Tab Tab Enter`), `select`, `check`, `uncheck`, `hover`, `scroll`, `navigate`, `back`, `forward`, `reload`, `wait`, `upload`, `dialog`. The model is offered all of these except `upload`, `back`, `forward`, `reload` and `wait` in `act()` (`agent()` also has `back` and `wait`), including `dialog` when a JavaScript alert, confirm or prompt is open: the view then shows the dialog's text and nothing else. The model can also `expand` a list or table the view folded (`… 30 more items (expand [8])`) to act on an item in it, `hover` a menu that opens on hover (then act in it), and scroll `to` `"top"`, `"bottom"` or a share such as `"50%"`, of the page or inside a scrolling box. Date and time fields take what a person writes ("24 December 2026", "2:30 pm") and are filled in their own format. A click must have an effect: something new to read, or, on a control, a change in the page or a request sent (a star that only fills in). A click that left the page as it was is a failure, and so is a field that does not hold the text when it is read back after typing.

`act()` result: `ok` is true when every action taken had its effect and the model had nothing left to do for the instruction. After an action that opens something (a menu, a list), leaves a JavaScript dialog open, is a hover the instruction did not ask for, or is the first part of an instruction with several parts ("hover the picture and open the link"), the model is asked what is left, up to three more actions; it answers "none" when the instruction is done. A confirmation box the instruction did not ask to confirm ("Remove the draft" opening "This cannot be undone") is left open for your next instruction. That closes the common cases of "ok after the first half"; it is still the model that judges whether an instruction is complete, so for a result that matters check it (`check()`, an extract, or your own assertion). A scroll that moved nothing is `ok: false` ("no effect"). A target below the fold is acted on, not just scrolled to (an `act` that only scrolled is `ok: false`, unless the instruction asks to scroll). When a safety guard refuses the action (a purchase, an origin, a secret rule, a popup to a refused origin), `ok` is false with the guard's `reason`, and the model is not asked for another way.

### Options

| option | default | |
|---|---|---|
| `browser` | `local()` | `local()`, `cdp(url)` or `browsa({ apiKey })` |
| `model` | none | a model, or a list (fallbacks in order) |
| `fallbackModels` | `[]` | models tried after the model fails |
| `modelApiKey` | the provider's env variable | the first model's key |
| `modelTimeoutMs` | `60000` | the longest one model call may take |
| `price` | table, live catalog | US$ per million tokens for the first model |
| `livePrices`, `cacheDir` | `true`, `~/.cache/ghostwright` | the live price lookup and its cache |
| `maxCostUsd` | none | stop before model spend passes this |
| `secrets` | `{}` | named secrets, see Secrets |
| `store` | `".ghostwright"` | the folder for flows, drafts and traces |
| `allowPurchases` | `false` | allow order, pay and subscribe actions |
| `allowedOrigins` | any | origins pages may load from |
| `allowFileUrls` | `false` | let pages open `file:` addresses |
| `selfHeal` | `true` | one more model call when an action fails (never after a guard refused it) |
| `followNewTabs` | `true` | when an action opens a new tab, go on working in that tab |
| `viewBudget` | `2000` | view size in approximate tokens |
| `settle` | | how long to wait for a page to go quiet |
| `captcha`, `maxCaptchaSolves` | none, `5` | the local token captcha solver and its cap |
| `debug` | `false` | print each step, or a function that gets each line |
| `onEvent` | | `model-call`, `captcha`, `repair`, `promote`, `warning` events |
| `warnings` | `true` | print warnings (an extract that did not compile) with `console.warn` |
| `browsaApiKey`, `browsaBaseUrl` | `BROWSA_API_KEY` | Browsa cloud calls |

### Errors

Wrong options (a schema that is not a JSON Schema too) throw a `TypeError` at once, before any model call. Everything else is a `GhostwrightError` with a `code`: `no_model`, `cost_limit`, `secret_origin`, `secret_not_named`, `secret_unset` (an env variable not set), `secret_in_recipe`, `challenge`, `action_failed`, `browser_unreachable` (`cdp()`), `browser_missing` and `browser_sandbox` (`local()`, with what to pass); `FlowError` (`site_changed`, `blocked`, `needs_review`, `secret_missing`: the flow types a secret this Ghostwright does not have, `no_model`: an extract that did not compile needs a model, `invalid_output`, `params_invalid`, `not_found`); `ModelError` (`model_key_missing`: no key for the model, said before a browser starts) and from the provider (`model_auth`: the key is missing or wrong, the message names the env variable; `model_rate_limit`: 429; `model_not_found`; `model_unavailable`: 5xx; `model_error`).

Dropdowns: a native `<select>` is chosen with the keyboard; for a custom one, when a click opens a menu or list, Ghostwright asks once more on what opened and picks the option.

### check()

`gw.check(statement)` asks the model whether a statement about the page is true and which words on the page show it. `ok` is true only when the model says so **and** those words are on the page; `evidence` has the words, whether they were found, the URL and the element.

### agent()

`agent()` in `dom` mode works over the view; `hybrid` also sends a screenshot and accepts clicks by position. Inside a flow, every step of an agent run is recorded, so one agent run gives you a flow that replays.

- **Verdict**: `success` is `true`, `false` or `"unknown"`. A missing verdict, an empty answer ("done", "N/A", the task read back), or a claim of success without words found on the page is `"unknown"`, never success. `evidence` has the final URL, the last action's effect, and the words the model cited with `found`.
- **What the model reads back**: after each action, what it did: navigated (where), changed, no change, or for typing what the field now holds (secrets masked).
- **Stall guard**: the same action on the same page twice, or three actions in a row that change nothing, adds a note to the model; at four repeats or six idle actions the run ends with `status: "stalled"`. Tune with `stall: { repeatNote, repeatStop, idleNote, idleStop }`.
- **Budget**: the model is never told how many steps it has. On the last allowed step it must answer with what it found; otherwise the run ends `max_steps`.

## Safety

- **Purchases**: refused below the model (whoever chose the action: a model, `do()`, or a replayed flow) unless `allowPurchases: true`. It is a filter on words and context, tested on the cases in `test/e2e/v02-guard.test.ts` and `test/e2e/held-guard.test.ts`, not a proof.
  - *Always refused*: labels that only commit money, as whole words: "Place your order", "Buy now", "Pay now", "Pay €12,50", "Complete purchase", "Charge my card", "Donate", "Place bid" (English, including the EU "Order with obligation to pay", and German, French, Spanish, Italian, Portuguese, Dutch, Polish, Swedish, Turkish, Russian, Chinese, Japanese, Korean); a bare "Checkout", "Order", "Pay" or "Buy" on a submit button; any submit of a form with card fields (cc-number, cvc, expiry); an unlabelled submit of an order or payment form.
  - *Refused only where money is in play*: "Buy", "Purchase", "Pay", "Order", "Checkout" on any clickable, "Subscribe", "Confirm", "Book now", "Complete booking", "Reserve", "Reserve my place", "Send payment", "Authorize $40", "Tip $5", "Top up", "Join now", "Upgrade", "Renew", "Get it today", a free trial. Money is in play when a price or total (also written `25,00 €`) stands in the control's label, its form or its own card, anywhere on a small page (up to about 1,500 characters of text), when the form has card fields, or on a checkout, cart, payment, billing or pricing address.
  - *Refused where the page says the card is charged now*: a generic submit ("Continue", "Confirm", "Submit", "Next") in a form, or on a small page, that states an amount "will be charged", "is taken from your card", "billed today" or "due today"; and Enter in a form that has no submit button and states a price.
  - *Never refused*: a field you type into ("Confirm password"), a checkbox or radio button ("Pay with card", a newsletter box), "Add to cart", "Proceed to checkout", "Book a demo", "Order by date", "Order history", "Booking history", "Payment history", "Donated items", "Tip of the day", "Top up history", "Join our newsletter", "Authorize app access", "Upgrade your browser", a newsletter "Subscribe", an appointment "Confirm" on a page with no price, a "Continue" where the page says the card is not charged.
  - *How it is applied*: to a click by id or by point (also inside a frame), to Enter, NumpadEnter or Space anywhere in a key sequence, to a newline in typed text, and to the submit controls of the form (`form.elements`, so `form="..."` buttons count). A purchase form that a page script submits while an action runs (a click on a box whose handler calls `requestSubmit()`) is stopped in the page before the page's own handlers see it.
  - *Not covered*: a script that sends the order itself (a `fetch` from a click handler, `form.submit()`, a timer), and a label that is only an image. There is no guard for other irreversible actions ("Delete account"): keep those out of instructions you do not mean.
- **Addresses**: only `http:`, `https:` and `about:blank` are opened, before and after every action: `file:`, `chrome:`, `devtools:`, `view-source:`, `data:`, `javascript:`, `blob:` and `filesystem:` are refused, and a page that ends up on one is left. `allowFileUrls: true` allows `file:`.
- **Origins**: `allowedOrigins: ["shop.example.com", "*.example.com"]` stops page loads elsewhere before the request is sent, for every frame and popup; `goto()` and `navigate` are refused, a popup that ends up elsewhere (or stays blank) is closed and the action that opened it returns `ok: false` with the reason, and a click that tried to leave fails. Subresources (images, scripts, API calls) are not filtered.
- **Local Chrome** runs with its sandbox on; `local({ sandbox: false })` turns it off where a container cannot run it.
- Ghostwright reads the page from an isolated world and never writes attributes, styles or scripts into it. Two exceptions: with the purchase guard on, a purchase form that a script submits while an action runs is stopped there (see Purchases), and the local token captcha solver (`captcha: browsaCaptcha()`), which puts the solved token into the widget's response field, as the widget itself would.

## Browsers

```ts
import { local, cdp, browsa } from "ghostwright";

local({ headless: false, userDataDir: "./profile" })   // the Chrome on this machine
cdp(wsUrl)                                              // a browser you started, by its exact ws:// address: drives its first open tab
browsa({ apiKey, proxy: { network: "auto" } })          // Phantom, Browsa's own browser (npm i browsa)
```

`cdp()` takes over the browser's current tab: the first open tab of its default context (a new tab only when there is none), with whatever that tab has open and its cookies. Attach only to a browser you started yourself, for this: launch it with `--remote-debugging-port=0` (a free port), read the exact `ws://` address it prints, and pass that. A fixed port such as 9222 may be another program's browser. `close()` disconnects and leaves that browser running.

Frames from other sites and closed shadow roots are part of the view: elements inside them get ids like any other and take clicks and typing.

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

## Secrets

```ts
import { env, secret, browsaSecret } from "ghostwright";

secrets: {
  email: env("APP_EMAIL", { origins: ["app.example.com"] }),
  password: secret(async () => readFromMyVault("app"), { origins: ["app.example.com"] }),   // read at create and at each keystroke
  code: browsaSecret("APP_TOTP", { totp: true, local: env("APP_TOTP_SEED", { origins: ["app.example.com"] }) }),
}
await gw.act("type %password% into the password field");
```

- The model sees `%password%`, and only the secrets the instruction names: `act()` may type the secrets written as `%name%` in its instruction, `agent()` the ones in its task or listed in `agent(task, { secrets: [...] })`. Any other is refused (`SecretNotAllowedError`).
- The value is read once when Ghostwright starts (so it is masked from the first prompt, even on a page that shows it before anything is typed) and again when it is typed (a function is called each time, so any vault CLI or one-time code source plugs in), for the document the field is in, and only when that document's origin is allowed (the frame's own origin counts; the origin is checked before the value is read). It is then put into the field itself by one call on that element, which checks again, in the page, that the element is still there and its document still has that origin. No key goes to whatever has focus, so a page that moves focus, opens a frame over the field or redirects on focus gets nothing. If the page rejects the value, keys are sent one at a time, each after checking focus, element, origin and document.
- Refused: a field on another origin (`SecretOriginError`), a field whose `maxlength` is shorter than the value, a search box, a field in a form that says it sends its fields in the address (`method="get"`, or a submit button with `formmethod="get"`), and an editable region that is not a text field. A `<form>` with no `method` is allowed: single-page apps post those from a script.
- Once a secret was typed, a page load whose address carries its whole value (any encoding or case) is stopped before the request is sent, whatever sent it: a form with no method submitted natively (the browser sends it as GET), a script, a link.
- A field holding a secret is shown as `value hidden`, with no value and no length (a password field too). In `hybrid` mode no screenshot is sent while such a field, or any text showing a secret's value, is in view.
- Values are scrubbed from every prompt, result, trace and `last()`: the whole value as typed, JSON-escaped, URL- and form-encoded, in any letter case, and any run of 12 or more of its characters as written (a value cut short or shown in part). Placeholders and recipe tokens are never touched, so a label like "Password" stays when the password is "SuperSecretPassword!". A saved recipe is never rewritten: a locator that holds a value is dropped from its step (the others stay), and any other text holding one stops the save (`secret_in_recipe`).
- A recipe stores Browsa Secrets tokens: `{{secret:APP_EMAIL}}`, `{{secret:NAME:password}}`, `{{totp:NAME}}`. The name is the `browsaSecret()` name, an UPPER_CASE `env()` variable name, or the local name upper-cased. So the same file runs here (the token maps back to your local secret) and on Browsa (Browsa Secrets types it).
- `browsaSecret("NAME")` is a secret kept in Browsa Secrets. Its value never leaves Browsa: flows that type it run on Browsa; pass `local:` to type it on this machine too. `totp: true` makes a 6-digit RFC 6238 code from the seed at the keystroke.
- Plain values go in `params` or `variables`: the model sees them, and the recipe stores `{{name}}` so the next run can use another value.

## Cost, usage, traces

- Every call returns `meta: { modelCalls, inputTokens, outputTokens, usd, ms }`; `gw.usage()` adds them up and `gw.metrics()` lists every model call.
- **Prices**: a built-in table of the current models (`PRICES`, a snapshot of OpenRouter's public catalog of providers' prices taken on `PRICES_AS_OF`, 2026-11-19). A model missing from it is looked up in that live catalog (no key is sent; cached a day in `~/.cache/ghostwright/prices.json`, outside the store you commit; `cacheDir` or `GHOSTWRIGHT_CACHE_DIR` moves it; a cache dated in the future is ignored; `livePrices: false` turns the lookup off). Only a dated or `-latest` variant borrows a listed model's price (`gpt-5-pro` is not `gpt-5`). An OpenAI-compatible endpoint (a gateway or proxy) that serves a listed model by its usual id (`openai/gpt-5.6-luna`) is priced as that model. `price: { input, output }` (US$ per million tokens) sets it yourself.
- **maxCostUsd** stops before a model call that could pass the cap (`CostLimitError`), counting the prompt plus the whole output limit (2,000 tokens). The error says what that call could cost and at which price. A model the cap refuses passes to the next model of the list, so a cheap fallback still runs. A call that timed out counts at that estimate (it was sent and may be billed), and a provider's token counts are clamped to finite, non-negative numbers. A model whose price is still unknown is counted at `ASSUMED_PRICE` ($10 in, $50 out per million tokens: the most expensive regular model of the snapshot), and those calls say `priceAssumed`; `usage().usdAssumed` is the part counted that way. "Pro" reasoning tiers cost more: pass `price` for those.
- Each flow recording and run writes `.ghostwright/traces/<flow>-<run>.jsonl`, one line per step (secrets scrubbed). Nothing is printed unless `debug: true`, except `flow.save()` warnings (`warnings: false` turns them off).
- `onEvent` receives `model-call` (with `hosted` for a model service that bills per step), `captcha`, `repair`, `promote` and `warning` events.

## Captchas

- On Phantom (`browsa()`), Browsa's in-session solver works on the server; Ghostwright reports a `captcha` event and waits.
- Locally, `captcha: browsaCaptcha({ apiKey })` solves token captchas (reCAPTCHA, Turnstile) through captcha.browsa.io, paid with Browsa credits: each widget once per page, at most 2 per page and `maxCaptchaSolves` (5) per Ghostwright.
- Otherwise a full-page bot check raises `ChallengeError`.

## The store and the recipe format

```
.ghostwright/
  flows/<name>.json        the version run() uses
  flows/<name>/v<N>.json   every version, for rollback
  drafts/                  repairs waiting for review, or that failed
  traces/                  one JSONL file per run
  browsa.json              which Browsa recipe and robot each flow was pushed to
```

Commit it to git. A flow is saved in Browsa's recipe format (`schema/recipe-v1.json`), so the same file runs here and on Browsa. Files are written for your user only (0600, folders 0700), and a store an older version made is tightened to those modes when Ghostwright starts. A flow's name always comes from the name you run it by, never from the file, so a shared file cannot write elsewhere. Compiled request URLs are saved without query parameters that look like credentials (`token`, `key`, `sig`, `session`, a JWT or a long random value).

CLI: `npx ghostwright init` (writes `quickstart.mjs`), `view <url>` (no model), `list`, `run <flow> key=value`, `rollback <flow>`, `extract <url|file> "<what>" [--schema file.json]`, `--version`.

The format, field by field: [docs/recipe-format.md](docs/recipe-format.md).

## Run it on Browsa

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

## Coming from other browser-agent SDKs

- `act`, `observe` and `extract` with a zod schema work the way you expect; `%name%` placeholders are supported, and secrets are pinned to origins.
- Replays need no cache service: `flow()` and `run()` keep recipes on disk, and they replay on any browser, with no model when their extracts compiled.
- `agent()` is here, in `dom` and `hybrid` modes, and its runs can be saved as flows.
- Attaching to a browser needs no extension: anything with a CDP endpoint works.

## Limits of 0.2

- TypeScript only; the Python client comes next.
- `agent()` has no coordinate-only mode for computer-use models yet.
- `check()` always calls the model; a passing check is not yet compiled into a replay assertion.
- An extract whose answer takes judgment (a yes or no read off a sentence, a summary) does not compile: it asks the model on every run, and `flow.save()` warns about it. Values that stand on the page, whole or as a part of a text, do compile.
- A click whose only effect comes later than the page takes to go quiet (a timer of half a second or more with no request and no change before it) is reported as having no effect. `wait` for what it brings, or act on the result.
- A value read by pattern (`how.match`) and the `within` locator are read by local replays; pushed to Browsa, such an extract asks the model and `within` is left out.
- Locally, stock Chrome faces bot walls like any automated browser. Attaching goes through Playwright, which a page can notice; Phantom is the browser for protected sites.
- The purchase guard reads labels and forms. A button whose only label is an image with no text, outside any order or card form, is not recognised.
- `allowedOrigins` filters page loads, not subresources: an image or script on an allowed page can still reach another origin.
- Scrubbing catches a part of a value from 12 characters on, as written: a shorter part, or a part in another letter case, is not masked (it is too often an ordinary word). It does not catch a page that shows a secret transformed (spaced out, reversed, re-encoded some other way); such a page already holds the value, on an origin you allowed.
- The purchase guard judges the control that is acted on and stops purchase forms that a script submits during the action (`requestSubmit()`). A script that sends the order by `fetch`, `form.submit()` or later on a timer is not caught; only a check on the network requests themselves would catch that.
- After an action, a request that is still running after 2.5 s is no longer waited for (`settle: { longLived: 2500 }`). An `extract()` that then reads nothing waits up to 15 s and reads once more when the page was at work when its view was taken (a request in flight, "Running…", a spinner), is at work now, or shows something else than when its view was taken (`extract(..., { waitMs })`, 0 turns it off). A page whose text keeps changing on its own (a clock) can cost one more model call for an empty answer. An `act()` on something that has not arrived yet can still fail: call `gw.waitForReady()` first, or raise `settle.longLived`.
- `act()`'s `ok` rests on the model's judgment that nothing is left to do. When its reason for "nothing left" says the work is not finished ("still processing", "not enabled yet"), Ghostwright waits for the page and asks once more; a second "not yet" is `ok: false`. An instruction with several parts that the model calls done after the first is still possible.
- The effect check knows that an action did something, not that it acted on the element the instruction meant. When the model picks the wrong link (seen once in the benchmark, while the model provider was slow and failing), the act is reported done, and a flow recorded that way replays the mistake. Check a result that matters (`check()`, an extract, an assertion in the flow) before saving the flow.
- Extracts inside frames, lists nested deeper than one level, and slotted shadow DOM content do not compile, so they ask the model on every run. Sortable table headers that are plain text with a script listener are not listed as elements to click.
- Types: `require("ghostwright")` type-checks under `module: nodenext` (TypeScript 5.8 or newer); under `module: node16` with `skipLibCheck: false` the CommonJS declaration file reports TS1479.
- A secret the instruction names can still be steered by a page into another field on an allowed origin (a comment box that is posted): the origin check holds, the choice of field is the model's. Keep `origins` narrow and name secrets only in instructions that need them.

## License

MIT. The page engine is Browsa's pageview, open-sourced with this package.

Guides, the recipe format and the API reference are in [docs/](docs); how to help is in [CONTRIBUTING.md](CONTRIBUTING.md); security reports go to [SECURITY.md](SECURITY.md).
