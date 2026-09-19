# Homepage Surface-Area Audit — Phases 2–4, Rebuilt on a Vision Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do NOT use subagent-driven-development for this plan** — see Execution Note below.

**Goal:** Replace the XY-cut segmenter with a vision model that decides where a homepage's blocks are and what each one is, keeping phase 1's capture and honesty layers untouched, and take the result through to an emailed report.

**Architecture:** Phase 1 is unchanged: it captures the page as stitched viewport slices and records what it could not measure. Phase 2 stops cutting on pixels. It sends the capture to a vision model as viewport-sized tiles, receives block boundaries **in tile-local coordinates**, snaps them to real DOM element edges, and builds the same true partition the old segmenter did — so the arithmetic stays exact. Phase 3 is the same call: the model returns each block's category alongside its boundary, because deciding where a section ends and deciding what it is are one judgement. Phase 4 turns the partition into percentages and emails them.

**Tech Stack:** Node ESM (`.mjs`), the existing Playwright/`sharp` capture, `fetch` against the Anthropic Messages API (`claude-opus-5`), `node:test` + `node:assert/strict`, Craft queue job for delivery.

**Spec:** This document's Context section, plus the measurements in `tools/audit/PROGRESS.md` and the original plan at `~/.claude/plans/project-homepage-surface-area-audit-luminous-dewdrop.md` (whose Context and Judgement call 1 still stand; its Judgement call 2 is superseded here).

## Global Constraints

- Node ESM only, `.mjs`, run from the repo root. **Do not tighten `engines`** — host node is v24, `package.json` declares `^20 || ^22`.
- Viewport is exactly **1440×900**, `deviceScaleFactor: 1`. Unchanged from phase 1.
- **The block tree is a true partition at every level.** Children exactly tile their parent; total leaf area equals image area. `assertPartition` runs before anything is written. This survives the rewrite intact and is the reason the percentage is defensible.
- **The model never does arithmetic.** It receives one tile at a time and answers in that tile's own coordinates, starting at 0. Offsets and scaling are applied in code. This is not a style preference — see Context.
- Progress to **stderr**, results to **stdout**. Exit 1 on failure.
- The API key is `KEY_ANTHROPIC_API` in `craft/.env` (NOT `ANTHROPIC_API_KEY`). Model id `claude-opus-5`. `temperature` is **deprecated on this model** and must not be sent.
- **No golden-value assertions.** Seven have broken on unrelated correct changes during phase 1–2. Tests carry their weight through invariants.
- Nothing under `tools/` is gitignored. Run artefacts go to a caller-supplied `outDir` outside the repo.
- Every file opens with a header comment: what it is, why it exists, the literal command line, and the one hard-won limitation.

---

## Context

### Why the segmenter is being replaced

`tools/audit/lib/xycut.mjs` grew to 2,163 lines and roughly ten populations that decide where a cut may land — full-bleed media, module containers, page landmarks, backdrops, bands, headings, text runs, repeated runs, declared lists, grids — each with its own axis rules and precedence. Every one was added for a real defect measured on a named page.

The last four defects found were **not rule bugs, they were interaction bugs**: a list vetoing a band boundary, a `<nav>` overruling the `<ul>`s inside it, a grid rule counting one box four times because three divs shared its geometry. Each rule was individually defensible. What broke was two of them meeting. That is a complexity curve, not a bug count.

The decisive measurement, on 26 captured sites:

| | segmenter | model |
|---|---|---|
| boondmanager | 69 blocks | 21 |
| jtcgroup | 66 | 18 |
| natwest | 32 | 18 |
| kohde | 22 | 11 |

The model solved, in one 19-second call, three defects the geometry cannot reach at all:

- **kohde has no `<header>` element** — its top bar is a plain `<div>`. `pageLandmarks` is right to find nothing. The model separates it at y=160.
- **kohde's "Launch." is SVG paths with no text content**, so `TEXT_TAGS`, `inkedTextRects` and `textRuns` can never reach it however they are tuned.
- **natwest's three stacked sections** were fused by a container the segmenter could not see past.

And it reframes a whole class of defect away: side-by-side columns come back as `cols: 3` **on one block** rather than three blocks, which is what the depth ruling wanted all along.

### Why phase 1 is untouched, and is not optional

The single most important experiment in this work: the same model was run on boondmanager's **old** capture, the one taken before slice-stitching, where a section was a 1,000px rectangle of flat `#282c36`.

It returned `2067–3427 "Dark solutions by profession"`. One confident, plausible, named block, over content that was not in the image. No hesitation, no flag. It also returned 16 blocks instead of 21, so a third of the page simply vanished from the arithmetic.

**A vision model is structurally incapable of knowing it was shown an incomplete picture.** Everything phase 1 does — stitched slices past Chromium's 16,384px paint ceiling, telling pinned chrome from a pinned scrollytelling panel by measurement, dismissing a consent card that lives in a shadow root and arrives seven viewports down, refusing a 403 or a 200 that is really an error page, declaring a region *unmeasured* rather than *empty* — is what makes the model's answer safe to use. None of it can be delegated to the thing being protected against.

### Why the model must not do arithmetic

In the 26-site sweep, three pages failed, all tall, both causes the same shape:

- **dept.agency**, 13,586px: coordinates came back running to **17,586px**. Four thousand pixels of error accumulated across ten tiles.
- **tpagency**, 8,878px: ran to 10,850px.
- **visionarygrid**, 24,746px: output truncated mid-JSON at the token ceiling, 18 tiles.

The sections each one *named* were right. What was wrong was the model repeatedly adding a tile offset and dividing by a scale. Task 2 removes that job from the model entirely: one tile per request, answers in that tile's own space starting at zero, offsets applied in code. Task 3 stitches the per-tile answers.

### Determinism — measured, and the ruling that follows

Three runs of the same image:

```
kohde   block counts 10, 11, 11   boundaries within 20px: 9/11, 10/11
budd    block counts  7,  7,  7   boundaries within 20px: 8/8,  5/8
```

Boundaries are stable to 10–20px. The **headline percentage is not**: kohde's largest block came out at 19.2%, 21.1% and 17.7% across three runs. Snapping to real element edges recovers part of it — andybudd reached 8/8 identical boundaries and 0.0px drift on one pair — but where the model genuinely chooses differently, merging two sections into one, snapping cannot help.

The original plan promised byte-identical output for a URL. That is not achievable and this plan does not pretend otherwise. **The replacement promise, implemented in Task 6:**

> A page is audited once. The response is stored and every report is served from it, so a given report's numbers are fixed forever and traceable to the exact image and response that produced them. The page is re-audited only when its **structural signature** changes — page height, element count, and a digest of its text and element boundaries — so a site that has not changed reports the same number forever, and one that has is re-measured automatically.

That is a weaker claim than the original and it is the honest one. It is also the claim that has to survive an argument with the person whose site it is.

### What is deleted, and why not kept as a fallback

`lib/xycut.mjs` and `segment.mjs` are removed in Task 8. Keeping the segmenter as a fallback would mean maintaining two answers and a rule for choosing between them — which is precisely the complexity being left behind. Its history is in git; `PROGRESS.md` records what each of its rules was for.

Three pieces are extracted before it goes, in Task 1, because they are needed and are not part of the cutting: `CONTENT_RECT`, `isContentRect` and `edgeCandidates`.

---

## File Structure

```
tools/audit/
  capture.mjs               phase 1 CLI — UNCHANGED
  analyse.mjs               phases 2+3 CLI — NEW, replaces segment.mjs
  report.mjs                phase 4 CLI — NEW
  lib/
    capture.mjs             UNCHANGED   phase 1 core
    consent.mjs             UNCHANGED
    pinned.mjs              UNCHANGED
    shadow.mjs              UNCHANGED
    unrendered.mjs          UNCHANGED
    painted.mjs             UNCHANGED
    errorpage.mjs           UNCHANGED
    webgl.mjs               UNCHANGED
    sameurl.mjs             UNCHANGED
    rects.mjs               UNCHANGED
    printable.mjs           UNCHANGED
    debug.mjs               MODIFIED    renders labelled blocks
    blocks.mjs              UNCHANGED   the partition invariant
    notes.mjs               MODIFIED    two new note codes
    candidates.mjs          NEW  Task 1  snap targets, extracted from xycut
    tiles.mjs               NEW  Task 2  cut a capture into model-ready tiles
    vision.mjs              NEW  Task 3  the API call and its validation
    bands.mjs               NEW  Task 4  boundaries -> a true partition
    signature.mjs           NEW  Task 6  the structural cache key
    surface.mjs             NEW  Task 9  percentages per category
    xycut.mjs               DELETED Task 8
    edges.mjs               REDUCED Task 8  only MAX_IMAGE_HEIGHT survives
  segment.mjs               DELETED Task 8
  test/                     xycut/bridge/landmarks/runs/lists tests deleted Task 8
```

## Execution Note

**Execute this plan inline, not with subagent-driven-development.** Measured on this project: the same class of fix took 45–104 minutes when dispatched to an agent and 10–20 minutes done directly, including a full 26-site sweep each time. Dispatch only Task 10's full re-capture, which is a long live run.

---

## Task 1: Extract the snap targets from the segmenter

**Files:**
- Create: `tools/audit/lib/candidates.mjs`
- Create: `tools/audit/test/candidates.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONTENT_RECT: {maxH: 700, minW: 60, minH: 12}`; `isContentRect(r): boolean`; `edgeCandidates(rects: Rect[], horizontal: boolean): number[]` — sorted ascending, de-duplicated.

This is a pure move. `xycut.mjs` keeps working by re-exporting, so nothing breaks before Task 8 deletes it.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/candidates.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONTENT_RECT, isContentRect, edgeCandidates} from '../lib/candidates.mjs';

const r = (x, y, w, h) => ({x, y, w, h, tag: 'div', boxed: false, text: 'x'});

test('the thresholds are the ones the corpus was measured against', () => {
    assert.deepEqual(CONTENT_RECT, {maxH: 700, minW: 60, minH: 12});
});

test('a page-level wrapper is not a snap target', () => {
    assert.equal(isContentRect(r(0, 0, 1440, 9000)), false);
});

test('a hairline and an icon are not snap targets', () => {
    assert.equal(isContentRect(r(0, 0, 1440, 4)), false);
    assert.equal(isContentRect(r(0, 0, 20, 20)), false);
});

test('an ordinary element is', () => {
    assert.equal(isContentRect(r(0, 0, 400, 100)), true);
});

test('candidates are both edges, sorted and de-duplicated', () => {
    const got = edgeCandidates([r(0, 100, 400, 50), r(0, 150, 400, 50)], true);
    assert.deepEqual(got, [100, 150, 200]);
});

test('the other axis asks for x', () => {
    assert.deepEqual(edgeCandidates([r(120, 0, 400, 100)], false), [120, 520]);
});

