# Design

`messenger.html` is the reference mockup for the Hermie interface (open it in a browser; no build needed). `tokens.md` lists the colour roles, type scale, spacing and radii the app tokens are derived from.

`icon.svg` is the app icon: a speech bubble carrying an H whose crossbar lifts to the right like a wing. It is hand-authored and it is the only source for the artwork — every PNG the app ships is rasterised from it by `scripts/generate-app-icons.mjs` (`npm run icons`), and `npm run icons:check` fails in CI if one of them has drifted. Edit the SVG, never a PNG.

The renderer understands a deliberately small subset of SVG: `<rect>` with a corner radius, `<path>` with M/L/H/V/C/S/Q/T/Z, flat fills and one two-stop linear gradient in user space. It throws on anything else rather than dropping it silently, so a shape that needs more than that needs the renderer extended first. The parts the generator addresses by id — `#backdrop` and `#mark` — are named in a comment at the top of the file.
