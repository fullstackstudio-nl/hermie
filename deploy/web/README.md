# Hermie Web — running it on your own server

Hermie Web is one small Node process that serves the browser build of Hermie and proxies **one**
Hermes gateway onto its own origin. It is meant to sit next to `hermes serve`, on its own port.

It has no runtime dependencies, needs Node 22 or newer, and **authenticates nobody** — the gateway
does that, and Hermie Web only makes its cookie session reachable from a page. Everything below
follows from that: bind it to loopback, and put TLS in front of it if it has to leave the machine.

Why it exists at all, and why the gateway is reached _through_ it rather than directly, is
[ADR-0015](../../docs/adr/0015-web-variant-on-its-own-port.md).

---

## Quick start

```sh
# Next to `hermes serve` on the same machine:
npx @hermie/web --gateway http://127.0.0.1:9119
# → http://127.0.0.1:9120
```

Open that address in a browser. There is no wizard to speak of: Hermie Web already fixed the
gateway, so a reader lands on the sign-in and goes Sign in → Test → Done.

### Or set it up from the browser

Leave `--gateway` off and Hermie Web serves an **operator setup page** at `/setup` instead of the
app — the gateway address, a probe of it, and the service login that push and the message cache are
spent on. Saving writes it to the state directory and `/setup` answers 404 from then on, for this
process and for every later one.

```sh
npx @hermie/web            # → http://127.0.0.1:9120/setup
```

Three things to know before you use it:

- **Do not expose the port before it is configured.** While the page is open, whoever reaches the
  port can point the proxy at a URL — including something else on this machine's loopback
  interface. It is the same power `--gateway` gives, handed to the first arrival. `--gateway` skips
  the page entirely.
- **Open it on `http://127.0.0.1:9120`, not `localhost`.** The service login is the gateway's native
  PKCE flow, and the gateway refuses a redirect URI whose host is not a loopback IP literal
  (RFC 8252 §8.3). Where that is impossible, use `hermie-web login` from a terminal.
- **Restart once you have saved**, if you want `--push`: the daemon is not started on a process that
  had no gateway when it booted.

## What to configure on the gateway

Two settings in the Hermes configuration, and only the second is conditional.

| Setting                     | When                                        | Why                                                                                                                                                                           |
| --------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard.public_url`      | Always                                      | The host the gateway believes it is served on. Hermie Web writes it into `Host` and `Origin` on every proxied request, which is what gets past the gateway's rebinding guard. |
| `dashboard.trusted_proxies` | When Hermie Web runs on a different machine | Lets the gateway read `X-Forwarded-For` instead of seeing Hermie Web's own address as every client.                                                                           |

If `dashboard.public_url` is not what Hermie Web derived from `--gateway`, say so explicitly:

```sh
hermie-web --gateway http://10.0.0.5:9119 --public-url https://hermes.example.com
```

A mismatch shows up as HTTP 403 on `/api/status`, or a WebSocket that refuses the upgrade with
`host_mismatch` / `origin_mismatch` in the gateway's log. That is the guard doing its job.

## Flags and environment

| Flag                    | Environment                    | Default                  |                                                                                                                             |
| ----------------------- | ------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `--gateway <url>`       | `HERMIE_GATEWAY_URL`           | `http://127.0.0.1:9119`  | The gateway. Fixed at start; nothing at runtime can change it.                                                              |
| `--port <n>`            | `HERMIE_PORT`                  | `9120`                   |                                                                                                                             |
| `--host <addr>`         | `HERMIE_HOST`                  | `127.0.0.1`              | Anything else puts an unauthenticated port on the network.                                                                  |
| `--public-url <url>`    | `HERMIE_PUBLIC_URL`            | derived from `--gateway` | Written into `Host` and `Origin` on proxied requests.                                                                       |
| `--static <dir>`        | `HERMIE_STATIC_DIR`            | the bundled `dist/web`   |                                                                                                                             |
| `--login-return <p>`    | `HERMIE_LOGIN_RETURN`          | `/`                      | Where a finished sign-in should land. See **OIDC** below.                                                                   |
| `--install-root`        | `HERMIE_INSTALL_ROOT`          | the package's parent     | Where self-update unpacks releases and keeps the `current` link.                                                            |
| `--no-self-update`      | `HERMIE_SELF_UPDATE=0`         | on                       | Turns `/hermie/update` into a refusal.                                                                                      |
| `--rollback`            |                                |                          | Point `current` at the previous release and exit.                                                                           |
| `--cache-max-mb <n>`    | `HERMIE_CACHE_MAX_MB`          | `64`                     | Disk the message cache may take. `0` turns it off.                                                                          |
| `--allow-insecure-oidc` | `HERMIE_ALLOW_INSECURE_OIDC=1` | off                      | Let the built-in identity provider be enabled on a non-https origin. The gateway refuses such an issuer anyway — see below. |

