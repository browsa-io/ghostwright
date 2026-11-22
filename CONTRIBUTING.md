# Contributing to Ghostwright

Thanks for helping. Issues and pull requests are welcome at [github.com/browsa-io/ghostwright](https://github.com/browsa-io/ghostwright).

## Set up

You need Node 20 or newer (22 or newer for the benchmark) and Google Chrome installed (the tests drive your local Chrome; nothing is downloaded).

```sh
git clone https://github.com/browsa-io/ghostwright.git
cd ghostwright
npm ci
npm run build
```

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | unit tests | nothing |
| `npm run test:e2e` | flows against a local fixture site, with a mock model | Chrome |
| `npm run typecheck` | `tsc --noEmit` | nothing |
| `npm run docs` | writes `docs/api.md` from the exported types (a unit test fails when it is out of date) | nothing |
| `npm run pack:check` | packs the package, installs it in an empty folder, and checks ESM, CommonJS, types and the CLI there | network (npm) |
| `npm run test:smoke` | a real model on the fixture site | a model key, see `test/smoke/real.test.ts` |

CI runs the build, the unit tests, the docs check and the package check on Linux, macOS and Windows with Node 20, 22 and 24, and the e2e tests on the fixture site, on every pull request. Please run the e2e tests yourself when you touch `src/engine`, `src/replay.ts`, `src/compile.ts`, `src/guard.ts` or `src/secrets.ts`.

Every script in `examples/` has a test in `test/e2e/examples.test.ts` that runs it against the fixture site with a mock model. A new example needs one too (the test lists the files).

## The benchmark

`bench/suite/` is the benchmark: 77 single tasks, 20 multi-step flows (run 10 times, then on redesigned pages) and a secrets set, on local fixture pages, with checks in code. `npm run bench -- --set parity,secrets` runs a set with your own model key (`OPENROUTER_API_KEY`); its [README](bench/suite/README.md) has the method. A change to the engine, the prompts or replay should come with the sets it touches, before and after. Never change a task or a check to make a number move: a check that is wrong is fixed for every SDK and listed in `bench/suite/results/CHECK-FIXES.md` with the evidence.

`bench/first-vs-replay.mts` measures run 1 (recording with a model) against runs 2-5 (replay) on public test sites, and `bench/render-chart.mts` draws the README chart from its result. It needs a model key and spends about $0.05 with the default model. See the comments at the top of each file.

## Pull requests

- One change per pull request, with a test that fails without it.
- A bug in replay or locating: add a small page to `test/fixtures/` that shows it, and a test in `test/e2e/`.
- Ghostwright's code, comments, docs and tests name no other SDK or company, and no code is copied from other projects: ideas only, written our own way. CI checks the names.
- Be kind: see the [code of conduct](CODE_OF_CONDUCT.md).
- Keep the README in step with what the code does. If you add an option, an error code or an event, document it.
- Prompts, page reading and the safety guards are the parts most likely to have side effects. Say in the pull request what you checked.
- Do not commit keys, cookies, recorded flows from real accounts, or traces.

## Security

Please do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT License of this project.
