# hermie-web

Hermie in a browser. One small Node process that serves the browser build of
[Hermie](https://hermie.dev) — a client for [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) —
and proxies **one** Hermes gateway onto its own origin.

It is meant to sit next to `hermes serve`, on its own port. It has no runtime dependencies, needs
Node 22 or newer, and **authenticates nobody**: the gateway does that, and Hermie Web only makes the
gateway's cookie session reachable from a page. Bind it to loopback, and put TLS in front of it if it
has to leave the machine.

```sh
npx hermie-web --gateway http://127.0.0.1:9119
# → http://127.0.0.1:9120
```

Open that address. The setup wizard has no address step, because there is nothing to type: the
gateway is whatever this process is in front of.

## Flags

Flags beat environment variables beat defaults.

| Flag                 | Environment            | Default                  |                                                                                                      |
| -------------------- | ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `--gateway <url>`    | `HERMIE_GATEWAY_URL`   | `http://127.0.0.1:9119`  | The gateway. Fixed at start; nothing at runtime can change it.                                       |
| `--port <n>`         | `HERMIE_PORT`          | `9120`                   |                                                                                                      |
| `--host <addr>`      | `HERMIE_HOST`          | `127.0.0.1`              | Anything else puts an unauthenticated port on the network.                                           |
| `--public-url <url>` | `HERMIE_PUBLIC_URL`    | derived from `--gateway` | The gateway's own `dashboard.public_url`, written into `Host` and `Origin` on every proxied request. |
| `--static <dir>`     | `HERMIE_STATIC_DIR`    | the bundled `dist/web`   | The exported browser build.                                                                          |
| `--install-root`     | `HERMIE_INSTALL_ROOT`  | the package's parent     | Where self-update unpacks releases and keeps the `current` link.                                     |
| `--no-self-update`   | `HERMIE_SELF_UPDATE=0` | on                       | Turns `/hermie/update` into a refusal.                                                               |
| `--rollback`         |                        |                          | Point `current` at the previous release and exit.                                                    |
| `--help`             |                        |                          |                                                                                                      |

It answers `GET /healthz`, `GET /hermie/config.json` and `GET|POST /hermie/update` itself. Everything
under `/api`, `/auth`, `/login` and `/logout` is proxied to the gateway; everything else is the app.

## Documentation

- [How Hermie Web works](https://github.com/fullstackstudio-nl/hermie/blob/main/docs/web.md) — the
  design: why the gateway is reached _through_ this process, how signing in works in a browser, and
  what the self-update does and does not verify.
- [Running it on your own server](https://github.com/fullstackstudio-nl/hermie/blob/main/deploy/web/README.md) —
  the runbook: gateway settings, a release-zip install, systemd, Docker, TLS with Caddy, nginx or
  Tailscale Serve, and a troubleshooting table.

## Licence

MIT, copyright FullStack Studio.
