# @hermes/shared

Vendored protocol sources from [NousResearch/hermes-agent](https://github.com/NousResearch/Hermes-Agent),
used under the MIT licence. The reasoning is in
[docs/adr/0003-vendor-hermes-shared.md](../../docs/adr/0003-vendor-hermes-shared.md); the licence
text is in [LICENSE](LICENSE).

## What is in here

Everything in `src/` except `index.ts` is generated. `index.ts` is a hand-written barrel over the
vendored files, and `package.json` exposes the same modules as sub-paths — prefer those at the import
site, so an upstream dependency is visible where it is used:

```ts
import { JsonRpcGatewayClient } from '@hermes/shared/json-rpc-gateway'
import { reconnectBackoffDelayMs } from '@hermes/shared/reconnect-backoff'
import type { RpcMethods } from '@hermes/shared/gateway-contract'
```

The file list and the pinned commit live in [`upstream.json`](upstream.json). It carries the protocol
contract and events, the JSON-RPC channel and gateway client, WebSocket URL handling, reconnect
backoff, slash parsing, reasoning-effort and model-search helpers, `fuzzy.ts` (only because
`model-search-text.test.ts` imports it), and the upstream tests for all of them. `i18n.ts` and
`skin.ts` are deliberately left upstream: Hermie ships its own strings and its own theme tokens.

## Rewrites

`scripts/sync-hermes-shared.mjs` fetches each file from `raw.githubusercontent.com` at the pinned
commit and applies exactly three changes. Every one of them is asserted — a rewrite marked required
that finds nothing to change fails the sync loudly, because a silently unpatched file is a bug that
only shows up on a device.

1. **Relative `.js` specifiers become extensionless** (optional per file). Upstream writes
   `from './gateway-events.js'`; Metro and `moduleResolution: Bundler` both want it without the
   extension.
2. **`readWindowLocation` in `websocket-url.ts` is guarded** (required). Upstream checks
   `typeof window === 'undefined'` and then reads `window.location.host`. React Native defines
   `window` but gives it no `location`, so upstream's guard passes and the next line throws. The
   replacement reads `globalThis.location` and accepts it only when it carries string `host` and
   `protocol`, falling back to `{ host: '', protocol: 'https:' }`.
3. **An attribution banner is prepended** naming the project, the upstream path, the commit and the
   licence, plus a line saying the file is generated.

## Working with it

```sh
npm run sync:hermes-shared        # refresh the vendored copy from the pin
npm run sync:hermes-shared:check  # fail if the tree has drifted (CI runs this)
```

Both need network access: `--check` re-runs the whole pipeline and diffs the result against disk, so
a hand-edit of a vendored file, a file removed from `upstream.json` but left behind, or a missing
file all fail the same way.

**To bump the pin:** change `commit` in `upstream.json`, run `npm run sync:hermes-shared`, read the
diff, then run `npm test`. The upstream tests are vendored too and run unchanged, so a rewrite that
breaks an assumption upstream makes shows up immediately. If the sync fails because a required
rewrite no longer matches, read the upstream file before adjusting the pattern — the point of the
assertion is that somebody looks.

Never edit a file in `src/` by hand. ESLint and Prettier both skip this directory, and `tsc` compiles
it under a tsconfig that mirrors upstream's (`lib: ["DOM", "DOM.Iterable", "ES2023"]`, strict,
Bundler resolution), so the vendored code is held to the rules it was written against rather than to
ours.