And, for push (see below):

| Flag                     | Environment                     | Default                     |                                                                              |
| ------------------------ | ------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `--push`                 | `HERMIE_PUSH=1`                 | off                         | Also watch every Bot Chat and notify registered devices.                     |
| `--gateway-token <t>`    | `HERMIE_GATEWAY_TOKEN`          |                             | The session token an ungated gateway takes.                                  |
| `--state-dir <dir>`      | `HERMIE_STATE_DIR`              | `~/.local/state/hermie-web` | Watch state, VAPID keys and any stored sign-in. Written `0600`.              |
| `--vapid-subject <uri>`  | `HERMIE_VAPID_SUBJECT`          | `https://hermie.dev`        | `mailto:` or `https:` contact in the VAPID token (RFC 8292 §2.1).            |
| `--push-server-requests` | `HERMIE_PUSH_SERVER_REQUESTS=1` | off                         | **Only if your gateway fans server requests out to every peer** — see below. |

Endpoints it answers itself: `GET /healthz`, `GET /hermie/config.json`, `GET|POST /hermie/update`,
`GET /hermie/cache/<id>`, `/setup` and `/hermie/setup/*` while no gateway is configured, and — with
`--push` — `GET /push/vapid-public-key`. Everything under `/api`, `/auth`, `/login` and `/logout` is
proxied; everything else is the app.

## The message cache

Hermie Web keeps each Bot Chat's tail in its state directory, so a chat opened on a device that has
never seen it paints at once instead of spinning. It is filled from the gateway link `--push`
already holds and from proxied `GET /api/sessions/<id>/messages` answers, so it works with or
without `--push` — with it, chats nobody has opened yet are cached too.

What it means for you:

- **This is transcript content on your disk.** The state directory is `0700` with `0600` files, the
  same as the push credentials beside it. `--cache-max-mb 0` turns the cache off entirely.
- **A shared Bot Chat is cached for everybody; a private chat is cached for one person.** A bot now
  has two kinds of conversation, so each entry carries whose it is. The chats the `--push` link
  resumes are the shared ones; a transcript captured off a proxied read belongs to the reader the
  gateway named, and anybody else asking for it is told there is nothing cached. On a gated gateway
  the read route still demands the caller's own gateway session.
- **Without `--push` every captured entry belongs to its reader**, because nothing can tell the two
  kinds apart. A second person's first open of a shared chat is cold, exactly as it was before this
  cache existed. An ungated gateway has nobody to name and its entries stay shared.
- **Eviction is least-recently-read**, up to `--cache-max-mb` (default 64 MB).

[ADR-0025](../../docs/adr/0025-hermie-web-is-a-service-layer.md) has the reasoning.

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

## Signing people in without a separate identity provider

Hermie Web can be **its own OpenID Provider**, so a gateway can be gated without standing up
Authentik or Keycloak beside it. It is **off**, and a deployment that already has an identity
provider should leave it off and point `dashboard.oauth.self_hosted` at that one.

