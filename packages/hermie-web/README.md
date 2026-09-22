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

Flags beat environment variables beat defaults.

| Flag                 | Environment            | Default                  |                                                                                                         |
| -------------------- | ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--gateway <url>`    | `HERMIE_GATEWAY_URL`   | `http://127.0.0.1:9119`  | The gateway. Fixed at start; the only thing that can set one is `/setup`, and only while there is none. |
| `--port <n>`         | `HERMIE_PORT`          | `9120`                   |                                                                                                         |
| `--host <addr>`      | `HERMIE_HOST`          | `127.0.0.1`              | Anything else puts an unauthenticated port on the network.                                              |
| `--public-url <url>` | `HERMIE_PUBLIC_URL`    | derived from `--gateway` | The gateway's own `dashboard.public_url`, written into `Host` and `Origin` on every proxied request.    |
| `--static <dir>`     | `HERMIE_STATIC_DIR`    | the bundled `dist/web`   | The exported browser build.                                                                             |
| `--install-root`     | `HERMIE_INSTALL_ROOT`  | the package's parent     | Where self-update unpacks releases and keeps the `current` link.                                        |
| `--no-self-update`   | `HERMIE_SELF_UPDATE=0` | on                       | Turns `/hermie/update` into a refusal.                                                                  |
| `--rollback`         |                        |                          | Point `current` at the previous release and exit.                                                       |
| `--cache-max-mb <n>` | `HERMIE_CACHE_MAX_MB`  | `64`                     | Disk the message cache may take. `0` turns it off.                                                      |
| `--help`             |                        |                          |                                                                                                         |

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
- **Entries are per gateway, not per person.** The gateway offers no field saying who owns a
  session, so there is nothing to key on — and by ADR-0007 the canonical Bot Chat is shared among
  everyone who can reach that bot anyway. The read route still demands the caller's own gateway
  session on a gated gateway.
- **Eviction is least-recently-read**, up to `--cache-max-mb`, default 64.
- **Without `--push` it still works**, filled by proxied reads alone: a chat somebody has opened is
  a chat the next person opens instantly.

[ADR-0024](https://github.com/fullstackstudio-nl/hermie/blob/main/docs/adr/0024-hermie-web-is-a-service-layer.md)
has the reasoning.

## Documentation

- [How Hermie Web works](https://github.com/fullstackstudio-nl/hermie/blob/main/docs/web.md) — the
  design: why the gateway is reached _through_ this process, how signing in works in a browser, and
  what the self-update does and does not verify.
- [Running it on your own server](https://github.com/fullstackstudio-nl/hermie/blob/main/deploy/web/README.md) —
  the runbook: gateway settings, a release-zip install, systemd, Docker, TLS with Caddy, nginx or
  Tailscale Serve, and a troubleshooting table.

## Licence

MIT, copyright FullStack Studio.
