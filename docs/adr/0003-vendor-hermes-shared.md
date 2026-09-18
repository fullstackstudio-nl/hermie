# 0003. Vendor the Hermes protocol sources with a sync script

- Status: Accepted
- Date: 2026-09-18

## Context

Hermes Agent's desktop app talks to the gateway through `apps/shared`, a pure-TypeScript package
that holds the generated protocol contract, the event types, the JSON-RPC channel and gateway
client, WebSocket URL handling and reconnect backoff. Reimplementing it would mean maintaining a
second, subtly different reading of the same protocol — exactly the kind of drift that produces bugs
nobody can reproduce.

`apps/shared` is not published to npm. It lives inside the Hermes Agent repository and has no
release cadence of its own. The ways to consume it are:

1. **A git submodule.** Pulls the entire Hermes Agent repository — a large Python project — for a
   handful of TypeScript files, and makes a clean checkout a two-step operation.
2. **A git subtree.** Same size problem, and merges become confusing.
3. **Vendoring by hand.** Fast to start, impossible to audit later: nobody can tell what was changed
   locally and what came from upstream.
4. **Vendoring with a script.** A committed copy, produced reproducibly from a pinned commit, with
   the local modifications expressed as code rather than as edits.

The copy cannot be byte-identical. Upstream writes `.js` extensions on relative imports, which Metro
does not resolve, and `websocket-url.ts` reads `window.location.host` — under React Native `window`
exists but `window.location` does not, so that access has to be guarded.

## Decision

The protocol sources are **vendored into `packages/hermes-shared` by
`scripts/sync-hermes-shared.mjs`**, which fetches a pinned upstream commit and applies a small set of
mechanical rewrites. The pin, the file list and the rewrites live in the script; the script fails
loudly if a rewrite no longer matches, rather than silently producing a file that does not work.

Each vendored file carries a banner naming the project, the commit and the MIT licence. The upstream
licence text is kept at `packages/hermes-shared/LICENSE` and the copy is listed in
`THIRD_PARTY_NOTICES.md`. The upstream tests are vendored along with the sources and run unchanged in
our suite.

`npm run sync:hermes-shared:check` re-runs the pipeline and fails if the working tree differs. CI
runs it, so a hand-edit of a vendored file cannot land unnoticed.

Two files are deliberately not vendored: `i18n.ts` and `skin.ts`. Hermie's interface is English-only
and does not use the gateway's theming.

## Consequences

- The vendored files are read-only. Changing one means changing the script and re-running it; this
  is stated in CONTRIBUTING.md because it is the first thing a new contributor gets wrong.
- Upgrading is a deliberate act: bump the pin, run the script, read the diff, run the tests. The diff
  is honest, because the copy is generated rather than merged.
- Running the upstream tests unchanged means we find out when our rewrites break an assumption
  upstream makes, not months later in production.
- We carry the risk that upstream reorganises `apps/shared` and the file list stops resolving. The
  script failing loudly is the mitigation: a broken sync is visible immediately rather than producing
  a half-updated tree.
