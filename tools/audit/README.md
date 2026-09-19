# Homepage surface-area audit

What proportion of a homepage is spent on brand, navigation, routing and promotion.
Phases 1 and 2 only: capture a page and cut it into blocks. Classification and
reporting are not built yet.

| file | what |
|---|---|
| `capture.mjs` | Phase 1 CLI. Loads a URL at 1440×900 and writes the screenshots, DOM rects and meta. |
| `segment.mjs` | Phase 2 CLI. Turns a screenshot (plus `rects.json`, if present) into `{notes, tree}` and a debug image. |
| `lib/capture.mjs` | `capturePage()` — the Playwright run. The Craft job will import this, not the CLI. |
| `lib/pinned.mjs` | Which elements hold the viewport, and which of those draw the same thing every time. |
| `lib/unrendered.mjs` | Regions that exist for a visitor and are missing from the capture. |
| `lib/webgl.mjs` | Whether this browser could render a WebGL hero, and whether the page wanted one. |
| `lib/consent.mjs` | The cookie-banner selectors, and one attempt at dismissing them. |
| `lib/edges.mjs` | Greyscale → Sobel → non-max suppression → hysteresis. A Canny edge map. |
| `lib/xycut.mjs` | Density profiles, gutter finding, the recursive partition, and tall-page tiling. |
| `lib/blocks.mjs` | The `Block` shape and `assertPartition()` — the invariant everything rests on. |
| `lib/notes.mjs` | Every condition that applies to a run, in the shape `blocks.json` carries. |
| `lib/errorpage.mjs` | Whether the page says it failed, on a page with nothing on it. |
| `lib/painted.mjs` | DOM content against painted pixels, per block. Finds what never rendered. |
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
  accept wording, a candidate must sit under an ancestor that is `fixed`, `sticky`, a
  dialog role, or MEASURED holding the viewport while the page scrolled under it,
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
- **A capture has a wall-clock budget, and it needs one.** bakerandpartners.com held a
  capture for FOURTEEN MINUTES on 0.60s of CPU before it was killed by hand: `goto` and
  `waitForLoadState` have timeouts, and `page.evaluate` and `screenshot` have none, because
  Playwright applies no default there. On a CLI that is something you Ctrl-C; in the Craft
  queue job it occupies a worker for ever and the prospect who submitted that URL never
  receives an email. Every in-page step now runs against `CAPTURE_BUDGET_MS` (3 minutes),
  and over budget fails like the 403 does — exit 1, a message naming the step, no
  artefacts. Measured on that site afterwards: it fails at 3:00 with "dismissing a consent
  banner did not finish within 175945ms", which also names the step that hangs, and it is
  not one of the five the queue suspected.
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
- **A line of text is one thing, not one thing per element.** A heading is protected from
  being cut through, using its ink rather than its box — but only element by element, and
  a line is often several elements. tpagency.com pins a panel across two viewports
  showing "Lead with Strategy & Insight" as two `<span>`s with an 18px space between
  their ink; that space is a full-height run of quiet pixels, so a vertical cut went down
  it and a 900px panel of black came back as five columns cut between the words. So parts
  of a line are merged into one protected **run** (`TEXT_RUN` in `lib/xycut.mjs`), and a
  run needs three things to be true, not two. Pixels alone cannot finish it: tpagency's
  word space is 0.47 of its line's ink height and natwest.com's footer — three accordion
  headings that must stay in three columns — is 0.48, and no threshold fits between them.
  The DOM does know: one pair shares a 77px line box, the other is two columns of a 380px
  wrapper. Both run-mates must also LOOK like lines (ink at least 4× as wide as tall), or
  a row of 437×246 case-study cards on switch.je reads as one line with 24px word spaces.
  **Only runs are protected, never a lone line** — protecting every text element was tried
  and is worse than useless, because jonleverrier's 1315px copyright line then vetoes every
  cut on its axis and merges the four footer columns into one block.
