# Progress

What is done, what is broken, and what each change actually bought. One line per defect,
each naming the site it was found on. Nothing in this file is an estimate.

**The goal:** a prospect submits a URL and is emailed a report saying what percentage of
their homepage is brand, navigation, routing and promotion. The number is read by the
person whose site it is, who may disagree with it, so every block must be inspectable and
every category defensible in one sentence.

**Where we are:** phases 1 and 2 (capture, and cut into blocks) are built and green.
Phase 3 (classify) and phase 4 (report and email) do not exist yet.

---

## The corpus

29 real homepages, captured and segmented, at `scratchpad/review/<slug>/`. Debug images
copied flat to `/tmp/audit-review/<host>.png` for review. This corpus is the evaluation
set: every defect below was found by looking at those images, not by guessing.

Four of the 30 produce no measurement, all deliberately:

| site | why |
|---|---|
| webreality, jerseyfsc, afdb | HTTP 403. Refused as error pages rather than measured. |
| lloydsbank | HTTP 200 serving "We are sorry an error has occurred". Flagged `errorPageLikely`. Reviewed the image: it really is an error page. |
| visionarygrid | 24,746px. Captured whole; phase 2 refuses on the memory budget. |

bakerandpartners.com is no longer on that list. It hung for 14 minutes, then failed at the
3-minute deadline, and now captures in **30 seconds** into 36 blocks with no notes.

---

## Open

