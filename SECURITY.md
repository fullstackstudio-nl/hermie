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
  device-only, after-first-unlock accessibility class.
- **Non-secret configuration** — the gateway URL, display preferences — goes in plain key-value
  storage.
- **Chat transcripts** are cached locally so the app can paint before the gateway answers. They are
  not encrypted beyond the protection the operating system gives the app container.

There is one known gap: on macOS there is no keystore-backed `SecretStore` yet, and the fallback
writes to unencrypted app storage. A macOS build is therefore a development build, not something to
point at a production gateway. This is tracked in `docs/platform-notes.md`.

## Supported versions

Hermie has not had a release yet. Once it has, security fixes go to the latest released version.