test('no rects, no candidates', () => {
    assert.deepEqual(edgeCandidates([], true), []);
    assert.deepEqual(edgeCandidates(undefined, true), []);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/candidates.test.mjs`
Expected: FAIL — `Cannot find module '../lib/candidates.mjs'`

- [ ] **Step 3: Create the module**

Create `tools/audit/lib/candidates.mjs`, moving the three exports out of `xycut.mjs` **verbatim**, with their comments:

```javascript
/**
 * CANDIDATES
 *
 * The coordinates a block boundary is allowed to land on: the edges of elements the page
 * actually drew.
 *
 *   node --test tools/audit/test/candidates.test.mjs
 *
 * A vision model places a boundary to within ten or twenty pixels — measured across three
 * runs of the same image — and rects.json says where elements ACTUALLY stop, exactly.
 * Snapping one to the other is what turns an approximate answer into a reproducible
 * number: on andybudd.com two runs whose raw boundaries differed reached 8/8 identical
 * after snapping, and 0.0px of drift.
 *
 * The limitation worth knowing: snapping cannot rescue a boundary the model genuinely
 * placed somewhere else. kohde.agency returns 10 blocks on one run and 11 on the next,
 * because it sometimes reads two sections as one; no amount of snapping makes those two
 * answers agree. See the determinism section of the plan.
 */

/**
 * A rect worth snapping to: an element that carries content, not the page scaffolding
 * around it. Page-level wrappers span the whole document, so their edges coincide with
 * the page's own extremes and they mark nothing. Hairlines and icons are excluded for
 * the opposite reason: too many of them, too small to be a section break.
 */
export const CONTENT_RECT = {maxH: 700, minW: 60, minH: 12};

export function isContentRect(r) {
    return r.h < CONTENT_RECT.maxH && r.w >= CONTENT_RECT.minW && r.h >= CONTENT_RECT.minH;
}

/**
 * Candidate coordinates on one axis: every content rect's leading and trailing edge,
 * sorted ascending and de-duplicated.
 *
 * Sorted is not cosmetic. A caller scanning in order and keeping the first of an equal
 * pair resolves a tie to the smaller coordinate no matter what order rects.json happened
 * to list its elements in.
 */
export function edgeCandidates(rects, horizontal) {
    if (!rects || rects.length === 0) return [];

    const seen = new Set();
    for (const r of rects) {
        if (!isContentRect(r)) continue;
        if (horizontal) {
            seen.add(r.y);
            seen.add(r.y + r.h);
        } else {
            seen.add(r.x);
            seen.add(r.x + r.w);
        }
    }

    return [...seen].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Re-export from xycut so nothing breaks yet**

In `tools/audit/lib/xycut.mjs`, delete the three definitions and add near the top, after the existing `import {leaves} from './blocks.mjs';`:

```javascript
// Moved to lib/candidates.mjs, which outlives this file — see the plan's Task 1. Still
// re-exported here so the segmenter and its tests keep working until Task 8 removes them.
export {CONTENT_RECT, isContentRect, edgeCandidates} from './candidates.mjs';
import {CONTENT_RECT, isContentRect, edgeCandidates} from './candidates.mjs';
```

- [ ] **Step 5: Run the whole suite**

Run: `node --test tools/audit/test/*.mjs`
Expected: PASS — the previous count plus 7. **If any xycut test fails, the move was not verbatim.** Do not adjust a test; re-check the move.

- [ ] **Step 6: Commit**

```bash
git add tools/audit/lib/candidates.mjs tools/audit/lib/xycut.mjs tools/audit/test/candidates.test.mjs
git commit -m "Move the snap targets somewhere that outlives the segmenter"
```

---

## Task 2: Cut a capture into tiles the model can read

**Files:**
- Create: `tools/audit/lib/tiles.mjs`
- Create: `tools/audit/test/tiles.test.mjs`

**Interfaces:**
- Consumes: `meta.image: {width, height}` from phase 1.
- Produces: `TILE_HEIGHT: 1400`; `TILE_SCALE: 0.75`; `tilePlan(height: number, tileHeight?: number): Array<{index: number, top: number, height: number}>`; `tileImages(pngPath: string, plan, width: number, scale?: number): Promise<Array<{index, top, height, scale, b64: string}>>`.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/tiles.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tilePlan, TILE_HEIGHT, TILE_SCALE} from '../lib/tiles.mjs';

test('a short page is one tile', () => {
    assert.deepEqual(tilePlan(900), [{index: 0, top: 0, height: 900}]);
});

test('tiles tile the page exactly, with no gap and no overlap', () => {
    for (const height of [900, 1400, 1401, 5717, 13586, 24746]) {
        const plan = tilePlan(height);
        assert.equal(plan[0].top, 0, `${height}: starts at the top`);
        for (let i = 1; i < plan.length; i++) {
            assert.equal(plan[i].top, plan[i - 1].top + plan[i - 1].height, `${height}: tile ${i} abuts`);
        }
        const last = plan[plan.length - 1];
        assert.equal(last.top + last.height, height, `${height}: reaches the bottom`);
    }
});

test('no tile is taller than the ceiling', () => {
    for (const t of tilePlan(24746)) assert.ok(t.height <= TILE_HEIGHT);
});

test('indices are sequential from zero', () => {
    assert.deepEqual(tilePlan(4000).map((t) => t.index), [0, 1, 2]);
});

test('a zero-height page yields no tiles rather than throwing', () => {
    assert.deepEqual(tilePlan(0), []);
});

test('the scale is the one the sweep was measured at', () => {
    assert.equal(TILE_SCALE, 0.75);
    assert.equal(TILE_HEIGHT, 1400);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/tiles.test.mjs`
Expected: FAIL — `Cannot find module '../lib/tiles.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/audit/lib/tiles.mjs`:

```javascript
/**
 * TILES
 *
 * A captured page, cut into pieces a vision model can actually read.
 *
 *   node --test tools/audit/test/tiles.test.mjs
 *
 * A 24,746px screenshot scaled to fit a model's input is about 90px wide and unreadable,
 * so the page goes up as a sequence of viewport-ish tiles instead. 1400px at 0.75 scale
 * puts each one at 1080x1050, which is the shape the 26-site sweep was measured at.
 *
 * THE TILES DO NOT OVERLAP, and that is deliberate. An overlapping tile would show the
 * model the same section twice and invite it to report the region twice, which the
 * partition then has to reconcile. A section straddling a seam is instead handled by
 * lib/bands.mjs, which merges a block ending at a seam with one starting there when the
 * model gave them the same label.
 *
 * The limitation worth knowing: a section taller than one tile is seen in pieces, and the
 * model can only say "this tile is all one thing" about the part it can see. That is why
 * the seam merge in bands.mjs exists and why it keys on the label.
 */
import sharp from 'sharp';

/** Page pixels per tile. */
export const TILE_HEIGHT = 1400;

/** …sent at this scale, so a tile arrives about 1080px on its long edge. */
export const TILE_SCALE = 0.75;

/** Where each tile starts and how tall it is. Exactly tiles the page. */
export function tilePlan(height, tileHeight = TILE_HEIGHT) {
    const out = [];
    for (let top = 0; top < height; top += tileHeight) {
        out.push({index: out.length, top, height: Math.min(tileHeight, height - top)});
    }

    return out;
}

/** The same plan, with each tile rendered and base64-encoded for the API. */
export async function tileImages(pngPath, plan, width, scale = TILE_SCALE) {
    const out = [];
    for (const t of plan) {
        const buf = await sharp(pngPath)
            .extract({left: 0, top: t.top, width, height: t.height})
            .resize(Math.round(width * scale))
            .png()
            .toBuffer();
        out.push({...t, scale, b64: buf.toString('base64')});
    }

    return out;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test tools/audit/test/tiles.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add tools/audit/lib/tiles.mjs tools/audit/test/tiles.test.mjs
git commit -m "Cut a capture into tiles a model can read"
```

---

## Task 3: Ask the model, one tile at a time

**Files:**
- Create: `tools/audit/lib/vision.mjs`
- Create: `tools/audit/test/vision.test.mjs`

**Interfaces:**
- Consumes: `tileImages` from Task 2.
- Produces: `MODEL: 'claude-opus-5'`; `CATEGORIES: ['brand','navigation','routing','promotion','other','unclassified']`; `TILE_PROMPT: string`; `apiKey(envPath?): string`; `parseTileReply(text: string, tile): {blocks: TileBlock[]} | {error: string}` where `TileBlock = {y0, y1, cols, what, category, confidence}` in **page** coordinates; `askTile(tile, pageSize, opts?): Promise<{blocks, usage, secs} | {error}>`; `askPage(pngPath, meta, opts?): Promise<{blocks, usage, secs, tiles}>`.

**The model answers in tile-local coordinates at the scale it was sent.** `parseTileReply` divides by the scale and adds the tile's top. The model is never asked to do either. See Context.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/vision.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTileReply, CATEGORIES, TILE_PROMPT} from '../lib/vision.mjs';

const tile = {index: 2, top: 2800, height: 1400, scale: 0.75};

test('tile-local coordinates become page coordinates', () => {
    // 0..1050 at 0.75 scale is the whole 1400px tile, which starts at 2800.
    const {blocks} = parseTileReply('[{"y0":0,"y1":1050,"cols":1,"what":"hero","category":"brand","confidence":0.9}]', tile);
    assert.equal(blocks[0].y0, 2800);
    assert.equal(blocks[0].y1, 4200);
});

test('a fenced reply is still read', () => {
    const {blocks} = parseTileReply('```json\n[{"y0":0,"y1":100,"cols":1,"what":"x","category":"other","confidence":0.5}]\n```', tile);
    assert.equal(blocks.length, 1);
});

test('prose around the JSON is tolerated', () => {
    const {blocks} = parseTileReply('Here you go:\n[{"y0":0,"y1":100,"cols":1,"what":"x","category":"other","confidence":0.5}]\nHope that helps.', tile);
    assert.equal(blocks.length, 1);
});

test('no JSON at all is an error, not a throw', () => {
    assert.ok(parseTileReply('I cannot see the image.', tile).error);
});

test('malformed JSON is an error, not a throw', () => {
    assert.ok(parseTileReply('[{"y0":0,', tile).error);
});

test('a block outside the tile is an error', () => {
    // 1400 at 0.75 scale is 1866px, past the tile's own height.
    assert.ok(parseTileReply('[{"y0":0,"y1":1400,"cols":1,"what":"x","category":"other","confidence":1}]', tile).error);
});

test('an unknown category becomes unclassified rather than being trusted', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"cols":1,"what":"x","category":"trust","confidence":0.8}]', tile);
    assert.equal(blocks[0].category, 'unclassified');
});

test('a missing confidence is treated as no confidence', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"cols":1,"what":"x","category":"brand"}]', tile);
    assert.equal(blocks[0].confidence, 0);
});

test('cols defaults to 1 and is never below it', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"what":"x","category":"brand","confidence":1},'
        + '{"y0":100,"y1":200,"cols":0,"what":"y","category":"brand","confidence":1}]', tile);
    assert.deepEqual(blocks.map((b) => b.cols), [1, 1]);
});

test('the categories are the ones the report promises', () => {
    assert.deepEqual(CATEGORIES,
        ['brand', 'navigation', 'routing', 'promotion', 'other', 'unclassified']);
});