- **The rule that draws a boundary is what hid it.** A divider under a header is one row
  of content, so it splits the whitespace into two gutters and stands between them along
  with the edge everyone can see: hsbc.co.uk's `<nav>` ends at y=118 with gutters at
  98–117 and 121–139, and the header, nav and hero came back as one 767px block.
  natwest.com is the same a pixel tighter, and kohde.agency stacks two full-bleed
  1440×900 videos whose seam is a colour step rather than a border, and jtcgroup.com
  leaves a one-pixel gap between two 86px gutters where its `<section>`s meet. So a cut
  may reach up to `MODULE_BRIDGE` (2px) outside its gutter — but only to a **seam**, where one
  protected module ends, the next begins, and the gutter is the whitespace of one of
  them. Both halves are load-bearing: reaching for any module edge near any gutter turned
  the page margins beside jonleverrier's header into blocks (12 leaves to 17), and
  dropping the "two modules meet" half took two more strips off the retail fixture. Ten
  pages segment identically at every tolerance from 1 to 24px — the seam condition is
  what bounds this, not the distance — so nothing is balanced on the number.
  **Only a seam BELOW or ABOVE a gutter is reached, never a lone outer edge** — a module
  edge with nothing on the other side of it is a page margin.
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
- **THE PAGE IS PHOTOGRAPHED A VIEWPORT AT A TIME AND THE SLICES ARE STITCHED.** One
  `fullPage` shot is taken from scroll position 0, and that was wrong for three separate
  reasons. Scroll-reveal content is not in its revealed state there: boondmanager.com puts
  a whole section inside a `<div>` of `opacity: 0` whose children each report `opacity: 1`,
  so every one of them lands in `rects.json` over an empty dark panel. Scroll-reveal
  content is not always in POSITION there either, and that half is REVERSIBLE:
  tpagency.com's region at y=1869–5890 holds 2 elements at the top of the page and 12 at
  y=3000, with the document's element count unchanged at 306 throughout — things are moved
  into place while the region is on screen and slide back out when it is not. And Chromium
  stops painting a full-page screenshot at 16,384px, so visionarygrid.studio's 24,746px
  PNG was the right height with content stopping dead at y=16,382. A viewport shot taken
  while scrolled to the offset has none of those problems. The pass is deterministic on
  purpose: offsets are multiples of the viewport, the settle is a fixed 400ms, and the
  last slice's overlap is CROPPED rather than painted over the band before it. Measured on
  jonleverrier.com, whose page has nothing to reveal, the stitched image is byte-for-byte
  what `fullPage` produced.
- **The DOM census is banded too, and that is not optional.** `COLLECT_RECTS` ran once, at
  scroll 0, after the scroll pass — which on tpagency.com is precisely the moment the
  content is absent. A correct image against an incomplete census is a worse failure than
  the one it replaces: `lib/painted.mjs` compares the two, and it would have drawn the
  wrong conclusion in the opposite direction. So each slice censuses the rows IT
  contributes, at the same scroll position as its own shot, and the results are unioned.
  De-duplication is ACROSS bands only — nesting is not unwound anywhere in this tool, so
  two coincident rects in one band stay two — and an element seen at two different
  coordinates in two bands keeps BOTH, because that is one element in two places and each
  position belongs to the rows it was photographed with. The cost is one `body *` walk per
  slice; the cheap test (a bounding box the browser has already laid out) comes first, so
  only elements inside the band pay for `getComputedStyle` and the ancestor walks.
- **WHAT REPEATS IS DECIDED BY MEASUREMENT, NOT BY `position`.** Anything that holds its
  place while the page scrolls is photographed once per slice and lands in the image ten or
  twenty times. This used to ask `position: fixed` and hide those, and that question fails
  in both directions, on real pages: `sticky` is a nav bar on jerseyfinance.com, hsbc.co.uk
  and klark.ai and a 4,000px scrollytelling panel on tpagency.com, and hiding both took 45%
  of tpagency to pure black; `relative` is boondmanager.com's consent card, held in the
  viewport by script, painted twelve times and recorded nowhere. No threshold on height or
  area separates them and none is guessed. `lib/pinned.mjs` asks two measured questions
  instead:

    1. **PINNED** — between two scroll offsets, did this element move less than half as far
       as the page did? Carried elements move by the full delta (868–900px measured), pinned
       ones by 0–52px, and nothing on any page measured sits between.
    2. **SAME PIXELS** — photographed IN ISOLATION at two offsets it was pinned across, does
       it draw the same thing? Same → repeating chrome, hidden after the first slice.
       Changing → a panel doing its job, kept, because the visitor really does spend those
       viewports on it. Measured: chrome comes out at 0.000%, tpagency's panel at 4%.

  **Isolation is what makes the answer about the element.** Cropping its box out of the
  ordinary screenshot measures the page scrolling behind it: jerseyfinance.com's round
  accessibility widget differs in 2.5–23% of its own box, all of it in the transparent
  corners, and its header in 24%. With the rest of the page hidden, both are identical.
  **Hiding means the subtree, element by element, with transitions cancelled** — a
  descendant carrying its own `visibility: visible` ignores an inherited hide, and a
  transition in flight beats `!important`; that pair is why the widget painted twice even
  after it had been correctly identified and correctly asked to go.
  The cost, both halves measured: a bounding-box walk at each step of the scroll pass
  (74–463ms for a whole page), and a decision pass of 1–3 offset pairs at about a second
  each. The census population also feeds `COLLECT_PINNED` and `lib/consent.mjs`, so
  `meta.fixed` records a script-held card and `consentBannerSeen` stops lying about one.
  `meta.capture.pinned` carries every decision with the number it was made on.
