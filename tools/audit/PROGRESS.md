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

Five of the 29 produce no measurement, all deliberately:

| site | why |
|---|---|
| webreality, jerseyfsc, afdb | HTTP 403. Refused as error pages rather than measured. |
| lloydsbank | HTTP 200 serving "We are sorry an error has occurred". Flagged `errorPageLikely`. |
| visionarygrid | 24,746px. Captured whole; phase 2 refuses on the memory budget. |
| bakerandpartners | Dies at the 3-minute deadline inside `dismissConsent`. Used to hang forever. |

---

## Open

| # | Defect | Site | State |
|---|---|---|---|
| 4 | Product grid cut one block per card; the depth ruling says a grid is one block | pola | in progress |
| 5 | A 295px soft-focus photograph shredded into ~15 fragments | dept.agency | in progress |
| 6 | Three oversized part-off-canvas `<img>` treated as modules, fusing header + hero + featured across the top 1,482px | gcsc | in progress |
| 8 | `shotTruncated` fires on a 3px difference — true statement, noisy threshold | liquidlight | not started |
| — | Consent card in a shadow root, repeats 12×, `consentBannerSeen` false | boondmanager | in progress |
| — | Whitespace reported as coverage per block, not as a category of block (user's ruling) | all | phase 3/4 |
| — | `webglBlind`: canvas content the edge map cannot read | 8 sites | accepted, declared in notes |

---

## Closed

Each row is a defect that was visible in a debug image and is not any more.

| Defect | Found on | Fixed by | Evidence |
|---|---|---|---|
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
- **xycut (~1,218)** — the cutting. The partition invariant and `segmentTall` are
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