test('the prompt tells the model to answer in this tile only', () => {
    assert.match(TILE_PROMPT, /0 is the top of THIS image/);
    assert.match(TILE_PROMPT, /Do not add any offset/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/vision.test.mjs`
Expected: FAIL — `Cannot find module '../lib/vision.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/audit/lib/vision.mjs`:

```javascript
/**
 * VISION
 *
 * Ask a model where a page's blocks are and what each one is.
 *
 *   node tools/audit/analyse.mjs <outDir>
 *
 * ONE TILE PER REQUEST, ANSWERED IN THAT TILE'S OWN COORDINATES. The model is never asked
 * to add an offset or divide by a scale, and this is the whole reason the module is shaped
 * this way. Asked to do that arithmetic across ten tiles, dept.agency came back with
 * coordinates running to 17,586px on a 13,586px page — four thousand pixels of accumulated
 * error — and tpagency.com overran by 1,972px. The sections both of them NAMED were right.
 * Offsets are applied here, in parseTileReply, where they cannot drift.
 *
 * WHAT COMES BACK IS NOT TRUSTED. A reply may be prose, may be fenced, may be truncated
 * mid-array, and may place a block outside the tile it was shown. Each of those is an
 * error with a reason, never a throw and never a silently repaired number — a capture that
 * cannot be read is a capture we decline to measure, which is the same rule phase 1
 * applies to a 403.
 *
 * The limitation worth knowing: a section taller than one tile is seen in pieces. The
 * model can only describe what is in front of it, so two halves of one hero arrive as two
 * blocks with the same label and are merged by lib/bands.mjs at the seam.
 */
import {readFileSync} from 'node:fs';
import {tilePlan, tileImages, TILE_SCALE} from './tiles.mjs';

export const MODEL = 'claude-opus-5';
export const API = 'https://api.anthropic.com/v1/messages';
export const MAX_TOKENS = 4000;

/**
 * The closed set. `unclassified` is a real answer and is reported as itself — never
 * redistributed into the others, because a percentage that absorbs our own uncertainty is
 * the confident wrong number this tool exists to avoid.
 */
export const CATEGORIES = ['brand', 'navigation', 'routing', 'promotion', 'other', 'unclassified'];

export const TILE_PROMPT = `You are shown ONE horizontal slice of a homepage screenshot.

Identify the LAYOUT BLOCKS visible in this slice: the regions a designer would say are
distinct parts of the page.

What counts as ONE block:
- A header, a hero, a section, a footer are each one block.
- A grid or carousel of cards is ONE block, not one per card.
- A list of links is ONE block, however many links.
- A heading and the body copy that belongs to it are ONE block.
- Side-by-side columns carrying the same KIND of content are one block; say how many in "cols".

What forces TWO blocks:
- A change of background colour or image.
- Side-by-side regions carrying different kinds of content.

Give each block a category, using these definitions and this precedence (first match wins):
- "promotion"  - asks the visitor to act now: an offer, urgency, a price, a capture form.
- "routing"    - points at specific internal destinations: a product grid, a card row, in-page links.
- "navigation" - persistent wayfinding chrome that would appear on any page of this site.
- "brand"      - identity with no offer and no destination: a logo, a positioning line, hero imagery.
- "other"      - the page's own substantive content, and structural whitespace.
- "unclassified" - you are not confident. Say so rather than guessing.

COORDINATES. Answer in THIS IMAGE's pixels: 0 is the top of THIS image, not of the page.
Do not add any offset and do not rescale. Cover this image top to bottom with no gaps and
no overlaps.

Return ONLY a JSON array, no prose and no code fence:
[{"y0": <int>, "y1": <int>, "cols": <int>, "what": "<3-5 words>", "category": "<one of the six>", "confidence": <0 to 1>}]`;

/** The key lives in craft/.env as KEY_ANTHROPIC_API, not ANTHROPIC_API_KEY. */
export function apiKey(envPath = 'craft/.env') {
    const found = (readFileSync(envPath, 'utf8').match(/^KEY_ANTHROPIC_API\s*=\s*"?([^"\n\r]+)"?/m) ?? [])[1];
    if (!found) throw new Error(`no KEY_ANTHROPIC_API in ${envPath}`);

    return found;
}

/**
 * A tile's reply, in page coordinates, or an error with a reason.
 *
 * Every repair here is a REFUSAL or a DOWNGRADE, never an invention: an unknown category
 * becomes `unclassified`, a missing confidence becomes 0, and a block outside the tile
 * fails the whole tile rather than being clamped into it. Clamping would turn a model that
 * lost track of where it was into a plausible-looking answer.
 */
export function parseTileReply(text, tile) {
    const m = String(text ?? '').match(/\[[\s\S]*\]/);
    if (!m) return {error: `no JSON array in the reply: ${String(text ?? '').slice(0, 120)}`};

    let raw;
    try {
        raw = JSON.parse(m[0]);
    } catch (e) {
        return {error: `unparseable JSON: ${e.message}`};
    }
    if (!Array.isArray(raw) || raw.length === 0) return {error: 'the reply held no blocks'};

    const limit = Math.round(tile.height * tile.scale);
    const blocks = [];
    for (const b of raw) {
        const y0 = Number(b?.y0);
        const y1 = Number(b?.y1);
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) {
            return {error: `a block has no usable extent: ${JSON.stringify(b).slice(0, 80)}`};
        }
        // The tile is `limit` pixels tall as the model saw it. A block past that means the
        // model lost track of which image it was looking at.
        if (y0 < 0 || y1 > limit + 2) {
            return {error: `a block runs from ${y0} to ${y1}, outside a ${limit}px tile`};
        }
        blocks.push({
            y0: tile.top + Math.round(y0 / tile.scale),
            y1: tile.top + Math.round(y1 / tile.scale),
            cols: Math.max(1, Math.round(Number(b?.cols) || 1)),
            what: String(b?.what ?? '').slice(0, 80),
            category: CATEGORIES.includes(b?.category) ? b.category : 'unclassified',
            confidence: Number.isFinite(Number(b?.confidence)) ? Number(b.confidence) : 0,
        });
    }

    return {blocks};
}

/** One tile, one request. */
export async function askTile(tile, pageSize, opts = {}) {
    const key = opts.key ?? apiKey(opts.envPath);
    const started = Date.now();
    const res = await fetch(API, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'},
        body: JSON.stringify({
            model: opts.model ?? MODEL,
            max_tokens: MAX_TOKENS,
            thinking: {type: 'adaptive'},
            messages: [{
                role: 'user',
                content: [
                    {type: 'image', source: {type: 'base64', media_type: 'image/png', data: tile.b64}},
                    {
                        type: 'text',
                        text: `This slice is ${Math.round(pageSize.width * tile.scale)}x`
                            + `${Math.round(tile.height * tile.scale)} pixels.\n\n${TILE_PROMPT}`,
                    },
                ],
            }],
        }),
    });
    const json = await res.json();
    if (!res.ok) return {error: `API ${res.status}: ${JSON.stringify(json).slice(0, 200)}`};
    if (json.stop_reason === 'max_tokens') return {error: 'the reply was cut off at the token limit'};

    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const parsed = parseTileReply(text, tile);
    if (parsed.error) return {error: `tile ${tile.index}: ${parsed.error}`};

    return {blocks: parsed.blocks, usage: json.usage ?? {}, secs: (Date.now() - started) / 1000};
}

/** Every tile of a page, in order. One bad tile fails the page. */
export async function askPage(pngPath, meta, opts = {}) {
    const {width, height} = meta.image;
    const plan = tilePlan(height);
    const tiles = await tileImages(pngPath, plan, width, opts.scale ?? TILE_SCALE);

    const blocks = [];
    const usage = {input_tokens: 0, output_tokens: 0};
    let secs = 0;
    for (const tile of tiles) {
        const r = await askTile(tile, {width, height}, opts);
        if (r.error) return {error: r.error, tiles: tiles.length};
        blocks.push(...r.blocks);
        usage.input_tokens += r.usage.input_tokens ?? 0;
        usage.output_tokens += r.usage.output_tokens ?? 0;
        secs += r.secs;
    }

    return {blocks, usage, secs, tiles: tiles.length};
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test tools/audit/test/vision.test.mjs`
Expected: PASS, 11 tests. None of them makes a network call.

- [ ] **Step 5: Try it against one real tile**

```bash
node -e "
Promise.all([import('./tools/audit/lib/tiles.mjs'), import('./tools/audit/lib/vision.mjs')]).then(async ([t, v]) => {
  const dir = process.env.DIR;
  const meta = JSON.parse(require('fs').readFileSync(dir + '/meta.json', 'utf8'));
  const plan = t.tilePlan(meta.image.height);
  const [tile] = await t.tileImages(dir + '/fullpage.png', plan.slice(0, 1), meta.image.width);
  const r = await v.askTile(tile, meta.image, {});
  console.log(r.error ?? r.blocks);
});" DIR=/tmp/audit-kohde
```

Expected: a handful of blocks whose `y0`/`y1` lie inside the first 1400px, each with a category from the closed set.

- [ ] **Step 6: Commit**

```bash
git add tools/audit/lib/vision.mjs tools/audit/test/vision.test.mjs
git commit -m "Ask the model one tile at a time, and do its arithmetic for it"
```

---

## Task 4: Turn boundaries into a true partition

**Files:**
- Create: `tools/audit/lib/bands.mjs`
- Create: `tools/audit/test/bands.test.mjs`

**Interfaces:**
- Consumes: `edgeCandidates` (Task 1); `assertPartition`, `leaves`, `totalArea` from `lib/blocks.mjs`.
- Produces: `SNAP_REACH: 40`; `snapBoundaries(edges: number[], candidates: number[], reach?): number[]`; `mergeSeams(blocks: TileBlock[], seams: number[]): TileBlock[]`; `buildTree(blocks, width, height): Block` where `Block = {x, y, w, h, depth, children, label?: {what, category, confidence, cols}}`.

**This is where the partition invariant is preserved.** The model's boundaries are advisory; the tree built from them must tile the image exactly or `analyse.mjs` refuses to write.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/bands.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapBoundaries, mergeSeams, buildTree, SNAP_REACH} from '../lib/bands.mjs';
import {assertPartition, leaves, totalArea} from '../lib/blocks.mjs';

const b = (y0, y1, category = 'other', what = 'x', cols = 1) => ({y0, y1, category, what, cols, confidence: 0.9});

test('a boundary within reach moves to the element edge', () => {
    assert.deepEqual(snapBoundaries([118], [0, 120, 400]), [120]);
});

test('a boundary with no edge near it stays put', () => {
    assert.deepEqual(snapBoundaries([600], [0, 120, 400]), [600]);
});

test('the reach is the one measured on the corpus', () => {
    assert.equal(SNAP_REACH, 40);
    assert.deepEqual(snapBoundaries([160], [200]), [160], 'just out of reach');
    assert.deepEqual(snapBoundaries([161], [200]), [200], 'just inside it');
});

test('two boundaries snapping to one edge collapse', () => {
    assert.deepEqual(snapBoundaries([118, 122], [120]), [120]);
});

test('snapped boundaries come back sorted', () => {
    assert.deepEqual(snapBoundaries([400, 100], [100, 400]), [100, 400]);
});

test('blocks meeting at a seam with the same label merge', () => {
    const got = mergeSeams([b(0, 1400, 'brand', 'hero'), b(1400, 2000, 'brand', 'hero')], [1400]);
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].y0, got[0].y1], [0, 2000]);
});