- **THE PINNED CENSUS RUNS ONCE, SO SOMETHING THAT ARRIVES LATER IS JUDGED BY NOTHING.**
  boondmanager.com loads its Axeptio consent card through a tag manager partway down the
  page: it is absent for the first 30 seconds of a still page, appears during the scroll,
  and its mount is a `1440x0` div whose card was not there at any point the census looked.
  It therefore repeats down the image exactly as it did before. The slice pass keeps
  measuring, and anything it finds holding the viewport that the census never saw is
  counted in `meta.capture.pinned.lateArrivals` and printed by the CLI as "MORE ARRIVED
  AFTER THE DECISION AND MAY REPEAT" — **declared, not fixed**. Deciding one of these would
  need an isolated pair of photographs taken mid-pass, which is a second screenshot at
  every slice for a case that has turned up once.
- **The stitched image is exactly the viewport width; a full-page screenshot was not.**
  lloydsbank.com's page is 1469px wide, so the old capture produced a 1469px PNG and phase 2
  measured 29px of horizontal overflow that a 1440px visitor has to scroll sideways to
  reach. Every slice is a viewport shot, so the new image is 1440px and that overflow is
  outside it. The viewport has always been locked at 1440 and every fixture is that width,
  so this is arguably the more consistent answer — but it is a decision, not an accident,
  and `meta.capture.pageWidth` records the page's own width so the difference can be seen.
  Both CLIs say so when the two disagree.
- **A scrubbed animation can be photographed mid-transition.** The slice waits a fixed
  400ms and shoots; a section that crossfades as it enters the viewport is then caught part
  way. alchemy.je's pinned values section comes out with two states of its caption
  superimposed, and altumgroup.com's quote block was a fade-in at a few per cent opacity —
  real content, unreadable, and correctly flagged `contentNotPainted` at a 200ms settle. It
  is a far better answer than the black void that was there before, and it is still not a
  clean render. See SLICE_SETTLE_MS for what the wait was measured against.
- **A pinned reveal footer still does not get captured.** Chrome appears in the first slice
  only, at the viewport box it has at scroll 0, and DOM rects for it are censused in that
  band for the same reason. switch.je's reveal footer is visible, 745px tall, and is in
  neither record — the pixels there measure a flat fill with a
  standard deviation of 0.0. `meta.heightGap` catches it by asking whether the page claims
  more height than its captured content explains, which covers reveal panels and sticky
  overlays too without special-casing any of them. **Nothing invents the missing pixels:**
  writing a rect for something the screenshot lacks would snap cuts onto invisible
  boundaries and hand phase 3 a blank rectangle to classify.
- **THE SLICE PASS REACHES WHAT SCROLLING REVEALS, AND NOTHING ELSE.** Content behind a
  hover, a click, a tab, an accordion, a carousel step or a timer is reached by none of it,
  and `prefers-reduced-motion` is still forced because phase 2 has to be deterministic. The
  two mechanisms above were found by meeting them; any list of mechanisms is only the ones
  we have happened to meet. Do not read a stitched capture as a guarantee of completeness —
  it is a much better sample of the page, and the honesty layer below is still the thing
  that says when it fell short.
