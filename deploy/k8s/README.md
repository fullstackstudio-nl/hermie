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

| Image                                             | What it is                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghcr.io/fullstackstudio-nl/hermie-web:<version>` | A tagged release. Pin this in anything you run more than once.                                                                                                                                             |
| `ghcr.io/fullstackstudio-nl/hermie-web:latest`    | The newest tagged release. Fine for trying this out, not for a pin.                                                                                                                                        |
| `ghcr.io/fullstackstudio-nl/hermes-agent:main`    | The Hermes gateway. See **The Hermes container's variables** below — the names below are set by a companion change to that image; build it after that change lands, or the gateway will not read them yet. |

## The two shapes

| File(s)                                                 | Shape                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sidecar.yaml`                                          | (a) Hermie Web as a **sidecar** in the same Pod as Hermes. Reaches it over `127.0.0.1:9119`. |
| `hermes-standalone.yaml` + `hermie-web-standalone.yaml` | (b) Hermie Web as its **own Deployment and Service**, reaching Hermes through a Service.     |

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

`configmap.yaml` and `secret.example.yaml` use these names for the Hermes container:

| Variable                                                         | Where                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `HERMES_DASHBOARD_PUBLIC_URL`                                    | ConfigMap                                                                                                    |
| `HERMES_DASHBOARD_USERNAME` / `_PASSWORD`                        | Secret                                                                                                       |
| `HERMES_DASHBOARD_OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` | Secret (the issuer alone could go in the ConfigMap; it is grouped with the other two here for one `envFrom`) |
| `HERMES_DASHBOARD_HOST` / `_PORT`                                | ConfigMap (default `0.0.0.0:9119`)                                                                           |
| `HERMES_PROFILES_MAX`                                            | ConfigMap                                                                                                    |
| `HERMIE_PLUGIN`                                                  | ConfigMap (`true`)                                                                                           |
| A provider key, e.g. `OPENROUTER_API_KEY`                        | Secret                                                                                                       |

**These are set by env-configuration work on the `hermes-agent` image itself, done alongside this
change rather than by it.** If the names above do not match what your build of that image reads,
the image predates that change — check that image's own docs, and align the names here if they
changed before it shipped.

## Probes, resources and `securityContext`

**Hermie Web**: `GET /healthz` answers `{ok: true, version}` immediately, before any gateway is even
configured, so it is used for both `readinessProbe` and `livenessProbe` in every example here. It
writes nothing outside `--state-dir` (self-update refuses inside a container regardless, detecting
one from `HERMIE_IN_DOCKER=1`, which the image already sets — see
[../web/README.md#docker](../web/README.md#docker)), so every example runs it with
`readOnlyRootFilesystem: true` and a single volume mounted at `HERMIE_STATE_DIR=/data`.

**Hermes**: this repository does not build that image, so its probe surface is not something these
examples can promise. `GET /api/status` is unauthenticated and used elsewhere as a liveness check
(`docs/test-gateway.md`), but a kubelet `httpGet` probe hits the Pod's own IP rather than
`dashboard.public_url`, and that is exactly the mismatch the gateway's Host/Origin guard exists to
reject (see [../web/README.md](../web/README.md#what-to-configure-on-the-gateway)) — so these
examples use a plain `tcpSocket` check instead of asserting an HTTP probe will pass. Switch to
`httpGet: /api/status` once you have confirmed it answers correctly from inside your cluster.

Both containers get `requests`/`limits` sized for a small deployment — raise them for real traffic —
and `runAsNonRoot: true`. Hermes additionally needs `fsGroup` set on the Pod so the mounted
`/opt/data` volume is writable by whatever user that image runs as; Hermie Web's image already runs
as the fixed `node` user (uid `1000`), which is why its `securityContext` pins `runAsUser: 1000`
explicitly.

## PersistentVolumeClaims

| Claim              | Mounted at                                                   | Holds                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hermes-data`      | `/opt/data` on the Hermes container                          | Everything `hermes serve` persists — profiles, sessions, cron jobs.                                                                                                                                                                                                                                                            |
| `hermie-web-state` | `/data` on the Hermie Web container (via `HERMIE_STATE_DIR`) | The push watcher's cursor, the VAPID key pair, any `hermie-web login` credential, the message cache. Treat a backup of this the way [../web/README.md](../web/README.md#signing-people-in-without-a-separate-identity-provider) treats it if the built-in OIDC provider is ever turned on — it would hold the signing key too. |

Both are `ReadWriteOnce`, matching the single-replica constraint above. Size them for your own
retention; 5Gi and 1Gi in the examples are starting points, not a sizing recommendation.

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
