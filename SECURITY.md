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
with the iOS keychain. One honest caveat: `expo-secure-store` links into the Mac build and the app is
signed with `application-identifier`, which is its default keychain access group, but reading and
writing a key **has not yet been exercised in a running Mac window**. It is the same binary and the
same API as on an iPhone, where it is exercised; `docs/platform-notes.md` tracks it as unverified
rather than claiming it.

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
