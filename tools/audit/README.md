# Homepage surface-area audit

What proportion of a homepage is spent on brand, navigation, hero, promotion, trust,
routing, editorial and footer. Capture, cut, classify and total; the email a prospect
receives is not built yet.

| file | what |
|---|---|
| `capture.mjs` | Phase 1 CLI. Loads a URL at 1440×900 and writes the screenshots, DOM rects and meta. |
| `analyse.mjs` | Phases 2+3 CLI. Asks the model where the sections are, and writes `{notes, tree}` plus a debug image. |
| `report.mjs` | Phase 4 CLI. The percentages, whole page and first viewport, with the caveats that apply. |
| `purpose.mjs` | Reads what a page says at the top of it, asks which of five jobs that makes it, and patches `report.json`. |
| `proposition.mjs` | Whether the first screen says what the company does, whether its `<head>` does, and every ask with where it goes. Writes `proposition.json`; collection only, nothing prints it yet. |
| `summary.mjs` | Chooses the cover's findings once every site is on disk, and patches them into the lead's `report.json`. |
| `sweep.mjs` | Every URL in a file, captured and analysed, one row each. The regression check. |
| `lib/capture.mjs` | `capturePage()` — the Playwright run. The Craft job will import this, not the CLI. |
| `lib/pinned.mjs` | Which elements hold the viewport, and which of those draw the same thing every time. |
| `lib/unrendered.mjs` | Regions that exist for a visitor and are missing from the capture. |
| `lib/webgl.mjs` | Whether this browser could render a WebGL hero, and whether the page wanted one. |
| `lib/bytes.mjs` | What the page shipped, counted on the load and scroll that made the image. |
| `lib/psi.mjs` | How fast it is, from Lighthouse via PageSpeed Insights. Lab metrics only. |
| `lib/styles.mjs` | The colours and typefaces the page renders with, and the fonts it loaded. |
| `lib/consent.mjs` | The cookie-banner selectors, and the two attempts at dismissing one. |
| `lib/shadow.mjs` | One walk of the page that does not stop at a web component's boundary. |
| `lib/tiles.mjs` | The page cut into non-overlapping tiles the model is shown one at a time. |
| `lib/vision.mjs` | The prompt, the API call, and the parse — where every repair is a refusal or a downgrade. |
| `lib/bands.mjs` | The model's boundaries, snapped to real element edges and built into a true partition. |
| `lib/candidates.mjs` | Which element edges a boundary may snap to. |
| `lib/signature.mjs` | Whether the stored answer still describes the page. A page is audited once. |
| `lib/surface.mjs` | The percentages, whole page and first viewport. |
| `lib/purpose.mjs` | The page's own claim, extracted not generated, and the five jobs a homepage can have. |
| `lib/proposition.mjs` | The in-page census of asks, headings and first-screen text, and the one fixed-choice question about them. |
| `lib/summary.mjs` | Which few facts go on the cover: level comparisons and clean results are not findings. |
| `lib/expectations.mjs` | Which segments matter given what the page is for. No model: the same input always answers the same. |
| `lib/overlay.mjs` | Chrome the DOM census cannot reach, found in the pixels. |
| `lib/edges.mjs` | Greyscale → Sobel → non-max suppression → hysteresis. A Canny edge map. |
| `lib/blocks.mjs` | The `Block` shape and `assertPartition()` — the invariant everything rests on. |
| `lib/notes.mjs` | Every condition that applies to a run, in the shape `blocks.json` carries. |
| `lib/errorpage.mjs` | Whether the page says it failed, on a page with nothing on it. |
| `lib/painted.mjs` | DOM content against painted pixels, per block. Finds what never rendered. |
| `lib/rects.mjs` | Loads and repairs `rects.json`. The only place a rects file is judged. |
| `lib/printable.mjs` | Page text on its way to a terminal. Everything printed about a page goes through it. |
| `lib/debug.mjs` | The screenshot with every block outlined. The review gate. |
| `fixtures/` | Committed captures the tests run against. See its own README. |
| `test/` | `node --test tools/audit/test/*.mjs` |

```sh
export KEY_ANTHROPIC_API=$(grep -m1 '^KEY_ANTHROPIC_API' craft/.env | sed 's/^[^=]*=//; s/"//g')
node tools/audit/capture.mjs https://example.com /tmp/audit   # phase 1
node tools/audit/analyse.mjs /tmp/audit                       # phases 2+3 (--force to re-ask)
node tools/audit/report.mjs /tmp/audit                        # phase 4
node tools/audit/proposition.mjs /tmp/audit                   # first screen + asks (--force to re-ask)
node tools/audit/sweep.mjs urls.txt /tmp/out                  # the whole corpus
node --test tools/audit/test/*.test.mjs                        # unit + fixture tests
AUDIT_LIVE=1 node --test tools/audit/test/*.test.mjs           # plus the network smoke test
```

## Gotchas

- **The viewport is locked at 1440×900.** Every committed fixture was captured at it,
  and every number in the tests assumes it. Changing it means recapturing the lot.
