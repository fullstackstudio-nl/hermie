# Hermie on Kubernetes

Worked examples for running Hermie Web and the Hermes gateway as containers on a cluster. This is
the third deployment shape after `npx @hermie/web` / a release zip and plain Docker
([../web/README.md](../web/README.md)) — read that one first if you have not; everything it says
about the gateway relationship, OIDC and TLS still applies here, and this page only adds the
Kubernetes-specific parts.

**These are examples, not a Helm chart or an operator.** Copy the files, put your own hostnames,
storage classes and secrets in, and drop what you do not need.

## Why environment variables, not `args`

A container's `command`/`args` are baked into whatever creates the Pod — image, Deployment,
Helm values — and changing one commonly means changing more than the value itself. A Kubernetes
`env` (or `envFrom` a ConfigMap/Secret) is the thing meant to vary per environment, and it is what
lets one Deployment manifest move from staging to production by way of a different ConfigMap rather
than a different YAML file. Every flag `hermie-web` accepts has an environment variable
counterpart for exactly this reason — the full list is in
[../web/README.md#flags-and-environment](../web/README.md#flags-and-environment) — and the image's
`ENTRYPOINT` is left as `["hermie-web"]` so `--flags` still work if you ever want them; you should
not need to.

## Images

| Image                                              | What it is                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ghcr.io/fullstackstudio-org/hermie-web:<version>` | A tagged release. Pin this in anything you run more than once.                                     |
| `ghcr.io/fullstackstudio-org/hermie-web:latest`    | The newest tagged release. Fine for trying this out, not for a pin.                                |
| `ghcr.io/fullstackstudio-org/hermes-agent:main`    | The Hermes gateway (the fullstackstudio-org fork). See **The Hermes container's variables** below. |

## The two shapes

| File(s)                                                 | Shape                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sidecar.yaml`                                          | (a) Hermie Web as a **sidecar** in the same Pod as Hermes. Reaches it over `127.0.0.1:9119`. |
| `hermes-standalone.yaml` + `hermie-web-standalone.yaml` | (b) Hermie Web as its **own Deployment and Service**, reaching Hermes through a Service.     |
| `networkpolicy.yaml`                                    | With (b): only Hermie Web may reach the gateway — see **Two domains**.                       |

Apply `configmap.yaml` and a filled-in copy of `secret.example.yaml` first in either case:

```sh
kubectl apply -f configmap.yaml
cp secret.example.yaml secret.yaml   # fill in the real values, and do not commit secret.yaml
kubectl apply -f secret.yaml

# shape (a):
kubectl apply -f sidecar.yaml

# shape (b):
kubectl apply -f hermes-standalone.yaml
kubectl apply -f hermie-web-standalone.yaml
kubectl apply -f networkpolicy.yaml   # recommended; see **Two domains**
```

**Pick (a)** when you want the simplest possible unit — one Pod, one thing to schedule, the gateway
never reachable except through Hermie Web's proxy. **Pick (b)** when Hermes and Hermie Web have
different lifecycles or resource needs, or when something else on the cluster also needs to reach
the gateway's Service directly.

Neither shape scales past one replica of Hermes as written: the gateway keeps its state under
`/opt/data` on a `ReadWriteOnce` volume and a live-session list in memory, so a second replica would
be a second, different gateway rather than two copies of one. Hermie Web's own state (the push
watcher's cursor, the VAPID key pair, any stored `hermie-web login` credential, the message cache)
has the same constraint — see `--state-dir` in [../web/README.md](../web/README.md#the-message-cache)
— so both example Deployments use `strategy: { type: Recreate }` and one replica.

## The Hermes container's variables

The Hermes image configures itself from its environment on every start; the full list, and what
each variable does, is in the fork's
[docker.md, "Configure from environment variables"](https://github.com/fullstackstudio-org/hermes-agent/blob/main/website/docs/user-guide/docker.md#configure-from-environment-variables).
`configmap.yaml` and `secret.example.yaml` use these:

| Variable                                                                                                                                    | Where                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `HERMES_DASHBOARD`                                                                                                                          | ConfigMap (`1`: start the supervised dashboard)                                                 |
| `HERMES_DASHBOARD_PUBLIC_URL`                                                                                                               | ConfigMap — the primary public URL                                                              |
| `HERMES_DASHBOARD_PUBLIC_URLS`                                                                                                              | ConfigMap, comma-separated — further public URLs (see **Two domains**)                          |
| `HERMES_DASHBOARD_TRUSTED_PROXIES`                                                                                                          | ConfigMap, comma-separated addresses or bounded networks                                        |
| `HERMES_DASHBOARD_WRITE_ORIGIN_CHECK`                                                                                                       | ConfigMap (`auto`, `on` or `off`)                                                               |
| `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`                                                                                                      | Secret                                                                                          |
| `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH`                                                                                                 | Secret — preferred over `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`, which the image hashes itself   |
| `HERMES_DASHBOARD_BASIC_AUTH_SECRET`                                                                                                        | Secret — the session-signing secret                                                             |
| `HERMES_DASHBOARD_OIDC_ISSUER` / `HERMES_DASHBOARD_OIDC_CLIENT_ID` / `HERMES_DASHBOARD_OIDC_CLIENT_SECRET` / `HERMES_DASHBOARD_OIDC_SCOPES` | Secret (the issuer and client id could go in the ConfigMap; they are grouped for one `envFrom`) |
| `HERMES_DASHBOARD_HOST` / `HERMES_DASHBOARD_PORT`                                                                                           | ConfigMap (default `0.0.0.0:9119`)                                                              |
| `HERMES_PROFILES_MAX`                                                                                                                       | ConfigMap                                                                                       |
| `HERMIE_PLUGIN`                                                                                                                             | ConfigMap (`true`)                                                                              |
| A provider key, e.g. `OPENROUTER_API_KEY`                                                                                                   | Secret                                                                                          |

## Probes, resources and `securityContext`

**Hermie Web**: `GET /healthz` answers `{ok: true, version}` immediately, before any gateway is even
configured, so it is used for both `readinessProbe` and `livenessProbe` in every example here. It
writes nothing outside `--state-dir` (self-update refuses inside a container regardless, detecting
one from `HERMIE_IN_DOCKER=1`, which the image already sets — see
[../web/README.md#docker](../web/README.md#docker)), so every example runs it with
`readOnlyRootFilesystem: true` and a single volume mounted at `HERMIE_STATE_DIR=/data`.

**Hermes**: `GET /api/status` is unauthenticated, and with the image's default bind of `0.0.0.0` the
gateway's Host guard accepts the Pod IP a kubelet probe uses — so the examples probe it with
`httpGet`, as the fork's own Kubernetes example does.

Both containers get `requests`/`limits` sized for a small deployment — raise them for real traffic.
Hermie Web runs with `runAsNonRoot: true` as the image's fixed `node` user (uid `1000`), which is why
its `securityContext` pins `runAsUser: 1000` explicitly, and the Pod's `fsGroup: 1000` is what makes
its state volume writable. The **Hermes container must start as root**: its init steps remap the
`hermes` user and fix the ownership of `/opt/data` before they drop privileges, so it gets no
`runAsNonRoot` or `runAsUser` (the fork's docker.md says the same). It does get
`allowPrivilegeEscalation: false` and every capability dropped except the six it needs: `CHOWN`,
`DAC_OVERRIDE`, `FOWNER`, `SETUID` and `SETGID` for the init steps, and `KILL` because the root
`s6-supervise` signals services that run as another uid. Without `KILL` nothing fails loudly —
`s6-svc -r` just does nothing and a stop waits out the whole grace period — so it is listed
explicitly rather than left for a log line to name. **Untested on a cluster so far**; verify them in
your first deployment.

The `httpGet` probes rely on the gateway's default bind of `0.0.0.0`. Set `HERMES_DASHBOARD_HOST` to
anything narrower and its Host guard refuses the Pod IP the kubelet probes with (a 400), so switch
the probes back to `tcpSocket: { port: 9119 }`.

## PersistentVolumeClaims

| Claim              | Mounted at                                                   | Holds                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hermes-data`      | `/opt/data` on the Hermes container                          | Everything `hermes serve` persists — profiles, sessions, cron jobs.                                                                                                                                                                                                                                                            |
| `hermie-web-state` | `/data` on the Hermie Web container (via `HERMIE_STATE_DIR`) | The push watcher's cursor, the VAPID key pair, any `hermie-web login` credential, the message cache. Treat a backup of this the way [../web/README.md](../web/README.md#signing-people-in-without-a-separate-identity-provider) treats it if the built-in OIDC provider is ever turned on — it would hold the signing key too. |

Both are `ReadWriteOnce`, matching the single-replica constraint above. Size them for your own
retention; 5Gi and 1Gi in the examples are starting points, not a sizing recommendation.

## Two domains

With the fullstackstudio-org gateway, Hermie Web can have a domain of its own
(`https://app.example.com`) next to the gateway's (`https://hermes.example.com`), and an OIDC sign-in
started in Hermie Web finishes there. `configmap.yaml` has the variables, commented out:

| Container  | Variable                           | Value                                                          |
| ---------- | ---------------------------------- | -------------------------------------------------------------- |
| Hermes     | `HERMES_DASHBOARD_PUBLIC_URL`      | `https://hermes.example.com` — the primary                     |
| Hermes     | `HERMES_DASHBOARD_PUBLIC_URLS`     | `https://app.example.com`                                      |
| Hermes     | `HERMES_DASHBOARD_TRUSTED_PROXIES` | Shape (b) only: the Pod network Hermie Web connects from       |
| Hermie Web | `HERMIE_PUBLIC_URL`                | `https://hermes.example.com` — still the gateway's own address |
| Hermie Web | `HERMIE_WEB_PUBLIC_URL`            | `https://app.example.com`                                      |
| Hermie Web | `HERMIE_PASS_HOST`                 | `true`                                                         |

Then give each its own Ingress host (`ingress.yaml` covers Hermie Web's), and register both
`https://hermes.example.com/auth/callback` and `https://app.example.com/auth/callback` at the
identity provider.

**Trust only what can reach the gateway.** A Pod's IP changes, so `HERMES_DASHBOARD_TRUSTED_PROXIES`
has to name a network, and k3s's Pod network (`10.42.0.0/16`) is every Pod on the cluster. Apply
`networkpolicy.yaml` with it: only Hermie Web (and your ingress controller, if the gateway has an
Ingress of its own) can then reach port 9119, so the wide range trusts nobody else. It needs a CNI
that enforces NetworkPolicy, which k3s's default does.

**Trust is the part that fails quietly.** In the sidecar shape Hermie Web reaches the gateway over
loopback, which the gateway trusts already. In shape (b) it connects from its own Pod IP, and unless
that is in `HERMES_DASHBOARD_TRUSTED_PROXIES` the gateway ignores its `X-Forwarded-Proto`, sees
plain http, never matches `https://app.example.com`, and sends every sign-in back to
`hermes.example.com` — logging a warning that says so. Hermie Web's own startup check catches an
origin missing from `HERMES_DASHBOARD_PUBLIC_URLS` only on a gateway bound to a specific host; the
image binds `0.0.0.0`, where the gateway's first-sign-in warning is the signal instead. The details
are in [../web/README.md](../web/README.md#its-own-domain-with-the-forks-dashboardpublic_urls).

## TLS and the reverse-proxy headers

`ingress.yaml` is a plain `networking.k8s.io/v1` Ingress terminating TLS in front of Hermie Web's
Service. Read [../web/README.md#putting-tls-in-front](../web/README.md#putting-tls-in-front) before
adapting it: Hermie Web builds the OIDC issuer, an invitation link and the service-login redirect out
of `X-Forwarded-Proto`/`-Host`/`-Port`, and a proxy that forwards a rewritten host or drops the port
silently breaks all three. nginx-ingress and Traefik both set `X-Forwarded-Proto` correctly on their
own when they terminate TLS on the plain `:443` case the example assumes; if you put Hermie Web on
another port behind either of them, revisit that page's nginx block for the headers that need to be
explicit, and carry the same values over into your ingress controller's own header-forwarding
configuration (an nginx-ingress `ConfigMap`-based annotation for nginx-ingress, a Traefik
`Middleware`/`IngressRoute` for Traefik — the annotation in `ingress.yaml` is nginx-ingress-specific
for that reason).

## What is deliberately not here

- **A NetworkPolicy.** Whether the gateway's Service should be reachable from outside its own
  namespace is a decision about your cluster's trust boundaries, not something a generic example
  should assume either way.
- **A cert-manager `Certificate`/`ClusterIssuer`.** `ingress.yaml` references a `secretName` your
  own certificate management is expected to populate, by cert-manager or otherwise.
- **Horizontal scaling of Hermes.** See **The two shapes** above for why.
