# How Hermie Web works

Hermie Web is the fifth place Hermie runs: a browser tab, with nothing installed on the device. It
is one small Node process that sits next to `hermes serve`, serves the browser build of the app, and
proxies that one gateway onto its own origin.

This page explains the design — why the proxy is not a convenience, what the browser build does
differently, and how the self-update works. It is not the runbook. Installing, configuring and
operating it is [deploy/web/README.md](../deploy/web/README.md); the decision and the options that
were rejected are [ADR-0015](adr/0015-web-variant-on-its-own-port.md).

## The problem: a cookie belongs to an origin

The native clients sign in with the gateway's native PKCE flow and carry a bearer token. A page
cannot: the flow ends on a loopback redirect that a page has no way to catch, and there is nowhere
safe to keep the token afterwards. What a browser _can_ use is the session the gateway already
issues to its own dashboard — an `HttpOnly` cookie, set by `/auth/*`, confirmed by `/api/auth/me`.

That cookie belongs to the gateway's origin. A page served from somewhere else cannot send it unless
the gateway relaxes two separate things at once: CORS with credentials, and the cookie's own
`SameSite` (which then requires `Secure`, and therefore TLS, everywhere). And there is a third guard
that cannot be relaxed at all without real cost. `hermes serve` refuses a WebSocket upgrade whose
`Host` it does not recognise, and refuses an `Origin` that does not match that host. That is a
DNS-rebinding defence on a server that executes shell commands: without it, any page on the internet
could point a name at `127.0.0.1` and drive an agent.

So a separate origin is not a deployment inconvenience to be worked around. It is the thing the
gateway is defending against, and the honest answer is not to argue with the guard but to stop being
cross-origin.

Two more browser limits shape the rest of the design. `new WebSocket(url, protocols)` is the whole
API — there is no way to put a header on the upgrade, which is why the ticket mechanism of
[ADR-0005](adr/0005-ticket-per-websocket-dial.md) exists in the first place. And there is no
keychain; whatever a page can write, a page can read.

## The shape: one process, two jobs

Hermie Web is `packages/hermie-web`, a Node 22 server with **zero runtime dependencies** — `http`,
`stream` and `zlib` cover all of it. It listens on **9120** by default, next to the gateway's 9119,
and binds to `127.0.0.1` unless told otherwise. It authenticates nobody; the gateway does that.

Every request is decided in one order:

| Path                                                | What happens                                     |
| --------------------------------------------------- | ------------------------------------------------ |
| `/healthz`, `/hermie/config.json`, `/hermie/update` | Answered by Hermie Web itself, never proxied.    |
| `/api/*`, `/auth/*`, `/login*`, `/logout*`          | Proxied to the gateway.                          |
| A path that names a file in the static build        | Served from disk.                                |
| Anything else                                       | `index.html`, so a deep link into the app works. |

The proxied prefixes are a list rather than a catch-all, so a typo falls through to the app instead
of quietly becoming a request to the gateway.

**The gateway is fixed at process start.** No path, header or query parameter can point the proxy
somewhere else. A proxy a browser could steer would be an open relay onto everything else listening
on the operator's loopback interface, which is a considerably worse thing to run than the app it was
meant to serve.

### What the proxy rewrites, and what it leaves alone

The browser sends Hermie Web's own address in `Host` and `Origin`, and the gateway has never heard of
it. Both are rewritten to the gateway's `dashboard.public_url`, which is what `--public-url`
configures and why a mismatch there shows up as a 403 rather than as a subtle bug. The real client
travels in `X-Forwarded-For`, `-Proto` and `-Host`, which the gateway reads when
`dashboard.trusted_proxies` names the machine Hermie Web runs on.

