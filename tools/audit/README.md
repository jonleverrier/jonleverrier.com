# Homepage surface-area audit

What proportion of a homepage is spent on brand, navigation, routing and promotion.
Phases 1 and 2 only: capture a page and cut it into blocks. Classification and
reporting are not built yet.

| file | what |
|---|---|
| `capture.mjs` | Phase 1 CLI. Loads a URL at 1440×900 and writes the screenshots, DOM rects and meta. |
| `segment.mjs` | Phase 2 CLI. Turns a screenshot (plus `rects.json`, if present) into a block tree and a debug image. |
| `lib/capture.mjs` | `capturePage()` — the Playwright run. The Craft job will import this, not the CLI. |
| `lib/unrendered.mjs` | Regions that exist for a visitor and are missing from the capture. |
| `lib/webgl.mjs` | Whether this browser could render a WebGL hero, and whether the page wanted one. |
| `lib/consent.mjs` | The cookie-banner selectors, and one attempt at dismissing them. |
| `lib/edges.mjs` | Greyscale → Sobel → non-max suppression → hysteresis. A Canny edge map. |
| `lib/xycut.mjs` | Density profiles, gutter finding, the recursive partition, and tall-page tiling. |
| `lib/blocks.mjs` | The `Block` shape and `assertPartition()` — the invariant everything rests on. |
| `lib/rects.mjs` | Loads and repairs `rects.json`. The only place a rects file is judged. |
| `lib/printable.mjs` | Page text on its way to a terminal. Everything printed about a page goes through it. |
| `lib/debug.mjs` | The screenshot with every block outlined. The review gate. |
| `fixtures/` | Committed captures the segmentation tests run against. See its own README. |
| `test/` | `node --test tools/audit/test/*.mjs` |

```sh
node tools/audit/capture.mjs https://example.com /tmp/audit   # phase 1
node tools/audit/segment.mjs /tmp/audit                       # phase 2, depth 4
node tools/audit/segment.mjs /tmp/audit --depth=6             # cut further
node --test tools/audit/test/*.mjs                             # unit + fixture tests
AUDIT_LIVE=1 node --test tools/audit/test/*.mjs                # plus the network smoke test
```

## Gotchas

- **The viewport is locked at 1440×900.** Every committed fixture was captured at it,
  and every number in the tests assumes it. Changing it means recapturing the lot.
- **Artefacts go outside the repo.** Nothing under `tools/` is gitignored, and a
  full-page screenshot of a commercial homepage is several megabytes. `outDir`
  defaults to `/tmp/audit`. The fixtures are the deliberate exception.
- **A consent banner we fail to dismiss is not a failure.** It is part of that page's
  surface area and should be measured as such. `meta.json` records which happened.
- **The text pass only looks inside something banner-shaped, and a navigation is never a
  dismissal.** It used to consider every control in the document, so on a page with no
  banner at all an ordinary `<a>OK</a>` was clicked, the capture followed it, and the run
  reported `dismissed via text "OK"` with every artefact taken from the other page. A
  stranger submitting a URL could steer the audit at will. So: a bare `a` is not a
  candidate (a link built as a button carries `role="button"`), bare `ok`/`okay` are not
  accept wording, a candidate must sit under a `fixed`/`sticky` ancestor or a dialog role,
  and the URL is compared across the click — if it moved, the page is put back and the
  capture continues with the banner still standing. The cost is a banner in normal
  document flow, or one whose only button says "OK", is left alone; it is then measured,
  which is the right answer anyway. `meta.url` is what was requested, `meta.capturedUrl`
  is what was measured, and both CLIs say so loudly when they differ.
- **The page's height is `max(documentElement.scrollHeight, body.scrollHeight)`, and the
  PNG's own height is recorded beside it.** `body.scrollHeight` alone is not the page
  height: on example.com it says 96 against a 900px screenshot, and on any page whose
  height lives on `<html>` it made the scroll loop stop on its first pass so lazy content
  never loaded — silently, exit 0. The two numbers in `meta` are there to be compared:
  phase 2 divides by the image, so a screenshot that stopped early means every percentage
  is of a prefix of the page, and both CLIs warn when they disagree by more than rounding.
- **Phase 2 writes nothing unless the tree passed.** `assertPartition` runs in the CLI —
  containment, pairwise overlap and exact area equality at every node, not just the
  leaf-area total — and a failure exits 1. Previous artefacts are removed at the start of
  every run, so `blocks.json` is always this run's or absent. It used to print
  `area check BROKEN` and exit 0 with the file already written.
- **`rects.json` makes the cuts land on the layout.** Phase 2 reads it from `outDir`
  when phase 1 left one and snaps each cut onto a real element edge inside the chosen
  gutter. It is optional — with only a PNG the cut falls back to the gutter midpoint,
  which is tens of pixels out wherever the whitespace is generous. Phase 2 says which
  it did on stderr; a run that quietly lost its rects looks like a worse segmenter.
