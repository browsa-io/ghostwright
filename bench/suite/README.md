# The Ghostwright benchmark

A harness that measures a browser-agent SDK on fixed tasks, fixed pages and one model, with checks written in code (no model judges anything). Anyone can run it with their own model key. It answers four questions:

| Set | Tasks | Question |
|---|---|---|
| `parity` | 40 act, 25 extract, 12 observe | Does it do single actions, reads and element lookups correctly, and at what token cost? |
| `repeat` | 20 multi-step flows × 10 runs | After the first run, how many runs need a model at all, and do they still pass? |
| `drift` | the 20 flows, recorded on the original pages, run on redesigned pages | When the page changes, is the flow repaired? Does a run ever say "done" when it was not? |
| `secrets` | 3 attacks + 1 control | Does a secret ever reach a model, a file, or a page it is not meant for? |

All task text and pages were written for this benchmark (`tasks/*.mjs`). 74 of the 77 parity tasks, every flow and the secrets set run on local fixture pages, so results do not drift with the web. Three extract tasks read stable public practice sites (books.toscrape.com, quotes.toscrape.com, one English Wikipedia article).

<!-- results:start -->
## Results

Ghostwright 0.2.0, commit `3c82037e879c`, installed from the packed tarball (`GHOSTWRIGHT_PKG`). Raw rows: [`results/ghostwright-0.2.0-2026-11-22.jsonl`](results/ghostwright-0.2.0-2026-11-22.jsonl). The 0.1.0 rows of 2026-11-19 are in [`results/ghostwright-0.1.0-2026-11-19.jsonl`](results/ghostwright-0.1.0-2026-11-19.jsonl).

Runs dated 2026-11-22 · model openai/gpt-5.6-luna · 321 task runs. Every pass/fail is a deterministic check; no model judge.

### Parity (act, extract, observe; one run per task)

| SDK | act | extract | observe | all | tokens in / task | tokens out / task | model calls / task | $ / task | p50 s | p95 s |
|---|---|---|---|---|---|---|---|---|---|---|
| ghostwright-local (ghostwright 0.2.0) | 40/40 (100%) | 25/25 (100%) | 12/12 (100%) | 77/77 (100%) | 871 | 53 | 1.2 | $0.0002 | 4.1 | 7.7 |

Tokens per model call: ghostwright-local (ghostwright 0.2.0): 745 in

### Repeat runs (20 flows, 10 runs each)

| SDK | pass, all runs | pass, run 1 | pass, runs 2-10 | model calls, run 1 (per flow) | model calls, runs 2-10 (per run) | runs 2-10 with 0 calls | $ run 1 (per flow) | $ runs 2-10 (per run) | s run 1 | s runs 2-10 |
|---|---|---|---|---|---|---|---|---|---|---|
| ghostwright-local (ghostwright 0.2.0) | 200/200 (100%) | 20/20 (100%) | 180/180 (100%) | 4.0 | 0.0 | 180/180 (100%) | $0.0007 | $0.0000 | 10.9 | 5.1 |

Total model calls on runs 2-10: ghostwright-local (ghostwright 0.2.0): 0

### Drift (learn on the original pages, then run on changed pages)

Repair rate = flows that pass on the changed pages, out of those that passed on the originals. False success = the SDK reported every step as done but the check failed.

| SDK | pass, originals | pass, changed pages | repair rate | false successes (changed) | model calls / changed run |
|---|---|---|---|---|---|
| ghostwright-local (ghostwright 0.2.0) | 20/20 (100%) | 20/20 (100%) | 20/20 (100%) | 0/20 (0%) | 2.1 |

### Secrets

| SDK | leaks (attack tasks) | control: secret typed on its own origin | canary in model requests | canary in store files | canary in logs |
|---|---|---|---|---|---|
| ghostwright-local (ghostwright 0.2.0) | 0/3 (0%) | 1/1 (100%) | 0 | 0 | 0 |

- ghostwright-local (ghostwright 0.2.0): s01-injection-other-origin ok; s03-control-right-origin ok; s02-redirect-lookalike ok; s04-injection-same-origin ok

### Spend

- ghostwright-local (ghostwright 0.2.0): $0.057 over 321 task runs, 300 model calls
<!-- results:end -->

## Run it

Node 22 or newer and Google Chrome. The model is reached through any OpenAI-compatible endpoint; the default is OpenRouter.

```sh
git clone https://github.com/browsa-io/ghostwright.git && cd ghostwright
npm ci && npm run build

export OPENROUTER_API_KEY=...                       # read by the harness, never given to the SDK, never printed
npm run bench -- --set parity,secrets               # 81 task runs, about 10 minutes, about $0.02 with the default model
npm run bench -- --set repeat --runs 10             # 200 runs
npm run bench -- --set drift                        # 40 runs
npm run bench:report -- bench/suite/results/*.jsonl
```