> **Read this before you turn it on.** It makes this service the **identity root of your gateway**.
> Whoever can read `--state-dir` can sign an ID token with any subject and be any account on that
> gateway — not merely read what is stored. There is no setting that reduces this; it is what an
> identity provider is. The full threat model is in
> [ADR-0025](../../docs/adr/0025-hermie-web-is-a-service-layer.md).

### Before you start

- **TLS in front of this service is a precondition, not advice.** The gateway refuses an issuer that
  is not `https`, allowing plain `http` only on `localhost`, `127.0.0.1` and `::1`. `/admin/oidc`
  refuses to enable on any other plain-http origin for exactly that reason — otherwise you would get
  a provider that works in a browser and is rejected by the gateway. See **Putting TLS in front**
  below.
- **You need `/admin`.** The provider is enabled from there, so a deployment nobody can administer
  (see **Administration**) cannot enable it at all.
- **Decide your issuer origin now.** The issuer is taken from the address you reach `/admin/oidc`
  on, and every token ever issued carries it. Changing it later means re-registering with the
  gateway and signing everybody out.
- **Add `--state-dir` to your backups, and treat that backup as a credential.** It now holds the
  signing key and every account.

### The steps

1. Open **`https://<this service>/admin/oidc`** on the address you want to be the issuer.
2. Press **Turn it on**. The issuer becomes `<that origin>/oidc`; a signing key and a client id are
   generated on the spot, and the client id is fixed for this install.
3. Copy the snippet the page prints into the gateway's `config.yaml` and **restart the gateway**.
   Enabling here writes nothing there — Hermie Web does not touch the gateway's configuration and
   would not know how.

   ```yaml
   dashboard:
     public_url: https://hermes.example.com
     oauth:
       self_hosted:
         issuer: https://hermes.example.com:9443/oidc
         client_id: hermie-web-0123456789abcdef
         scopes: openid profile email offline_access
   ```

   or, for a container:

   ```sh
   HERMES_DASHBOARD_OIDC_ISSUER=https://hermes.example.com:9443/oidc
   HERMES_DASHBOARD_OIDC_CLIENT_ID=hermie-web-0123456789abcdef
   HERMES_DASHBOARD_OIDC_SCOPES="openid profile email offline_access"
   ```

   **Keep `offline_access`.** Without it the gateway is issued no refresh token, and `hermie-web
login` — the service sign-in that `--push` and the message cache are spent on — cannot be made at
   all. It fails with that exact complaint.

4. Add people on the same page. Each one gets a **one-time invitation link** to choose their own
   password with; you never see it. The link works once and lapses in a day.
5. Press **Test sign-in** with one of those accounts. It runs discovery, the JWKS, the sign-in form,
   the code exchange, the ID token's signature against the published key, userinfo and the refresh
   grant, and tells you which step failed if one does. It reads the authorization redirect and never
   follows it, so it cannot sign anybody in to the gateway as a side effect.
6. Only then, sign in to the app normally. The **OIDC** section below still applies in full: the
   gateway's callback is fixed to `public_url`, so Hermie Web has to answer on that same hostname on
   another port, and `--login-return` has to point the landing back.

### Day-to-day

| You want to                          | Do this                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Add somebody                         | `/admin/oidc` → fill the row → **Invite**, then send them the link it shows once.                                     |
| Reset a password                     | **Reset password** on their row. It mints a fresh link and ends their sessions.                                       |
| Remove somebody's access now         | **Disable**. Their refresh tokens are dropped and their sign-in sessions end immediately.                             |
| Help somebody who lost their phone   | **Clear two-factor**. They enrol a new authenticator at their next sign-in.                                           |
| Require a second factor for everyone | **Settings** → _Require a second factor_. Anybody without one enrols at their next sign-in.                           |
| Rotate the signing key               | **Rotate the signing key**. Nobody is signed out: the old key stays published until everything it signed has expired. |
| Turn it off                          | **Turn it off**. Accounts and keys are kept, every refresh token is dropped, and `/oidc` answers 404 again.           |

