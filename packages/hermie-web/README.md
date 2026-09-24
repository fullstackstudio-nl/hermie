# @hermie/web

Hermie in a browser. One small Node process that serves the browser build of
[Hermie](https://hermie.dev) — a client for [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) —
and proxies **one** Hermes gateway onto its own origin.

It is meant to sit next to `hermes serve`, on its own port. It has no runtime dependencies, needs
Node 22 or newer, and **authenticates nobody**: the gateway does that, and Hermie Web only makes the
gateway's cookie session reachable from a page. Bind it to loopback, and put TLS in front of it if it
has to leave the machine.

```sh
npx @hermie/web --gateway http://127.0.0.1:9119
# → http://127.0.0.1:9120
```

Open that address. The app has no setup wizard to speak of: the gateway is whatever this process is
in front of, so there is no address to type and nothing to probe — a reader only ever signs in.

## First run, without a `--gateway`

Start it with no gateway at all and it serves an **operator setup page** at `/setup` instead of the
app: the gateway address, a probe of it, and the service login that push and the message cache are
spent on. Save, and `/setup` answers 404 — for this process and for every later one, because the
answer is written to the state directory.

```sh
npx @hermie/web            # → http://127.0.0.1:9120/setup
```

Three things worth knowing before you use it.

- **While it is open, whoever reaches the port can point the proxy somewhere.** That is the same
  power `--gateway` gives, handed to the first arrival. Do not expose the port before it is
  configured; `--gateway` skips the page entirely.
- **Reach it on `http://127.0.0.1:9120`, not `localhost`.** The service login is the gateway's
  native PKCE flow, and the gateway refuses a redirect URI whose host is not a loopback IP literal
  (RFC 8252 §8.3). A deployment where that is impossible uses `hermie-web login` from a terminal
  instead; the page says so too.
- **Push does not start until the next start.** The daemon is not launched on a process that had no
  gateway when it booted. Restart the service once the setup is saved.

The package is scoped and the command is not: `npm i -g @hermie/web` puts a `hermie-web` on your
`PATH`, which is the name the Docker entry point, the systemd unit and the release zip all use.

## Flags

Flags beat environment variables beat defaults. A bad value in either fails at start with a message naming the flag or the variable. This is the whole configuration surface for a container — Docker or Kubernetes — since the image's `ENTRYPOINT` takes no `args`; see
[deploy/web/README.md](../../deploy/web/README.md#flags-and-environment) for the rest (push, `--state-dir`
and the others this shorter table leaves out) and
[deploy/k8s/README.md](../../deploy/k8s/README.md) for worked Kubernetes manifests.

| Flag                    | Environment                             | Default                  |                                                                                                                 |
| ----------------------- | --------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--gateway <url>`       | `HERMIE_GATEWAY_URL`                    | `http://127.0.0.1:9119`  | The gateway. Fixed at start; the only thing that can set one is `/setup`, and only while there is none.         |
| `--port <n>`            | `HERMIE_PORT`                           | `9120`                   |                                                                                                                 |
| `--host <addr>`         | `HERMIE_HOST`                           | `127.0.0.1`              | Anything else puts an unauthenticated port on the network.                                                      |
| `--public-url <url>`    | `HERMIE_PUBLIC_URL`                     | derived from `--gateway` | The gateway's own `dashboard.public_url`, written into `Host` and `Origin` on every proxied request.            |
| `--static <dir>`        | `HERMIE_STATIC_DIR`                     | the bundled `dist/web`   | The exported browser build.                                                                                     |
| `--install-root`        | `HERMIE_INSTALL_ROOT`                   | the package's parent     | Where self-update unpacks releases and keeps the `current` link.                                                |
| `--no-self-update`      | `HERMIE_SELF_UPDATE=0/false/no`         | on                       | Turns `/hermie/update` into a refusal.                                                                          |
| `--rollback`            |                                         |                          | Point `current` at the previous release and exit.                                                               |
| `--cache-max-mb <n>`    | `HERMIE_CACHE_MAX_MB`                   | `64`                     | Disk the message cache may take. `0` turns it off.                                                              |
| `--allow-insecure-oidc` | `HERMIE_ALLOW_INSECURE_OIDC=1/true/yes` | off                      | Let the built-in identity provider be enabled on a non-https origin. The gateway refuses such an issuer anyway. |
| `--help`                |                                         |                          |                                                                                                                 |

It answers `GET /healthz`, `GET /hermie/config.json` and `GET|POST /hermie/update` itself, plus
`/setup` and `/hermie/setup/*` while no gateway is configured. Everything under `/api`, `/auth`,
`/login` and `/logout` is proxied to the gateway; everything else is the app.

`GET /hermie/config.json` is the browser build's bootstrap: the gateway host and origin, which auth
kinds that gateway offers, whether a setup is still needed, what this service is running, and the
version. It is what lets the app skip the address step and the probe.

## The message cache

Hermie Web keeps a per-session transcript tail in its state directory, and the app reads it from
`GET /hermie/cache/<id>` **before the socket answers** — so a chat opened on a laptop that has never
seen it paints at once instead of spinning, and then does not move. It is filled from two places
that were already carrying the same bytes: the gateway link `--push` holds, and proxied
`GET /api/sessions/<id>/messages` answers.

What that means for an operator:

- **This is transcript content on your disk**, not just a credential. The state directory is `0700`
  with `0600` files, and `--cache-max-mb 0` turns the whole thing off.
- **A shared Bot Chat is cached for everybody; a private chat is cached for one person.** Since
  ADR-0007's amendment a bot has two kinds of conversation, so every entry carries whose it is. The
  ones the `--push` link resumes are the canonical Bot Chats and stay shared; a transcript captured
  off a proxied read is stored under the reader the gateway names and comes back to that reader
  alone — as a miss for anybody else, because a refusal would also say the chat exists. The read
  route still demands the caller's own gateway session on a gated gateway.
- **Without `--push` every captured entry belongs to its reader.** With no gateway link there is
  nothing that can tell a shared chat from a private one, so the safe reading is taken: a second
  person's first open of a shared chat is cold, which is where it was before this cache existed. An
  ungated gateway has nobody to name and its entries stay shared.
- **Eviction is least-recently-read**, up to `--cache-max-mb`, default 64.
- **Without `--push` it still works**, filled by proxied reads alone: a chat you have opened is a
  chat your next device opens instantly.

[ADR-0025](https://github.com/fullstackstudio-nl/hermie/blob/main/docs/adr/0025-hermie-web-is-a-service-layer.md)
has the reasoning.

## Administration

A configured service serves **`/admin`**: what it is running, what it will send, what it keeps, how
this team's build looks, and what it will do for each person who signs in through it.

**Who gets in.** A gateway user id on this service's own list. Whoever completes `/setup` is added
automatically — that is the one moment the process can point at somebody without being told — and
others are added on the page. The gate is the gateway's `/api/auth/me`, asked fresh on every
request: this service issues no session of its own and has no user database, which is the same rule
`/hermie/update` and the cache route already follow.

**A gateway with no accounts** names everybody the same thing, so an id list would be a list of one.
Setup can take an **administrator secret** instead, stored as a scrypt hash and never shown back. A
deployment on such a gateway with no secret has no way into `/admin` short of editing `admin.json`;
the setup page says so when it saves.

**The page is HTML with no script in it.** Every control is a form that posts, changes one thing and
redirects, with a double-submit CSRF token checked before the body is read. Nothing secret is
rendered — not the VAPID private key, not the service refresh token, not the secret above — only
whether each exists.

### What it can set

| Panel         | What it changes                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | Shows the version, the service login, the push daemon, the VAPID key, cache size and hit rate; **Update and restart** runs the same self-update the app's Settings row does. |
| Push          | Which event types this service will send at all, and whether a notification may carry message text. A ceiling on what devices asked for, never a second opt-in.              |
| Message cache | How long an unread entry is kept (`0` = only the size cap), and **Clear the cache now**.                                                                                     |
| Branding      | A name, an accent and a starting theme, served in `/hermie/config.json` and read by the app before it draws. A starting point, never an override.                            |
| Features      | Turn private chats, the message cache or the update button off for everybody on this deployment.                                                                             |
| People        | Everyone this service has seen sign in, with per-person options.                                                                                                             |

### The per-person options, and their honest limit

They are **service-level settings, not gateway permissions**. The gateway has none to set, and this
service can only decide what it does itself:

- **Push allowed** and **allowed bots** are enforced completely. The daemon and the cache are this
  service's own, so nothing is sent and nothing is served outside them.
- **Read-only** refuses every mutating request that arrives over HTTP — the REST surface and file
  uploads.
- **Read-only does not police the gateway WebSocket**, which is a raw byte pipe by design and
  carries prompts, approvals and profile changes. It is a guard rail against accident, not a
  boundary against intent. A deployment that needs the second thing needs two gateways.

### The people list

It is **who has signed in through this service**, with when — not the gateway's account list.
Upstream documents no route for listing accounts, and guessing at one would mean reading a 404 as
"no users". The page labels which of the two it is showing.

## Signing people in, when there is nothing to sign them in with

Hermie Web can be **its own OpenID Provider**. It is **off**, and a deployment that has an identity
provider should leave it off and point the gateway at that one instead.

It exists for the operator who has neither: one gateway, a handful of people, and no Authentik or
Keycloak to point `dashboard.oauth.self_hosted` at. The alternatives were an ungated gateway — where
everyone is the same person, so there are no private chats, no per-person rules and nobody for a
notification to be addressed to — or standing up a second service with its own database to put in
front of one Python process.

**Turning it on makes this service the identity root of your gateway.** Whoever can read its state
directory can mint any account on that gateway, not merely read what is stored. That is what an
identity provider is, there is no setting that softens it, and it is why the switch is on a page of
its own with the consequence written beside it.

### Enabling it

1. **Put TLS in front of this service first.** The gateway refuses an issuer that is not `https` —
   it allows plain `http` only on `localhost`, `127.0.0.1` and `::1` — so a provider enabled on a
   plain-http hostname would work in a browser and be rejected by the gateway. `/admin/oidc` refuses
   to enable on such an origin for that reason. `--allow-insecure-oidc` exists to reproduce that
   refusal deliberately, not to work around it.
2. **Open `/admin/oidc` on the address you want to be the issuer** and press **Turn it on**. The
   issuer becomes `<that origin>/oidc`, because that is the address a browser can actually come back
   to, and every token will carry it as `iss` from then on.
3. **Copy the snippet the page prints into the gateway's `config.yaml`** and restart the gateway.
   Enabling here changes nothing there; it tells you what to change.

   ```yaml
   dashboard:
     public_url: https://hermes.example.com
     oauth:
       self_hosted:
         issuer: https://hermes.example.com:9443/oidc
         client_id: hermie-web-0123456789abcdef
         scopes: openid profile email offline_access
   ```

   `offline_access` is not optional in practice. Without it the gateway is issued no refresh token,
   and this service's own push sign-in cannot be made at all.

4. **Add people.** Creating somebody mints a **one-time invitation link** they use to choose their
   own password — nobody else, including you, ever sees it. The link is shown once, works once, and
   lapses in a day.
5. **Press Test sign-in.** It runs the whole round trip from the server against its own issuer —
   discovery, the JWKS, the sign-in form, the code exchange, the ID token's signature against the
   published key, and the refresh grant — and reports each step. It reads the authorization redirect
   and never follows it, so the diagnostic cannot sign anybody in to the gateway as a side effect.

### What it is

Authorization code with PKCE and nothing else: `S256` required, no implicit flow, no password grant,
no dynamic client registration, no federation, no SCIM. RS256, because that is what the gateway's
own validator accepts first. Passwords are hashed with `scrypt` — argon2id would be better and is a
native dependency this package does not have; the trade is written down in ADR-0025 rather than
hidden. Optional TOTP (RFC 6238) with single-use recovery codes. Refresh tokens rotate, and
presenting a token that has already been rotated revokes every token from that sign-in.

The signing key can be rotated from the page. The old key stays in the published JWKS until
everything it signed has expired plus the window a relying party caches the JWKS for, so a rotation
signs nobody out.

Every page it serves is HTML with no script in it, like `/setup` and `/admin`.

### The one redirect URI, and why the app is not in it

The registered redirect URI is the **gateway's** `/auth/callback`, built from its `public_url`. A
phone signing in never talks to this issuer: the gateway brokers that flow, and the app's loopback
redirect is registered with the gateway, not here. The list is editable for a deployment that
genuinely has a second client.

[ADR-0025](https://github.com/fullstackstudio-nl/hermie/blob/main/docs/adr/0025-hermie-web-is-a-service-layer.md)
has the reasoning and the whole threat model.

## Documentation

- [How Hermie Web works](https://github.com/fullstackstudio-nl/hermie/blob/main/docs/web.md) — the
  design: why the gateway is reached _through_ this process, how signing in works in a browser, and
  what the self-update does and does not verify.
- [Running it on your own server](https://github.com/fullstackstudio-nl/hermie/blob/main/deploy/web/README.md) —
  the runbook: gateway settings, a release-zip install, systemd, Docker, TLS with Caddy, nginx or
  Tailscale Serve, and a troubleshooting table.

## Licence

MIT, copyright FullStack Studio.