`Set-Cookie` passes back almost untouched. `Domain` is dropped, because a domain naming the gateway's
host would make the browser discard the cookie outright. `Secure` is dropped and `SameSite=None`
becomes `Lax` **only** when the browser reached Hermie Web over plain HTTP — a `Secure` cookie on an
`http://` origin is silently thrown away, which looks exactly like a sign-in that did nothing.
`Path` is never touched: the gateway computes it from its own prefix and rewriting it would unscope
the session.

The WebSocket upgrade is not terminated and re-offered. The raw sockets are piped, so the subprotocol
negotiation — which is how the ticket is carried — and the close codes are exactly what the two ends
agreed. Terminating it would have meant re-framing every message for no benefit.

## Signing in, in a browser

The native flow and the browser flow share the transcript and share nothing else. In a tab:

1. The app probes `window.location.origin`. There is no address to type — Hermie Web already fixed
   the gateway, and `GET /hermie/config.json` tells the app which host is behind it so the wizard can
   name it.
2. It asks `GET /api/auth/me`. A cookie survives the reload at the end of a redirect chain, so an
   already-signed-in visitor never sees a button.
3. Otherwise it goes to the gateway's own sign-in page. An OAuth provider is a **full-page
   navigation**: the app is torn down and rebuilt when it returns, which is precisely why the cookie
   is the state rather than anything the wizard was holding. A password provider is not —
   `POST /auth/password-login` sets the cookies on its own response, so that one stays inside the
   page.
4. Every WebSocket dial then mints its own credential: `POST /api/auth/ws-ticket` over HTTP, and the
   ticket goes out in the subprotocol list. Tickets are single-use and short-lived, so a reconnect
   mints a fresh one.

The app's credential provider is `CookieSessionCredentials`: no `Authorization` header on REST,
`credentials: 'include'` so the browser attaches the cookie, a ticket per dial. There is no refresh
token within reach, so a rejection is always "sign in again" rather than a silent renewal.

### What the wizard does differently

It has no address step. Welcome → Sign in → Test → Done, where the native wizard has five steps and
the second is where you type the gateway. It shows the gateway host instead of asking for it, and
the **Advanced** extra-headers field is absent too — see the limitations below.

The connection test is the same test: one authenticated REST call, then a real WebSocket dial
through to `gateway.ready`, before anything is saved.

## Self-update

A Hermie Web install can be told a newer version exists, and — where the install shape allows it —
replace itself. Settings → **Hermie Web** is the surface: the running version, whether a newer one
exists, and an **Update** button when this install can apply it.

**Where it checks.** `GET /hermie/update` compares the running version with the newest GitHub
release of this repository. The listing is fetched once at startup, then at most once every six
hours, and on an explicit refresh — GitHub rate-limits unauthenticated API calls per IP, and a
settings screen that polled would spend that budget for nothing. A failed fetch keeps the previous
answer rather than replacing it with "no releases": the network being down is not news about the
release. A release that publishes no `hermie-web.zip` is treated as no release at all, because it is
a release of the apps only.

The same answer says whether this install can update itself, and when it cannot it carries the
command that does work instead of a button that would fail. There are three noes: `--no-self-update`,
a container (the image is the version — `docker pull`), and a copy under `node_modules`
(`npm i -g @hermie/web@latest`).

**What it downloads and what it verifies.** `POST /hermie/update` fetches `hermie-web.zip` and the
release's `SHA256SUMS`, both over https and nothing else. A zip the checksum file does not list is
refused, and so is one whose digest does not match. That is worth stating precisely: **nothing here
verifies a signature.** The digest proves the bytes match what the release lists, and https proves
they came from GitHub. Anyone who can publish a release can publish a matching digest. It is the same
trust boundary as `npm i -g`, written down rather than dressed up.

The endpoint is gated on the caller's own gateway session: the request's cookies are put to the
gateway's `/api/auth/me`, and anything but a 200 is a 401 here. Hermie Web has no user database and
is not going to grow one. The refusal for an install that cannot update itself comes first, so a
Docker deployment never sends a request it has no use for.

