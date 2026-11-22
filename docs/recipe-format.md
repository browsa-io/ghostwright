# The recipe format

A saved flow is one JSON file in Browsa's recipe format, version 1. The schema ships with the package: [`schema/recipe-v1.json`](../schema/recipe-v1.json). The same file replays locally and, pushed, on Browsa.

```
.ghostwright/
  flows/<name>.json        the version run() uses
  flows/<name>/v<N>.json   every version, for rollback
  drafts/                  repairs waiting for review, or that failed
  traces/                  one JSONL file per run
  browsa.json              which Browsa recipe and robot each flow was pushed to
```

Commit it to git. A flow is saved in Browsa's recipe format (`schema/recipe-v1.json`), so the same file runs here and on Browsa. Files are written for your user only (0600, folders 0700), and a store an older version made is tightened to those modes when Ghostwright starts. A flow's name always comes from the name you run it by, never from the file, so a shared file cannot write elsewhere. Compiled request URLs are saved without query parameters that look like credentials (`token`, `key`, `sig`, `session`, a JWT or a long random value).

CLI: `npx ghostwright list`, `run <flow> key=value`, `rollback <flow>`, `view <url>`, `extract <url|file> "<what>" [--schema file.json]`.

## A recipe

```json
{
  "name": "books",
  "version": 1,
  "params": { "type": "object", "properties": { "category": { "type": "string" } }, "required": ["category"] },
  "output": { "type": "object", "properties": { "titles": { "type": "array" } } },
  "start_url": "https://books.toscrape.com/",
  "steps": [
    { "id": "s1", "kind": "navigate", "url": "https://books.toscrape.com/" },
    { "id": "s2", "kind": "click", "goal": "open the %category% category",
      "target": { "role": "link", "name": "{{category}}", "near": "Books" },
      "effect": { "kind": "navigate", "path": "/catalogue/category/books/{{category}}_2/index.html" } },
    { "id": "s3", "kind": "extract", "from": "page", "goal": "every book title",
      "how": { "css": "ol.row > li", "fields": { "title": "h3 > a @title" }, "into": "titles" } }
  ],
  "assertions": [{ "after": "s3", "expr": "output.titles.length >= 1" }],
  "repair": { "mode": "auto", "max_steps": 3 }
}
```

## Steps

| kind | what it does | fields |
|---|---|---|
| `navigate` | opens an address | `url` |
| `click` | clicks; with `state` it checks or unchecks | `target`, `state`, `effect` |
| `type` | types into a field | `target`, `text`, `clear`, `submit` |
| `select` | chooses an option of a `<select>` | `target`, `value` |
| `press` | presses keys | `keys` |
| `scroll` | scrolls by pixels, or to `"top"`, `"bottom"`, `"50%"`; with a `target`, inside that box | `value`, `target` |
| `wait` | waits for a time, a text or an element; with `hover` it hovers the element | `timeout_ms`, `for`, `hover` |
| `fetch` | an in-page `GET` whose JSON an extract reads | `url`, `save_as` |
| `extract` | reads data: from saved JSON, page JSON, the page by CSS, or with the model | `from`, `how`, `output_schema` |
| `assert` | an expression over the output that must hold | `expr` |

## Targets

A `target` holds several locators for one element; a replay uses them together (see [Record and replay](record-replay.md)).

| field | |
|---|---|
| `role`, `name` | the accessible role and name |
| `css` | a selector; `host >>> inner` crosses open shadow roots |
| `text` | the visible text, when it differs from the name |
| `near` | the heading, legend or label before the element |
| `within` | the text of the element's own item (its card, its row), kept when other controls on the page are named alike. Read by local replays; a push to Browsa leaves it out |
| `xpath` | the position in the document |
| `frame` | host and path of the frame the element is in |

## What a step expects

`effect` is what the action did when recorded and must do again: `{ "kind": "navigate", "path": ... }`, `{ "kind": "change", "state": { "expanded": "true" } }`, `{ "kind": "value" }` or `{ "kind": "none" }` (the page changed without anything new to read).

Extract steps read by CSS may carry, in `how`: `match` (per field, a pattern with one group for a value that is a part of an element's text), `pick` (a list of plain values: the one field of each row that is the value), `nested` (per field, a list inside each row: its selector relative to the row, its fields and patterns), and `headers` (per field, the header of the table column it was read from, checked on replay). These are read by local replays; pushed to Browsa, a step with `match`, `pick` or `nested` becomes a model extract.

A step may also carry `after_ms` (how long after the step before it this one was done when recorded: a replay waits about one and a half times that for its element) and `dialog` (`"accept"` or `"dismiss"`: the answer to the JavaScript dialog the step opens).

## Placeholders

`{{name}}` is a param of the run. `{{secret:NAME}}`, `{{secret:NAME:password}}` and `{{totp:NAME}}` are secrets by name, only in the `text` of `type` steps; a recipe never holds a secret's value.
