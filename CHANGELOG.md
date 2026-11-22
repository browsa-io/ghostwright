# Changelog

## 0.2.0 (2026-11-21)

What the 0.1 benchmark found, fixed, with regression tests (`test/e2e/v02*.test.ts`, `test/unit/v02.test.ts`). The benchmark itself (task set, harness, results) is now in this repository: `bench/suite/`.

Replay

- Controls that are named alike ("Compare" in every card, "Delete" in every row) are told apart by the text of their own item, saved as `target.within`. After a reorder a step finds the same item in its new place with no model; when the item is gone the step fails instead of acting on its neighbour.
- Position (an `nth-of-type` selector, the XPath) no longer decides for an element that has a name: it only breaks a tie that is left.
- A toggle records the state it took (open, checked, pressed). A replay that finds it already in that state does not click it again; one that leaves it in another state fails.
- A redesign that breaks every step can be repaired in one run: each step may be repaired once (the cap was 3 steps). `flow.save({ maxRepairs })` and `run(name, params, { maxRepairs })` set a lower one.
- A repair works the way `act()` does (whole page, folded lists, menus that open) and is told what the step did when it was recorded.
- Extracts whose values are a part of an element's text ("Kestrel Sling — $45", "Guests: 3", a line of code) compile to a selector plus a pattern (`how.match`), so their replays need no model. Lists whose rows are one text each compile the same way.

What "done" means

- A click on a control must change the page or send a request. A click that left the page exactly as it was is `ok: false` ("no effect"), where 0.1 could report an action as done when nothing had happened.
- A field is read back after typing: `ok` only when it holds the text (formatting a field adds is left aside). Typing into a field given by role and name is checked too.
- `do()` reports the element it acted on, so effects are checked for actions given by role and name as well as by id.

Actions

- Date and time fields (`date`, `time`, `datetime-local`, `month`, `week`) take what a person writes ("24 December 2026", "2:30 pm") and are set in the field's own format. 0.1 typed keys into them, which gave dates like `61224-02-20`.
- Menus that open on hover: the model can `hover` and then act in what opened; elements that a `:hover` rule opens something for are listed.
- `scroll` takes `to: "top" | "bottom" | "50%"`, for the page or inside a scrolling box (now listed as `scrollbox`).
- A link that opens a new tab is followed: the next action happens in the new tab (`followNewTabs: false` stays put). `gw.page` is the tab Ghostwright works in.
- Frames inside frames of other sites take clicks and typing; controls in closed shadow roots are found.
- A custom dropdown that opens a list of choices gets its second step (pick the option) without being told.
- `extract()` reads every row of a table and every item of a list; the view an act uses still folds long ones.
- `observe(request)` returns `selector`: one CSS selector from the top document, frames first (`iframe#pay >>> button`), and `frame`.

Safety

- The purchase guard was reworked in both directions and is tested on two tables of cases (`test/e2e/v02-guard.test.ts`, `test/e2e/held-guard.test.ts`); it is a filter on words and context, not a proof. Labels that only commit money, as whole words ("Place your order", "Pay now", "Charge my card", a submit of a form with card fields) are always refused. "Buy", "Purchase", "Pay", "Order", "Checkout", "Subscribe", "Confirm", "Book now", "Reserve", "Upgrade", "Renew", "Get it today" and free trials are refused only where money is in play: a price or total in the control's label, form or card, or anywhere on a small page, card fields, or a checkout, cart, payment, billing or pricing address. A newsletter "Subscribe", an appointment "Confirm", "Order by date" and "Donated items" go through. Fields, checkboxes and radio buttons are never refused for what their label says ("Confirm password", "Pay with card").
- A purchase form that a page script submits while an action runs (a click on a box whose handler calls `requestSubmit()`) is stopped in the page. A script that sends the order by `fetch` or `form.submit()` is not caught.
- A model behind an OpenAI-compatible endpoint that serves a listed model by its usual id (`openai/gpt-5.6-luna` through a gateway) is priced as that model. 0.1 counted it at the assumed price, about 40 times too high, which made `maxCostUsd` stop far too early.

First run