- **A rects file is repaired, not trusted, and never just believed.** The whole
  measurement rests on whole pixels, and a fractional coordinate voids it: a rect
  100.33333333333334px tall — an ordinary three-column grid, a fractional line-height,
  anything under `transform: scale` — makes two children sum to 119999.99999999999
  against an image of 120000. `lib/rects.mjs` rounds every coordinate as the file loads,
  because phase 1 rounds already so a fractional file is an out-of-house one and refusing
  it would fail an audit over a third of a pixel. Anything that cannot be repaired is
  dropped and counted on stderr. `[1, 2, 3]` used to be accepted with stderr announcing
  "snapping cuts to 3 DOM rects" while snapping to nothing; a file containing `null` was
  reported as "no rects.json in `<dir>`" with the file right there; and `{"y": null}`
  moved a cut by 50px in silence.
- **A full-bleed `<video>`, `<img>` or `<canvas>` is one module, and rects are the only
  way to know it.** A photograph or a blurred video has no gutters, only noise, so the
  pixels alone will happily slice a hero into arbitrary pieces — and phase 3 can then
  give one module four different labels. With `rects.json`, a cut may not land strictly
  inside media at least 90% of the page width and 200px tall; its own edges stay valid.
  Narrower or shorter media is ordinary content and is left alone.
- **A card is one block, and so is a header.** The gap between a quote and its
  attribution looks exactly like the gap between two modules, so switch.je's testimonial
  card came out with its quote split across two blocks. A rect is a **module container**
  when it draws its own box (`boxed` in `rects.json`) or is a `header`/`nav`/`article`/
  `figure`, is between 0.5% and 12% of the page, and contains no other such rect — the
  innermost box is the module, not the section holding two of them. A cut may not land
  strictly inside one; its own edges stay valid. Whitespace inside a module is that
  module's padding, and counting it as space between modules is what makes the number
  wrong. The band is wide on purpose: 0.5–15%, 0.5–10% and 1–12% pick the same seven
  containers on switch.je. Two rects sharing one box cancel out, because each contains
  the other — M&S wraps its `<nav>` in a `<div>` of identical size and neither is
  protected.
- **The stitch is a second place a cut is decided.** `segmentTall` rebuilds a tall page
  from full-width bands, so a cut that was legal inside one column becomes a line across
  the whole page. EVERY protection rule is applied to the harvested line as well as inside
  `segment`, or a stat card's top edge in the right-hand column saws through the
  testimonial beside it — which is exactly what it did. The lesson has had to be learned
  twice: module containers reached the stitch when the rule arrived, headings did not, and
  a band boundary taken from a right-hand column's whitespace went on slicing left-hand
  headlines. A new population of protected rects is not finished until it is in both.
- **A page can decline to draw its own hero, and nothing will look wrong.** WebGL itself
  works here — headless Chromium renders it through SwiftShader, verified, and
  pola.co.jp draws a full WebGL scene in 1089 calls with no GPU at all. But a site with a
  heavy scene may probe the renderer, see SwiftShader, and choose not to render; the page
  then loads clean with a hole where its hero belongs. PageSpeed Insights and Lighthouse
  see the same hole, which is what confirms it is the page deciding rather than the tool
  failing. `meta.webgl` records the renderer, what was requested and **the draw count**;
  both CLIs warn when a context was requested and never drawn with. **Do not report a
  percentage for a region flagged this way** — it is unmeasured, not empty, and a site
  whose hero is its homepage would otherwise be told a quarter of its page is nothing.
  Note the evidence is the draw count, never the renderer: keying off "software" would
  flag every site that renders happily in software, which is most of them.
- **A `position: fixed` reveal footer does not get captured.** A full-page screenshot
  does not paint fixed elements down the page, and DOM rects are collected at scroll-top
  where a fixed element reports its viewport box. switch.je's footer is visible, 745px
  tall, and appears in neither — the pixels there measure a flat fill with a standard
  deviation of 0.0. `meta.heightGap` catches it by asking whether the page claims more
  height than its captured content explains, which covers reveal panels and sticky
  overlays too without special-casing any of them. **Nothing invents the missing pixels:**
  writing a rect for something the screenshot lacks would snap cuts onto invisible
  boundaries and hand phase 3 a blank rectangle to classify.
- **Content behind `prefers-reduced-motion` is absent too.** It is forced, because
  determinism requires it. That is a third way the captured page differs from the one a
  visitor sees, and unlike the other two nothing detects it.
- **"Unmeasured" and "empty" are different answers.** Deliberate whitespace is a design
  choice and should be reported as a number like any other. A region we could not capture
  is a hole in our data. Never let the second masquerade as the first.
- **Open `debug.png`.** The tests prove the tree is a valid partition. They cannot
  prove it is a sensible one.

## The rule this tool defends

**A block's children exactly tile it.** A split lands on one coordinate inside the
gutter — a real element edge from `rects.json` when there is one, the gutter midpoint
otherwise — and every pixel goes to one child or the other, so total leaf area equals
image area at every depth.

That is the measurement, not tidiness. Trim blocks to their content instead and the
gutters fall out of every leaf, so cutting a nine-card grid into nine blocks quietly
shrinks the measured area of that grid and inflates the unassigned residual — the
headline percentage would then move with `--depth`, which is indefensible in a report
somebody is reading about their own site. With a true partition, depth changes which
labels get applied and never the arithmetic.
