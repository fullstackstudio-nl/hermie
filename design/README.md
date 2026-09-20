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
- **A cron card in a chat offers _Open cron_ but never _Run now_.** §6.5 lists both and the component
  takes both. `Open cron` is wired: `ChatScreen` resolves the card's job NAME against the loaded
  crons, narrowed by this chat's bot, and passes the action only where that leaves exactly one job —
  a name is not an identity, which is the same fact the list's profile chip exists for. Where it
  does not resolve the card draws no action, which is also what it does before the crons list has
  been read once in a session: the cron controller's lifetime is the Crons screen's, so until then
  the app genuinely does not know which job the card names.

  `Run now` is deliberately left off. It is a side effect on the gateway, it lives on the cron's own
  detail behind its confirm, and a transcript card is a receipt for a run that already happened —
  one tap from starting another one is not where that belongs.

- **The tab strip's icons are text glyphs, not the mockup's line art.** §6.8 draws four stroked
  SVG icons; the strip uses `◉ ⇄ ◷ ⚙︎`. They read as a monochrome set at strip size and cost
  no assets, but the chat glyph in particular is a filled circle where the mockup has a speech
  bubble. Replacing them is a `react-native-svg` job now that the dependency is in.
- **A screen inside the overlay panel does not repeat its own title.** §6.11 draws the crons list
  with `Crons` at the top of it. Both shells already title the destination — the overlay panel's
  header on the wide layout, the stack's title bar on the phone — so the screen printing it again
  underneath made the panel say its own name twice in two sizes. Only the subtitle stays. The same
  reasoning removed the cron editor's `NEW CRON` eyebrow over `New cron`: an eyebrow earns its line
  where it says something the title does not, which is why the approval sheet keeps its one (it
  names the bot).
- **A fold clips at a multiple of the BODY leading, not at a count of rendered lines.** §6.3 says
  fourteen lines. The clip is `14 × the body leading`, which is a line boundary for a run of body
  text and therefore fixes the sliced row — but a heading or a table inside the fold is taller than
  one body line, so the fold then holds fewer than fourteen visible lines. Counting real lines would
  mean measuring every block and there is no reader-visible difference between fourteen lines and
  twelve; a cut through the middle of one is what a reader sees.
- **The fold's fade colour is the bubble's TAIL colour, not its exact composite.** Both are the
  bubble's lower edge resolved against the panel, and on the dark reading bubble they differ by a
  few levels per channel, so a very close look at the bottom of a fade can find the join. Measuring
  the true composite would mean the fold knowing the wallpaper behind the bubble, which is the thing
  §7.4 keeps bubbles from depending on.
- **A table's columns are as wide as their longest value**, between 110 and 280pt, rather than the
  150pt the mockup's table uses. A flat width broke `docs.example.org` mid-word and left one letter
  under the row. The table scrolls horizontally either way, which is what pays for it.
- **The jump-to-latest pill carries the count as a badge**, not as its whole label. §6.10 says "with
  the count of messages that arrived since"; `3 new` alone stopped saying what tapping it does, so
  the pill keeps its name and the count rides beside it.

`messenger.html` and `tokens.md` are the **superseded** Messenger direction. They are kept because the app still carries a few token names from them while the second half of the Liquid Glass pass lands, and because the reasoning in them about bubble contrast has not changed. Do not take layout, colour or motion from them.

`icon.svg` is the app icon: a speech bubble carrying an H whose crossbar lifts to the right like a wing. It is hand-authored and it is the only source for the artwork — every PNG the app ships is rasterised from it by `scripts/generate-app-icons.mjs` (`npm run icons`), and `npm run icons:check` fails in CI if one of them has drifted. Edit the SVG, never a PNG.

The renderer understands a deliberately small subset of SVG: `<rect>` with a corner radius, `<path>` with M/L/H/V/C/S/Q/T/Z, flat fills and one two-stop linear gradient in user space. It throws on anything else rather than dropping it silently, so a shape that needs more than that needs the renderer extended first. The parts the generator addresses by id — `#backdrop` and `#mark` — are named in a comment at the top of the file.
