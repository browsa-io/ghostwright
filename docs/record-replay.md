# Record once, replay without a model

A flow is a list of steps you describe in plain words. The first run uses a model to find each element and read each value. What worked is saved as a recipe (a JSON file). Every later run replays the recipe with the same checks. Actions replay with no model; an extract does when it compiled to a page read (see below), so a flow whose extracts all compiled replays with 0 model calls and no tokens.

```js
import { Ghostwright } from "ghostwright";

const gw = await Ghostwright.create({ model: "openai/gpt-5.6-luna" }); // OPENAI_API_KEY

// run 1: record
const flow = await gw.flow("books", { params: { category: "Travel" } });
await flow.goto("https://books.toscrape.com/");
await flow.act("open the %category% category");
await flow.extract("every book title", {
  type: "object",
  properties: { titles: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } } },
});
await flow.save();                       // .ghostwright/flows/books.json

// every later run: replay
const run = await gw.run("books", { category: "Poetry" });
console.log(run.output.titles.length, run.meta.modelCalls);   // 0 here: this extract compiles
await gw.close();
```

From a terminal: `npx ghostwright run books category=Poetry` (no model configured: a broken step fails instead of being repaired), `npx ghostwright list`, `npx ghostwright rollback books`.

## Params

`params` names the values that change between runs. `%category%` in an instruction is shown to the model as a name; the value is filled in when the step runs. In the saved recipe the value becomes `{{category}}` wherever it appeared: typed text, an address, an element's name, the path a click went to. A step whose element is named by a param must match with this run's value: `{ category: "Nonexistent" }` fails, it never falls back to the item that was recorded.

## What a replay does for each step

1. **Finds the element** with every locator the step recorded, together:
   - what names it: its role and name, its text, a selector by id or attribute;
   - what tells it apart from controls named alike: the text of its own item (`within`: "Model A 13-inch…" for one of four "Compare" boxes) and the heading before it (`near`);
   - where it was: an `nth-of-type` selector, the XPath. Position only breaks a tie that is left. It never decides for an element that has a name, so after a reorder the step finds the same item in its new place, and when the item is gone the step fails instead of acting on its neighbour.
   An element that comes late is waited for before the step fails: about one and a half times what the step took when recorded (`after_ms` in the recipe), at least 1.5 s, at most 15 s.
2. **Acts with real input** (mouse and key events from the browser), after checking that nothing covers the element.
3. **Checks the effect**, not the absence of an error:
   - a click must change the page or send a request; one that left the page as it was is a failure;
   - a field is read back after typing and must hold the text;
   - a step that navigated when recorded must navigate again, to the same path (digits and param parts may differ);
   - a toggle must end up in the state it took when recorded (open, checked, pressed); one already in that state is not clicked again;
   - a link that opens a new tab is followed into that tab (`followNewTabs: false` stays put);
   - a JavaScript dialog the step opened when recorded is answered as it was then; one the flow has no answer for fails the step.
4. **Repairs** a step that failed, with a model if one is configured: the model gets the step's goal, what it did when recorded, and the page as it is now. An instruction that took several actions is repaired as a whole (its steps are replaced together). Each step may be repaired once per run (`flow.save({ maxRepairs })` or `run(name, params, { maxRepairs })` sets a lower cap). The repaired recipe becomes the new version only after the whole run passed, and only when it differs from the version it repaired; `gw.rollback(name)` goes back.

A repair waits for your review as a draft (`run().draft`, then `gw.promote(name)`) when it goes to a host the flow never used, or when the flow types secrets. A step a safety guard refused is never repaired another way: the run fails with `FlowError` `blocked`. With no model configured nothing is ever repaired: a broken step is `FlowError` `site_changed`.

## Extracts that need no model

After a model extract in a flow, Ghostwright tries to build a reader that needs no model, in this order:

1. the JSON the page fetched while you worked (replayed as an in-page `fetch`, `GET` only),
2. JSON embedded in the page (`__NEXT_DATA__`, `application/ld+json`),
3. CSS selectors, for values that are elements of their own,
4. a selector plus a pattern, for values that are a part of an element's text ("Kestrel Sling — $45", "Guests: 3"). The pattern is held in place by the label and punctuation around the value, never by another value or a digit.

Shapes that compile by 3 and 4: one object of plain values, a list of such objects (each may hold one more list of such objects), or a list of plain values, read from the main page (not from inside a frame). A table read also saves the header of each column it reads and checks it on replay: reordered columns fail the step (and are repaired) instead of returning another column's values.

A reader is kept only when it reads back exactly the model's answer (typography and text the view cut short aside). `meta.layer` says which was kept: `fetch`, `page_json`, `css` (3 and 4), or `model` when none fit. An extract that stays `model` asks the model on every run, and `flow.save()` warns about it. Answers that take judgment ("is it in stock?" as yes or no) do not compile.

On replay a compiled reader reads the page as it is now, so the next run returns new data in the same layout. When the layout changed and the reader finds nothing, the step fails and is repaired like any other.

## Results

`run()` returns `{ output, version, steps, repaired, promoted?, draft?, meta }`. `meta.modelCalls` is 0 for a replay that needed no repair. `steps` says, per step, how it ran (`replay`, `fetch`, `page_json`, `css`, `model`, `repair`) and how the element was found (`by`).

Each recording and run writes `.ghostwright/traces/<flow>-<run>.jsonl`, one line per step, secrets scrubbed.

## Measured

The [benchmark](../bench/suite/README.md) runs 20 multi-step flows 10 times each and then again on redesigned pages, and reports how many replays needed a model and how many redesigns were repaired.