| # | Defect | Site | State |
|---|---|---|---|
| 8 | `shotTruncated` fires on a 3px difference — true statement, noisy threshold | liquidlight | not started |
| — | Whitespace reported as coverage per block, not as a category of block (user's ruling) | all | phase 3/4 |
| — | `webglBlind`: canvas content the edge map cannot read | 8 sites | accepted, declared in notes |

### Found by reviewing the debug images, 19 Sep — not reported by the user

A pass over 22 of the 25 segmented sites. Ordered by how many sites carry each defect,
which is a better guide to what to fix next than how bad any single instance looks.

| # | Defect | Sites | Cause |
|---|---|---|---|
| 10 | **A cut runs through a paragraph** — vertically between its words on altum and milk, horizontally between its lines on hettich | altum, milk, hettich — **3** | **measured**: `TEXT_TAGS` is h1–h6 only, so a `<p>` is in no protected population. On altum the `<h2>` at 46,1028 is protected and shrunk to 706px of ink while the `<p>` at 46,1092 sized 1337x72 is not, and cuts land at x=805, 1073, 1248 — clear of the heading, through the paragraph |
| 11 | **Display type shredded** — a headline cut between words and in places between letters. alchemy loses ~19 of its 91 blocks to one headline | alchemy, kohde, dept — **3** | task 16 merges runs of separate ELEMENTS on a line; this is one element whose letter and word spacing at display size opens gutters wider than the threshold. **Measured on kohde (task 19): "Launch." is not text at all.** It is drawn as SVG `<g>`/`<path>` with no `textContent`, so `TEXT_TAGS`, `inkedTextRects` and `textRuns` can never reach it and the fix is not in ink clustering. Unchanged by task 19: kohde 18 → 18 leaves, alchemy 89 → 86 |
| 12 | **Whitespace given its own blocks** — empty background strips either side of centred content | klark, milk, liquidlight, hettich — **4** | relates to the ruling that space is a coverage measure across blocks, not a kind of block |
| 13 | **Slivers holding a single `>` chevron** | hsbc, hettich — **2** | a link's arrow is a separate element with a gutter each side |
| 14 | Header still fused into the hero; task 17's landmark rule did not reach it | kohde — **1** | unknown; likely no `<header>` landmark, or not edge to edge |
| 15 | Footer columns not separated | vaiie — **1** | unknown |
| 16 | An undismissed late banner is kept from slice 0 rather than from first sighting, so "present and measured once" is not literally true | — | queued by task 18, costs an image change on every site with chrome that fades in |
| 17 | **A decorative blob INSIDE the canvas fuses four sections** — one block y=740–2228 | bakerandpartners — **1** | **measured (task 19), and it is NOT the backdrop defect**: nothing on this page leaves the canvas on more than one side. `div 0,978 380x760` is `boxed` and 2.5% of the page, so it is a module container; it is 760px tall so `CONTENT_RECT` (maxH 700) keeps its own top edge out of the snap candidates; the 79px gutter at 949–1028 therefore snaps to 1028, inside it, and is refused. `section 0,1788 1440x440` refuses the other three |
| 18 | A repeated run of exactly THREE is still cut per item — whitepaper's "Legal" and "Quick Links" lists | whitepaper — **1** | `REPEAT.minMembers` is 4 and stops there by design; separating three nav links from three feature columns needs the label, not the geometry. See the report for task 19 |
| 19 | The hero's decorative gradient is cut into about five slices | gcsc — **1** | **introduced by the fix to #6**: the six backdrop images that used to blanket the top are no longer protected, so the edge map finds gutters in the gradient. A smaller defect than the fusion it replaced, and it is decoration rather than content |

**Two sites confirm defects the user reported on one site each**, which matters because a
one-site defect can be special pleading and a two-site defect cannot:

- ~~bakerandpartners carries gcsc's backdrop defect~~ — **measured and wrong** (task 19).
  The block is real but the cause is not: its orange graphics run off the canvas on ONE
  side each, so the backdrop rule neither does nor should touch them. See open #17.
- milk carries dept.agency's shredded-photograph defect. Both are fixed.

switch.je shows the backdrop problem in its other direction: its decorative pink swoosh
fragments the hero into six blocks rather than fusing it.

---

## Closed

Each row is a defect that was visible in a debug image and is not any more.

| Defect | Found on | Fixed by | Evidence |
|---|---|---|---|
| Repeating siblings cut one block per item — a grid per card, a nav per item, a link list per link (#4, #9) | pola, clearleft, whitepaper, jersey.com, milk, altum, natwest, hettich, switch | `%%SHA%%` | pola 132 → 60 leaves with each carousel one block; clearleft's nav one block with the logo beside it; whitepaper's nine-link list one block with its three columns still separate; milk's logo grid 9 → 1; altum's stat row 11 → 2; jersey.com's season grid 4 → 1. **andybudd's three feature columns stay cut, 17 leaves.** Every one cropped |
| A 571x714 soft-focus photograph shredded into 13 fragments (#5) | dept.agency, milk | `%%SHA%%` | dept 81 → 49 leaves; the photograph at `21,2434 571x714` is one block. Cropped |
| Oversized part-off-canvas `<img>` treated as modules, fusing header + hero + featured across the top 1,482px (#6) | gcsc | `%%SHA%%` | the top 1,362px was ONE block; it is now a top strip, a hero band and three featured blocks. Cropped. Cost: open #19 |
| A capture blocked for 14 minutes, then failed at the deadline — the site was unauditable | bakerandpartners | `02f5b47` | 30.5s, 36 blocks, `notes: none`. Cause: a frame whose URL is the empty string, on which `frame.evaluate` never returns |
| Consent card in a shadow root, repeating 12×, `consentBannerSeen` false | boondmanager | `02f5b47` | dismissed after the scroll pass; cropped y=2400 and the card is gone from all twelve places |
| A widget painted once per slice with `notes: none` — one element counted four times | natwest | `a8a7b1e` | the condition reached the phase 1 terminal only; now in blocks.json |
| Header fused into the hero | jtcgroup, jerseyfinance, jersey.com, andybudd | `dfbf10d` | all four have a header block; cropped and checked |
| A whole page left as 4 blocks — 3 columns, a heading and 3 cards in one box | andybudd | `dfbf10d` | 4 → 17 leaves |
| Cuts between the words of a headline | tpagency | `d3539a0` | 44 → 30 leaves, one band per headline |
| 38px slivers of black; every card edge licensed a cut line for the whole page height | 13 of 29 sites | `ee35a5d` | 13 sites lost cuts, none gained |
| Sticky nav repeated down the stitched image | jerseyfinance ×3, hsbc ×3, klark ×6 | `cf71a1d` | jfin 7 → 24 leaves, hsbc 24 → 33 |
| Scroll-reveal content missing from the capture entirely | boondmanager, tpagency, alchemy, altum | `87ad291` | every `blankRegion` / `contentNotPainted` flag cleared |
| Chromium stops painting a full-page shot at 16,384px | visionarygrid, jersey.com | `87ad291` | stitched capture; verified at y=16000–24000 |
| A capture could hang forever, occupying a queue worker | bakerandpartners | `87ad291` | 14 min → fails at 3:00, names `dismissConsent` |
| An error page measured as if it were the site | webreality, jerseyfsc, afdb | `5234f4a` | refused, exit 1 |
| A 200 that is really an error page | lloydsbank | `6c61ff0` | `errorPageLikely` |
| Unpainted-content detector had 2 false positives in 3 | alchemy | `5c22236` | rewritten per-element; 9 flags, 0 false |
| A region empty in both the pixels and the DOM went unnoticed | alchemy (49% of the page) | `1606858` | `blankRegion` |

---

## What each layer is worth

Source is 5,681 lines. Useful to know which parts are load-bearing if the approach changes.

- **capture + pinned + consent (~2,200 lines)** — stitched slices, telling pinned chrome
  from a pinned scrollytelling panel by measurement, consent dismissal. Every
  missing-content defect above was fixed here. Nothing can measure a page whose content is
  not in the image, so this layer is required under any approach.
- **painted, notes, unrendered, errorpage (~1,050)** — the honesty layer. "Unmeasured"
  versus "empty", refusals, soft error pages. This is what stops a confident wrong number
  reaching a prospect.
- **xycut (~1,530)** — the cutting. The partition invariant and `segmentTall` are
  structural; the gutter heuristics on top are the part with the long tail, and the part
  most exposed if grouping ever moves to a model.

---

## Standing rules, learned the hard way

- **Crop the region and look at it.** Arithmetic has produced a wrong verdict on this
  project four times: twice by the controller, twice in a brief handed to an agent. Two of
  those were diagnoses that read as certain.
- **A number is not evidence that the right thing moved it.** A leaf count going the right
  way has coincided with the wrong fix more than once.
- **No golden-value assertions.** Six have broken on unrelated correct changes. The tests
  carry their weight through invariants — area conservation, non-overlap, determinism.
- **The partition invariant is absolute.** Children exactly tile their parent at every
  depth, so `--depth` changes labels and never the arithmetic. That is the measurement, not
  tidiness.
