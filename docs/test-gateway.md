# Setting up a gateway to develop against

An operator runbook for standing up a Hermes gateway that Hermie can be developed and tested
against: authenticated with OIDC, reachable over HTTPS, with a couple of bots and a scheduled job so
that every screen in the app has something real to show.

Run everything as `root` on a fresh Ubuntu 24.04 or newer host. Substitute your own hostname,
identity provider and model provider throughout — the commands below use placeholders in
`ANGLE_BRACKETS`.

Budget an hour, most of which is waiting for the installer and for DNS.

This runbook deliberately builds the **public** case, because it is the one with the most moving
parts: a routable host, a certificate, an identity provider that will only redirect to `https`. That
is not the only supported shape. A gateway on a tailnet is reached over plain `http://` and Hermie
connects to it as it stands — see "Keep the gateway off the public internet" in the README.

## Before you start

- A host with a public IPv4 address, ports 80 and 443 reachable.
- A DNS A record pointing at it. This runbook calls it `GATEWAY_HOST`.
- An OIDC provider where you can register a **public** client (PKCE, no client secret) with the
  redirect URI `https://GATEWAY_HOST/auth/callback`.
- Credentials for a model provider.

## 1. Install Hermes Agent

```sh
apt update
apt install -y git curl xz-utils ca-certificates jq
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- \
  --skip-setup --non-interactive --skip-browser --skip-computer-use
```

This puts the code in `/usr/local/lib/hermes-agent` and the data directory in `/root/.hermes`. The
browser and computer-use components are skipped: they are large, they need a display, and Hermie does
not exercise them.

## 2. Configure the model provider

This step needs a human with the provider account — it cannot be scripted in a pipeline, because the
OAuth flow prints a URL you have to open and a code you have to paste back:

```sh
hermes auth add anthropic --type oauth --no-browser
```

If you are using an API key instead, put it in `/root/.hermes/.env` as `ANTHROPIC_API_KEY=...` and
skip the command above.

Then point the agent at a model. Use the same model for cron jobs, so that a scheduled run behaves
like an interactive one:

```sh
hermes config set model.provider anthropic
hermes config set model.default MODEL_ID
hermes config set cron.model MODEL_ID
hermes config set cron.model_provider anthropic
```

## 3. Turn on the detail Hermie renders

Hermie can only display what the gateway sends. `verbose` is the only tool-progress level that
includes raw tool arguments and results, which is what the Verbose view in the app shows:

```sh
hermes config set display.tool_progress verbose
hermes config set display.interim_assistant_messages true
hermes config set display.show_reasoning true
hermes config set display.focus_view false
```

These are **global** settings, shared with the desktop and terminal clients on the same host. That is
exactly why Hermie never changes them silently — on a shared machine, do not set them without saying
so.

## 4. Configure OIDC and the public URL

```sh
hermes config set dashboard.public_url https://GATEWAY_HOST
hermes config set dashboard.oauth.self_hosted.issuer https://IDP_HOST/api/oidc
hermes config set dashboard.oauth.self_hosted.client_id CLIENT_ID
hermes config set dashboard.oauth.self_hosted.scopes "openid profile email"
```

Two things worth knowing:

- No client secret. The client must be registered as **public** with PKCE; Hermie is a native app and
  cannot hold a secret.
- Setting `dashboard.public_url` is what engages the authentication gate, even though the server
  binds to loopback. A reverse proxy on loopback is trusted automatically, so the gate does not lock
  you out of your own proxy.

## 5. Install the services

Two processes, and both are needed. `hermes serve` is the gateway Hermie talks to; `hermes gateway`
runs the scheduler that actually fires cron jobs. `serve` does not run the scheduler — a host with
only `serve` will list and accept cron jobs and never execute one.

```sh
hermes gateway install --system --start-on-login --start-now
loginctl enable-linger root
```

Then a unit for `serve`:

