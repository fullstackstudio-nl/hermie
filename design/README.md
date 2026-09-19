# Design

`liquid-glass.html` is the **current** reference mockup for the Hermie interface (open it in a browser; no build needed), and `liquid-glass-tokens.md` is the token set the app's `src/ui/tokens.ts` is derived from. Between them they are the source of truth for look, states and motion: floating glass panels over a coloured wallpaper, a dark elevation ladder whose rungs are measurably apart, and one animated presence state.

Two rules from that document are easy to lose and expensive to rediscover:

- **Status indicators are static.** The only presence state that animates is _Needs input_ — a slow amber ring pulse, off under Reduce Motion. A bot being busy is information, not a request.
- **Never nest glass more than one level.** Panel → header/composer/sheet/card → tint only. Two stacked blurs cost real frame time and visually cancel out.

`messenger.html` and `tokens.md` are the **superseded** Messenger direction. They are kept because the app still carries a few token names from them while the second half of the Liquid Glass pass lands, and because the reasoning in them about bubble contrast has not changed. Do not take layout, colour or motion from them.

`icon.svg` is the app icon: a speech bubble carrying an H whose crossbar lifts to the right like a wing. It is hand-authored and it is the only source for the artwork — every PNG the app ships is rasterised from it by `scripts/generate-app-icons.mjs` (`npm run icons`), and `npm run icons:check` fails in CI if one of them has drifted. Edit the SVG, never a PNG.

The renderer understands a deliberately small subset of SVG: `<rect>` with a corner radius, `<path>` with M/L/H/V/C/S/Q/T/Z, flat fills and one two-stop linear gradient in user space. It throws on anything else rather than dropping it silently, so a shape that needs more than that needs the renderer extended first. The parts the generator addresses by id — `#backdrop` and `#mark` — are named in a comment at the top of the file.
