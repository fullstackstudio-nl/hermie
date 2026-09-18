# @hermes/shared

Vendored protocol sources from [NousResearch/hermes-agent](https://github.com/NousResearch/Hermes-Agent),
used under the MIT licence. Nothing in `src/` is written by hand: it is produced by
`npm run sync:hermes-shared`, which fetches a pinned upstream commit and applies a
small, fail-loud set of rewrites (dropping `.js` import extensions, guarding
`window.location` access so the code runs under React Native, and prepending an
attribution banner).

Run `npm run sync:hermes-shared:check` to detect drift between the vendored copy
and the pinned commit; CI runs the same check.

The pin, the exact file list and the rewrites are recorded in `upstream.json` once
the pipeline lands. See `docs/adr/0003-vendor-hermes-shared.md` for the reasoning.