**How it installs.** The zip is unpacked into `<install-root>/releases/<version>.incoming` and only
then renamed into place, so a half-unpacked directory can never become a release. `current` is
pointed at it by writing a new symlink and `rename`-ing it over the old one — atomic, where unlink
followed by symlink has a window in which `current` does not exist and a restart landing in it has
nothing to run. `--rollback` walks the release directories on disk, in version order, and points
`current` at the one before the active version; the previous release directory is kept, which is what
makes that possible.

**How it restarts, and why the systemd `Restart=` line matters.** The HTTP response is answered
first — the browser has to receive `{restarting: true}` before the socket dies, or the settings row
has nothing to poll about — and then the process **exits 0**. That is the whole restart. Under a
supervisor, exiting is the correct way to do it: re-executing inside the old process would leave the
unit's idea of its main PID pointing at something that no longer exists. Which means the supervisor
has to be there. `Restart=always` in the unit file is not hardening; it is the line that turns
"update" into a restart instead of an outage, because without it the update stops the service and
nothing starts it again. Hermie Web detects a supervisor from the environment it announces itself
with (`INVOCATION_ID`, `NOTIFY_SOCKET`, and friends); with none, it spawns a detached child first,
which is strictly worse — no logs, no restart on crash — and is documented as the fallback it is.

Meanwhile the page polls `/healthz` every second and a half until a version comes back, reloads only
when that version is the **new** one (an old server that never restarted would answer just as
happily), and gives up after a minute rather than spinning for ever.

## Installing it

The configurations are in [deploy/web/README.md](../deploy/web/README.md); in brief:

| Route             | What it is                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx @hermie/web` | One command next to `hermes serve`. Nothing to install, nothing to update — and no supervisor.                                                                                                               |
| A release zip     | `hermie-web.zip` from a GitHub release, unpacked under `/opt/hermie-web/releases/<version>/` with a `current` symlink. This is the layout self-update expects.                                               |
| Docker            | `ghcr.io/fullstackstudio-nl/hermie-web`. The image is the version, so self-update refuses and points at `docker pull`.                                                                                       |
| systemd           | A unit pointing `ExecStart` at `current`, with `Restart=always` and the install root in `ReadWritePaths`.                                                                                                    |
| TLS in front      | Caddy, nginx or `tailscale serve`. All three pass `X-Forwarded-Proto`, which is what makes the gateway issue `Secure` cookies; nginx needs the two upgrade headers spelled out or the socket never connects. |

The gateway needs `dashboard.public_url` set to the address Hermie Web claims to be, and
`dashboard.trusted_proxies` naming Hermie Web's machine if the two are not the same host.

## What it cannot do

Three things, none of which a browser is going to grow:

- **No keychain.** The session is the gateway's cookie, which the page cannot read; anything the
  shared code does route through the web secret store is protected by the origin and nothing else.
  Clearing site data signs you out.
- **No extra request headers on a WebSocket.** A gateway behind Cloudflare Access is reached on
  native by configuring those headers in the app. A page cannot send them, and cannot be made to — so
  that perimeter belongs **in front of Hermie Web**, not inside it. Put the access proxy on the
  Hermie Web port and let the gateway trust the machine behind it.
- **No loopback redirect**, which is why the native PKCE flow is not used here at all.

Two behaviours change shape rather than disappear: picking a file becomes an `<input type="file">`
whose cancel is a focus heuristic rather than an event, and haptics become a no-op. The web section
of [docs/platform-notes.md](platform-notes.md) is the full list of what has and has not been verified
in a browser.

## When something is wrong

The symptom table in [deploy/web/README.md](../deploy/web/README.md#troubleshooting) is the place to
start — a 403 on `/api/status`, REST working while the socket never connects, a sign-in that
un-signs-in on reload, and every client showing up in the gateway's log as Hermie Web's own address
each have one usual cause, and all four of them are configuration rather than code.