### What it deliberately is not

Authorization code with PKCE (`S256` required) and nothing else — no implicit flow, no password
grant, no dynamic client registration. **No federation and no SCIM**: if you have something to
federate with, point the gateway at that instead. RS256, because that is what the gateway's
validator accepts first. Passwords are `scrypt` (argon2id would be better and is a native dependency
this package does not carry — ADR-0025 says so rather than hiding it). Optional TOTP with single-use
recovery codes. `/oidc/logout` ends the sign-in here only; the gateway's own session lasts until its
ID token expires.

The one registered redirect URI is the **gateway's** `/auth/callback`. A phone never talks to this
issuer — the gateway brokers the native flow and the app's loopback redirect is registered with the
gateway, not here.

### When it does not work

| What you see                                                      | What it is                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The **Turn it on** button is disabled                             | You reached the page on a plain-http origin that is not loopback. Put TLS in front; the gateway would refuse it too.       |
| Gateway log: `OIDC issuer must be https://`                       | The same thing, from the other side.                                                                                       |
| Gateway log: `OIDC discovery issuer mismatch`                     | The gateway's configured `issuer` is not the one on the page. Copy it again; a trailing slash is tolerated, a port is not. |
| Gateway log: `OIDC discovery resolved to …, outside the … origin` | Something redirected the discovery fetch — usually a proxy upgrading `http` to `https` on a different host.                |
| Gateway log: `OIDC discovery unreachable`                         | The gateway cannot reach this service's issuer URL. Press **Test sign-in**: its first step reads the same URL.             |
| Sign-in works, then push cannot be set up                         | `offline_access` is missing from the gateway's `scopes`. The test sign-in's last step says so explicitly.                  |
| `/oidc/...` answers 404                                           | The provider is off — or this is a different Hermie Web to the one you enabled it on.                                      |

## Push notifications