test('blocks meeting at a seam with different labels do not', () => {
    const got = mergeSeams([b(0, 1400, 'brand', 'hero'), b(1400, 2000, 'routing', 'cards')], [1400]);
    assert.equal(got.length, 2);
});

test('blocks meeting away from a seam never merge, however alike', () => {
    const got = mergeSeams([b(0, 700, 'brand', 'hero'), b(700, 900, 'brand', 'hero')], [1400]);
    assert.equal(got.length, 2);
});

test('the tree tiles the image exactly', () => {
    const root = buildTree([b(0, 500), b(500, 1200)], 1440, 1200);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), 1440 * 1200);
});

test('a gap between blocks is closed rather than left', () => {
    const root = buildTree([b(0, 500), b(600, 1200)], 1440, 1200);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), 1440 * 1200);
});

test('a page the blocks do not reach the bottom of is still a partition', () => {
    const root = buildTree([b(0, 500)], 1440, 1200);
    assert.equal(totalArea(leaves(root)), 1440 * 1200);
});

test('overlapping blocks are resolved rather than double-counted', () => {
    const root = buildTree([b(0, 700), b(500, 1200)], 1440, 1200);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), 1440 * 1200);
});

test('every leaf keeps the label it came from', () => {
    const root = buildTree([b(0, 500, 'brand', 'logo'), b(500, 1200, 'navigation', 'nav')], 1440, 1200);
    assert.deepEqual(leaves(root).map((l) => l.label.category), ['brand', 'navigation']);
});

test('no blocks at all yields one leaf covering the page', () => {
    const root = buildTree([], 1440, 1200);
    const ls = leaves(root);
    assert.equal(ls.length, 1);
    assert.equal(ls[0].label.category, 'unclassified');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/bands.test.mjs`
Expected: FAIL — `Cannot find module '../lib/bands.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/audit/lib/bands.mjs`:

```javascript
/**
 * BANDS
 *
 * The model's boundaries, turned into the true partition the measurement rests on.
 *
 *   node --test tools/audit/test/bands.test.mjs
 *
 * THE MODEL'S ANSWER IS ADVISORY; THE PARTITION IS NOT. Blocks arrive as a list of y
 * ranges that MOSTLY tile the page — across 26 sites the sweep found no gaps, but "mostly"
 * is not a foundation for a percentage somebody will argue with. Everything here exists to
 * turn that list into a partition where total leaf area equals image area exactly, so the
 * arithmetic is ours and not the model's.
 *
 * Snapping first, because it is what makes the number reproducible: the model places a
 * boundary to within ten or twenty pixels, and rects.json knows where elements actually
 * stop. On andybudd.com two runs that differed raw reached 8/8 identical boundaries and
 * 0.0px of drift once snapped. See lib/candidates.mjs.
 *
 * The limitation worth knowing: where two runs genuinely disagree about whether a region
 * is one section or two, snapping cannot reconcile them — kohde.agency returns 10 blocks
 * on one run and 11 on another. That is why a page is audited once and the answer stored;
 * see lib/signature.mjs.
 */
import {assertPartition} from './blocks.mjs';

/** How far a boundary may move to reach a real element edge. */
export const SNAP_REACH = 40;

/**
 * Each boundary moved to the nearest element edge within reach, de-duplicated and sorted.
 *
 * Out of reach means the model saw a boundary the DOM does not have — a background change
 * inside one element, most often — and the model's own coordinate stands.
 */
export function snapBoundaries(edges, candidates, reach = SNAP_REACH) {
    const snapped = edges.map((y) => {
        let best = y;
        let gap = reach + 1;
        for (const c of candidates) {
            const d = Math.abs(c - y);
            if (d < gap) {
                gap = d;
                best = c;
            }
        }

        return gap <= reach ? best : y;
    });

    return [...new Set(snapped)].sort((a, b) => a - b);
}

/**
 * Blocks split by a tile seam, put back together.
 *
 * A section taller than one tile is shown to the model in pieces and comes back as two
 * blocks with the same label, meeting exactly at the seam. Nothing else may merge: two
 * adjacent sections that happen to share a category are still two sections, and merging
 * them would hide a boundary a reader can see.
 */
export function mergeSeams(blocks, seams) {
    const at = new Set(seams);
    const out = [];
    for (const b of blocks) {
        const last = out[out.length - 1];
        const joins = last && last.y1 === b.y0 && at.has(b.y0)
            && last.category === b.category && last.what === b.what;
        if (joins) {
            last.y1 = b.y1;
            last.cols = Math.max(last.cols, b.cols);
            last.confidence = Math.min(last.confidence, b.confidence);
            continue;
        }
        out.push({...b});
    }

    return out;
}

/**
 * A root whose children exactly tile the image, each carrying its block's label.
 *
 * Built from the BOUNDARIES rather than from the blocks themselves, which is what makes
 * gaps and overlaps impossible rather than merely unlikely: the distinct y values become
 * one contiguous run of bands, and each band takes the label of the block that covers its
 * midpoint. A block that overlapped another simply loses the part it did not own, and a
 * gap becomes a band nobody labelled — reported as `unclassified`, never silently absorbed
 * into a neighbour.
 */
export function buildTree(blocks, width, height) {
    const cuts = new Set([0, height]);
    for (const b of blocks) {
        if (b.y0 > 0 && b.y0 < height) cuts.add(b.y0);
        if (b.y1 > 0 && b.y1 < height) cuts.add(b.y1);
    }
    const ys = [...cuts].sort((a, b) => a - b);

    const children = [];
    for (let i = 0; i < ys.length - 1; i++) {
        const y = ys[i];
        const h = ys[i + 1] - y;
        if (h <= 0) continue;
        const mid = y + h / 2;
        const owner = blocks.find((b) => b.y0 <= mid && mid < b.y1);
        children.push({
            x: 0,
            y,
            w: width,
            h,
            depth: 1,
            children: [],
            label: owner
                ? {what: owner.what, category: owner.category, confidence: owner.confidence, cols: owner.cols}
                : {what: 'unlabelled region', category: 'unclassified', confidence: 0, cols: 1},
        });
    }

    const root = {x: 0, y: 0, w: width, h: height, depth: 0, children};
    // Thrown here rather than left to the caller: a tree that is not a partition is not a
    // measurement of anything, and every path to this function produces one or fails.
    assertPartition(root);

    return root;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test tools/audit/test/bands.test.mjs`
Expected: PASS, 14 tests.

**If "the tree tiles the image exactly" fails, do not adjust the test.** It is the specification, and it is the one claim the whole report rests on.

- [ ] **Step 5: Commit**

```bash
git add tools/audit/lib/bands.mjs tools/audit/test/bands.test.mjs
git commit -m "Turn the model's boundaries into a partition we can defend"
```

---

## Task 5: The phase 2+3 CLI

**Files:**
- Create: `tools/audit/analyse.mjs`
- Create: `tools/audit/test/analyse-cli.test.mjs`
- Modify: `tools/audit/lib/debug.mjs`

**Interfaces:**
- Consumes: `askPage` (Task 3); `snapBoundaries`, `mergeSeams`, `buildTree` (Task 4); `edgeCandidates` (Task 1); `loadRects`, `runNotes`, `noteCodes`, `anyUnmeasured`, `pixelsFromPng`, `inkPrefix`, `unpaintedBlocks`, `transparentBlocks`, `blankRegions`, `renderDebug`, `printable`.
- Produces: `blocks.json` as `{notes, tree}` — the **same shape** `segment.mjs` wrote, so nothing downstream changes — plus `vision.json` holding the raw model response, and `debug.png`.

- [ ] **Step 1: Write the CLI**

Create `tools/audit/analyse.mjs`:

```javascript
#!/usr/bin/env node
/**
 * PHASES 2 AND 3 — ANALYSE
 *
 *   node tools/audit/analyse.mjs <outDir>
 *
 * Reads fullpage.png, rects.json and meta.json from a phase 1 capture. Asks a vision model
 * where the blocks are and what each one is, snaps the boundaries onto real element edges,
 * and writes blocks.json, vision.json and debug.png.
 *
 * blocks.json is `{notes, tree}` — the SAME SHAPE segment.mjs wrote, deliberately, so that
 * everything downstream of it is unchanged by the rewrite. What is new is that every leaf
 * carries a `label`.
 *
 * ARTEFACTS ARE WRITTEN ONLY BY A RUN THAT PASSED, and the previous run's are removed
 * first, so what is in the directory afterwards is always this run's or nothing.
 *
 * REFUSES BEFORE IT SPENDS. The honesty checks run against the capture BEFORE the API call,
 * because paying to measure a 403 page is worse than not measuring it: a model shown an
 * error page describes it confidently as a homepage, and a model shown boondmanager's old
 * capture named a 1,000px rectangle of flat colour "Dark solutions by profession".
 */
import {join} from 'node:path';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {askPage} from './lib/vision.mjs';
import {tilePlan} from './lib/tiles.mjs';
import {snapBoundaries, mergeSeams, buildTree} from './lib/bands.mjs';
import {edgeCandidates} from './lib/candidates.mjs';
import {leaves, totalArea} from './lib/blocks.mjs';
import {anyUnmeasured, noteCodes, runNotes} from './lib/notes.mjs';
import {loadRects} from './lib/rects.mjs';
import {printable} from './lib/printable.mjs';
import {renderDebug} from './lib/debug.mjs';
import {blankRegions, inkPrefix, pixelsFromPng, transparentBlocks, unpaintedBlocks} from './lib/painted.mjs';

const outDir = process.argv[2];
if (!outDir) {
    console.error('usage: node tools/audit/analyse.mjs <outDir>');
    process.exit(1);
}

const png = join(outDir, 'fullpage.png');
const blocksPath = join(outDir, 'blocks.json');
const visionPath = join(outDir, 'vision.json');
const debugPath = join(outDir, 'debug.png');

process.stderr.write(`analysing ${printable(png)}\n`);
try {
    rmSync(blocksPath, {force: true});
    rmSync(visionPath, {force: true});
    rmSync(debugPath, {force: true});

    const metaPath = join(outDir, 'meta.json');
    if (!existsSync(metaPath)) throw new Error('no meta.json — phase 2 needs a phase 1 capture, not just a PNG');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const loaded = loadRects(join(outDir, 'rects.json'));
    const rects = loaded ? loaded.rects : [];

    // The honesty layer FIRST, and a refusal here costs nothing.
    if (typeof meta.httpStatus === 'number' && (meta.httpStatus < 200 || meta.httpStatus >= 300)) {
        throw new Error(`the server answered ${meta.httpStatus}, so this is an error page rather than the site`);
    }

    const {width, height} = meta.image;
    const answer = await askPage(png, meta, {});
    if (answer.error) throw new Error(`the model could not read this capture: ${answer.error}`);

    const seams = tilePlan(height).map((t) => t.top).filter((y) => y > 0);
    const merged = mergeSeams(answer.blocks, seams);
    const boundaries = snapBoundaries(
        [...new Set(merged.flatMap((b) => [b.y0, b.y1]))],
        edgeCandidates(rects, true),
    );
    // Re-seat each block on the snapped boundaries, nearest wins, so the tree is built from
    // coordinates the DOM actually has.
    const nearest = (y) => boundaries.reduce((best, c) => (Math.abs(c - y) < Math.abs(best - y) ? c : best), y);
    const seated = merged.map((b) => ({...b, y0: nearest(b.y0), y1: nearest(b.y1)}))
        .filter((b) => b.y1 > b.y0);

    const root = buildTree(seated, width, height);
    const ls = leaves(root);
    if (totalArea(ls) !== width * height) {
        throw new Error(`area check BROKEN: leaves total ${totalArea(ls)} against an image of ${width * height}`);
    }

    // The same per-block honesty measurements segment.mjs made: the DOM and the pixels
    // compared against each other, which only this phase holds both halves of.
    let unpainted = null;
    let blank = null;
    let transparent = null;
    if (rects.length) {
        const raw = await pixelsFromPng(png);
        const measured = inkPrefix(raw.pixels, raw.width, raw.height);
        unpainted = unpaintedBlocks(measured, ls, rects);
        transparent = transparentBlocks(measured, ls, rects);
        blank = blankRegions(measured, ls);
    }
    const notes = runNotes(meta, 'present', rects, unpainted, blank, transparent);

    await renderDebug(png, root, debugPath);
    writeFileSync(visionPath, JSON.stringify({
        model: answer.usage ? undefined : undefined,
        blocks: answer.blocks,
        usage: answer.usage,
        tiles: answer.tiles,
        secs: Number(answer.secs.toFixed(1)),
    }, null, 1));
    writeFileSync(blocksPath, JSON.stringify({notes, tree: root}, null, 1));

    console.log(`image        ${width}x${height}`);
    console.log(`tiles        ${answer.tiles}`);
    console.log(`blocks       ${ls.length}`);
    console.log('area check   conserved');
    console.log(`tokens       ${answer.usage.input_tokens} in, ${answer.usage.output_tokens} out`);
    console.log(`seconds      ${answer.secs.toFixed(1)}`);
    console.log(`debug image  ${printable(debugPath)}`);

    const codes = noteCodes(notes);
    console.log(`notes        ${codes.length ? `${codes.length} — ${codes.join(', ')}` : 'none'}`);
    if (anyUnmeasured(notes)) console.log('unmeasured   YES — see warnings');
    for (const code of codes) process.stderr.write(`\nWARNING: ${notes.conditions[code].message}\n`);
} catch (e) {
    console.error(`analysis failed: ${printable(e.message, 500)}`);
    process.exit(1);
}
```

- [ ] **Step 2: Make the debug image show the labels**

In `tools/audit/lib/debug.mjs`, replace the `.map((b, i) => ...)` body so a leaf's label is drawn when it has one:

```javascript
        .map((b, i) => {
            const tag = b.label ? `${i} ${b.label.category}${b.label.cols > 1 ? ` x${b.label.cols}` : ''} — ${b.label.what}` : String(i);

            return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" `
                + 'fill="none" stroke="#e02e1a" stroke-width="2"/>'
                + `<text x="${b.x + 6}" y="${b.y + 18}" font-family="monospace" font-size="13" `
                + `fill="#e02e1a">${tag.replace(/[<&]/g, '')}</text>`;
        })