- **Artefacts go outside the repo.** Nothing under `tools/` is gitignored, and a
  full-page screenshot of a commercial homepage is several megabytes. `outDir`
  defaults to `/tmp/audit`. The fixtures are the deliberate exception.
- **The page weight is ours and the speed is Google's, and neither borrows the other's
  number.** PageSpeed reports a byte weight too, and it is not the one in `meta.bytes`:
  Lighthouse loads a page and never scrolls it, so everything lazy-loaded is missing from
  its count. kohde.agency measured 1,229 KiB at load and 2,710 KiB after the scroll pass,
  against PSI's 4,924 KiB — three numbers for one page. The weight that belongs beside a
  measurement of the whole page is the one taken over the whole page, so it is counted here
  from CDP, free, on the load we were doing anyway. Speed goes the other way: our own
  timings would be unthrottled, measured from wherever this runs, and would flatter every
  page on earth. That has to come from Lighthouse, so it does.
- **Colours and fonts come from the RENDERED page, not from the stylesheets.** Parsing CSS
  answers a different question: a stylesheet covers every page of a site and carries
  whatever third parties injected — kohde.agency loads 74 KB of CookieHub CSS from another
  origin, which the client never wrote and cannot change. Computed styles answer what THIS
  page uses, and cost nothing, because the capture is already walking the DOM.
- **Alpha is not a colour, and distance is measured in CIELAB.** `rgba(60,16,83,0.6)` and
  `rgb(60,16,83)` are one colour at two opacities; four of natwest.com's eighteen colour
  values were exactly that, and counting them separately reports a drift where there is a
  deliberate choice. Once alpha is collapsed, two colours are "the same colour twice" when
  they are within dE 5 in Lab — not in RGB, where twenty points of green is nearly twice
  the perceived distance of twenty points of red. The drift is real and common:
  jersey.com paints three near-blacks at `rgb(26,26,26)`, `rgb(27,27,27)` and
  `rgb(28,28,28)`; visionarygrid.studio declares its brand yellow twice as
  `rgb(255,211,0)` and `rgb(255,210,2)`. One-point differences nobody chose and nobody can
  see — a design token entered twice.
- **Colour values are normalised through a canvas, and this is not optional.**
  `getComputedStyle` does not always answer in `rgb()`: boondmanager.com returns
  `color(srgb 0.156863 0.172549 0.196078)` and visionarygrid.studio
  `color(srgb 1 1 0.835)`. Reading the first three numbers out of those treats 0-1 values
  as 0-255, so white arrives as near-black — which it did, and white was reported as "the
  same colour" as a dark grey. Painting each value to a 1x1 canvas and reading the pixel
  back is correct for every colour syntax, current and future. An early survey concluded
  the drift signal was thin; it had been run through the broken parser.
- **Fonts are three numbers, not one.** Declared is the `@font-face` rules the page has;
  loaded is the faces the browser actually fetched, because a face is only `loaded` once
  something needs it; rendered is the families that actually paint text. kohde.agency is
  7, 5 and 2. The naming carries as much as the counts: natwest.com renders with
  `RNHouseSansRegular` AND `RNHouseSans-Regular` — the same weight of the same typeface
  under two names — alongside `knilebold` and `knileblack`, which are weights wearing
  family names. A raw family count has that exactly backwards.
- **Lab data only, and CrUX is deliberately not collected.** Field data — real Chrome
  visitors over a rolling 28 days — is unarguably the better number, and it needs enough
  traffic before Google reports on a site at all. natwest.com has it for both page and
  origin; kohde.agency has neither, and kohde is what almost every prospect for this tool
  looks like. Carrying it would mean a section that appears for perhaps one site in twenty,
  two shapes of email, and a conditional in every piece of copy. Lab was complete for BOTH,
  so lab alone buys one report, one shape, and a number that is there every time.
- **PageSpeed runs beside the capture, not before it, and lands in `meta.json`.** It took
  21.5s and 27.5s on the two probes and the browser work takes longer than that on any page
  worth measuring, so the two overlap and the audit pays nothing for it. It still lands
  before anything is segmented, which is the ordering that matters. It is fetched inside
  `capturePage`, not in the CLI, because the Craft job imports `lib/` and never the
  wrappers — a PSI that lived in `capture.mjs` would never have reached production.
  `meta.psi` is `{error}` rather than absent when it could not be had, so a reader can tell
  "we did not ask" from "we asked and it failed". It is not asked for at all on a localhost
  URL, which PageSpeed cannot reach: that is every test driving a real capture.
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
- **Nothing is written unless the tree passed.** `assertPartition` runs in the CLI —
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
- **The blocks are the model's, the arithmetic is ours, and the boundary is the DOM's.**
  Phase 3 shows the page to a vision model a tile at a time and asks where the sections
  are; `lib/bands.mjs` then snaps each boundary onto a real element edge from `rects.json`
  and builds the tree FROM THE BOUNDARIES rather than from the returned blocks, so gaps and
  overlaps are impossible rather than merely unlikely. The model never does arithmetic: it
  answers in the tile's own pixels and `parseTileReply` applies the offset. Every repair is
  a refusal or a downgrade — an unknown category becomes `unclassified`, a missing
  confidence becomes 0, and a block outside its own tile fails the tile.