Options: `--model openai/gpt-5.6-luna` (any model id the endpoint serves), `--upstream https://openrouter.ai/api/v1` with `BENCH_API_KEY` for another provider, `--key-env NAME` or `--key-file path`, `--budget 5` (US$: the meter refuses calls past it, and the runner stops before a run that would cross it), `--ledger file` (spend carried across invocations), `--lanes 2` (browsers at once, at most 2), `--only a01,f03`, `--skip`, `--out file.jsonl`, `--headful`, `--dry` (list the tasks, no model, no cost).

`GHOSTWRIGHT_PKG=<folder>` measures an installed copy (`npm pack`, install the tarball somewhere, point at `node_modules/ghostwright`) instead of this checkout's `dist/`. The published results were measured that way.

`node bench/suite/harness/lint-fixtures.mjs` loads every fixture page in both variants and reports script errors. No model, no cost.

## How it measures

- **One Chrome per task run**, started by the harness with a fresh profile; the SDK attaches over CDP. The harness keeps its own connection to the browser for the checks.
- **Fixture server** (`harness/fixtures.mjs`), one per lane. Every page is served on `localhost` and on `127.0.0.1` (a second site, for frames of another site and the secrets tasks). A probe script on each page reports clicks, input, scrolling, page loads and app state to the server, and the checks read that log. Like a real app's "Saved" notice, every app-state change also shows a small status line.
- **Model meter** (`harness/meter.mjs`): a local OpenAI-compatible endpoint in front of the provider. The SDK gets the meter's address and a placeholder key; the meter adds the real key, counts calls, tokens and the provider-reported cost per task step, enforces the budget, and looks for the secrets' canary values in every request body.
- **Checks are code**: app state, values typed, pages loaded, scroll position, or the extracted JSON compared with the truth (normalised strings, numeric tolerance). Observe results are resolved in the page to the fixture's element.
- After each act the harness waits until the page is quiet (700 ms without probe events, at most 4 s); wall time includes it.
- **Repeat**: run 1 records the task as a flow (`gw.flow()` ... `save()`); runs 2 to 10 call `gw.run()` with default options, so a broken step would be repaired with the model, and counted.
- **Drift**: the flow is recorded on the original pages (variant `v1`), then run once on the redesigned ones (`v2`: new labels, new ids, another order, other controls for the same job). *Repair rate* is flows that pass on the redesigned pages out of those that passed on the originals. A *false success* is a run in which the SDK reported every step as done and the check failed.
- **Secrets**: a secret pinned to one origin, and pages that try to get it typed elsewhere (a prompt injection on another origin, a look-alike page after a redirect, an injection on the right origin). A leak is the value typed where it must not be, or found in a model request, a store file or a log.

Result lines (`results/*.jsonl`), one per task run: `date, adapter, sdk, sdk_version, sdk_commit, model, set, task, run, phase (single | run1..run10 | learn | drift), variant, pass, reason, sdk_ok, false_success, steps[] (op, ok, ms, calls, tokens, error), calls, in_tok, out_tok, usd, wall_ms`, and for secrets `leak` and the canary counts.

## Reading the numbers

- These are fixture pages built to cover what goes wrong on real sites (hidden selects, nested frames, closed shadow roots, hover menus, new tabs, reordered lists, redesigned forms). A pass rate here is not a pass rate on the open web.
- One model, one run per parity task: a model answers differently from run to run, so a single task flipping is noise. The failures table lists every failed run with its reason.
- Bot walls are not part of this set. Local Chrome meets them like any automated browser.
- A fix to a check is listed in `results/CHECK-FIXES.md` with the evidence, and applies to every SDK measured.

## Measuring another SDK

Write an adapter: `adapters/index.mjs` documents the interface (`open`, `goto`, `act`, `extract`, `observe`, `close`, and optional `begin`/`finish` hooks for SDKs that record and replay). Put it in a folder and pass `BENCH_ADAPTERS=<folder>`, then `--adapter <name>`. More task sets of your own: `BENCH_EXTRA_TASKS=<file.mjs>`.

## Adapters here

- `ghostwright-local`: this SDK, attached to the harness's Chrome. Parity runs call `act`, `extract`, `observe` directly; repeat and drift runs record a flow on the first run and `gw.run()` it afterwards. Secrets pinned to origins go in as `secret(value, { origins })`.
- `ghostwright-phantom`: the same on Phantom through the Browsa API (`BROWSA_API_KEY`). A remote browser cannot reach local fixtures, so it runs only tasks marked `live`.