```

- [ ] **Step 3: Write the CLI test**

Create `tools/audit/test/analyse-cli.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const run = promisify(execFile);

test('a directory with no meta.json is refused, not guessed at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyse-'));
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dir]),
        (e) => /needs a phase 1 capture/.test(e.stdout + e.stderr),
    );
});

test('an error page is refused before any API call is made', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyse-'));
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        url: 'https://example.com', httpStatus: 403, image: {width: 1440, height: 900},
    }));
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dir]),
        (e) => /answered 403/.test(e.stdout + e.stderr),
    );
});

test('no outDir prints usage and exits 1', async () => {
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs']),
        (e) => /usage: node tools\/audit\/analyse\.mjs/.test(e.stderr),
    );
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test tools/audit/test/analyse-cli.test.mjs`
Expected: PASS, 3 tests. None makes a network call — the refusals happen first, which is the point.

- [ ] **Step 5: Run it end to end on one real capture**

```bash
node tools/audit/capture.mjs https://kohde.agency /tmp/audit-kohde
node tools/audit/analyse.mjs /tmp/audit-kohde
open /tmp/audit-kohde/debug.png
```

Expected: `area check conserved`, roughly 10 blocks, every one labelled, the header separated from the hero at about y=160 and the case study panel separated at about y=897.

- [ ] **Step 6: Commit**

```bash
git add tools/audit/analyse.mjs tools/audit/lib/debug.mjs tools/audit/test/analyse-cli.test.mjs
git commit -m "Add the analyse CLI, which asks rather than cuts"
```

---

## Task 6: Audit once, unless the site changed

**Files:**
- Create: `tools/audit/lib/signature.mjs`
- Create: `tools/audit/test/signature.test.mjs`
- Modify: `tools/audit/analyse.mjs`

**Interfaces:**
- Consumes: `meta`, `rects` from a capture.
- Produces: `pageSignature(meta, rects): string` — a 16-character hex digest; `signatureFacts(meta, rects): {height, rectCount, textDigest, edgeDigest}`.

**This is the determinism promise made good.** Re-capture every time, which costs 19 seconds. Pay for a model call only when the signature moved.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/signature.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageSignature, signatureFacts} from '../lib/signature.mjs';

const meta = {image: {width: 1440, height: 5717}, fullHeight: 5717};
const rects = [
    {x: 0, y: 0, w: 1440, h: 88, tag: 'header', boxed: true, text: 'Kohde'},
    {x: 40, y: 200, w: 600, h: 120, tag: 'h1', boxed: false, text: 'Kohde builds businesses'},
];

test('the same capture gives the same signature', () => {
    assert.equal(pageSignature(meta, rects), pageSignature(meta, rects));
});

test('a different page height changes it', () => {
    assert.notEqual(pageSignature(meta, rects), pageSignature({...meta, image: {width: 1440, height: 5800}}, rects));
});

test('changed copy changes it', () => {
    const edited = [rects[0], {...rects[1], text: 'Kohde builds something else'}];
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, edited));
});

test('a moved element changes it', () => {
    const moved = [rects[0], {...rects[1], y: 260}];
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, moved));
});

test('an added element changes it', () => {
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, [...rects, {x: 0, y: 900, w: 300, h: 40, tag: 'p', text: 'new'}]));
});

/**
 * The point of the whole thing: a page whose CONTENT is unchanged must not be re-audited
 * because a carousel happened to be showing a different photograph. Rect order is not
 * stable between captures either, so the digest must not depend on it.
 */
test('reordered rects do not change it', () => {
    assert.equal(pageSignature(meta, rects), pageSignature(meta, [rects[1], rects[0]]));
});

test('the facts behind it are inspectable', () => {
    const f = signatureFacts(meta, rects);
    assert.equal(f.height, 5717);
    assert.equal(f.rectCount, 2);
    assert.ok(f.textDigest.length > 0);
});

test('no rects is a usable signature, not a crash', () => {
    assert.ok(pageSignature(meta, []).length > 0);
    assert.ok(pageSignature(meta, undefined).length > 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/signature.test.mjs`
Expected: FAIL — `Cannot find module '../lib/signature.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/audit/lib/signature.mjs`:

```javascript
/**
 * SIGNATURE
 *
 * Has this page actually changed since we last measured it?
 *
 *   node --test tools/audit/test/signature.test.mjs
 *
 * A vision model does not return the same answer twice. Measured over three runs of one
 * image: block counts of 10, 11 and 11, boundaries agreeing to within 20px, and the
 * largest block reported at 19.2%, 21.1% and 17.7% of the page. Snapping to element edges
 * recovers some of that and not all of it.
 *
 * So a page is audited ONCE and the answer is stored, and the number a prospect reads never
 * moves underneath them. The question this file answers is when that stored answer has
 * stopped describing the site.
 *
 * NOT A HASH OF THE SCREENSHOT. A hero carousel or a rotating photograph changes those
 * pixels on every single load, which would re-audit an unchanged page every time and cost
 * money to produce a slightly different number. The signature is STRUCTURAL: how tall the
 * page is, how many elements it has, what they say, and where they sit.
 *
 * The limitation worth knowing: a site that changes only its imagery — a new hero
 * photograph, the same layout and copy — will not be re-audited, and its report will be
 * right about the proportions and stale about the picture. That is the intended trade.
 */
import {createHash} from 'node:crypto';

/** The inputs, separately, so a mismatch can be explained rather than just asserted. */
export function signatureFacts(meta, rects) {
    const list = Array.isArray(rects) ? rects : [];
    // Sorted, because rects.json's order is the DOM's and is not stable between captures.
    const lines = list
        .map((r) => `${r.tag}|${r.x},${r.y},${r.w},${r.h}|${String(r.text ?? '').trim().slice(0, 120)}`)
        .sort();

    return {
        height: meta?.image?.height ?? meta?.fullHeight ?? 0,
        rectCount: list.length,
        textDigest: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16),
        edgeDigest: createHash('sha256')
            .update(list.map((r) => `${r.y}:${r.y + r.h}`).sort().join(','))
            .digest('hex').slice(0, 16),
    };
}

export function pageSignature(meta, rects) {
    const f = signatureFacts(meta, rects);

    return createHash('sha256')
        .update(`${f.height}|${f.rectCount}|${f.textDigest}|${f.edgeDigest}`)
        .digest('hex')
        .slice(0, 16);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test tools/audit/test/signature.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the cache into analyse.mjs**

In `tools/audit/analyse.mjs`, add the import:

```javascript
import {pageSignature, signatureFacts} from './lib/signature.mjs';
```

…and replace the `const answer = await askPage(png, meta, {});` line with:

```javascript
    // THE CACHE, AND IT IS THE DETERMINISM PROMISE. A stored answer is reused whenever the
    // page's structure is unchanged, so a report's numbers are fixed forever and traceable
    // to the response that produced them. `--force` re-audits anyway.
    const signature = pageSignature(meta, rects);
    const force = process.argv.includes('--force');
    const cached = !force && existsSync(visionPath)
        ? JSON.parse(readFileSync(visionPath, 'utf8'))
        : null;
    let answer;
    if (cached && cached.signature === signature) {
        process.stderr.write(`page unchanged since ${cached.askedAt} — reusing the stored answer\n`);
        answer = {blocks: cached.blocks, usage: cached.usage ?? {}, secs: 0, tiles: cached.tiles, reused: true};
    } else {
        answer = await askPage(png, meta, {});
    }
```

Then replace the `writeFileSync(visionPath, ...)` call with one that records what was asked:

```javascript
    writeFileSync(visionPath, JSON.stringify({
        signature,
        facts: signatureFacts(meta, rects),
        askedAt: answer.reused ? cached.askedAt : new Date().toISOString(),
        blocks: answer.blocks,
        usage: answer.usage,
        tiles: answer.tiles,
    }, null, 1));
```

…and add to the printed summary, after the `seconds` line:

```javascript
    console.log(`answer       ${answer.reused ? 'reused — page unchanged' : 'fresh'}`);
```

**Note:** `rmSync(visionPath, {force: true})` at the top must be REMOVED, or the cache is deleted before it can be read. Delete that one line.

- [ ] **Step 6: Prove the cache works**

```bash
node tools/audit/analyse.mjs /tmp/audit-kohde | grep answer   # fresh
node tools/audit/analyse.mjs /tmp/audit-kohde | grep answer   # reused — page unchanged
node tools/audit/analyse.mjs /tmp/audit-kohde --force | grep answer   # fresh
```

Expected: `fresh`, then `reused — page unchanged`, then `fresh`. **And the block count must be identical between the first two runs** — that is the promise working.

- [ ] **Step 7: Commit**

```bash
git add tools/audit/lib/signature.mjs tools/audit/test/signature.test.mjs tools/audit/analyse.mjs
git commit -m "Audit a page once, and again only when it has actually changed"
```

---

## Task 7: Say when the model's answer is not to be trusted

**Files:**
- Modify: `tools/audit/lib/notes.mjs`
- Modify: `tools/audit/test/notes.test.mjs`

**Interfaces:**
- Consumes: `runNotes(meta, reason, rects, unpainted, blank, transparent)` — unchanged signature.
- Produces: two new codes in `notes.conditions`: `lowConfidence` (effect `unknown`) and `unlabelledRegion` (effect `unmeasured`).

`runNotes` gains a seventh parameter, `leaves`, defaulting to `null` so every existing caller is unaffected.

- [ ] **Step 1: Write the failing test**

Append to `tools/audit/test/notes.test.mjs`:

```javascript
/* ------------------------------------------------ what the model was unsure about */

const leaf = (category, confidence, h = 500) => ({x: 0, y: 0, w: 1440, h, label: {category, confidence, what: 'x', cols: 1}});

test('a page the model was largely unsure about says so', () => {
    const notes = runNotes(clean({}), 'present', [], null, null, null, [
        leaf('brand', 0.95), leaf('unclassified', 0.2), leaf('unclassified', 0.1),
    ]);
    assert.ok('lowConfidence' in notes.conditions);
    assert.equal(notes.conditions.lowConfidence.effect, 'unknown');
});

test('a confident page stays quiet', () => {
    const notes = runNotes(clean({}), 'present', [], null, null, null, [leaf('brand', 0.95), leaf('routing', 0.9)]);
    assert.equal('lowConfidence' in notes.conditions, false);
});

test('a region nothing labelled is declared unmeasured, not absorbed', () => {
    const notes = runNotes(clean({}), 'present', [], null, null, null, [
        leaf('brand', 0.9, 800), {x: 0, y: 800, w: 1440, h: 400, label: {category: 'unclassified', confidence: 0, what: 'unlabelled region', cols: 1}},
    ]);
    assert.ok('unlabelledRegion' in notes.conditions);
    assert.equal(notes.conditions.unlabelledRegion.effect, 'unmeasured');
});

test('no leaves at all does not invent either condition', () => {
    const notes = runNotes(clean({}), 'present', [], null, null, null, null);
    assert.equal('lowConfidence' in notes.conditions, false);
    assert.equal('unlabelledRegion' in notes.conditions, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/notes.test.mjs`
Expected: FAIL — `lowConfidence` is not in `conditions`.

- [ ] **Step 3: Write the implementation**

In `tools/audit/lib/notes.mjs`, change the signature:

```javascript
export function runNotes(meta, reason = 'missing', rects = null, unpainted = null, blank = null, transparent = null, leaves = null) {
```

…and add, immediately before the closing `return {metaRead: true, conditions};`:

```javascript
    // WHAT THE MODEL WAS UNSURE ABOUT, which nothing else here can see: every other
    // condition is about the capture, and these two are about the reading of it.
    //
    // `unclassified` is never redistributed into the four categories. A percentage that
    // quietly absorbs our own uncertainty is exactly the confident wrong number this tool
    // exists to avoid, and the person reading the report is entitled to know how much of
    // their page we could not name.
    if (Array.isArray(leaves) && leaves.length) {
        const area = (l) => l.w * l.h;
        const total = leaves.reduce((a, l) => a + area(l), 0);
        const unsure = leaves.filter((l) => (l.label?.confidence ?? 0) < LOW_CONFIDENCE);
        const unsureShare = total > 0 ? unsure.reduce((a, l) => a + area(l), 0) / total : 0;
        if (unsureShare >= LOW_CONFIDENCE_SHARE) {
            add(
                'lowConfidence',
                'unknown',
                `${(unsureShare * 100).toFixed(1)}% of this page is in blocks the model was not confident `
                    + `about (below ${LOW_CONFIDENCE}). Those blocks are reported as unclassified and are not `
                    + 'shared out among the four categories',
                {share: Number(unsureShare.toFixed(4)), blocks: unsure.length, threshold: LOW_CONFIDENCE},
            );
        }

        const unlabelled = leaves.filter((l) => l.label?.what === 'unlabelled region');
        if (unlabelled.length) {
            const share = total > 0 ? unlabelled.reduce((a, l) => a + area(l), 0) / total : 0;
            add(
                'unlabelledRegion',
                'unmeasured',
                `${unlabelled.length} region${unlabelled.length === 1 ? '' : 's'} covering `
                    + `${(share * 100).toFixed(1)}% of the page fell between the blocks the model returned and `
                    + 'carries no label. It is reported as unmeasured rather than folded into a neighbour',
                {share: Number(share.toFixed(4)), blocks: unlabelled.length},
            );
        }
    }
```

…and add near the other constants at the top of the file:

```javascript
/** Below this, a block's category is a guess rather than a reading. */
export const LOW_CONFIDENCE = 0.5;

/** …and this much of a page being guesswork is worth saying out loud. */
export const LOW_CONFIDENCE_SHARE = 0.2;
```

- [ ] **Step 4: Pass the leaves in**

In `tools/audit/analyse.mjs`, change the `runNotes` call to:

```javascript
    const notes = runNotes(meta, 'present', rects, unpainted, blank, transparent, ls);
```

- [ ] **Step 5: Run the whole suite**

Run: `node --test tools/audit/test/*.mjs`
Expected: PASS, previous count plus 4.

- [ ] **Step 6: Commit**

```bash
git add tools/audit/lib/notes.mjs tools/audit/test/notes.test.mjs tools/audit/analyse.mjs
git commit -m "Say how much of a page the model could not confidently name"
```

---

## Task 8: Retire the segmenter

**Files:**
- Delete: `tools/audit/lib/xycut.mjs`, `tools/audit/segment.mjs`
- Delete: `tools/audit/test/xycut.test.mjs`, `bridge.test.mjs`, `landmarks.test.mjs`, `runs.test.mjs`, `lists.test.mjs`, `clusters.test.mjs`, `sparse.test.mjs`, `protection.test.mjs`, `headings.test.mjs`, `ink.test.mjs`, `stitch.test.mjs`, `segment-cli.test.mjs`
- Modify: `tools/audit/lib/edges.mjs`, `tools/audit/README.md`, `tools/audit/PROGRESS.md`

**Do this only once Task 5 has been run end to end on at least three real captures** and the debug images judged by eye. Until then the segmenter is the only working phase 2.

- [ ] **Step 1: Check nothing still imports it**

```bash
grep -rn "xycut.mjs" tools/audit/ --include=*.mjs
```

Expected: no output. If `painted.mjs` or anything else appears, stop and move what it needs into `candidates.mjs` first.

- [ ] **Step 2: Reduce edges.mjs to what survives**

`lib/painted.mjs` imports `MAX_IMAGE_HEIGHT` from `edges.mjs` and nothing else does. Replace the whole of `tools/audit/lib/edges.mjs` with:

```javascript
/**
 * EDGES
 *
 * What is left of the Canny edge map after the segmenter was retired.
 *
 * This file held greyscale, Sobel, non-maximum suppression and hysteresis, which existed
 * to find the near-empty runs an XY-cut splits on. Phase 2 no longer cuts on pixels, so
 * none of that has a caller. It is in git if it is ever wanted; see the plan at
 * docs/superpowers/plans/2026-09-19-homepage-audit-vision.md for why it went.
 *
 * The constant below outlived it because lib/painted.mjs decodes the same PNGs and needs
 * the same memory budget.
 */

/**
 * The tallest image worth decoding into raw pixels in one go.
 *
 * A budget, not a limit of the format: a 1440px-wide image this tall is about 70MB of
 * RGB. visionarygrid.studio, at 24,746px, is the page that needs the check.
 */
export const MAX_IMAGE_HEIGHT = 16384;
```

- [ ] **Step 3: Delete the segmenter and its tests**

```bash
git rm tools/audit/lib/xycut.mjs tools/audit/segment.mjs
git rm tools/audit/test/xycut.test.mjs tools/audit/test/bridge.test.mjs \
       tools/audit/test/landmarks.test.mjs tools/audit/test/runs.test.mjs \
       tools/audit/test/lists.test.mjs tools/audit/test/clusters.test.mjs \
       tools/audit/test/sparse.test.mjs tools/audit/test/protection.test.mjs \
       tools/audit/test/headings.test.mjs tools/audit/test/ink.test.mjs \
       tools/audit/test/stitch.test.mjs tools/audit/test/segment-cli.test.mjs
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test tools/audit/test/*.mjs`
Expected: PASS. The count drops sharply — that is the point. **Every remaining test must still pass; if one fails it was relying on the segmenter and needs its own fixture.**

- [ ] **Step 5: Update the README and PROGRESS**

In `tools/audit/README.md`, replace the `segment.mjs` and `lib/xycut.mjs` rows of the file table with:

```markdown
| `analyse.mjs` | Phases 2+3 CLI. Asks a vision model where the blocks are and what each is, and writes the partition. |
| `lib/vision.mjs` | The API call, one tile per request, and the validation of what comes back. |
| `lib/tiles.mjs` | Cutting a capture into tiles a model can read. |
| `lib/bands.mjs` | Boundaries snapped onto element edges and built into a true partition. |
| `lib/candidates.mjs` | The element edges a boundary may snap to. |
| `lib/signature.mjs` | Whether a page has changed since it was last audited. |
```

…and replace the "Gotchas" entry about `debug.png` with:

```markdown
- **The model cannot tell it was shown an incomplete page.** Run on boondmanager.com's
  pre-stitching capture, it named a 1,000px rectangle of flat colour "Dark solutions by
  profession" and returned 16 blocks instead of 21. Everything phase 1 does to make the
  capture complete, and everything `lib/notes.mjs` does to declare what is missing, is what
  makes the model's answer safe to use.
- **A page is audited once.** Three runs of one image gave block counts of 10, 11 and 11
  and put the largest block at 19.2%, 21.1% and 17.7%. `lib/signature.mjs` decides when a
  stored answer has stopped describing the site; `--force` overrides it.
```

In `tools/audit/PROGRESS.md`, move every open cutting defect to a closed section headed:

```markdown
## Retired with the segmenter

These were defects in `lib/xycut.mjs`, which no longer exists. They are kept because each
one names a page and a mechanism, and because two of them are the reason the approach
changed: kohde.agency declares no `<header>` and draws its headline as SVG paths, so no
rule reading markup or pixels could ever have reached either.
```

- [ ] **Step 6: Commit**

```bash
git add -A tools/audit/
git commit -m "Retire the segmenter

2,163 lines of xycut.mjs and the ten populations that decided where a cut could
land. Every rule was added for a real defect on a named page, and the last four
defects found were not rule bugs but interactions between rules: a list vetoing a
band boundary, a <nav> overruling the <ul>s inside it, a grid rule counting one
box four times because three divs shared its geometry.

Kept as history rather than as a fallback. Two answers and a rule for choosing
between them is the complexity this leaves behind."
```

---

## Task 9: Percentages, and whitespace as a measure

**Files:**
- Create: `tools/audit/lib/surface.mjs`
- Create: `tools/audit/test/surface.test.mjs`

**Interfaces:**
- Consumes: `leaves`, `totalArea` from `lib/blocks.mjs`; a tree from Task 4.
- Produces: `surfaceArea(root, viewportHeight): {full: Share[], firstViewport: Share[], coverage: number, unmeasured: number}` where `Share = {category, area, share, coverage}`.

**Whitespace is a measure across blocks, not a category of block** — the user's ruling, recorded during phase 2. Every block carries `coverage`: how much of its own area has ink in it. A client logo strip at 4% coverage is reported as "5% of the page, at 4% coverage", not silently counted as 5% of solid content.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/surface.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {surfaceArea} from '../lib/surface.mjs';

const leaf = (y, h, category, coverage = 0.5) => ({
    x: 0, y, w: 1000, h, depth: 1, children: [], coverage,
    label: {category, what: 'x', cols: 1, confidence: 0.9},
});
const tree = (children) => ({x: 0, y: 0, w: 1000, h: children.reduce((a, c) => a + c.h, 0), depth: 0, children});

test('shares are of the whole image and sum to one', () => {
    const {full} = surfaceArea(tree([leaf(0, 400, 'brand'), leaf(400, 600, 'routing')]), 900);
    const sum = full.reduce((a, s) => a + s.share, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `shares summed to ${sum}`);
    assert.equal(full.find((s) => s.category === 'brand').share, 0.4);
});

test('blocks of the same category are added together', () => {
    const {full} = surfaceArea(tree([leaf(0, 200, 'navigation'), leaf(200, 300, 'routing'), leaf(500, 300, 'navigation')]), 900);
    assert.equal(full.find((s) => s.category === 'navigation').share, 0.5);
});

test('the first viewport is measured separately and over its own area', () => {
    const {firstViewport} = surfaceArea(tree([leaf(0, 450, 'brand'), leaf(450, 1350, 'other')]), 900);
    assert.equal(firstViewport.find((s) => s.category === 'brand').share, 0.5);
});

test('a block straddling the fold counts only the part above it', () => {
    const {firstViewport} = surfaceArea(tree([leaf(0, 1800, 'brand')]), 900);
    assert.equal(firstViewport.find((s) => s.category === 'brand').share, 1);
});

test('unclassified is reported, never shared out', () => {
    const {full} = surfaceArea(tree([leaf(0, 500, 'brand'), leaf(500, 500, 'unclassified')]), 900);
    assert.equal(full.find((s) => s.category === 'unclassified').share, 0.5);
    assert.equal(full.find((s) => s.category === 'brand').share, 0.5);
});

/** The user's ruling: space is a measure across blocks, not a kind of block. */
test('each category carries how much of its area actually has ink', () => {
    const {full} = surfaceArea(tree([leaf(0, 500, 'routing', 0.04), leaf(500, 500, 'other', 0.6)]), 900);
    assert.equal(full.find((s) => s.category === 'routing').coverage, 0.04);
});

test('coverage across categories is area-weighted, not averaged', () => {
    const {coverage} = surfaceArea(tree([leaf(0, 900, 'routing', 0.1), leaf(900, 100, 'other', 0.9)]), 900);
    assert.ok(Math.abs(coverage - 0.18) < 1e-9, `got ${coverage}`);
});

test('a tree with no leaves does not divide by zero', () => {
    const empty = {x: 0, y: 0, w: 1000, h: 0, depth: 0, children: []};
    assert.doesNotThrow(() => surfaceArea(empty, 900));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/surface.test.mjs`
Expected: FAIL — `Cannot find module '../lib/surface.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/audit/lib/surface.mjs`:

```javascript
/**
 * SURFACE
 *
 * The number the report prints: how much of a homepage goes to each category.
 *
 *   node --test tools/audit/test/surface.test.mjs
 *
 * Two figures, because they answer different questions. The FULL PAGE is what the site
 * spends its space on; the FIRST VIEWPORT is what a visitor is given before they do
 * anything. A site can be 6% navigation overall and 31% navigation above the fold.
 *
 * WHITESPACE IS A MEASURE ACROSS BLOCKS, NOT A KIND OF BLOCK. That ruling came from the
 * client logo strip on klark.ai, which is 4% ink and 96% space: labelled "routing" and
 * counted by area alone, its whitespace silently becomes routing, while a "space" category
 * would only ever capture the blocks nobody labelled — an accident of where boundaries
 * fell. So every share carries its own `coverage`, and the report says both: "client
 * logos: 5% of the page, at 4% coverage".
 *
 * UNCLASSIFIED IS NEVER REDISTRIBUTED. A percentage that absorbs our own uncertainty is
 * the confident wrong number this tool exists to avoid.
 *
 * The limitation worth knowing: `coverage` needs each leaf to carry one, measured from the
 * pixels by lib/painted.mjs. A leaf without it counts as fully covered, which flatters a
 * sparse block — so analyse.mjs sets it on every leaf and this is only reachable by a
 * caller building a tree by hand.
 */
import {leaves} from './blocks.mjs';

const CATEGORY_ORDER = ['brand', 'navigation', 'routing', 'promotion', 'other', 'unclassified'];

const tally = (ls, total) => {
    const byCategory = new Map();
    for (const l of ls) {
        const a = l.area;
        if (a <= 0) continue;
        const key = l.label?.category ?? 'unclassified';
        const held = byCategory.get(key) ?? {area: 0, inked: 0};
        held.area += a;
        held.inked += a * (typeof l.coverage === 'number' ? l.coverage : 1);
        byCategory.set(key, held);
    }

    return CATEGORY_ORDER
        .filter((c) => byCategory.has(c))
        .map((category) => {
            const {area, inked} = byCategory.get(category);

            return {
                category,
                area,
                share: total > 0 ? area / total : 0,
                coverage: area > 0 ? inked / area : 0,
            };
        });
};

export function surfaceArea(root, viewportHeight) {
    const ls = leaves(root).filter((l) => l.w > 0 && l.h > 0);

    const whole = ls.map((l) => ({...l, area: l.w * l.h}));
    const total = whole.reduce((a, l) => a + l.area, 0);

    // A block straddling the fold contributes only the part above it, which is the only
    // reading that makes the first-viewport figure mean what it says.
    const above = ls
        .map((l) => {
            const h = Math.max(0, Math.min(l.y + l.h, viewportHeight) - l.y);

            return {...l, area: l.w * h};
        })
        .filter((l) => l.area > 0);
    const aboveTotal = above.reduce((a, l) => a + l.area, 0);

    const full = tally(whole, total);
    const unmeasured = full.find((s) => s.category === 'unclassified')?.share ?? 0;
    const inked = whole.reduce((a, l) => a + l.area * (typeof l.coverage === 'number' ? l.coverage : 1), 0);

    return {
        full,
        firstViewport: tally(above, aboveTotal),
        coverage: total > 0 ? inked / total : 0,
        unmeasured,
    };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test tools/audit/test/surface.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Give every leaf a coverage in analyse.mjs**

In `tools/audit/analyse.mjs`, after `const ls = leaves(root);` and inside the `if (rects.length)` block that already computes `measured`, add:

```javascript
        // Each leaf's own ink, for the whitespace measure. See lib/surface.mjs.
        for (const l of ls) l.coverage = Number(inkFraction(measured, l).toFixed(4));
```

…and add `inkFraction` to the existing import from `./lib/painted.mjs`.

- [ ] **Step 6: Commit**

```bash
git add tools/audit/lib/surface.mjs tools/audit/test/surface.test.mjs tools/audit/analyse.mjs
git commit -m "Measure each category's share, and how much of it is actually ink"
```

---

## Task 10: Sweep all 26, and judge it by eye

**Files:**
- Create: `tools/audit/sweep.mjs`
- Modify: `tools/audit/PROGRESS.md`

**This is the gate.** The corpus is the evaluation set: 26 sites whose debug images have already been reviewed by the person the tool is for. **Dispatch this task to a subagent if any task is dispatched — it is the one long live run.**

**Interfaces:**
- Consumes: `capture.mjs`, `analyse.mjs` as child processes.
- Produces: `sweep.json` and a printed table.

- [ ] **Step 1: Write the sweep**

Create `tools/audit/sweep.mjs`:

```javascript
#!/usr/bin/env node
/**
 * SWEEP
 *
 *   node tools/audit/sweep.mjs <urlsFile> <outRoot>
 *
 * Capture and analyse every URL in a file, one per line, and print one row each. The
 * corpus this was built against is 26 homepages whose debug images have been reviewed by
 * eye; re-running it after a change is how a regression is found before a prospect finds
 * it.
 *
 * THE TABLE IS NOT THE VERDICT. A block count moving in a plausible direction has
 * coincided with the wrong fix more than once on this project. Crop the region and look.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {leaves} from './lib/blocks.mjs';
import {noteCodes} from './lib/notes.mjs';

const run = promisify(execFile);
const [urlsFile, outRoot] = process.argv.slice(2);
if (!urlsFile || !outRoot) {
    console.error('usage: node tools/audit/sweep.mjs <urlsFile> <outRoot>');
    process.exit(1);
}

const urls = readFileSync(urlsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const slug = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/[^a-z0-9.]/gi, '-');

const rows = [];
printf('SITE', 'BLOCKS', 'UNCLASS', 'NOTES');
for (const url of urls) {
    const dir = join(outRoot, slug(url));
    const row = {url, dir, blocks: '-', unclassified: '-', notes: '-'};
    try {
        await run('node', ['tools/audit/capture.mjs', url, dir], {timeout: 300000, maxBuffer: 1 << 24});
        await run('node', ['tools/audit/analyse.mjs', dir], {timeout: 300000, maxBuffer: 1 << 24});
        const {notes, tree} = JSON.parse(readFileSync(join(dir, 'blocks.json'), 'utf8'));
        const ls = leaves(tree);
        const unclassified = ls.filter((l) => l.label?.category === 'unclassified')
            .reduce((a, l) => a + l.w * l.h, 0) / (tree.w * tree.h);
        row.blocks = ls.length;
        row.unclassified = `${(unclassified * 100).toFixed(1)}%`;
        row.notes = noteCodes(notes).join(',') || 'none';
    } catch (e) {
        const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        row.notes = (out.match(/(?:analysis|capture) failed: (.*)/) ?? [, 'failed'])[1].slice(0, 60);
        row.blocks = 'REFUSED';
    }
    rows.push(row);
    printf(slug(url), row.blocks, row.unclassified, row.notes);
}

writeFileSync(join(outRoot, 'sweep.json'), JSON.stringify(rows, null, 1));
const done = rows.filter((r) => typeof r.blocks === 'number');
console.log(`\n${done.length}/${rows.length} measured. Debug images: ${outRoot}/<slug>/debug.png`);

function printf(a, b, c, d) {
    console.log(`${String(a).padEnd(22)} ${String(b).padStart(7)}  ${String(c).padStart(8)}  ${d}`);
}
```

- [ ] **Step 2: Write the URL list**

```bash
cat > /tmp/audit-urls.txt <<'EOF'
https://www.visionarygrid.studio
https://www.liquidlight.co.uk
https://vaiie.com
https://milk.je
https://www.atkinsonsca.co.uk
https://clearleft.com
https://www.klark.ai
https://whitepaper.co.uk
https://www.jerseyfinance.com
https://kohde.agency
https://www.hsbc.co.uk
https://www.lloydsbank.com
https://www.natwest.com
https://www.boondmanager.com
https://dept.agency
https://andybudd.com
https://altumgroup.com
https://gcsc.gg
https://tpagency.com
https://www.hettich.co.uk
https://www.jtcgroup.com
https://alchemy.je
https://www.masonbreese.com
https://www.jersey.com
https://switch.je
https://www.pola.co.jp
https://www.bakerandpartners.com
EOF
```

- [ ] **Step 3: Run it**

Run: `node tools/audit/sweep.mjs /tmp/audit-urls.txt /tmp/audit-sweep`

Expected: roughly 20 minutes. Every site either measured or refused with a reason.

- [ ] **Step 4: Judge it by eye — this is the gate**

Open at least these, which are the cases that decided the approach:

```bash
open /tmp/audit-sweep/kohde.agency/debug.png       # header at y~160, case study at y~897
open /tmp/audit-sweep/natwest.com/debug.png        # three separate sections, not one
open /tmp/audit-sweep/andybudd.com/debug.png       # 3 cols on ONE block, not three blocks
open /tmp/audit-sweep/dept.agency/debug.png        # was the coordinate overrun; must now be clean
open /tmp/audit-sweep/visionarygrid.studio/debug.png  # 24,746px; the segmenter refused this outright
open /tmp/audit-sweep/boondmanager.com/debug.png   # the section that used to be blank
```

**Stop and fix before continuing if:** any page's blocks do not reach its full height; any label is plainly wrong; `unclassified` is above 20% anywhere; or `dept.agency` or `tpagency.com` overrun again, which would mean the tile-local coordinates did not take.

- [ ] **Step 5: Record it**

Replace the corpus section of `tools/audit/PROGRESS.md` with the new table, and add:

```markdown
## The evaluation set

27 homepages, captured and analysed, at `/tmp/audit-sweep/<slug>/`. Every change to the
prompt or the pipeline is measured against them, because their debug images have been
reviewed by the person the tool is for. A number moving is not evidence; the image is.
```

- [ ] **Step 6: Commit**

```bash
git add tools/audit/sweep.mjs tools/audit/PROGRESS.md
git commit -m "Sweep the whole corpus and record what it looks like"
```

---

## Task 11: The report

**Files:**
- Create: `tools/audit/report.mjs`
- Create: `tools/audit/test/report.test.mjs`

**Interfaces:**
- Consumes: `surfaceArea` (Task 9); `blocks.json`.
- Produces: `reportFor(blocksJson, viewportHeight): Report`; a CLI printing it.

`Report` is `{url, capturedAt, full: Share[], firstViewport: Share[], coverage, unmeasured, caveats: string[], headline: string}`.

- [ ] **Step 1: Write the failing test**

Create `tools/audit/test/report.test.mjs`:

```javascript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportFor} from '../report.mjs';

const leaf = (y, h, category, coverage = 0.5) => ({
    x: 0, y, w: 1440, h, depth: 1, children: [], coverage,
    label: {category, what: 'x', cols: 1, confidence: 0.9},
});
const doc = (children, notes = {metaRead: true, conditions: {}}) => ({
    notes,
    tree: {x: 0, y: 0, w: 1440, h: children.reduce((a, c) => a + c.h, 0), depth: 0, children},
});

test('the headline names the four categories and their shares', () => {
    const r = reportFor(doc([leaf(0, 900, 'brand'), leaf(900, 900, 'navigation'),
        leaf(1800, 900, 'routing'), leaf(2700, 900, 'promotion')]), 900);
    assert.match(r.headline, /brand/);
    assert.match(r.headline, /25(\.0)?%/);
});

test('every note with an effect becomes a caveat a reader sees', () => {
    const notes = {metaRead: true, conditions: {
        webglBlind: {effect: 'unmeasured', message: 'a canvas could not be read', facts: {}},
    }};
    const r = reportFor(doc([leaf(0, 900, 'other')], notes), 900);
    assert.equal(r.caveats.length, 1);
    assert.match(r.caveats[0], /canvas could not be read/);
});

test('a capture whose provenance could not be read says so first', () => {
    const r = reportFor(doc([leaf(0, 900, 'other')], {metaRead: false, conditions: {}}), 900);
    assert.match(r.caveats[0], /could not be checked/);
});

test('unclassified area is reported as its own line, not folded away', () => {
    const r = reportFor(doc([leaf(0, 900, 'brand'), leaf(900, 900, 'unclassified')]), 900);
    assert.equal(r.unmeasured, 0.5);
    assert.ok(r.full.some((s) => s.category === 'unclassified'));
});

test('a sparse block is reported with its coverage, not as solid content', () => {
    const r = reportFor(doc([leaf(0, 900, 'routing', 0.04)]), 900);
    assert.equal(r.full.find((s) => s.category === 'routing').coverage, 0.04);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools/audit/test/report.test.mjs`
Expected: FAIL — `Cannot find module '../report.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/audit/report.mjs`:

```javascript
#!/usr/bin/env node
/**
 * PHASE 4 — REPORT
 *
 *   node tools/audit/report.mjs <outDir>
 *
 * Turns a blocks.json into the thing a prospect reads: what share of their homepage goes
 * to brand, navigation, routing and promotion, above the fold and over the whole page.
 *
 * EVERY CAVEAT TRAVELS WITH THE NUMBER. The notes are not debug output; they are the
 * difference between a measurement and a claim. A page with a canvas the capture could not
 * read, or a region the model would not name, gets a figure AND the sentence saying what
 * the figure does not cover — because the person reading it owns the site and will know.
 *
 * The limitation worth knowing: this reports one capture at one width. A homepage that
 * reorganises itself on a phone is a different page and is not measured here.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {surfaceArea} from './lib/surface.mjs';
import {printable} from './lib/printable.mjs';

const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function reportFor(doc, viewportHeight) {
    const {notes, tree} = doc;
    const {full, firstViewport, coverage, unmeasured} = surfaceArea(tree, viewportHeight);

    const caveats = [];
    if (!notes?.metaRead) {
        caveats.push('how this page was captured could not be checked, so nothing here is guaranteed to '
            + 'describe the page that was asked for');
    }
    for (const [, c] of Object.entries(notes?.conditions ?? {})) caveats.push(c.message);

    const named = full.filter((s) => s.category !== 'other' && s.category !== 'unclassified');
    const headline = named.length
        ? named.map((s) => `${s.category} ${pct(s.share)}`).join(', ')
        : 'nothing on this page classified as brand, navigation, routing or promotion';

    return {url: doc.url ?? null, full, firstViewport, coverage, unmeasured, caveats, headline};
}

const outDir = process.argv[2];
if (outDir) {
    try {
        const doc = JSON.parse(readFileSync(join(outDir, 'blocks.json'), 'utf8'));
        const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
        const r = reportFor({...doc, url: meta.url}, meta.viewport?.height ?? 900);

        console.log(`\n${printable(meta.url)}`);
        console.log(`captured ${meta.capturedAt}\n`);
        console.log('                    whole page        first viewport');
        for (const s of r.full) {
            const fv = r.firstViewport.find((f) => f.category === s.category);
            console.log(`  ${s.category.padEnd(14)} ${pct(s.share).padStart(7)} @ ${pct(s.coverage).padStart(6)} ink`
                + `   ${fv ? pct(fv.share).padStart(7) : '      -'}`);
        }
        console.log(`\n  ${r.headline}`);
        if (r.caveats.length) {
            console.log('\nwhat this does not cover:');
            for (const c of r.caveats) console.log(`  - ${printable(c, 300)}`);
        }
    } catch (e) {
        console.error(`report failed: ${printable(e.message, 300)}`);
        process.exit(1);
    }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test tools/audit/test/report.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Read one for real**

```bash
node tools/audit/report.mjs /tmp/audit-sweep/kohde.agency
```

Expected: a table, a headline sentence, and any caveats. **Read it as the person whose site it is.** If a number would provoke "that's not right", the argument has to be answerable from `debug.png` — that is the whole design.

- [ ] **Step 6: Commit**

```bash
git add tools/audit/report.mjs tools/audit/test/report.test.mjs
git commit -m "Print the report a prospect reads, caveats and all"
```

---

## Review gate

Stop here before phase 4's delivery layer.

- Read three reports as the site's owner. Is every number defensible from `debug.png`?
- Is `unclassified` small enough to be credible, and reported honestly where it is not?
- Does the first-viewport figure differ from the whole-page one in the way you expected?

**The Craft queue job, the signup flow and the email are a separate plan.** They need answers this one deliberately does not have: what happens when a prospect's CDN blocks the crawler (three of 26 sites did), what the email says when a page is 30% unclassified, and who pays for a re-audit. Those are product decisions, not implementation ones.

---

## Self-Review

**Spec coverage.** Phase 1: untouched, by design (Context). Phase 2: Tasks 1–6, 8. Phase 3 (classification): folded into Task 3's prompt and Task 7's confidence notes, with the original plan's Judgement call 1 category definitions copied verbatim into `TILE_PROMPT`. Phase 4: Tasks 9 and 11, with delivery explicitly deferred at the review gate. The determinism constraint the original plan set is replaced in Context and implemented in Task 6. The whitespace ruling is implemented in Task 9.

**Placeholders.** None. Every code step carries the code. Task 8's deletions name every file.

**Type consistency.** `TileBlock` is produced by `parseTileReply` (Task 3) and consumed by `mergeSeams` and `buildTree` (Task 4) with the same six fields. `Block.label` is written by `buildTree` (Task 4), read by `debug.mjs` (Task 5), `runNotes` (Task 7) and `surfaceArea` (Task 9) with the same four fields. `leaf.coverage` is set in Task 9 Step 5 and read by `surfaceArea`. `edgeCandidates(rects, horizontal)` keeps its phase-2 signature through the move in Task 1.

**One gap accepted knowingly:** `vision.json` grows a `signature` field in Task 6 that Task 5 does not write. Task 6 Step 5 replaces the whole write, so no run produces a file without it.
