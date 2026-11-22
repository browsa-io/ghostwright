# Safety

Ghostwright acts in a real browser, so the rules below hold below the model: they apply to whatever chose the action (a model, your own `do()`, or a replayed flow), and a refusal is final. The model is not asked for another way round, and a replay is not repaired round it.

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

## What "done" means

`ok: true` means the effect was seen, not that no error was thrown:

- a click changed the page (something a person can read, or the DOM) or sent a request; a click that left the page as it was is `ok: false`;
- a typed field was read back and holds the text;
- a scroll moved the page; an `act` that only scrolled is `ok: false` unless the instruction asked to scroll;
- after an action that opens something, leaves a JavaScript dialog open, or is the first part of a several-part instruction, the model is asked what is left before `act()` returns; it is still the model that judges the instruction complete, so check a result that matters (`check()`, an extract, your own assertion);
- `agent()` reports `success: "unknown"` when the model gives no verdict or cites words that are not on the page;
- `check()` is `ok` only when the words the model cites are on the page.

## Cost

- Every call returns `meta: { modelCalls, inputTokens, outputTokens, usd, ms }`; `gw.usage()` adds them up and `gw.metrics()` lists every model call.
- **Prices**: a built-in table of the current models (`PRICES`, a snapshot of OpenRouter's public catalog of providers' prices taken on `PRICES_AS_OF`, 2026-11-19). A model missing from it is looked up in that live catalog (no key is sent; cached a day in `~/.cache/ghostwright/prices.json`, outside the store you commit; `cacheDir` or `GHOSTWRIGHT_CACHE_DIR` moves it; a cache dated in the future is ignored; `livePrices: false` turns the lookup off). Only a dated or `-latest` variant borrows a listed model's price (`gpt-5-pro` is not `gpt-5`). An OpenAI-compatible endpoint (a gateway or proxy) that serves a listed model by its usual id (`openai/gpt-5.6-luna`) is priced as that model. `price: { input, output }` (US$ per million tokens) sets it yourself.
- **maxCostUsd** stops before a model call that could pass the cap (`CostLimitError`), counting the prompt plus the whole output limit (2,000 tokens). The error says what that call could cost and at which price. A model the cap refuses passes to the next model of the list, so a cheap fallback still runs. A call that timed out counts at that estimate (it was sent and may be billed), and a provider's token counts are clamped to finite, non-negative numbers. A model whose price is still unknown is counted at `ASSUMED_PRICE` ($10 in, $50 out per million tokens: the most expensive regular model of the snapshot), and those calls say `priceAssumed`; `usage().usdAssumed` is the part counted that way. "Pro" reasoning tiers cost more: pass `price` for those.
- Each flow recording and run writes `.ghostwright/traces/<flow>-<run>.jsonl`, one line per step (secrets scrubbed). Nothing is printed unless `debug: true`, except `flow.save()` warnings (`warnings: false` turns them off).
- `onEvent` receives `model-call` (with `hosted` for a model service that bills per step), `captcha`, `repair`, `promote` and `warning` events.

## Captchas

- On Phantom (`browsa()`), Browsa's in-session solver works on the server; Ghostwright reports a `captcha` event and waits.
- Locally, `captcha: browsaCaptcha({ apiKey })` solves token captchas (reCAPTCHA, Turnstile) through captcha.browsa.io, paid with Browsa credits: each widget once per page, at most 2 per page and `maxCaptchaSolves` (5) per Ghostwright.
- Otherwise a full-page bot check raises `ChallengeError`.
