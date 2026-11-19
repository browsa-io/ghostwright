# Contributing to Ghostwright

Thanks for helping. Issues and pull requests are welcome at [github.com/browsa-io/ghostwright](https://github.com/browsa-io/ghostwright).

## Set up

You need Node 20 or newer and Google Chrome installed (the tests drive your local Chrome; nothing is downloaded).

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
| `npm run test:smoke` | a real model on the fixture site | a model key, see `test/smoke/real.test.ts` |

CI runs the build and the unit tests on every pull request. Please run the e2e tests too when you touch `src/engine`, `src/replay.ts`, `src/guard.ts` or `src/secrets.ts`.

## The benchmark

`bench/first-vs-replay.mts` measures run 1 (recording with a model) against runs 2-5 (replay) on public test sites, and `bench/render-chart.mts` draws the README chart from its result. It needs a model key and spends about $0.05 with the default model. See the comments at the top of each file.

## Pull requests

- One change per pull request, with a test that fails without it.
- A bug in replay or locating: add a small page to `test/fixtures/` that shows it, and a test in `test/e2e/`.
- Keep the README in step with what the code does. If you add an option, an error code or an event, document it.
- Prompts, page reading and the safety guards are the parts most likely to have side effects. Say in the pull request what you checked.
- Do not commit keys, cookies, recorded flows from real accounts, or traces.

## Security

Please do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT License of this project.