```sh
cat > /etc/systemd/system/hermes-serve.service <<'UNIT'
[Unit]
Description=Hermes gateway (serve)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HERMES_HOME=/root/.hermes
EnvironmentFile=-/root/.hermes/.env
ExecStart=/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main serve --host 127.0.0.1 --port 9119
Restart=always
RestartSec=2
KillMode=mixed

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now hermes-serve
```

Binding to `127.0.0.1` is deliberate: the reverse proxy in the next step is the only thing that
should reach it.

## 6. Put a reverse proxy in front

Caddy, because it gets a certificate on its own:

```sh
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
GATEWAY_HOST {
  reverse_proxy 127.0.0.1:9119
}
CADDY
systemctl reload caddy
```

If `ufw` is active, open the ports:

```sh
ufw allow 80/tcp
ufw allow 443/tcp
```

If your gateway sits behind an access proxy such as Cloudflare Access, exempt `/auth/*` and `/login`
from it. The sign-in flow runs inside the app's web view, and an interstitial login page there will
break it.

## 7. Create a couple of bots

One bot is enough to chat with; two are needed to see bot-to-bot traffic.

```sh
hermes profile create researcher --description "Looks things up and summarises them"
hermes profile create writer --description "Turns notes into prose"
```

For each profile, give it a personality in `/root/.hermes/profiles/PROFILE/SOUL.md`, and mark it as a
bot so that it shows up in Hermie's list. In `/root/.hermes/profiles/PROFILE/profile.yaml`:

```yaml
ui_meta:
  hermes-bots: {}
```

Enable the bot-to-bot protocol, and open each bot's canonical chat so that Hermie finds an existing
conversation rather than having to create one:

```sh
hermes config set agent.bot_mode_protocol true
hermes -p researcher chat -c "Bot Chat" --create-if-missing -Q -q "Introduce yourself in one line."
hermes -p writer     chat -c "Bot Chat" --create-if-missing -Q -q "Introduce yourself in one line."
```

The session title has to be exactly `Bot Chat` — that is the canonical chat Hermie resumes.

Optionally point delegations at a cheaper model, since subagents are chatty:

```sh
hermes config set delegation.model CHEAP_MODEL_ID
```

## 8. Create some scheduled jobs

Enough variety that the routines screen has something to show:

```sh
hermes cron create "every 2h" "Report the host's uptime and disk usage in one line." \
  --name "Host heartbeat" --deliver local
hermes cron create "in 5m" "Say hello once." \
  --name "One-off smoke test" --deliver local
hermes cron create "every day at 9am" "[bot:researcher] Summarise anything new worth knowing." \
  --name "Morning sweep" --deliver bot-chat:researcher
```

The `in 5m` job is there so you can watch one fire without waiting two hours.

## 9. Verify

Authentication is advertised the way Hermie expects:

```sh
curl -s https://GATEWAY_HOST/api/status | jq '.auth_required, .auth_providers, .auth_flows'
```

Expected: `true`, a non-empty provider list, and an `auth_flows` array containing `native_pkce`.
Without `native_pkce`, Hermie cannot sign in — it does not use the browser-cookie flow.

Check the protocol version too. Hermie requires `desktop_contract` 7 or newer:

```sh
curl -s https://GATEWAY_HOST/api/status | jq '.version'
```

The scheduler is running and the jobs are registered:

```sh
hermes cron status
```

And watch both services while you exercise the app:

```sh
journalctl -u hermes-serve -u hermes-gateway -f
```

## Troubleshooting

**`/api/status` returns 404 or HTML.** Something other than Hermes is answering — usually the proxy
is pointing at the wrong port, or `serve` is not running.

**`auth_required` is false although OIDC is configured.** `dashboard.public_url` is not set. That
setting is what engages the gate.

**`GET /api/auth/providers` returns 503.** The gate is on but no provider resolved. Check the issuer
URL and that the client id exists at that issuer.

**Sign-in gets as far as the identity provider and then stalls.** Check that the redirect URI
registered there is exactly `https://GATEWAY_HOST/auth/callback`, and that no access proxy is
intercepting `/auth/*`.

**Cron jobs are listed but never run.** `hermes gateway` is not running. `hermes serve` alone does
not execute schedules.