- `npx ghostwright init` writes `quickstart.mjs`; `npx ghostwright --version`.
- A missing model key is reported by `Ghostwright.create()` before any browser starts, in one sentence that names the variable (`ModelError` `model_key_missing`).
- `require("ghostwright")` works (Node 20.19+, 22.12+); on an older Node the error says what to do. Types resolve from ES module and CommonJS projects.
- Runnable examples ship in the package (`examples/*.mjs`, importing from `ghostwright`), each covered by a test.
- Docs: guides, the recipe format, and an API reference written from the types (`docs/`).

Found by the independent release gate on held-out pages, and fixed before release (tests: `test/e2e/held.test.ts`, `test/e2e/held-guard.test.ts`, `test/unit/gate.fixes.test.ts`)

- A compiled table read saves the header of each column it reads and checks it on replay. Reordered columns used to return another column's values with no error; now the step fails and is repaired.
- `act()` asks the model what is left after an action that leaves a JavaScript dialog open, is a hover the instruction did not ask for, or is the first part of a several-part instruction, so "hover ... and open the link" is no longer `ok` after the hover. A confirmation box the instruction did not ask to confirm is left for the next instruction. A scroll that moved nothing is `ok: false`.
- A repair of an instruction that took several actions (open the dropdown, pick the option) replaces all of its steps; the later ones are no longer run again on top of the repair.
- JavaScript dialogs: the model is offered the `dialog` action in `act()` and `agent()` and sees the dialog's text; the answer is recorded on the step that opened the dialog and replayed.
- Replays wait for an element or an extract's content that comes late: about one and a half times what the step took when recorded (`after_ms`), between 1.5 s and 15 s. A repair that ends on the steps the flow already had is not promoted as a new version.
- More extracts compile: a list of plain values (with repeats), and a list of objects that each hold one more list. Values in an element of their own inside a row are read from that element. A number is matched as a whole number ("2" is not found in "TR-200").
- `local()` gives Chrome 30 s to start, kills a browser that hung (with its temporary profile) and starts it once more; a second hang is `browser_start`.
- Second gate pass: the text typed into a `prompt()` is recorded (as a param when it came from one, as a secret token when it is a secret) and replayed; before, replays accepted the prompt empty. The purchase guard also refuses "Complete booking", "Send payment", "Authorize $40", "Tip $5", "Top up", "Join now" and "Reserve my place" where money is in play, a generic submit where the page says the card is charged now, and Enter in a form with no submit button that states a price; it no longer refuses "Upgrade your browser". Each new word has a look-alike that must pass ("Booking history", "Tip of the day", "Join our newsletter", "Authorize app access").
- An `extract()` that reads nothing waits up to 15 s and reads once more (`waitMs`) when the page was at work when its view was taken (a request in flight, "Running…"), is at work now, or has changed since; a list that arrives in a slow response while the model answers is no longer returned empty. An `act()` whose model says "nothing left" with a reason that the work is not finished waits and asks once more. A repair that ends on the step the flow already had keeps the step's timing and is not promoted as a new version.
- `flow.save()` warns when an instruction failed while recording (it is not in the flow). A rate-limited model call waits as long as the provider's `Retry-After` asks (at most 20 s) before its one retry.

Changed behaviour to know about

- A click that changes nothing at all on a control now fails where it passed silently in some cases; a click whose only effect arrives after the page went quiet fails too (`wait` for it).
- A step recorded by 0.1 with only a positional selector and a name that now matches several elements may need one repair.
- `target.within` and `how.match` are read by local replays. A push to Browsa leaves `within` out and turns an extract with `match` into a model extract.

## 0.1.1 (2026-11-19)

- Replay: a parameterised step ("open the %tag% tag") on a page with two links of the same name (a tag in a quote and in the sidebar, a book's cover and title) now replays with 0 model calls. The step's recorded heading context breaks the tie among exact name matches; a value that is not on the page still fails.
- README: logo, badges, a measured first-run vs replay chart (`bench/first-vs-replay.mts`, results in `bench/results/`), CONTRIBUTING.md and SECURITY.md.

## 0.1.0 (2026-11-19)

First release: `act`, `observe`, `extract` and `agent` on any page; flows recorded once and replayed with zero model calls; repair with review; secrets by reference, locked to their sites; local Chrome, any CDP endpoint, or Browsa cloud browsers.