- **Content the capture never reached is still detectable, as a CONTRADICTION.** A
  1440×1199 block on boondmanager.com held 102 elements carrying text or media and **100
  of them had no painted pixel inside them**. `lib/painted.mjs` measures each block's ink
  against the background each ROW sits on — not a page-wide colour, or a dark section
  reads as solid ink — and raises `contentNotPainted` when at least 6 content elements are
  in a block and at least half of them are blank. **Ink alone would be wrong**: klark.ai's
  logo strip is 4.3% ink and entirely correct, and none of its 22 elements is blank.
  Measured over eleven pages, correctly rendered blocks run 0–16% blank and regions that
  did not render run 77–100%. It cannot say WHY the pixels are missing — a lazy image, a
  failed script and a reveal that wanted a click look the same — so the effect is
  `unmeasured` rather than a diagnosis.
- **"Transparent when we looked" and "never painted" are different facts, and the rect
  carries which.** `COLLECT_RECTS` skipped an element whose OWN opacity was 0 and never
  walked its ancestors, so 89 elements inside one `opacity: 0` container were recorded as
  ordinary visible content and `contentNotPainted` diagnosed them as a render that failed.
  The walk now happens and the rect is flagged `transparentAncestor` — **flagged, not
  dropped**, because a dropped element is indistinguishable from a page that genuinely has
  nothing there. `contentNotPainted` gates on the blanks that flag does NOT explain, so one
  transparent container can no longer carry a block over the threshold on its own, and
  `contentTransparent` reports the ones it does explain. That second check needs BOTH
  halves — flagged AND no ink — because the banded census catches most reveals in their
  revealed state, and a flag over painted pixels is a capture that lost nothing.
- **A region can be empty in BOTH records, and that is a different condition.**
  `contentNotPainted` needs a contradiction — elements that say there is content over
  pixels that say there is not. alchemy.je gives **49% of its page** to a black void with
  a "Scroll" indicator in it and three tiny elements; tpagency.com gives 45% to the same
  thing with none. There is no contradiction there, so that check is right to stay quiet,
  and both pages came through phase 2 with `notes none` — a report would then have said
  what percentage of the page is navigation with half of it a hole. `blankRegion` fires
  on a block that is **at least 15% of the page and under 0.1% ink**. Measured over
  seventeen pages: those two voids are 49.4% and 45.3%, and the next largest near-empty
  block anywhere is 6.3%. What is actually in such a region cannot be known from here — a
  scroll-driven scene, a canvas that declined, or genuinely empty design — so the effect
  is `unmeasured`.
- **`blocks.json` is `{notes, tree}`, and the notes come first.** Every warning used to
  reach stdout and stderr and stop there — and the Craft job imports `lib/`, not the CLIs,
  so the entire honesty layer was invisible to everything downstream of a terminal.
  `notes.conditions` is keyed by a stable code (`httpError`, `errorPageLikely`,
  `wrongPage`, `shotTruncated`, `paintLimit`, `scrollCapHit`, `consentNotDismissed`,
  `webglBlind`, `contentNotPainted`, `contentTransparent`, `blankRegion`, `unrenderedGap`,
  `metaMissing`),
  each carrying an `effect` — `unmeasured`, `attribution`, `included` or `unknown`, which
  is the axis a report branches on — a `message`, and raw `facts`. **`notes.metaRead`
  distinguishes "nothing was wrong" from "we could not tell":** a missing `meta.json` used
  to be a clean-looking exit 0. A `message` has been through `printable()` and is safe on
  a terminal; `facts` is the record and keeps the page's bytes exactly.
- **An error page can arrive with a 200.** The status check catches the hard block (a
  CloudFront 403) and refuses to measure it. Bot mitigation usually presents as a soft
  error page instead: lloydsbank.com answers a headless browser with 200, an `<h1>` of
  "We are sorry an error has occurred, please try again later." and 65 elements, and that
  segmented into 12 blocks with area conserved and no notes at all. `errorPageLikely`
  needs **both** halves — error wording in the `<h1>`, and fewer than 100 elements on the
  page — because wording alone flags a site that sells error monitoring and sparseness
  alone flags a homepage that is minimal on purpose (the jonleverrier fixture, 123
  elements, is exactly that page). It is a **note, not a refusal**, unlike `httpError`: a
  200 makes the evidence circumstantial, and a false refusal produces nothing at all
  while a false note can be read and dismissed. A bot wall that says "checking your
  browser" rather than apologising is not caught, and neither is a well-populated error
  page.
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