- **A section taller than one tile comes back as two blocks, and they have to be rejoined.**
  They meet exactly at the seam and carry the same category. NOT the same wording: the
  model sees two halves and describes them as two halves. A block at a seam that is short
  (under 200px) or unsure (0.5 or less) is a fragment the seam created, and it adopts the
  section it abuts. Confidence alone was the first rule and it was a coin toss — hsbc's
  Trustpilot panel merged at 0.5/0.5 on one run and split at 0.55/0.6 on the next, the same
  pixels either way.
- **A page is audited ONCE and the answer stored.** A vision model does not return the same
  answer twice: three runs of one image gave block counts of 10, 11 and 11 and the largest
  block at 19.2%, 21.1% and 17.7%. Snapping recovers some of that and not all of it, so the
  number a prospect reads must not move underneath them. `lib/signature.mjs` re-asks only
  when the page's STRUCTURE moves — its height, its element count, what those elements say
  and where they sit — never when its pixels do, because a rotating hero photograph changes
  those on every load. The prompt is hashed in beside them: editing what we ask is as much
  a change as editing the page.
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
- **EVERY WALK CROSSES OPEN SHADOW ROOTS.** `document.querySelectorAll('body *')` stops dead
  at a component boundary, and so does `parentElement` at the top of a shadow tree — so a
  page's web components were PAINTED and recorded in nothing: no rect, no pinned census,
  nothing to hide, nothing to warn about. boondmanager.com's Axeptio consent card is the
  measurement: `div.axeptio_mount` (relative, 1440x0) → `div.needsclick` (1440x0, open
  shadow root) → `div.ax-website-overlay` (fixed, 1440x0) → the card (absolute, 420x223).
  The light-DOM walk sees three zero-height wrappers, drops all of them for having no area,
  and never reaches the card; the card painted twelve times down a 10,567px capture while
  `rects.json` held not one rect for it. `lib/shadow.mjs` installs one walk on the page
  before its own scripts run, and **`capturePage` refuses to continue without it** — a
  census that quietly stopped counting part of the page is the one failure this tool is not
  allowed to have. `meta.capture.shadow` records the hosts and how many elements are behind
  them, so "no web components" and "the walk broke" are different numbers on every site.
  **A CLOSED shadow root is still unreachable**, by design and with no way round it; it is
  the same blind spot as a cross-origin iframe.
- **THE PINNED CENSUS RUNS ONCE, SO SOMETHING THAT ARRIVES LATER IS JUDGED BY NOTHING.**
  The census rides on the scroll pass, so it SEES a late arrival; what it cannot do is
  revisit the offsets the decision was made at. The slice pass keeps measuring, and anything
  it finds holding the viewport that the decision never covered is counted in
  `meta.capture.pinned.lateArrivals` and printed by the CLI as "MORE ARRIVED AFTER THE
  DECISION AND MAY REPEAT" — **declared, not fixed**. Deciding one of these would need an
  isolated pair of photographs taken mid-pass, which is a second screenshot at every slice
  for a case that has turned up once.
- **THE CONSENT BANNER IS ASKED FOR TWICE, and the second time is stricter.**
  boondmanager.com's card is loaded by a tag manager and opens about eight seconds in, three
  viewports down the scroll pass — long after the one attempt at consent had run and gone,
  so it was never offered a click at all. `dismissLateConsent` runs after the scroll pass,
  and **only when the first attempt found no banner AND there is one now**: a banner that was
  already seen and refused has had its attempt, and a page with nothing there pays one
  `FIND_BANNER` per frame and no more. The second attempt will not click anything whose
  ancestor is merely banner-SHAPED, because by then the pinned census has marked hundreds of
  elements as holding the viewport (647 on boondmanager.com) and that test has gone loose;
  its candidates must sit inside something that is positioned AND says what it is about.
  `meta.consentArrivedLate` says when this happened, because every measurement taken before
  the scroll pass was then of a page without the banner.
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

**A block's children exactly tile it.** Every pixel of the page belongs to exactly one
block, so total leaf area equals image area, always. `assertPartition` checks containment,
pairwise overlap and exact integer area at every node, and a failure exits 1 rather than
writing a file.

That is the measurement, not tidiness. Trim blocks to their content instead and the gutters
fall out of every leaf, so cutting a nine-card grid into nine blocks quietly shrinks the
measured area of that grid and inflates the unassigned residual — the headline percentage
would then move with how finely the page was cut, which is indefensible in a report
somebody is reading about their own site. With a true partition, granularity changes which
labels get applied and never the arithmetic.

It is also why the model's answer is advisory and the tree is not. `lib/bands.mjs` builds
from the BOUNDARIES rather than from the returned blocks: a block that overlapped another
loses the part it did not own, and a gap becomes a band nobody labelled, reported as
`unclassified` and never silently absorbed into whichever neighbour happens to be nearer.
