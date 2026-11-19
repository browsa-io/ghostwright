# Changelog

## 0.1.1 (2026-11-19)

- Replay: a parameterised step ("open the %tag% tag") on a page with two links of the same name (a tag in a quote and in the sidebar, a book's cover and title) now replays with 0 model calls. The step's recorded heading context breaks the tie among exact name matches; a value that is not on the page still fails.
- README: logo, badges, a measured first-run vs replay chart (`bench/first-vs-replay.mts`, results in `bench/results/`), CONTRIBUTING.md and SECURITY.md.

## 0.1.0 (2026-11-19)

First release: `act`, `observe`, `extract` and `agent` on any page; flows recorded once and replayed with zero model calls; repair with review; secrets by reference, locked to their sites; local Chrome, any CDP endpoint, or Browsa cloud browsers.