Off by default. With `--push`, the same process holds a second connection to the same gateway,
watches every Bot Chat, and notifies devices that registered themselves through the gateway's
`ui_meta`. There is no inbound endpoint and nothing to expose: the app never talks to this process.
[ADR-0017](../../docs/adr/0017-push-through-hermie-web.md) is the design;
[docs/web.md](../../docs/web.md#push-notifications) is the self-hoster's version of it.

```sh
# Ungated gateway:
hermie-web --gateway http://127.0.0.1:9119 --push --gateway-token "$HERMES_SESSION_TOKEN"

# OIDC-gated gateway — once, interactively, then start it normally:
hermie-web --gateway https://hermes.example.com login
hermie-web --gateway https://hermes.example.com --push
```

`login` prints a URL rather than opening one, and listens on `127.0.0.1:38007` for the redirect. On
a headless server, reach that port from your laptop with an SSH tunnel and open the URL there:

```sh
ssh -L 38007:127.0.0.1:38007 server
```

Use `--redirect-port` if 38007 is taken; the gateway has to accept that redirect URI.

**How it hears about an approval, and the one flag worth reading twice.** By default the daemon does
not ask the gateway to route approval and clarify requests to it. It finds open questions in the
snapshot a resume answers with and in an `approval.pending` poll every 30 seconds — the same method
and cadence the app uses, and only while a device is registered.

`--push-server-requests` asks for the live route instead. **Only turn it on if your gateway fans a
server request out to every peer of a session.** The daemon never answers a question — an approval is
the owner's — so on a gateway that routes to a single peer, a daemon that receives one and holds it
open has taken it away from you, and the app that should have shown it never will. The default costs
you at most thirty seconds of latency on an approval notification; the flag can cost you the
approval.

**What it costs.** A watcher that resumes every Bot Chat keeps every Bot Chat resident in the
gateway's live-session list, because upstream never evicts a session whose transport is alive. If you
run with `max_live_sessions` set, the daemon's chats count against it. Per finished turn it also
reads five rows off `GET /api/sessions/{id}/messages` — on a gateway with no REST transcript that
falls back to `session.history`, which is unpaginated and returns the whole chat.

**What it can read.** Everything. Watching a transcript requires reading it, so the state directory
holds a credential with the gateway's full reach. Keep it on the gateway's own host, and keep its
permissions — the process writes `0600` inside `0700` and will tighten a directory it finds looser.

**Web Push needs TLS.** A service worker and a `PushSubscription` are https-only, which is the same
condition this README already puts on exposing Hermie Web at all. Over plain http the browser build
does not offer it; phones on Expo are unaffected.

For systemd, add the state directory to `ReadWritePaths` (or use `StateDirectory=hermie-web`) and put
the token in an `EnvironmentFile` rather than on the `ExecStart` line, where it would be visible in
`ps`.

## Install from a release zip

```sh
VERSION=0.2.0
curl -fLO "https://github.com/fullstackstudio-nl/hermie/releases/download/v$VERSION/hermie-web.zip"
curl -fLO "https://github.com/fullstackstudio-nl/hermie/releases/download/v$VERSION/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS

sudo mkdir -p /opt/hermie-web/releases
sudo unzip -q hermie-web.zip -d "/opt/hermie-web/releases/$VERSION"
# no install step: the server has no runtime dependencies
sudo ln -sfn "/opt/hermie-web/releases/$VERSION" /opt/hermie-web/current
sudo node /opt/hermie-web/current/bin/hermie-web --gateway http://127.0.0.1:9119
```

The `current` symlink is the same one self-update flips, so an install laid out this way can update
itself later.

## systemd

`/etc/systemd/system/hermie-web.service`:

```ini
[Unit]
Description=Hermie Web
After=network-online.target hermes.service
Wants=network-online.target

[Service]
Type=simple
User=hermie
WorkingDirectory=/opt/hermie-web/current
ExecStart=/usr/bin/node /opt/hermie-web/current/bin/hermie-web
Environment=HERMIE_GATEWAY_URL=http://127.0.0.1:9119
Environment=HERMIE_PUBLIC_URL=https://hermes.example.com
Environment=HERMIE_INSTALL_ROOT=/opt/hermie-web
# Self-update answers the HTTP request, then exits 0. This line is what turns
# that into a restart rather than an outage — without it, an update stops the
# service and nothing starts it again.
Restart=always
RestartSec=1

# It serves static files and proxies one local port; it needs nothing else.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/hermie-web

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now hermie-web
```

`ExecStart` points at `current`, so a self-update is picked up by the restart. `ReadWritePaths` has
to include the install root or the update cannot unpack; drop it (and set
`Environment=HERMIE_SELF_UPDATE=0`) if you would rather update by hand.

## Docker

```sh
docker run -d --name hermie-web \
  --restart unless-stopped \
  -p 127.0.0.1:9120:9120 \
  --add-host host.docker.internal:host-gateway \
  ghcr.io/fullstackstudio-nl/hermie-web:latest \
  --gateway http://host.docker.internal:9119 \
  --public-url https://hermes.example.com
```

`--gateway` is not optional in practice: the default reaches loopback **inside the container**,
which is not where `hermes serve` is. Inside a container the self-update endpoint reports
`canSelfUpdate: false` and points at `docker pull`, because the image is the version.

## OIDC: Hermie Web must share the gateway's public hostname (another port)

If your gateway signs people in with OIDC, this is the one rule that decides whether the sign-in can
work at all. Get it wrong and the round trip ends on:

```json
{ "detail": "Missing PKCE state cookie" }
```

**The callback is fixed to `public_url`.** The gateway builds the `redirect_uri` it gives the
identity provider out of `dashboard.public_url` and nothing else. The PKCE state that has to be
there when the browser comes back is a cookie, and a cookie belongs to a **host name** — it ignores
the port, but not the name. So Hermie Web has to answer on the **same hostname** as `public_url`,
on **another port**. A second hostname (`hermie.example.com` next to `hermes.example.com`) cannot
work, however carefully the rest is configured: the cookie is on a host the callback never visits.

**Then point the landing back.** `next=` comes back from `/auth/callback` as a relative redirect, so
the browser resolves it against the gateway's port — a successful sign-in would finish on the
dashboard. Give the gateway's own vhost a path that redirects to Hermie Web, and start Hermie Web
with `--login-return <that path>`. It is published in `/hermie/config.json` as `loginReturn` and the
app sends it as `next=`; both ends refuse anything that is not a path on this origin.

Worked example: gateway on `https://hermes.example.com` (443), Hermie Web on 9443 of that same name.

```nginx
# Hermie Web on its own port, same name as the gateway's public_url — that is
# what lets the PKCE cookie survive the round trip to the identity provider.
server {
    listen 443 ssl http2;                 # the gateway's own vhost, unchanged
    server_name hermes.example.com;

    # ... the gateway proxy_pass block ...

    # Where /auth/callback lands people when the app asked for next=/hermie.
    # A path of its own, so it can never collide with a dashboard route.
    location = /hermie { return 302 https://$host:9443/; }
}

server {
    listen 9443 ssl http2;
    server_name hermes.example.com;       # the SAME name, deliberately

    ssl_certificate     /etc/letsencrypt/live/hermes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hermes.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9120;
        proxy_http_version 1.1;

        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # `$http_host` and not `$host`: `$host` is the name with the port
        # stripped off it, so on a port that is not 443 this service is told it
        # is on `example.com` while the browser is on `example.com:9443` — and
        # every address it then builds (the issuer, an invitation link, the
        # service-login redirect) points at a port nothing is listening on.
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $http_host;
        proxy_set_header X-Forwarded-Port  $server_port;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```sh
hermie-web --gateway http://127.0.0.1:9119 \
  --public-url https://hermes.example.com \
  --login-return /hermie
```

Open `https://hermes.example.com:9443/` to use it. Whatever port you pick has to be open in the
firewall on the interface Hermie Web is reached over, and the certificate has to cover that name —
a wildcard or the gateway's own certificate already does.

Password providers are unaffected: `POST /auth/password-login` answers in place and never leaves the
page, so nothing about it depends on where the callback points.

## Putting TLS in front

Hermie Web speaks plain HTTP and expects something in front of it whenever it is reachable beyond
the machine it runs on. All three of these pass `X-Forwarded-Proto`, which is what makes the
gateway issue `Secure` cookies with the right names.

**On a port that is not 443, pass the port too.** Hermie Web builds three addresses out of these
headers that an operator cannot correct afterwards: the OIDC issuer, an invitation link, and the
redirect the service login comes back to. nginx's `$host` is the name with the port **stripped off
it**, so the block most guides print reports `example.com` while the browser is on
`example.com:9443`, and every one of those addresses then points at a port nothing is listening on.
Use `$http_host` for both `Host` and `X-Forwarded-Host`, and add `X-Forwarded-Port $server_port` —
or set the standard `Forwarded` header, which carries the port inside `host=` and which Hermie Web
reads for whichever half the `X-` headers did not say. Caddy and Tailscale Serve get this right
without being asked. If it has already happened to you, `/admin/oidc` prints the stored issuer next
to the address you reached it on and offers to re-capture it.

### Caddy

```caddyfile
hermie.example.com {
	reverse_proxy 127.0.0.1:9120
}
```

Caddy sets `X-Forwarded-*` and handles the WebSocket upgrade itself; nothing else is needed.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name hermie.example.com;

    ssl_certificate     /etc/letsencrypt/live/hermie.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hermie.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9120;
        proxy_http_version 1.1;

        # Without these two the WebSocket never upgrades and the app sits on
        # "connecting" for ever while REST works perfectly.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # `$http_host`, not `$host`: `$host` has the port stripped off it, and
        # this service builds addresses out of what these headers say.
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $http_host;
        proxy_set_header X-Forwarded-Port  $server_port;

        # An agent's reply can stream for minutes; the default 60 s read timeout
        # cuts the socket mid-answer.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Tailscale Serve

The smallest correct deployment, and the one that needs no certificate of your own:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:9120
```

The app is then at `https://<machine>.<tailnet>.ts.net`, reachable only from the tailnet, with a
certificate Tailscale manages. Add `--funnel` only if you genuinely want it on the public internet —
that puts a gateway that runs shell commands one sign-in away from everyone.

## Updating

Settings → **Hermie Web** shows the running version, whether a newer one exists, and an **Update**
button when this install can apply it. The button downloads `hermie-web.zip`, checks it against the
release's `SHA256SUMS`, unpacks it into `<install-root>/releases/<version>/`, flips `current`, and
exits so the supervisor starts the new code; the page polls `/healthz` until the new version answers
and then reloads.

Two things to know before relying on it:

- **It is gated on your gateway session.** `POST /hermie/update` puts your own cookies to the
  gateway's `/api/auth/me` and refuses with 401 if that is not a 200.
- **The digest is not a signature.** It proves the bytes match what the release lists, and https
  proves they came from GitHub. That is the same trust as `npm i -g`.

Going back:

```sh
sudo -u hermie node /opt/hermie-web/current/bin/hermie-web --rollback --install-root /opt/hermie-web
sudo systemctl restart hermie-web
```

The previous release directory is kept, which is what makes that possible.

## Troubleshooting

| What you see                                          | What it usually is                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 403 on `/api/status`                                  | `--public-url` does not match the gateway's `dashboard.public_url`.                          |
| `Missing PKCE state cookie` at the end of a sign-in   | Hermie Web is on a different HOSTNAME from the gateway's `public_url`. See **OIDC** above.   |
| Signed in successfully, but landed on the dashboard   | The gateway's redirect went to its own port. Set `--login-return` and the matching redirect. |
| REST works, the socket never connects                 | The reverse proxy is not passing the upgrade (see the nginx block above).                    |
| Signed in, then signed out again on reload            | A `Secure` cookie over a plain-HTTP origin. Put TLS in front, or reach it over loopback.     |
| Every client shows up as Hermie Web's address in logs | `dashboard.trusted_proxies` does not name the machine Hermie Web runs on.                    |
| `no_web_build` from `/`                               | The static export is missing. `npm run web:build`, or point `--static` at one.               |

With `--push`:

| What you see                                              | What it usually is                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `push_unavailable` from `/push/vapid-public-key`          | The process was started without `--push`.                                                                                               |
| Settings says push is not available                       | The daemon is not running, or cannot write `ui_meta` — its liveness stamp is what Settings reads.                                       |
| `hermie-web login` refuses and names `offline_access`     | The identity provider issued no refresh token. That scope is on the provider's client registration.                                     |
| The daemon connects, then notifies nothing                | Nobody is registered yet, or every registration has that event type switched off. A type nobody opted into is off.                      |
| An approval notification takes up to 30 s                 | That is the poll, and it is the safe default. `--push-server-requests` makes it immediate — read what it risks first.                   |
| An approval opens in the app and is never answerable      | `--push-server-requests` on a gateway that routes a request to one peer. Turn it off.                                                   |
| Push is slow on a very long chat                          | The gateway has no REST transcript, so classification falls back to the unpaginated `session.history`.                                  |
| Phones get notifications, browsers do not                 | Web Push is https-only. Over plain http the browser build never subscribes.                                                             |
| Browser subscriptions stopped working after a reinstall   | The state directory was lost, so the VAPID key pair changed. Existing subscriptions are bound to the old one and have to be made again. |
| Bots stay live on the gateway and hit `max_live_sessions` | That is the watcher: a resumed chat is a pinned chat. It is the price of hearing about a message as it is written.                      |
