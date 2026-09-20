# Design

`liquid-glass.html` is the **current** reference mockup for the Hermie interface (open it in a browser; no build needed), and `liquid-glass-tokens.md` is the token set the app's `src/ui/tokens.ts` is derived from. Between them they are the source of truth for look, states and motion: floating glass panels over a coloured wallpaper, a dark elevation ladder whose rungs are measurably apart, and one animated presence state.

Two rules from that document are easy to lose and expensive to rediscover:

- **Status indicators are static.** The only presence state that animates is _Needs input_ — a slow amber ring pulse, off under Reduce Motion. A bot being busy is information, not a request.
- **Never nest glass more than one level.** Panel → header/composer/sheet/card → tint only. Two stacked blurs cost real frame time and visually cancel out.

## Where the implementation deviates from the mockup

The mockup is the source of truth and the app follows it, with these knowing exceptions. Each one is
a decision, not a shortfall; if the mockup should change instead, change it and this list with it.

- **A row's options, a message's options and a cron's options are the PLATFORM's menu, not a
  drawn one.** The mockup shows the chat row's options as a bottom sheet, and the sheet is still
  what Android gets. Where `UIContextMenuInteraction` exists — a Mac, an iPad, an iPhone — a
  secondary click or a long press opens a real `UIMenu` instead: the system's glass, its placement,
  its keyboard navigation, and the row lifting into a preview. The mockup's sheet cannot be drawn
  with any of those, and a Mac that answers a right click with a sheet from the bottom of the window
  is the specific thing the owner asked to stop. The two are built from ONE list of items
  (`src/ui/menu.ts`), so nothing about what a row can do lives in two places.

- **The transcript's typing bubble is pinned below the list rather than being its last row.** §6.2
  puts it at the bottom of the transcript, which is where it still draws — but it is a sibling of
  the scroll view, not content inside it. Anything whose height comes and goes at the bottom of an
  inverted list moves the first cell's origin, and that is the whole cause of the jump-and-scroll-back
  the owner reported; see the 2026-09-20 section of docs/platform-notes.md. Visually identical,
  including the gap above it.

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

- **The onboarding wizard is a card, and the mockup does not draw one.** `liquid-glass.html` has no
  setup flow at all, so the card is an extrapolation from the sheet recipe: `sheet` glass, `opaque`,
  the sheet radius, `space.panel` padding, capped at 520pt. 520 rather than the 480 of
  `FORM_MAX_WIDTH` because the card carries its own padding, its status lines and its actions rather
  than only a field; at 480 the same content wrapped one line more on every step.

- **The wizard's card is centred on a phone too, rather than sheet-anchored to the bottom.** A
  sheet-like treatment was the other reading of "full-width sheet-like on phones". Centring is what
  keeps one rule for both layouts, and the card's height already follows its content, so a
  bottom-anchored variant would only differ on the tallest steps. The card does take the full window
  width on a phone, minus the window gap and the safe-area inset.

- **The step indicator counts the four numbered steps, not the five screens.** Welcome is the cover
  and carries the app icon instead of a rail, which is also why the eyebrow still reads `Step 1 of
4` — a five-segment rail beside a four-step counter would have had the card contradicting itself.

- **The progress rail and the status dots are static, including while a probe or a connection test
  is running.** §5's motion rule reserves animation for "needs input" and for streaming content, and
  a spinner is neither. A waiting state is a hollow ring in the accent; an answer is a filled dot.
  The shape, not only the colour, is what separates the two.

- **The disclosure caret does not rotate.** It is a drawn chevron that swaps between its down and
  its right form, rather than one chevron turning ninety degrees: §5 does not spend motion on a
  disclosure, and a rotation is the only part of the usual treatment that would be motion.

- **The wide layout can hide its sidebar, and the mockup has no control for one.** The layout was
  measured as too tight below 900pt — at 834pt portrait the chat column keeps 492pt and the bubble
  cap lands around 335pt, about 38 characters — and the only remaining lever was the list itself.
  Frame A of `liquid-glass.html` now draws the collapsed state beside the expanded one, so the
  reference is not silent about a state the app has. Four decisions inside it are ours:

  - **A 56pt glass RAIL, not nothing.** Collapsing to zero loses the only way back that does not
    involve knowing a keyboard shortcut, and takes Activity, Crons and Settings with it — the strip
    that reaches them is at the foot of the list. The brief's other option was to move those three
    into the chat header's `…` menu; that menu is the CHAT's options (verbosity, colour, model), and
    app destinations dropped into it would make one menu answer two scopes, which is the confusion
    the tab strip exists to avoid. The rail keeps every destination one tap away, at the same depth.
  - **One control on screen at a time.** The chat column's round sidebar button exists only while the
    list is SHOWING and always says _Hide sidebar_; the rail's exists only while it is hidden and
    always says _Show sidebar_. With both, an iPad drew two identical sidebar icons about 90pt apart
    doing the same thing. It also settles the wording: neither has to describe a state the other is in.
    The Mac's menu bar item does still carry both, because a menu has no rail to look at.
  - **Below 900pt the list comes back as an OVERLAY**, over the chat and behind a scrim, and closes
    as soon as a chat is picked. Re-expanding in place at that width would squeeze the chat column,
    which is the thing the collapse was for. At 900 and above Show simply shows.
  - **The collapse itself is instant; only the overlay animates.** §5 reserves motion, and the owner
    allowed one short static-feeling ease for this. The overlay takes it, because something arriving
    over content with no transition reads as a rendering fault — 200ms, zero under Reduce Motion. The
    in-place collapse takes none: there the panel is not arriving, it is resizing, and a resizing
    panel full of list rows is the most expensive thing in the app to animate for the least benefit.

- **The rail's Show control carries the unread total as a badge.** Nothing in §6.8 has one. A hidden
  list still receives messages and every bead and per-row badge went with the rows, so without it the
  collapsed state silently swallows the one fact the list exists to report.

`messenger.html` and `tokens.md` are the **superseded** Messenger direction. They are kept because the app still carries a few token names from them while the second half of the Liquid Glass pass lands, and because the reasoning in them about bubble contrast has not changed. Do not take layout, colour or motion from them.

`icon.svg` is the app icon: a speech bubble carrying an H whose crossbar lifts to the right like a wing. It is hand-authored and it is the only source for the artwork — every PNG the app ships is rasterised from it by `scripts/generate-app-icons.mjs` (`npm run icons`), and `npm run icons:check` fails in CI if one of them has drifted. Edit the SVG, never a PNG.

The renderer understands a deliberately small subset of SVG: `<rect>` with a corner radius, `<path>` with M/L/H/V/C/S/Q/T/Z, flat fills and one two-stop linear gradient in user space. It throws on anything else rather than dropping it silently, so a shape that needs more than that needs the renderer extended first. The parts the generator addresses by id — `#backdrop` and `#mark` — are named in a comment at the top of the file.
