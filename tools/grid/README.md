# jonson-grid measurement

Scripts used to fix and verify the dot-grid canvas (see `GRID-TODO.md` in the root).

| script | what |
|---|---|
| `measure.mjs [url] [scrollY]` | Headed Chrome via puppeteer: canvas bitmap size, arcs and fills per frame, idle rAF deltas. Chrome here is GPU-accelerated and holds 120 fps regardless, so read the **draw counts**, not the frame time. |
| `measure_safari.py [url] [scrollY] [padPx]` | Real Safari via `tools/safari/` (start `safaridriver -p 9223` first): bitmap size + idle rAF deltas. `padPx` pads the grid container to that height to reproduce a long article. Safari is where the original 26 ms/frame was seen. |
| `verify.mjs [outDir]` | Behavioural checks: fill accounting with/without pointer, canvas placement when scrolled, and the home `.c-jonson` mount — **which asks Jonson a question, i.e. one Claude call**. |

Gotchas: puppeteer `clip` screenshots are page-relative by default (the canvas only exists
over the viewport slice, so a clip at the top of a scrolled page shows no dots — that's the
window working, not a bug). `sips --cropOffset` takes `y x`.

| `srcset-picks.mjs [url]` | Headless Chrome at DPR 2 across 390–1920 widths: real figure width, the srcset candidate the browser picked, and the effective DPR. Use after any change to `sizes` strings or the width ladders in `case-content.twig`. |
