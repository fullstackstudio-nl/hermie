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

Open that address in a browser. The wizard has no address step: Hermie Web already fixed the
gateway, so it goes Welcome → Sign in → Test → Done.

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

| Flag                 | Environment            | Default                  |                                                                  |
| -------------------- | ---------------------- | ------------------------ | ---------------------------------------------------------------- |
| `--gateway <url>`    | `HERMIE_GATEWAY_URL`   | `http://127.0.0.1:9119`  | The gateway. Fixed at start; nothing at runtime can change it.   |
| `--port <n>`         | `HERMIE_PORT`          | `9120`                   |                                                                  |
| `--host <addr>`      | `HERMIE_HOST`          | `127.0.0.1`              | Anything else puts an unauthenticated port on the network.       |
| `--public-url <url>` | `HERMIE_PUBLIC_URL`    | derived from `--gateway` | Written into `Host` and `Origin` on proxied requests.            |
| `--static <dir>`     | `HERMIE_STATIC_DIR`    | the bundled `dist/web`   |                                                                  |
| `--install-root`     | `HERMIE_INSTALL_ROOT`  | the package's parent     | Where self-update unpacks releases and keeps the `current` link. |
| `--no-self-update`   | `HERMIE_SELF_UPDATE=0` | on                       | Turns `/hermie/update` into a refusal.                           |
| `--rollback`         |                        |                          | Point `current` at the previous release and exit.                |

And, for push (see below):

| Flag                    | Environment            | Default                     |                                                                   |
| ----------------------- | ---------------------- | --------------------------- | ----------------------------------------------------------------- |
| `--push`                | `HERMIE_PUSH=1`        | off                         | Also watch every Bot Chat and notify registered devices.          |
| `--gateway-token <t>`   | `HERMIE_GATEWAY_TOKEN` |                             | The session token an ungated gateway takes.                       |
| `--state-dir <dir>`     | `HERMIE_STATE_DIR`     | `~/.local/state/hermie-web` | Watch state, VAPID keys and any stored sign-in. Written `0600`.   |
| `--vapid-subject <uri>` | `HERMIE_VAPID_SUBJECT` | `https://hermie.dev`        | `mailto:` or `https:` contact in the VAPID token (RFC 8292 §2.1). |

Endpoints it answers itself: `GET /healthz`, `GET /hermie/config.json`, `GET|POST /hermie/update`,
and — with `--push` — `GET /push/vapid-public-key`. Everything under `/api`, `/auth`, `/login` and
`/logout` is proxied; everything else is the app.

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

**What it costs.** A watcher that resumes every Bot Chat keeps every Bot Chat resident in the
gateway's live-session list, because upstream never evicts a session whose transport is alive. If you
run with `max_live_sessions` set, the daemon's chats count against it.

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
cd "/opt/hermie-web/releases/$VERSION" && sudo npm ci --omit=dev   # a no-op today: no runtime deps
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

## Putting TLS in front

Hermie Web speaks plain HTTP and expects something in front of it whenever it is reachable beyond
the machine it runs on. All three of these pass `X-Forwarded-Proto`, which is what makes the
gateway issue `Secure` cookies with the right names.

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

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

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

| What you see                                          | What it usually is                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 403 on `/api/status`                                  | `--public-url` does not match the gateway's `dashboard.public_url`.                      |
| REST works, the socket never connects                 | The reverse proxy is not passing the upgrade (see the nginx block above).                |
| Signed in, then signed out again on reload            | A `Secure` cookie over a plain-HTTP origin. Put TLS in front, or reach it over loopback. |
| Every client shows up as Hermie Web's address in logs | `dashboard.trusted_proxies` does not name the machine Hermie Web runs on.                |
| `no_web_build` from `/`                               | The static export is missing. `npm run web:build`, or point `--static` at one.           |

With `--push`:

| What you see                                              | What it usually is                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `push_unavailable` from `/push/vapid-public-key`          | The process was started without `--push`.                                                                                               |
| Settings says push is not available                       | The daemon is not running, or cannot write `ui_meta` — its liveness stamp is what Settings reads.                                       |
| `hermie-web login` refuses and names `offline_access`     | The identity provider issued no refresh token. That scope is on the provider's client registration.                                     |
| The daemon connects, then notifies nothing                | Nobody is registered yet, or every registration has that event type switched off. A type nobody opted into is off.                      |
| Phones get notifications, browsers do not                 | Web Push is https-only. Over plain http the browser build never subscribes.                                                             |
| Browser subscriptions stopped working after a reinstall   | The state directory was lost, so the VAPID key pair changed. Existing subscriptions are bound to the old one and have to be made again. |
| Bots stay live on the gateway and hit `max_live_sessions` | That is the watcher: a resumed chat is a pinned chat. It is the price of hearing about a message as it is written.                      |
