# Security policy

## Reporting a vulnerability

Report security issues privately to **security@fullstackstudio.nl**. Please do not open a public
issue for anything exploitable.

Include what you can: the version or commit, the platform, what an attacker can achieve, and the
steps to reproduce. If you have a proof of concept, a small one is worth more than a long report.

You will get an acknowledgement within three working days and an assessment within ten. If the issue
is confirmed, we will agree a disclosure date with you; we aim to ship a fix before it, and we will
credit you in the release notes unless you prefer otherwise.

## Scope

In scope: the Hermie app and the packages in this repository.

Out of scope, because they are other people's projects — report them upstream:

- Hermes Agent itself, including `hermes serve` and its authentication endpoints
  ([NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)).
- Identity providers, access proxies and other infrastructure a gateway sits behind.

## What Hermie stores and where

Knowing this helps when assessing an issue:

- **Secrets** — access token, refresh token, session token and any extra request headers — go in the
  platform keystore through `SecretStore`. On iOS and Android that is the system keychain, with a
  device-only, after-first-unlock accessibility class. A Mac runs the same iOS build (ADR-0011) and
  therefore the same `expo-secure-store`.
- **Non-secret configuration** — the gateway URL, display preferences — goes in plain key-value
  storage.
- **Chat transcripts** are cached locally so the app can paint before the gateway answers. They are
  not encrypted beyond the protection the operating system gives the app container.

The gap that used to be here — macOS had no keystore-backed `SecretStore`, so tokens went to
unencrypted app storage — is closed. The native macOS target is gone, and the Mac runs the iOS build
with the iOS keychain, and that is now **exercised rather than assumed**: on 2026-09-19 a Mac window
stayed signed in across a quit and a relaunch, which is a keychain read and a keychain write of the
token in the ordinary path.

One observation from the same session, recorded because it is not explained: the FIRST launch of that
build did ask for a sign-in again. The cause was not established — a fresh install and a new wrapper
are both in the picture, and a different keychain access context is a plausible reading — so it is
written down as something seen once, not as a known behaviour.

## The app lock

Settings → Privacy & security → **Require unlock** puts `expo-local-authentication` in front of the
app: Face ID, Touch ID, Optic ID or Android's BiometricPrompt, with the device passcode as the
platform's own fallback. Off, immediately, or after 1, 5 or 15 minutes in the background; a cold
start always asks.

What it is and is not worth stating precisely, because a lock that is described too generously is
worse than none:

- **A locked app does not render its contents.** The plate is not an overlay — the gate above the
  gateway provider does not mount its children, so there is no live transcript, no chat list and no
  open socket behind it. That is also what the operating system's app-switcher snapshot gets, which
  is why "immediately" locks on the way out rather than on the way back.
- **It does not encrypt anything.** The credentials are in the keystore either way, and the
  transcript cache is protected by the app container and nothing more. This keeps a person who
  picks up an unlocked phone out of your chats; it does not keep out someone with the device, its
  passcode and time.
- **It is per device and is never synced.** The threshold has its own key in plain key-value
  storage and is deliberately not part of the settings section ADR-0016 carries to the gateway.
- **It cannot be switched on with nothing enrolled.** A device with no biometric and no passcode is
  told to set one up rather than being locked behind a prompt that cannot succeed. A prompt that
  fails, is cancelled, or cannot run at all leaves the app locked — a broken module is not a way in.
- **There is no app lock in a browser**, and the settings screen says so rather than offering one: a
  plate drawn over this app's own DOM is enforced by the same JavaScript it is protecting.
- **Notification previews are not the lock's business.** What a banner shows on a locked screen is
  the operating system's setting and the notification's own payload; [ADR-0017](docs/adr/0017-push-through-hermie-web.md)
  is where that payload is decided.

## Transport

Hermie talks to one gateway, at an address the user types during setup, and to the identity provider
that gateway redirects the sign-in page to. It is not known at build time, so the app cannot declare
per-domain transport rules for it: iOS ships `NSAllowsArbitraryLoads` and Android
`usesCleartextTraffic`, which permit cleartext to **any** host either platform is asked to reach.
[ADR-0014](docs/adr/0014-plain-http-on-private-networks.md) records why, and which narrower options
were measured and ruled out.

Permission is not use. The app has no address of its own to call: every request goes to the
configured gateway. An address typed without a scheme is probed over `https://` first and only tried
over `http://` when https does not answer at all; an address typed with `https://` is never
downgraded; and the app says on screen when the connection it ended up with is in the clear.

**Which transport is safe is the operator's call, and it is a real one.** Over Tailscale, Headscale
or on the same machine, plain `http://` is encrypted by WireGuard or never leaves the host, and TLS
on top adds nothing. Over the open internet it is a different sentence: the session token, the bearer
token, the sign-in and every message are readable by anyone on the path, and Hermie warns about
exactly that case rather than refusing it. Hermie does not pin certificates and does not ship a trust
store of its own; a self-signed certificate has to be trusted by the device.

## Supported versions

| Version            | Supported                         |
| ------------------ | --------------------------------- |
| `main`             | Yes — fixes land here first       |
| The latest release | Yes                               |
| Anything older     | No; upgrade to the latest release |

Hermie has not had a release yet, so today that means `main`. Once there is one, security fixes go
to the latest released version and no further back: there is one codebase, and a build from source
is always an option.

Hermie is a client. A fix in the gateway it talks to is an upstream release, on upstream's schedule,
and the two version numbers are unrelated.
