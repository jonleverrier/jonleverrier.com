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
- **`rects.json` makes the cuts land on the layout.** Phase 2 reads it from `outDir`
  when phase 1 left one and snaps each cut onto a real element edge inside the chosen
  gutter. It is optional — with only a PNG the cut falls back to the gutter midpoint,
  which is tens of pixels out wherever the whitespace is generous. Phase 2 says which
  it did on stderr; a run that quietly lost its rects looks like a worse segmenter.
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
