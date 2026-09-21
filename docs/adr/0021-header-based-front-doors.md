# 0020. Header-based front doors: Cloudflare Access

- Status: Accepted
- Date: 2026-09-22

## Context

A Hermes gateway runs agents that execute commands on the machine it lives on. The deployment
[ADR-0014](0014-plain-http-on-private-networks.md) argues for is a private network, but the other
common answer is to put the gateway on a public name behind an identity-aware proxy and let the
proxy decide who reaches it at all. Cloudflare Access is the one people actually use for this: the
gateway keeps its own sign-in, and the edge refuses anything that has not got past Access first.

Hermie already carried arbitrary extra headers. `GatewayConfig.extraHeaders` reaches every REST
call (`http.ts`), the WebSocket dial plan (`credentials.ts`) and the unauthenticated probe
(`probe.ts`), and the onboarding wizard's Advanced disclosure is a list of name/value rows that
writes into it. So the transport was never the problem. Three other things were.

**The wizard asked the wrong question.** "Header" and "Value", twice, with `CF-Access-Client-Id` as
the placeholder — which means the reader has to already know the two header names, spell them
correctly, and know that a service token is what goes in them. A misspelling produces a 403 that
says an access proxy answered, which is also what a correct pair with a revoked token produces.

**A service token is not a header.** It is a long-lived bearer credential for an Access
application, and two facts follow from that which a generic header row cannot express: it belongs to
one hostname, and it has no business travelling in the clear. A header row that survived a change of
gateway would send a tenant credential to a host that never asked for it, and a header row on an
`http://` gateway would put it on a wire this app supports precisely because the wire is a tailnet.

**The sign-in page is a browser, and the token does not make it one.** ADR-0004 signs in through an
in-app web view. `source.headers` applies to the load the app initiates and to nothing the page does
afterwards, and the gateway's own `/login` form posts with `fetch` — so behind Access that POST is
answered by the Access login page rather than by the gateway. Worse, the redirect-based flow leaves
the origin entirely: `/auth/native/authorize` navigates to the identity provider and the provider
navigates back, and neither of those is a request this app can attach anything to.

Three shapes were considered.

1. **Leave it as custom headers and document the two names.** Free, and it keeps every one of the
   three problems: no origin binding, no https rule, and a `/login` POST that fails with a page.
2. **A Cloudflare-Access authentication MODE**, beside `native_pkce`, `session_token` and `cookie`.
   Wrong shape: Access is not how the app proves who the USER is, it is how the app gets to the
   gateway at all. A mode would have to be crossed with every existing mode.
3. **A preset over the headers that already exist**, plus the two rules a service token needs and a
   document-start script for the web view.

The reference point for the third is [Conduit](https://github.com/kaishi00/hermes-conduit), a
separate iOS client for the same gateway, which stores the pair in the keychain scoped to the
gateway origin and injects the headers into native requests, the WebSocket handshake and in-page
WebKit `fetch` through a document-start user script. Its `Conduit/Services/CloudflareAccess.swift`
also applies the same https-only rule, for the same reason.

## Decision

Cloudflare Access is a **preset over the extra headers**, not a mode and not a second transport.

- The Advanced step offers two presets: **Custom headers**, which is the name/value rows it has
  always had, and **Behind Cloudflare Access**, which is a Client ID field and a secret field.
- The preset produces `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and the transport carries
  them the way it already carries extra headers: every REST call, the WebSocket dial, the ticket
  mint that precedes it, and both of the probe's requests. Nothing downstream of `extraHeaders`
  knows a preset exists.
- The record is stored in the secure store under its own key, **bound to the gateway origin it was
  entered for**. A record whose origin does not match the configured address is dropped on load, and
  a record with no origin at all counts as a mismatch.
- **The pair is withheld from a cleartext gateway**, and the address step says so. A service token
  is a tenant-wide credential; `http://` is supported for tailnets, where nothing needs one.
- For the in-app sign-in, the pair rides on `source.headers` for the load the app initiates, and a
  **document-start user script** puts it on the page's own `fetch` and `XMLHttpRequest` — scoped so
  that it attaches only when the page's origin and the request's origin are both the gateway's.
  Values cross into JavaScript as JSON string literals.
- **The native OAuth authorize route cannot carry them, and this is not worked around.** A top-level
  navigation is not a `fetch`; the redirect to the identity provider and the redirect back are
  requests no header and no script of ours can touch. Operators must exempt `/auth/*` and `/login`
  from the Access policy, which ADR-0004 already asked for and which is now stated in the field's
  own hint.
- **Nothing ever prints a header value.** `redactHeaders` replaces every value — not a list of known
  names, because the custom preset exists so people can use a header this package has never heard
  of. The auth timeline and the developer screen get one phrase, `cf-access: present`, computed once
  at the provider so the values never reach a screen at all.
- Android keeps the existing refusal. Its WebView re-sends `source.headers` across a cross-origin
  redirect (ADR-0004), so a gateway with headers configured goes to the system browser; the script
  is withheld with the same branch rather than kept alive inside it.

## Consequences

- **The transport gained nothing and needed to gain nothing.** The preset is a way of filling in a
  map that three code paths already read, which is why the gateway client's part of this is one
  module of pure functions and no change to `http.ts`, `credentials.ts` or `probe.ts`.
- **A gateway on `http://` behind Cloudflare Access cannot work**, by construction. That combination
  does not exist — Access terminates TLS — so the cost is a sentence, not a deployment.
- **An operator who does not exempt `/auth/*` still cannot sign in from the app**, and now finds out
  in the field's hint rather than from a 403 halfway through. What they get instead of a failure is
  Access's own login page inside the web view; that page is interactive and may well complete, but
  it is not the service token doing it and nothing here promises it will.
- **A stored token is useless to another gateway**, which costs one field in the record and one
  check on load. "Change gateway" already clears credentials when the address changes; the origin
  binding is what holds when the address changed some other way — a restore onto another device, or
  a record written by a build that predates the binding.
- **The wizard now restores the way in after a sign-out.** It had to: a gateway behind Access
  answers `/api/status` with a 403 to anyone without the token, so a resumed wizard with blank
  headers fails its probe before reaching the sign-in it was opened for. Custom headers come back
  with it, which fixes the same latent defect for a plain reverse proxy.
- **A secret is now one origin check away from a host that should not see it**, which is a sentence
  worth leaving in a decision record rather than only in a comment. The check is in one function,
  `readFrontDoor`, and it fails closed.
- **Turnstile is not addressed, and the finding is recorded rather than acted on.** Cloudflare's
  Turnstile requires a web view to allow `about:blank` and `about:srcdoc` SUBFRAME navigations —
  Conduit pins this with a live-WebKit test, `ConduitTests/TurnstileSubframeBoundaryTests.swift`,
  having measured that cancelling a `srcdoc` subframe stops its document instantiating. Hermie's
  `onShouldStartLoadWithRequest` returns `true` for everything that is not the loopback redirect, so
  the app does not currently cancel such a subframe — but whether `react-native-webview` consults
  that callback for subframes at all has **not** been measured here, on either platform, and an
  Access policy with Turnstile in front of `/login` has never been put in front of this app. No
  allowance is added, because an allowance for a callback that may never fire is a line of code
  that documents a guess. See the 2026-09-22 section of
  [docs/platform-notes.md](../platform-notes.md).
