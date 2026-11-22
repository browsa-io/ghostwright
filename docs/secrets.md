# Secrets by reference

A secret is a value the model never sees. You name it, say which sites may receive it, and write `%name%` where it goes. Ghostwright types the value itself, at the keystroke, only into a field on an origin you allowed. It never reaches a prompt, a trace, a result or a saved flow.

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

## What is tested

- `test/e2e/flows.test.ts`: after a recorded login, no prompt, trace, recipe or result holds a secret's value (the test reads every file in the store); a page that tells the model to type the password on another origin gets nothing.
- `test/e2e/security.test.ts`: pages that move focus, redirect on focus, mirror the value, or post forms by GET.
- The [benchmark](../bench/suite/README.md) has three attack tasks and a control; it counts the secret in model requests, store files and logs.
