# Security

## Reporting a problem

Email **support@browsa.io** with "Ghostwright security" in the subject. Please include the version, what you did, and what happened, with a small page or flow that shows it if you can. Do not open a public issue for it.

We will confirm that we got it, keep you posted, and tell you when a fix is released. We are happy to credit you in the release notes if you would like.

## What counts

Anything that lets a page, a model or a shared flow file do something Ghostwright says it prevents, for example:

- a secret's value reaching a prompt, a trace, a saved flow, `last()`, a screenshot, or a field or origin it was not meant for;
- a purchase, payment or subscription going through without `allowPurchases: true`;
- a page load to an origin outside `allowedOrigins`, or to a `file:`, `chrome:`, `javascript:` or similar address;
- a flow file that writes outside its store, or runs code;
- an API key sent over plain http, or to a host other than the one configured.

Limits that are documented in the README (under "Limits of 0.1") are known and are not vulnerabilities, but tell us if you find a way to make one worse.

## How secrets work, in short

- The model only ever sees a placeholder such as `%password%`. The value is read from your source (an env variable, your own function, or Browsa Secrets) when Ghostwright starts and again at the keystroke.
- Each secret is locked to the origins you list. Before typing, Ghostwright checks that the field's own document is on one of them and puts the value into that one element; nothing is typed into whatever happens to have focus.
- Values are scrubbed from every prompt, result and trace, in the encodings a page is likely to show them in. A saved flow stores a token by name (`{{secret:APP_PASSWORD}}`), never the value; a save that would hold a value is refused.
- A page load whose address carries a secret's value is stopped before the request is sent.

The README section "Secrets" has the full rules.

## Supported versions

Fixes go into the latest release on npm. Please upgrade before you report.
