# Design

`liquid-glass.html` is the **current** reference mockup for the Hermie interface (open it in a browser; no build needed), and `liquid-glass-tokens.md` is the token set the app's `src/ui/tokens.ts` is derived from. Between them they are the source of truth for look, states and motion: floating glass panels over a coloured wallpaper, a dark elevation ladder whose rungs are measurably apart, and one animated presence state.

Two rules from that document are easy to lose and expensive to rediscover:

- **Status indicators are static.** The only presence state that animates is _Needs input_ — a slow amber ring pulse, off under Reduce Motion. A bot being busy is information, not a request.
- **Never nest glass more than one level.** Panel → header/composer/sheet/card → tint only. Two stacked blurs cost real frame time and visually cancel out.

## Where the implementation deviates from the mockup

The mockup is the source of truth and the app follows it, with these knowing exceptions. Each one is
a decision, not a shortfall; if the mockup should change instead, change it and this list with it.

- **The bubble tail is drawn BEHIND the bubble, not inside it.** §6.1 says the tail is an inline SVG
  child of the bubble, absolutely positioned at its bottom corner. It is a sibling rendered first
  instead, so the bubble's own fill covers the overlapping part. Drawn on top, the tail's flat colour
  paints a 5pt strip of the bubble's BOTTOM stop over a lighter part of its gradient, which reads as a
  stripe on a tall bubble. Behind, only the part that escapes the rounded corner is ever visible and
  the join cannot show.
- **A pending dispatch whose recipient is mid-turn says so.** §6.6 lists three reply indicators
  (replied / waiting / failed). Where the app holds both chats and knows the recipient's turn is
  running, the WAITING indicator reads `@writer is writing…` instead of `Delivered · waiting for
reply`. It is still one indicator and still static; it is strictly more information in the same
  space, and dropping it would have lost a behaviour the previous build had.
- **The `Open @writer's chat` link lands on the matching message.** §6.6 only asks that the link
  exists. It carries the counterpart query the old card used, so the far chat opens on the row this
  one is about rather than at its bottom. What §6.6 removed — navigation as the DEFAULT gesture — is
  removed.
- **A cron card in a chat offers neither _Open cron_ nor _Run now_ yet.** §6.5 lists both and the
  component takes both; the chat screen does not pass them, so the card shows no actions rather than
  dead ones. Wiring a chat row to the Crons feature is outstanding. The card's own two states are
  addressable in the gallery (`gallery:cron-card`, `gallery:cron-card-actionless`), so the decision
  can now be judged on a screen rather than in a diff.
- **The tab strip's icons are text glyphs, not the mockup's line art.** §6.8 draws four stroked
  SVG icons; the strip uses `◉ ⇄ ◷ ⚙︎`. They read as a monochrome set at strip size and cost
  no assets, but the chat glyph in particular is a filled circle where the mockup has a speech
  bubble. Replacing them is a `react-native-svg` job now that the dependency is in.
- **The crons list, its detail, the run transcript and Activity are still on the Part-1 surfaces.**
  §6.11's cron rows (schedule in words, next run, static status dot, profile chip, a `Paused`
  section) and the ledger language Activity is supposed to share with the transcript's DM lines are
  not built yet. All four are now addressable (`gallery:cron-detail`, `gallery:cron-detail-paused`,
  `gallery:cron-run`, `overlay:crons`, `overlay:activity`), which is what the restyle was waiting
  for.
- **The agents bar and the interiors of the four sheets are still Part-1 too.** This round brought
  their TITLES onto §3's `sheetTitle` and the eyebrow onto `micro`; the bodies are unchanged.
- **`ok` has no readable variant.** §1.1 gives `danger` a fill and `dangerText` an ink, and gives
  `ok` only one value — which is used as ink and measures 3.47–4.54 : 1 on every surface but the dark
  sunk tint. Either the mockup grows an `okText` or the app stops using `ok` as ink; until then a
  `Success` line is below AA. Measurements are in docs/platform-notes.md.
- **The colour page's Default swatch is an unlabelled hollow ring.** §1.3 says "eight curated
  colours, or Default"; drawn as a ring with nothing in it on a dark sheet it reads as a hole rather
  than as the ninth choice.
- **The jump-to-latest pill carries the count as a badge**, not as its whole label. §6.10 says "with
  the count of messages that arrived since"; `3 new` alone stopped saying what tapping it does, so
  the pill keeps its name and the count rides beside it.

`messenger.html` and `tokens.md` are the **superseded** Messenger direction. They are kept because the app still carries a few token names from them while the second half of the Liquid Glass pass lands, and because the reasoning in them about bubble contrast has not changed. Do not take layout, colour or motion from them.

`icon.svg` is the app icon: a speech bubble carrying an H whose crossbar lifts to the right like a wing. It is hand-authored and it is the only source for the artwork — every PNG the app ships is rasterised from it by `scripts/generate-app-icons.mjs` (`npm run icons`), and `npm run icons:check` fails in CI if one of them has drifted. Edit the SVG, never a PNG.

The renderer understands a deliberately small subset of SVG: `<rect>` with a corner radius, `<path>` with M/L/H/V/C/S/Q/T/Z, flat fills and one two-stop linear gradient in user space. It throws on anything else rather than dropping it silently, so a shape that needs more than that needs the renderer extended first. The parts the generator addresses by id — `#backdrop` and `#mark` — are named in a comment at the top of the file.
