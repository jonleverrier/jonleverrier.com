/**
 * XY-CUT
 *
 * Density profiles, gutter finding, and the recursive partition (`segment`) that
 * turns an edge map into a tree of blocks. `segmentTall` extends that to pages
 * taller than one capture viewport, by tiling and stitching.
 *
 *   node --test tools/audit/test/xycut.test.mjs
 *
 * A gutter is a run of rows or columns, spanning the full width or height of the
 * CURRENT REGION, whose edge density is near zero. minRun exists because line
 * spacing is also a near-zero run: without it, every paragraph cuts into separate
 * lines and the tree is meaningless.
 *
 * A gutter says a boundary is somewhere in this run; it does not say where. The
 * boundary is at the EDGE of the whitespace, where an element actually stops, so
 * `opts.rects` (phase 1's DOM rects) snaps each cut onto a real element edge inside
 * the run. The same rects also say where NOT to cut: some things are ONE visual module
 * however the pixels look, and a cut may not land strictly inside one. Several
 * populations earn that, chosen by different rules and rejected by the same one — a
 * full-bleed `<video>`, `<img>` or `<canvas>` whose interior is only noise (FULL_BLEED);
 * ANY media element big enough for a cut to land in, for that same reason at a smaller
 * size (mediaModules); a module container: a card, a header, a testimonial box, whose
 * interior gaps are its own padding (MODULE_AREA); a RUN OF REPEATED SIBLINGS — a card
 * grid, a nav bar, a list of links — because every member of one takes the same label, so
 * cutting them apart changes no answer (REPEAT); a heading,
 * shrunk to the groups of ink it holds (inkedTextRects, inkClusters); and a RUN OF TEXT,
 * which is a line assembled from several elements (TEXT_RUN). See protectedRects, textRuns
 * and cutsInsideProtected. One thing is excluded from all of it: an element that leaves
 * the page in both directions at once is the page's BACKDROP rather than a module on it,
 * whatever its tag or its size says (isBackdrop).
 * Rects are OPTIONAL throughout — without them every cut falls back to the gutter
 * midpoint, nothing is protected, and the pure-pixel path still works exactly as it did.
 *
 * ONE POPULATION GOES THE OTHER WAY, and it is the only one that does: the page's own
 * `<header>` and `<footer>` (pageLandmarks). Those are boundaries rather than things to
 * keep whole, because brand and navigation are two of the four categories this tool
 * exists to measure, so a landmark's own edge outranks the protections drawn over it and
 * outranks the size floor. Never the words.
 *
 * `segment` is the reason this file exists: the block tree it produces is a TRUE
 * PARTITION at every level. See segment's own doc comment for why that is the
 * measurement, not a tidiness detail.
 *
 * The limitation worth knowing: rects are matched by COORDINATE ONLY. A cut snaps to
 * whichever content edge sits nearest the gutter's midpoint, with no idea which
 * element it belongs to, so on a page whose elements do not align to its visual
 * structure the snap is no better than the midpoint — it is never worse, because the
 * candidate is always inside the gutter the pixels already chose.
 */

import {leaves} from './blocks.mjs';

/**
 * What counts as a gutter.
 *
 * `maxDensity` is a FLOOR, not the threshold. The real threshold is relative to the
 * region being cut — see adaptiveMaxDensity, and the reason it has to be.
 */
export const GUTTER = {
    minRun: 8,
    maxDensity: 0.005, // the floor: an all-but-empty region still needs a real answer
    relative: 0.1, // …otherwise a tenth of the region's own median density
    ceiling: 0.05, // and never more than this, however dense the region gets
};

/**
 * The density below which a row or column counts as empty, scaled to the region.
 *
 * AN ABSOLUTE THRESHOLD CANNOT SEE A GUTTER SOMETHING IS DRAWN ACROSS, and that is
 * common enough to have broken a real page. On switch.je a decorative curve loops
 * through the 96px gap between the hero CTAs and the first case study; those rows run
 * 0.010–0.028 against a 0.005 threshold, so the gap is disqualified and a CTA pair and a
 * case-study card end up in one block. The same happens under any textured background,
 * watermark, or full-bleed pattern.
 *
 * But the gap IS obviously a gutter — it is about 16x quieter than the content either
 * side of it (median 0.136 there). So compare against the region rather than a constant.
 *
 * The median, not the mean: a region that is half whitespace drags a mean down until the
 * threshold is meaningless, whereas the median tracks what "busy" looks like HERE.
 *
 * A tenth of it, measured rather than picked. On that switch.je region 5% finds nothing,
 * 10% finds exactly the two gaps a person would point at, and 15% starts slicing between
 * the two CTA buttons — over-cutting a single row of controls.
 *
 * The floor keeps an almost-empty region sane (a tenth of ~0 is ~0, which would find no
 * gutters at all) and preserves the old behaviour wherever the old behaviour was right.
 * The ceiling stops a very dense region from calling half its content a gutter.
 */
export function adaptiveMaxDensity(density, opts = GUTTER) {
    const {maxDensity, relative, ceiling} = {...GUTTER, ...opts};
    if (density.length === 0) {
        return maxDensity;
    }
    // Float32Array.prototype.sort is numeric by default — no comparator needed, and it
    // avoids materialising a normal array on every recursion.
    const sorted = density.slice().sort();
    const median = sorted[Math.floor(0.5 * (sorted.length - 1))];

    return Math.min(ceiling, Math.max(maxDensity, relative * median));
}

export function rowDensity(edges, width, rect) {
    const out = new Float32Array(rect.h);
    for (let y = 0; y < rect.h; y++) {
        let on = 0;
        const base = (rect.y + y) * width + rect.x;
        for (let x = 0; x < rect.w; x++) on += edges[base + x];
        out[y] = on / rect.w;
    }

    return out;
}

export function colDensity(edges, width, rect) {
    const out = new Float32Array(rect.w);
    for (let x = 0; x < rect.w; x++) {
        let on = 0;
        for (let y = 0; y < rect.h; y++) on += edges[(rect.y + y) * width + rect.x + x];
        out[x] = on / rect.h;
    }

    return out;
}

/**
 * Runs of at least minRun that stay quiet. `end` is exclusive.
 *
 * "Quiet" is relative to this region by default (see adaptiveMaxDensity). Pass
 * `adaptive: false` to compare against `maxDensity` flat — the unit tests do, so that
 * they assert the run-finding rather than the thresholding.
 */
export function findGutters(density, opts = GUTTER) {
    const {minRun} = {...GUTTER, ...opts};
    const maxDensity = opts.adaptive === false
        ? {...GUTTER, ...opts}.maxDensity
        : adaptiveMaxDensity(density, opts);
    const runs = [];
    let start = -1;
    for (let i = 0; i <= density.length; i++) {
        const quiet = i < density.length && density[i] <= maxDensity;
        if (quiet && start < 0) start = i;
        if (!quiet && start >= 0) {
            if (i - start >= minRun) runs.push({start, end: i});
            start = -1;
        }
    }

    return runs;
}

/**
 * A rect worth snapping to: an element that carries content, not the page scaffolding
 * around it. Page-level wrappers span the whole document, so their edges coincide with
 * the page's own extremes and with every tile's frame — left in, they are by far the
 * most numerous candidates near a cut and they mark nothing. Hairlines and icons are
 * excluded for the opposite reason: too many of them, too small to be a section break.
 *
 * These are the same thresholds the cut-accuracy metric scores against, deliberately:
 * snapping to a population the metric does not count would be marking its own homework.
 */
export const CONTENT_RECT = {maxH: 700, minW: 60, minH: 12};

export function isContentRect(r) {
    return r.h < CONTENT_RECT.maxH && r.w >= CONTENT_RECT.minW && r.h >= CONTENT_RECT.minH;
}

/**
 * Candidate cut coordinates on one axis: every content rect's leading and trailing
 * edge, sorted ascending and de-duplicated.
 *
 * Sorted is not cosmetic. `snapToEdge` scans in order and keeps the first of an equal
 * pair, which is what makes a tie resolve to the smaller coordinate no matter what
 * order rects.json happened to list its elements in.
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

/**
 * How far outside a gutter a MODULE BOUNDARY may sit and still be reachable, in pixels.
 *
 * THE VISUAL LINE THAT MAKES A HEADER READ AS A SEPARATE BLOCK IS WHAT STOPPED IT BEING
 * CUT AS ONE. A divider rule under a header is content — one row of it, at a density no
 * threshold will call quiet — so it splits the whitespace around it into two gutters and
 * sits between them along with the boundary everyone can see. On hsbc.co.uk the `<nav>`
 * ends at y=118, the gutters are 98-117 and 121-139, and 118 is in neither of them:
 *
 *   y=116  0.0000  quiet
 *   y=117  0.4139  the divider rule
 *   y=118  0.0000  the header's true bottom edge
 *   y=119  0.5833  the hero starting
 *
 * natwest.com is the same shape one pixel tighter: gutter 100-110, rule at 110, the
 * header's bottom edge at 111. Both headers came out merged into the hero. kohde.agency
 * stacks two full-bleed 1440x900 videos and is the same defect again with no border at
 * all — row 899 is the colour step from the dark hero to the light panel, and the seam
 * at y=900 is the only cut that band legally has. jtcgroup.com puts a 1px gap between
 * gutters of 86 and 86 at the boundary of two `<section>`s. Four pages, four causes, one
 * shape: the seam is a pixel or two outside a substantial gutter that points straight
 * at it.
 *
 * WHAT MAY BE BRIDGED TO IS A SEAM: one module ends there, the next begins there, and
 * this gutter is the whitespace of one of the two. Both halves were measured into
 * existence. Reaching for any module edge near any gutter moved both fixtures at once
 * (jonleverrier 12 leaves to 17, retail 23 to 33), because a page margin sits one pixel
 * from the header's side edges and every margin became a cuttable sliver; requiring only
 * that the gutter be inside the module still took two strips off retail, at edges where
 * nothing else begins. A seam is the one shape where the pixels, the DOM and the eye all
 * agree there is a boundary.
 *
 * THE TOLERANCE IS MEASURED AND THE MEASUREMENT IS FLAT. Every instance found needs
 * exactly 1px — the seam is the row after the gutter's last, with one rule or one colour
 * step in between — and ten pages (both fixtures, hsbc, natwest, kohde, jtcgroup,
 * switch.je, boondmanager, klark, clearleft, lloydsbank) segment IDENTICALLY at every
 * value from 1 to 24. Nothing anywhere is balanced on this number, because what bounds
 * the rule is the seam condition and not the distance: widening the reach finds no
 * further seams because there are none to find. 2 is taken because a 2px rule is real —
 * retail draws one at y=3443-3444 — and because reaching no further than the evidence
 * is the cheapest kind of caution.
 *
 * SCOPED DELIBERATELY NARROWLY. Promoting every container edge to a cut line was tried
 * and reverted: switch.je went from 43 leaves to 116 and jonleverrier from 12 to 56. This
 * reaches one coordinate per gutter, only where two modules meet, and switch.je is
 * unchanged at every tolerance above.
 */
export const MODULE_BRIDGE = 2;

/**
 * Where to cut inside gutter `g`, returned in `g`'s own index space (offsets from the
 * region's origin, which is what `segment` builds children from).
 *
 * `candidates` are absolute coordinates in the segmented image's space, so `origin` —
 * the region's x or y — converts between the two. The chosen candidate is the one
 * NEAREST THE MIDPOINT, not the first in the run: nearest-to-midpoint is unbiased,
 * deterministic, and by construction cannot leave the gutter. With no candidate in
 * range the midpoint stands.
 *
 * BRIDGING IS OFF UNLESS THE CALLER SUPPLIES BOTH `opts.extent` AND `opts.spans`, and
 * each is a different half of the safety:
 *
 *   - `extent` is the region's size on this axis. A bridged cut is the one kind that
 *     lands outside the gutter, so it is the one kind that could reach the region's own
 *     frame and hand `segment` a child of zero height.
 *   - `spans` maps a coordinate to the modules it is an edge of, as [start, end] pairs
 *     on this axis (see edgeSpans), and is what enforces the rule above MODULE_BRIDGE.
 *
 * A caller that supplies neither gets exactly the behaviour this had before bridging.
 */
export function snapToEdge(g, candidates, origin, preferred = null, opts = {}) {
    const mid = (g.start + g.end) >> 1;
    const {bridge = MODULE_BRIDGE, extent = null, spans = null, landmarks = null} = opts;
    const bridging = extent !== null && spans !== null && bridge > 0;
    // NOT "no candidates, so the midpoint": the bridged population is a different list,
    // and a page whose only protected modules are taller than CONTENT_RECT allows has no
    // ordinary candidates at all. Two stacked full-bleed videos are exactly that page.
    if ((!candidates || candidates.length === 0) && !bridging) return mid;

    const lo = origin + g.start;
    const hi = origin + g.end;
    const absMid = origin + mid;

    /**
     * May a cut bridge out of this gutter to land on `c`?
     *
     * ONE MODULE ENDS THERE, THE NEXT BEGINS THERE, AND THIS GUTTER IS THE WHITESPACE OF
     * ONE OF THEM — the rule stated above MODULE_BRIDGE, and each half of it is carrying
     * a page. Without "the gutter belongs to one of them", a module's padding reaches
     * out past its own edge and the page margin beside it becomes a block: that moved
     * jonleverrier from 12 leaves to 17. Without "two modules meet here", a lone edge
     * across a rule becomes a cut, which took two more strips off the retail fixture.
     * Together they describe one thing only: the seam between two stacked modules, with
     * the rule that draws it in the way.
     */
    const isASeam = (c) => {
        const here = spans.get(c) ?? [];
        const ours = here.some(([s, e]) => (s === c || e === c) && s <= lo && hi <= e);

        return ours && here.some(([, e]) => e === c) && here.some(([s]) => s === c);
    };

    // A MODULE'S OWN BOUNDARY BEATS A NEARER ELEMENT EDGE. Both are real edges, but one
    // of them ends a module and the other merely ends some element inside the next one,
    // and a gutter wide enough to hold both is exactly where that distinction decides
    // the block. On jonleverrier the gutter below the header runs 115-307: its midpoint
    // is 211, the header's bottom edge is at 116 and the headline's top at 288, so
    // nearest-to-midpoint chose 288 by 18px and handed the header 170px of empty olive.
    let best = null;
    let bestDistance = Infinity;
    let bestPreferred = null;
    let bestPreferredDistance = Infinity;
    // AN ORDINARY ELEMENT EDGE IS ONLY EVER TAKEN FROM INSIDE THIS GUTTER, so no such cut
    // moves outside the whitespace the pixels chose.
    for (const c of candidates ?? []) {
        if (c < lo) continue;
        if (c > hi) break;
        const d = Math.abs(c - absMid);
        if (d < bestDistance) {
            bestDistance = d;
            best = c;
        }
        if (preferred !== null && preferred.has(c) && d < bestPreferredDistance) {
            bestPreferredDistance = d;
            bestPreferred = c;
        }
    }
    // A SEAM JUST OUTSIDE THE GUTTER IS ITS OWN CANDIDATE POPULATION, taken from the
    // protected modules themselves rather than from `candidates`, because the edge that
    // matters is regularly not in `candidates` at all: kohde.agency stacks two 1440x900
    // videos, and CONTENT_RECT excludes anything 700px or taller, so the seam at y=900 —
    // the only cut that band legally has — was never offered. The sort keeps the choice
    // independent of the order rects.json happened to list its elements in.
    //
    // A PAGE LANDMARK'S OWN BOUNDARY IS REACHABLE ON THE SAME TERMS AND WITHOUT THE SEAM,
    // because nothing has to begin where a header ends for that edge to be a boundary.
    // See pageLandmarks for why that population can be reached from either side when the
    // module population cannot.
    if (bridging) {
        const reachable = landmarks === null
            ? [...spans.keys()]
            : [...new Set([...spans.keys(), ...landmarks])];
        for (const c of reachable.sort((p, q) => p - q)) {
            if (c < lo - bridge || c > hi + bridge) continue;
            if (c >= lo && c <= hi) continue;
            // The region's own frame is no longer out of reach, and a cut there would
            // hand `segment` a child of zero height.
            if (c - origin <= 0 || c - origin >= extent) continue;
            if (!isASeam(c) && !(landmarks !== null && landmarks.has(c))) continue;
            const d = Math.abs(c - absMid);
            if (d < bestPreferredDistance) {
                bestPreferredDistance = d;
                bestPreferred = c;
            }
        }
    }
    const chosen = bestPreferred !== null ? bestPreferred : best;

    return chosen === null ? mid : chosen - origin;
}

/**
 * A full-bleed media element is ONE visual module and must not be cut open.
 *
 * A photograph or a blurred video has no gutters, only noise: rows and columns whose
 * density happens to dip. On the retail fixture a 1440x698 hero `<video>` was sliced
 * into four leaves at y=201, 335, 472 and 771, and two of those boundaries were the
 * page's worst cut-accuracy outliers (134px and 271px from the nearest real element
 * edge). Nothing on the page is there.
 *
 * It matters past tidiness: one module arriving as four blocks can collect four
 * different labels from the vision model downstream, so the same hero would be counted
 * as brand AND navigation AND content in one report.
 *
 * The gates are deliberately narrow. NARROWER OR SHORTER MEDIA IS ORDINARY CONTENT: a
 * 400px product photo sits inside a grid that must still be cuttable, and a full-width
 * 120px banner is a strip, not a module. Only something spanning nearly the whole width
 * AND tall enough to be a section earns the protection.
 */
/**
 * NOT `svg`. A photograph or a video IS the module — opaque content whose interior holds
 * no structure to find. A page-scale SVG is a decorative flourish drawn OVER the content,
 * and protecting it protects everything beneath it: switch.je draws a 1440x810 curve
 * starting at y=-76, above the page, across its header, headline, buttons and first two
 * case studies. Treating that as a hero merged all of them into one block.
 */
export const MEDIA_TAGS = new Set(['video', 'img', 'canvas', 'picture']);
export const FULL_BLEED = {widthFraction: 0.9, minH: 200};

/** The rects a cut may not pass through. Empty without rects — they are never required. */
export function fullBleedMedia(rects, width, opts = FULL_BLEED) {
    if (!rects || rects.length === 0) return [];
    const {widthFraction, minH} = {...FULL_BLEED, ...opts};

    return rects.filter((r) => MEDIA_TAGS.has(r.tag) && r.w >= widthFraction * width && r.h >= minH);
}

/**
 * A MEDIA ELEMENT IS ONE MODULE AT ANY SIZE A CUT COULD LAND IN, because its interior is
 * not layout.
 *
 * FULL_BLEED answers this for a hero — something spanning the page is one thing — and says
 * nothing about the same photograph at a third of the width. dept.agency puts a 571x714
 * soft-focus photograph beside a paragraph; the blurred colour fires the edge map
 * irregularly, `adaptiveMaxDensity` reads the quiet patches as gutters, and that one
 * picture came back as THIRTEEN blocks, not one of which is a thing on the page. Phase 3
 * would then be asked to label the same photograph thirteen times.
 *
 * A CARD'S INTERIOR IS CONTENT WITH REAL GAPS; A PHOTOGRAPH'S IS NOISE — and the tag is
 * the measurement of that, not a proxy for it. `img`, `video`, `canvas` and `picture` hold
 * pixels and nothing else, so a quiet run found inside one is by construction not a
 * boundary between two modules: there is nothing in there to be on either side of it. The
 * populations either side of this one are selected by evidence that only makes sense for a
 * container — `boxed`, a semantic tag, a containment test — and none of that evidence
 * exists for a picture.
 *
 * SIZED BY THE SAME BAND AS EVERY OTHER MODULE, deliberately, rather than a fourth number.
 * MODULE_AREA already says how big a thing has to be before it is a module here and how
 * big is too big to be one. dept's photograph is 2.08% of its page, comfortably inside it.
 * Below the floor a media element is an icon or an avatar and no cut can land inside it
 * anyway — `minSide` is 120px. Above the ceiling it is the page's own backdrop, which
 * FULL_BLEED and `isBackdrop` are the rules for. The cost is stated rather than hidden: a
 * picture between 12% of the page and 90% of its width gets nothing from any of the three.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is stop a grid being cut into cards. A cut on a
 * protected element's own EDGE is always legal — see cutsInsideProtected — and a product
 * grid's gutters run between its photographs, never through one. The 400px product photo
 * FULL_BLEED's comment promises to leave cuttable is still cuttable in the only sense that
 * mattered: the grid around it still cuts.
 */
export function mediaModules(rects, width, pageHeight, opts = MODULE_AREA) {
    if (!rects || rects.length === 0) return [];
    const {min, max} = {...MODULE_AREA, ...opts};
    const pageArea = width * pageHeight;

    return rects.filter((r) => {
        if (!MEDIA_TAGS.has(r.tag)) return false;
        const a = r.w * r.h;

        return a >= min * pageArea && a <= max * pageArea;
    });
}

/**
 * AN ELEMENT THAT LEAVES THE PAGE IN BOTH DIRECTIONS AT ONCE IS A BACKDROP, NOT A MODULE.
 *
 * A module is inside the page. A backdrop is the thing the page is drawn on, and the
 * difference is structural rather than a matter of size: no threshold is involved and none
 * is wanted. gcsc.gg is the page that found it. It stacks six decorative `<img>` elements
 * at -319,-274 1606x1569, 192,-394 1492x1457 and four more of the same shape — each larger
 * than the viewport, each hanging off the top and one side — and every one of them passes
 * the full-bleed test. Between them they blanket the top 1,482px, `cutsInsideProtected`
 * refuses every cut underneath, and the header, the hero and the featured area arrived as
 * ONE block. Three of the four things this tool exists to measure were in it.
 *
 * HORIZONTALLY AND VERTICALLY, not merely on two sides, and the difference is a real page
 * rather than pedantry. Overflowing on one side is ordinary: a hero cropped by
 * `overflow: hidden`, a sticky panel hanging off the bottom, an off-canvas menu to the
 * left of everything. Overflowing on BOTH HORIZONTAL sides is just as ordinary and is the
 * commonest full-bleed hero there is — a 1600px image centred in a 1440px page starts at
 * x=-80 and ends at 1520, and calling that a backdrop would strip the protection
 * FULL_BLEED exists to give it. What no laid-out module does is leave the page in both
 * directions at once. Measured over the 30 captured pages and both fixtures: 27 protected
 * rects overflow on exactly one side and are untouched; eight overflow both horizontally
 * and vertically; and all eight are decoration — gcsc's six backdrop images, and
 * andybudd's two 306x306 dot patches at -115,-101 and -299,-101.
 *
 * `offsetY` IS NOT OPTIONAL POLISH. The test is meaningless in a tile's coordinate space,
 * where every element above the tile has a negative y and the page's own bottom is 900px
 * down, so `segment` is told where the slice it was handed sits in the page. Get it wrong
 * and a full-width hero becomes a backdrop in every tile below it, silently.
 *
 * IT DOES NOT REPLACE THE `svg` EXCLUSION IN MEDIA_TAGS, and the measurement says so
 * plainly: switch.je's decorative curve — the page that exclusion exists for — is
 * 0,-76 1440x810, which leaves the page on exactly ONE side. Two different shapes of
 * decoration, two rules, and neither subsumes the other.
 */
export function isBackdrop(r, width, pageHeight, offsetY = 0) {
    const top = r.y + offsetY;

    return (r.x < 0 || r.x + r.w > width) && (top < 0 || top + r.h > pageHeight);
}

/**
 * A MODULE CONTAINER IS ONE BLOCK, and the gaps inside it are its own padding.
 *
 * The segmenter cuts on whitespace, and the gap between a quote and its attribution
 * looks exactly like the gap between two modules — so a testimonial card came out as
 * several blocks with the quote split across two of them, and a vertical gutter between
 * a logo and the nav beside it cut the header in half. Counting a card's padding as
 * space between modules is what makes the surface-area number wrong, and it is also
 * what hands phase 3 half a paragraph to label.
 *
 * Three gates, all of which must hold:
 *
 *   1. It draws its own box (`boxed`, from phase 1: a background differing from its
 *      parent's, a border, or a radius) OR its tag says it is a module outright.
 *   2. Its area is a real fraction of the page. Below MODULE_AREA.min it is a chip or a
 *      button, not a module. Above MODULE_AREA.max it is a page section or the page:
 *      switch.je has a `<header>` of 1440x1700 wrapping its whole hero, and protecting
 *      that would suppress nearly every cut on the page.
 *   3. It contains no other candidate. The INNERMOST box is the module — a section
 *      holding two testimonial cards is not itself a card.
 *
 * The band is wide on purpose: 0.5-15%, 0.5-10% and 1-12% all pick exactly the same
 * seven containers on switch.je, so nothing here is balanced on a threshold.
 *
 * Containment is geometric, computed from the rect list. Phase 1 deliberately does not
 * report the DOM tree, and reconstructing one from rects would be guesswork.
 *
 * The limitation worth knowing: TWO CANDIDATES SHARING ONE BOX CANCEL EACH OTHER OUT,
 * because each contains the other. M&S wraps its primary nav in a `<div>` of exactly the
 * `<nav>`'s size, so neither is protected and a cut at y=143 does still land inside that
 * 40px strip. That is the literal reading of gate 3 and it is the reading the rule was
 * measured against — retail has seven containers under it, eight if coincident boxes are
 * folded into one. Folding them is the obvious alternative and is stated here rather
 * than taken, because it was not what the thresholds were verified with.
 */
export const MODULE_TAGS = new Set(['header', 'nav', 'article', 'figure']);
export const MODULE_AREA = {min: 0.005, max: 0.12};

/** Does `outer` cover every pixel of `inner`? Equal boxes contain each other. */
function containsRect(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w
        && inner.y + inner.h <= outer.y + outer.h;
}

/**
 * The module containers in `rects`, in the order phase 1 listed them.
 *
 * `pageHeight` is the WHOLE PAGE's height, not the height of whatever slice is being
 * segmented: gate 2 is a fraction of the page, and a tile that measured against its own
 * 900px would call a 640x546 card 27% of "the page" and refuse to protect it. Empty
 * without rects, and empty for an older capture whose rects carry no `boxed` field
 * unless a semantic tag qualifies them — the field is never required.
 */
export function moduleContainers(rects, width, pageHeight, opts = MODULE_AREA) {
    if (!rects || rects.length === 0) return [];
    const {min, max} = {...MODULE_AREA, ...opts};
    const pageArea = width * pageHeight;

    const candidates = rects.filter((r) => {
        if (r.boxed !== true && !MODULE_TAGS.has(r.tag)) return false;
        // A FULL-WIDTH BOX THAT ONLY DRAWS A BACKGROUND IS A BAND, NOT A MODULE.
        //
        // Nearly everything this population keeps whole is INSET — a card, a testimonial
        // box — sitting in the page with room either side, its interior gaps its own
        // padding. A box reaching both page edges is usually the thing those sit IN, and
        // protecting it forbids every cut BETWEEN the modules it holds.
        //
        // vaiie.com is the case. Its footer wrapper is `div 0,2795 1440x394`, 12.0% of
        // the page and so a module by area, and it vetoed all three gutters between the
        // four footer columns a reader can plainly see. The whole footer came back as
        // one block. The corpus holds 73 edge-to-edge boxes against 353 inset ones, and
        // the wide ones are bands: whole `<section>`s on jtc and bakerandpartners, the
        // footer wrapper on tpagency, a cookie bar on alchemy.
        //
        // BUT WIDTH ALONE IS THE WRONG TEST, and the retail fixture says so: M&S's
        // primary `<nav>` spans the full 1440px and is exactly the kind of thing that
        // must stay whole — navigation is one of the four categories this tool reports.
        // So the question is not how wide the box is, it is whether it SAYS WHAT IT IS.
        // A `<nav>`, `<header>`, `<article>` or `<figure>` is taken at its word at any
        // width. A plain `<div>` or `<section>` that qualified only by drawing itself a
        // background has claimed nothing, and at full width it is a band.
        //
        // The `<footer>`s dropped by this lose nothing: an edge-to-edge landmark is
        // protected by `pageLandmarks`, a better rule for them, which makes the boundary
        // a cut rather than merely refusing one inside.
        if (!MODULE_TAGS.has(r.tag) && r.x <= 0 && r.x + r.w >= width) return false;
        const a = r.w * r.h;

        return a >= min * pageArea && a <= max * pageArea;
    });

    // COINCIDENT BOXES ARE ONE BOX. A component wrapped in a div of exactly its own size
    // is ordinary markup — M&S does it to its primary <nav> — and under a plain
    // innermost test the pair cancels out, because each contains the other, so the nav
    // ends up unprotected and gets cut. Collapse identical geometry to a single
    // candidate first, preferring the semantic tag so the survivor is the <nav> rather
    // than its wrapper, and falling back to the earlier rect so the choice never depends
    // on anything but rects.json's own order.
    const byGeometry = new Map();
    for (const r of candidates) {
        const key = `${r.x},${r.y},${r.w},${r.h}`;
        const held = byGeometry.get(key);
        if (!held || (!MODULE_TAGS.has(held.tag) && MODULE_TAGS.has(r.tag))) {
            byGeometry.set(key, r);
        }
    }
    const distinct = [...byGeometry.values()];

    // Compared by POSITION, not object identity: the list is a plain array whose order
    // is rects.json's, so this is deterministic, and it survives shiftRects handing us
    // fresh objects for every tile.
    return distinct.filter((outer, i) => !distinct.some((inner, j) => j !== i && containsRect(outer, inner)));
}

/**
 * A RUN OF REPEATED SIBLINGS IS ONE BLOCK. A product grid, a navigation bar and a list of
 * links are the same thing seen three ways.
 *
 * This is the plan's own ruling rather than a new opinion: recurse while it changes an
 * answer, stop when it only changes the arithmetic. Every card in a product grid takes the
 * same label, every item in a nav takes the same label, every link in a footer list takes
 * the same label — so cutting them apart changes no answer. It only multiplies the work and
 * gives phase 3 a dozen chances to label one thing a dozen different ways. Three pages
 * found it, at three scales and on two axes:
 *
 *   pola.co.jp       seven four-up product carousels, a block per CARD — 132 leaves
 *   clearleft.com    the primary nav cut per ITEM: Services | Work | Thinking | Events
 *   whitepaper.co.uk the footer's "Current Topics" list cut per LINK
 *
 * NOTHING IS MALFUNCTIONING in any of them. The cards are real modules with real gutters
 * between them and the segmenter is doing exactly what it was told, at a granularity the
 * ruling says is too fine. So the question is not how to suppress a cut but how a run is
 * RECOGNISED, and the answer is that a run announces itself in the geometry: FOUR OR MORE
 * elements sharing one edge, of one size across the run, laid at EVEN intervals. Its
 * bounding box is then one module and the ordinary rejection does the rest.
 *
 * BOTH AXES, and the vertical one is not an afterthought. A row of cards repeats across,
 * a list of links repeats down, and whichever way it goes the members share a label. Only
 * the cross-axis measurement differs: a row's members share a `y` and a height and may be
 * any width (a nav's labels are words of different lengths — clearleft's are 59, 37, 60,
 * 46, 43 and 58 pixels wide at gaps of 40, 39, 40, 40, 40); a column's members share an `x`
 * and a width and may be any height.
 *
 * FOUR, AND THE LINE IS DRAWN THERE ON PURPOSE. Three side by side is a composition — the
 * three-up feature row every agency site has, three DIFFERENT things saying three different
 * things, each with its own destination and its own call to action. Cutting those apart is
 * right, it cost work to achieve in `dfbf10d`, and this rule must not reach it:
 * andybudd.com's Coaching / Educating / Speaking is a run of 3 (`figure` 286x286 at
 * x=192, 632, 1072) and does not qualify. Four is where a layout stops being a composition
 * and becomes a LIST. The corpus bears it out: at four and above every run this finds is a
 * collection of one kind of thing — pola's product cards, clearleft's nav items,
 * whitepaper's topic links, natwest's four account categories, altum's footer columns,
 * andybudd's four client logos; at three, the population is feature rows.
 *
 * WHETHER THAT LINE IS RIGHT IS NOT SOMETHING GEOMETRY CAN SETTLE, and it should be said
 * plainly. Six nav links and three feature columns differ in what they MEAN, not in how
 * they are laid out: both are evenly-spaced siblings of one size. Four is where the corpus
 * splits, which is evidence, but it is a count and not a mechanism, and a page with four
 * feature columns would be cut the wrong way by it. The distinction that would always hold
 * is "do these take the same label", and that is phase 3's question, not this file's.
 *
 * EVEN, MEASURED, AND THE MARGIN IS ENORMOUS. The spread between the widest and narrowest
 * gap in a run is 0 or 1 pixel for every genuine one in the corpus — 1 because the browser
 * rounds subpixel positions apart — and 38, 64, 70, 141, 193, 244, 304, 469, 480, 543, 695,
 * 727, 890, 953, 1114, 1188, 1221, 1449 or 4,986 for every false one. Those false ones are
 * what the gate is for: atkearney has fifteen 920x50 paragraphs down its page and
 * boondmanager scatters four 96x96 logos across 1,382px. Both are repeated siblings of one
 * size; neither is a run. Nothing in the corpus sits between 1 and 38.
 *
 * AND THEY MAY NOT OVERLAP, which is a definition rather than a threshold: siblings laid
 * side by side do not sit on each other. jerseyfinance stacks twelve 322x34 dropdown labels
 * at one x, evenly offset by 34px and each overlapping the last; vaiie and atkearney do the
 * same. Every one of them passes the evenness test and none is a list.
 *
 * AND THEY MUST BE NEXT TO EACH OTHER, which is the gate that stops this rule blanketing a
 * page. Evenness says nothing about scale: one button repeated once per section, or one
 * decorative mark repeated once per panel, is as evenly spaced as any grid and its
 * bounding box is the whole page. kohde.agency repeats a 56x56 button six times down the
 * page at 844px intervals — a 56x4556 strip that vetoes every full-width band boundary it
 * crosses, and the page collapsed from 18 leaves to 4. alchemy draws four 46x15 marks at
 * 885px intervals, four more page-tall strips, and lost 45 leaves the same way. So each
 * gap must be no more than REPEAT.adjacency times the SHORTER of the two members it
 * separates — the same normaliser TEXT_RUN and inkClusters use, for the same reason.
 *
 * 1.4, MEASURED, AND THE THINNEST MARGIN IN THIS FILE — stated as such rather than dressed
 * up. Over the 30 captured pages and both fixtures, 126 runs pass every other gate. Their
 * gap ratios climb continuously to 1.38 and every one of them is a real list: clearleft's
 * nav, the case this rule exists for, is 1.08; its footer list 1.10; bakerandpartners'
 * footer column 1.25; jerseyfinance's service icons 1.26; hett's menu 1.33 and 1.38. The
 * first false one is at 1.50 and above it the population is entirely false: 2.00, 2.35,
 * 2.38, 3.86, 9.32 for dept's five "Learn More" buttons 453px apart, 15.07 for kohde,
 * 17.00 for natwest's chat button.
 *
 * WHAT SITS AT 1.50 IS WORTH NAMING, because it is not a list at all and no geometric
 * threshold should have to tell. alchemy.je and kohde.agency pin a panel for one viewport
 * at a time, so the stitched capture carries the same element once per 900px slice —
 * alchemy's `<g>` at x=188 appears at y=2945, 3845, 4745, 5645 and 6545, a pitch of
 * exactly 900, and so does kohde's button and natwest's chat widget. They are one thing
 * repeated by the capture, not four things in a column, and the gap ratio only separates
 * them by accident. If this threshold ever has to move, that is the reason to look at
 * instead: it belongs with the pinned-chrome work in lib/pinned.mjs, not here.
 *
 * A ROW'S CELL IS A BOX, NOT A LINE, and without that gate this destroys a footer. Four
 * columns of links are four columns — but every horizontal slice through them is a run of
 * four `<li>`s of one height at one y, evenly spaced, and there are a dozen such slices
 * stacked up. Protecting each one vetoes the column cuts that are the real structure, and
 * the segmenter then does the only thing left to it and cuts the footer into full-width
 * strips one line of text tall: the retail fixture went from four footer columns to six
 * 42px bands, which is not a worse answer so much as a meaningless one. So a row's members
 * must not be line-shaped, at TEXT_RUN.lineAspect — the question "is this a line or a
 * block?" already asked and already measured elsewhere in this file, asked here about a box
 * instead of about ink. Measured on the corpus: the flattest cell in a genuine ROW is
 * altum's 233x66 at 3.5:1 and clearleft's nav labels are 1.8:1 to 2.9:1, while every column
 * slice is 6.8:1 or flatter (retail's footer links 7.4:1, jerseyfinance's captions 7.3:1,
 * hett's nav items 11.3:1). 4 sits in the gap, as it does for ink.
 *
 * A COLUMN'S CELLS GET NO SUCH GATE, and that asymmetry is the point rather than an
 * oversight: a stack of lines IS a list, and it is exactly what whitepaper's topic links
 * and clearleft's footer are. The cost is a horizontal row of line-shaped items — a legal
 * link row along the bottom of a page — which this will not recognise. That is a miss, not
 * a wrong answer.
 *
 * AND A COLUMN ONLY FORBIDS THE CUT THAT WOULD SEPARATE IT. Every other protected
 * population in this file is uncuttable on both axes, and a column of links must not be,
 * because a line's box is mostly padding: retail's footer links are 312px boxes holding
 * about 200px of ink, so the four column gutters a reader sees at x=296, 642 and 1016 are
 * all strictly INSIDE a link's own box. Vetoing them merged the fixture's four footer
 * columns into one block and broke the test that guards them. A row is different and keeps
 * the ordinary both-axis veto: its members are boxes by the gate above, a horizontal cut
 * slices every one of them through real content, and that is how pola's cards were coming
 * out in halves.
 *
 * A CEILING BUT NO FLOOR. MODULE_AREA.max stops a run claiming the page; weightmans' four
 * 301x440 columns are 22% of a short page and get nothing from this. There is deliberately
 * no lower bound, because the floor in MODULE_AREA answers "is this a module or a chip?"
 * and four repeated siblings have already answered it: clearleft's whole primary nav is
 * 502x21, which is 0.15% of a 4,904px page and is still the navigation. A small run box
 * costs nothing because a run is a veto and nothing else — see protectedRects.
 *
 * THE LIMITATION WORTH KNOWING: one row, or one column, at a time. A 3-wide, 3-deep grid is
 * nine cards that should be one block, and this finds three runs of 3 and rejects all of
 * them. Merging adjacent parallel runs was measured and NOT taken: pola's y=2132 and y=2853
 * carousels are identical 259x475 runs 246px apart — closer together than one card is tall
 * — with a section heading between them, so every adjacency test cheap enough to write here
 * swallows the heading.
 */
export const REPEAT = {minMembers: 4, spacing: 1, adjacency: 1.4, minSide: CONTENT_RECT.minH};

/**
 * The bounding box of each repeated run in `rects`, rows first, in the order phase 1
 * listed them.
 */
export function repeatedRuns(rects, width, pageHeight, opts = REPEAT, areaOpts = MODULE_AREA, runOpts = TEXT_RUN) {
    if (!rects || rects.length === 0) return [];
    const {minMembers, spacing, adjacency, minSide} = {...REPEAT, ...opts};
    const {max} = {...MODULE_AREA, ...areaOpts};
    const {lineAspect} = {...TEXT_RUN, ...runOpts};
    const ceiling = max * width * pageHeight;

    const out = [];
    for (const row of [true, false]) {
        // One shared edge, one cross-axis size. A Map keyed on both collects the
        // candidates, and its insertion order is rects.json's, so nothing here depends on
        // anything else.
        const groups = new Map();
        for (const r of rects) {
            if (r.w < minSide || r.h < minSide) continue;
            // A row's cell is a box, not a line. A column's may be either. See above.
            if (row && r.w >= lineAspect * r.h) continue;
            const key = row ? `${r.y}|${r.h}` : `${r.x}|${r.w}`;
            const held = groups.get(key);
            if (held) held.push(r); else groups.set(key, [r]);
        }
        for (const [key, all] of groups) {
            // Coincident geometry is one member: a `<picture>` and the `<img>` inside it,
            // or clearleft's `<li>` and the `<a>` filling it, are one thing, and counting
            // both would turn a pair into a run of four.
            const seen = new Set();
            const distinct = all.filter((r) => {
                const at = row ? `${r.x}|${r.w}` : `${r.y}|${r.h}`;
                if (seen.has(at)) return false;
                seen.add(at);

                return true;
            }).sort((p, q) => (row ? p.x - q.x : p.y - q.y));
            // A CONTAINER IS NOT A SIBLING OF WHAT IS INSIDE IT, the same innermost rule
            // moduleContainers already applies and for a sharper reason here: a column
            // layout gives a list, its wrapper and every item the SAME x and the same
            // width, so whitepaper's nine footer links arrive in one group along with the
            // `<div>`, the `<p>` heading and the `<ul>` around them. Left in, the wrapper
            // overlaps every item, the gaps come out negative and the list is refused.
            const members = distinct.filter((m, i) => !distinct.some((n, j) => j !== i && containsRect(m, n)));
            if (members.length < minMembers) continue;

            // MAXIMAL RUNS, NOT THE WHOLE GROUP, because a list rarely arrives alone: a
            // heading sits 17px above whitepaper's nine links, which are 0 or 1px apart,
            // and asking the whole group to be evenly spaced throws away the list because
            // of the heading. So walk the group and take the longest stretch that holds
            // together, then start again from whatever broke it.
            const at = (r) => (row ? r.x : r.y);
            const along = (r) => (row ? r.w : r.h);
            const [fixed, size] = key.split('|').map(Number);
            let i = 0;
            while (i < members.length - 1) {
                let pitch = null;
                let j = i;
                while (j + 1 < members.length) {
                    const gap = at(members[j + 1]) - (at(members[j]) + along(members[j]));
                    // Side by side, not stacked on each other; and next to each other, not
                    // merely repeated down a page; and evenly, not merely repeatedly.
                    if (gap < 0) break;
                    if (gap > adjacency * Math.min(along(members[j]), along(members[j + 1]))) break;
                    if (pitch === null) pitch = gap;
                    else if (Math.abs(gap - pitch) > spacing) break;
                    j++;
                }
                if (j - i + 1 >= minMembers) {
                    const first = members[i];
                    const last = members[j];
                    // `stacked` says the members are one above another, so only a
                    // horizontal cut separates them. See above.
                    const box = row
                        ? {x: first.x, y: fixed, w: last.x + last.w - first.x, h: size, tag: 'run', text: 'repeated row', stacked: false}
                        : {x: fixed, y: first.y, w: size, h: last.y + last.h - first.y, tag: 'run', text: 'repeated column', stacked: true};
                    if (box.w * box.h <= ceiling) out.push(box);
                }
                // Whatever broke the stretch may begin the next one.
                i = j > i ? j : i + 1;
            }
        }
    }

    return out;
}

/**
 * A PAGE LANDMARK'S OWN BOUNDARY IS A BOUNDARY, WHATEVER ELSE IS DRAWN THERE.
 *
 * Brand and navigation are two of the four categories this tool exists to measure, and
 * both of them live in the `<header>`. A page whose header is fused into its hero cannot
 * be measured at all, so the header's bottom edge is not one module edge among many — it
 * is the single most valuable cut line on the page. The same holds for the `<footer>`,
 * which is where the legal and contact surface is.
 *
 * Three rules elsewhere in this file each blocked that cut on a real page, and each is
 * right about the population it was written for and wrong about this one:
 *
 *   - `isASeam` (see MODULE_BRIDGE) reaches a module edge just outside a gutter only
 *     where ONE MODULE ENDS AND ANOTHER BEGINS. Nothing begins where a header ends:
 *     jtcgroup.com's `<header>` ends at y=94 between gutters of 68-93 and 97-120, and
 *     jerseyfinance.com's at y=58 between 39-56 and 59-73. Both came out fused.
 *   - `cutsInsideProtected` refuses a cut landing inside a full-bleed element. jersey.com
 *     draws its 1440x134 header ON TOP of a 1440x860 hero `<img>`, and the gutter 99-173
 *     holds the header's edge perfectly — the cut was available and was thrown away. A
 *     landmark drawn over an element is not that element's interior. andybudd.com is the
 *     same shape against a module container: a 306x306 decorative dot patch spans y=-101
 *     to 205 and vetoed the header cut at y=105 during the stitch.
 *   - `minSide` calls a 94px child a sliver. A header strip is a real block; the size
 *     floor is already waived on a module container's edge for exactly that reason.
 *
 * A LANDMARK'S BOUNDARY IS THE LINE WHERE IT STOPS, WHICH IS HORIZONTAL. Its left and
 * right edges are the page margin, not a boundary, and granting anything to those is the
 * failure the seam rule's other half — "and this gutter is the whitespace of one of them"
 * — exists to prevent: a module's padding reaches past its own edge and the margin beside
 * it becomes a block. That is not a hypothetical here. Reaching for a landmark's side
 * edges as well was measured on the jonleverrier fixture, whose `<header>` is 17,51
 * 1406x65 inside a 1440px page, and it cut two 17px-wide slivers of empty margin off the
 * header band. Horizontal only, and the population is then about three coordinates per
 * page: 40 rects over the 29 captured pages and both fixtures, 1.4 per page, against the
 * 664 rects pola.co.jp alone hands `moduleContainers`.
 *
 * REACHABLE FROM EITHER SIDE, unlike a module seam. That is what the whole mechanism is
 * for: nothing begins where a header ends, so requiring the gutter to belong to the
 * landmark would refuse andybudd.com, where the only gutter near the boundary is the one
 * BELOW the rule the header draws under itself.
 *
 * EDGE TO EDGE, NOT MERELY WIDE, and this is the gate that decides what the population
 * means. A landmark reaching both page edges is the page's OWN band — the strip the site
 * draws its brand across — and its top and bottom are where that band starts and stops.
 * A landmark inset by a page margin is a CARD, and a card's own top edge competes with
 * the content inside it rather than announcing a section. Measured on the jonleverrier
 * fixture, whose `<footer>` is 17,900 1406x380 inside a 1440px page: admitted at 0.9 of
 * the width, its top edge at y=900 outranked the element edge at y=946 that the gutter
 * itself offered, the stitch rebuilt the bands around it, and the footer's four link
 * columns stopped being cut — 12 leaves to 9. Every page this mechanism exists for draws
 * its header at x=0 spanning the full 1440. The cost is stated rather than hidden:
 * dept.com's `<footer>` at 21,13103 1398x483 and gcsc's at 53,3600 1335x512 are inset,
 * so they get nothing from this rule.
 *
 * NOT `nav`, NOT `main`, and both exclusions are deliberate. A full-width `<nav>` is
 * normally a strip INSIDE the header (the retail fixture has one at 0,112 1440x40, 1px
 * from the header's own bottom edge at 153), so admitting it would put two competing
 * boundaries 41px apart and move a committed fixture. `<main>` spans the page: its edges
 * are the page's own extremes plus the footer boundary, which the `<footer>` already
 * gives, so it adds no coordinate that is not already here.
 */
export const LANDMARK_TAGS = new Set(['header', 'footer']);

/**
 * How much of a region's width must carry ink along a landmark's edge for that boundary
 * to count as DRAWN — a divider rule, a border, or the colour step between two panels.
 *
 * Only the last-resort cut in `segment` asks this. See the comment on `landmarkGutters`
 * for the measurement: the corpus splits at 0.023 and 0.131 with nothing between.
 */
export const LANDMARK_RULE = 0.05;

/** The page's own header and footer bands, in the order phase 1 listed them. */
export function pageLandmarks(rects, width) {
    if (!rects || rects.length === 0) return [];

    return rects.filter((r) => LANDMARK_TAGS.has(r.tag) && r.x <= 0 && r.x + r.w >= width && r.h > 0);
}

/**
 * Is `at` — an ABSOLUTE coordinate, the same space `landmarks` is in — a page landmark's
 * own top or bottom edge, drawn across the region being cut?
 *
 * ALWAYS FALSE ON THE VERTICAL AXIS, and that is the rule rather than an oversight: a
 * landmark's side edges are the page margin. See pageLandmarks. Answering here rather
 * than at each call site is what keeps every one of them honest.
 *
 * The other axis matters for the same reason it does in `cutsInsideProtected`: the cut is
 * a line segment across `rect`, and a landmark that does not reach this region says
 * nothing about it. Touching at a single edge is not overlapping.
 */
export function onLandmarkBoundary(landmarks, rect, at, horizontal) {
    if (!horizontal) return false;

    return landmarks.some((l) => (at === l.y || at === l.y + l.h)
        && Math.max(rect.x, l.x) < Math.min(rect.x + rect.w, l.x + l.w));
}

/**
 * Everything a cut may not pass through, in one list.
 *
 * TWO POPULATIONS, ONE REJECTION. Full-bleed media and module containers are selected by
 * completely different evidence — a tag and a size for one, a drawn box and a containment
 * test for the other — but what happens to a cut landing inside either is identical, so
 * the rejection is written once and both feed it.
 */
/**
 * Tags that hold words directly.
 *
 * BODY TEXT IS IN HERE AND FOR A WHILE IT WAS NOT, which is worth the paragraph because
 * the reason it was excluded stopped being true and nobody noticed.
 *
 * Protecting every text element was tried early and reverted: four footer columns merged
 * into one, because a 1315px copyright line spanned the whole page and vetoed the axis.
 * The narrowing to headings was the right call AT THE TIME. What has changed since is
 * that a protected rect is no longer its box — `inkBounds` shrinks it to the pixels that
 * are actually drawn, and `inkClusters` splits that into the groups the ink falls in — so
 * a copyright line now protects the width of its own sentence and nothing else.
 *
 * Leaving `<p>` out cost three pages in the corpus a cut straight through a paragraph.
 * altum is the clearest: its `<h2>` at 46,1028 is protected and shrunk to 706px of ink,
 * the `<p>` beneath it at 46,1092 sized 1337x72 is in no population at all, and cuts land
 * at x=805, 1073 and 1248 — clear of the heading, through the middle of the sentence. A
 * reader sees one paragraph; the segmenter saw an unprotected region with quiet columns
 * between the words. milk has the same defect vertically, hettich horizontally.
 *
 * Re-measured before widening, and the old regression does not come back: both fixtures
 * are unmoved (retail 17 leaves, jonleverrier 12) even though retail's protected-text
 * population goes from 14 rects to 52, and the four sites in the corpus with real
 * multi-column footers — whitepaper, vaiie, jtc, natwest — keep their columns. The three
 * defect pages lose only the cuts that were through their prose: altum 27 to 24, milk 29
 * to 27, hettich 30 to 26.
 *
 * `<span>` and `<a>` stay out deliberately. They are inline and everywhere, and the runs
 * they form are already handled by `textRuns`, which joins what reads as one line.
 */
export const TEXT_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'blockquote', 'figcaption', 'dd', 'dt',
]);

/**
 * Elements that carry words. A cut may not pass THROUGH one.
 *
 * A gutter is a run of quiet pixels, and the space between two words in a large headline
 * is exactly that — on jonleverrier the gap between "How" and "can" is a 268px-tall
 * column of background, and a vertical cut went straight down it. Between elements is
 * still fine; only the interior of one is off limits.
 *
 * Restricted to tags that hold text directly, because rects carry textContent including
 * descendants: a <section>'s text is the whole page's, and protecting that would protect
 * everything.
 */
export function textRects(rects) {
    if (!rects || rects.length === 0) return [];

    // NOT `isContentRect`, and the difference is one of its three gates. That helper
    // answers "is this worth snapping a cut to", and its 700px height ceiling is there to
    // keep PAGE-LEVEL WRAPPERS out of the candidate list — a `<div>` around the whole
    // document marks nothing and would otherwise be the most numerous candidate near any
    // cut. That reasoning does not transfer here: an element in TEXT_TAGS holds words
    // directly, so it cannot be a page wrapper however tall it is, and a headline is
    // exactly the thing that most needs protecting when it is big.
    //
    // alchemy.je is the page that found it. Its `<h1>` at 16,212 is 1408x704 — FOUR
    // PIXELS over the ceiling — so "IGNITING BUSINESS SUCCESS / THROUGH THE POWER OF
    // DIFFERENCE." was protected by nothing and got cut between its words and in places
    // between its letters, taking about 19 of that page's 91 blocks. The two `<span>`s
    // inside it are under the ceiling but are inline, so they are not in TEXT_TAGS
    // either, and being on separate lines they form no run. Nothing in the file reached
    // it.
    //
    // The other two gates stay: a hairline or an icon is still too small to be a section
    // break, and protecting one would veto an axis for nothing.
    const bigEnough = (r) => r.w >= CONTENT_RECT.minW && r.h >= CONTENT_RECT.minH;

    return rects.filter((r) => TEXT_TAGS.has(r.tag) && (r.text || '').trim().length > 0 && bigEnough(r));
}

/**
 * A rect shrunk to the pixels that actually have ink in them, or null if none do.
 *
 * THE BOUNDING BOX OF ALL OF IT, which is the right answer only while the ink is one
 * piece. What the segmenter protects is `inkClusters` — see there for the page that made
 * the difference matter.
 *
 * PROTECT THE WORDS, NOT THE BOX. A heading's element box is as wide as its column, and
 * the words rarely fill it: M&S's footer headings are 336px boxes holding "Here to Help"
 * (121px of ink) and the column gutter beside each one begins EXACTLY where its ink ends
 * — 161 against ink ending at 146, 557 against 556, 898 against 897. Protecting the box
 * rejected all three column cuts and left the footer's four link columns as one
 * full-width band with the columns below it cut short.
 *
 * Shrinking loses nothing that mattered: on jonleverrier the headline's ink spans 511-932
 * inside a 440-1000 box, and the cut that must stay refused — between "How" and "can" at
 * x=745 — is inside the ink either way.
 *
 * `edges` must be the same coordinate space as `r`, which is what segment guarantees:
 * segmentTall shifts rects to match each tile and band before handing both over.
 */
export function inkBounds(edges, width, height, r) {
    const x0 = Math.max(0, r.x);
    const x1 = Math.min(width, r.x + r.w);
    const y0 = Math.max(0, r.y);
    const y1 = Math.min(height, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return null;

    let left = null;
    let right = null;
    let top = null;
    let bottom = null;
    for (let y = y0; y < y1; y++) {
        const base = y * width;
        for (let x = x0; x < x1; x++) {
            if (!edges[base + x]) continue;
            if (left === null || x < left) left = x;
            if (right === null || x > right) right = x;
            if (top === null) top = y;
            bottom = y;
        }
    }

    // No ink at all — an empty heading box protects nothing.
    return left === null
        ? null
        : {x: left, y: top, w: right - left + 1, h: bottom - top + 1, tag: r.tag, text: r.text};
}

/**
 * A BOX CAN HOLD SEVERAL SEPARATE PIECES OF INK, AND THE SPAN BETWEEN THE FAR ENDS OF
 * THEM IS NOT ONE OF THEM.
 *
 * `inkBounds` takes the leftmost and rightmost edge pixel anywhere in the box, which is
 * the right answer when the ink is one line of words and the wrong one as soon as it is
 * not. andybudd.com is the case that found it: its `<h4>` "Popular articles" is a
 * 1276x27 box, the words occupy x=82..285, and the page draws a decorative dot matrix
 * that clips through both ends of the box — roughly 100 to 190 edge pixels per row,
 * spread right across it. `inkBounds` returned the full 1276px, which is not a shrink to
 * ink at all, and that one element then vetoed every vertical cut in the region: the
 * three columns of its Coaching / Educating / Speaking row stayed in one 1440x1219
 * block, with 42px-wide gutters four times quieter than the threshold sitting unused.
 *
 * This is the same failure `inkBounds` was written to prevent — a heading's box being
 * wider than its content and vetoing a real gutter, the M&S footer case — arrived at
 * from the other side. A textured, noisy or photographic backdrop defeats a shrink to
 * ink by putting a few pixels of ink everywhere, and nothing about it is specific to one
 * page: it is silent wherever it happens.
 *
 * So take the ink as it actually lies: runs of inked columns, merged where the gap
 * between two runs is small enough to read as a word space, and each surviving group
 * protected on its own. The words stay protected — on andybudd the glyphs and the dots
 * that overlap them are one group, 82..285 — and the 932px of background between that
 * group and the dot patch at the other end stops being called ink.
 *
 * WHAT MUST NOT CHANGE is the case the population exists for: on jonleverrier the gap
 * between "How" and "can" in the headline is a 268px-tall column of background, and a
 * vertical cut went straight down it. A word space inside one heading is the same
 * physical thing as a word space between two elements of one line, so this asks the
 * question `TEXT_RUN.gap` already answered and takes its answer: the gap as a fraction of
 * the shorter neighbouring ink's height, 0.75, measured there against a must-merge of
 * 0.47 and a must-not of 1.07. Measured again here over the 29 captured pages and both
 * fixtures: of 359 headings whose ink is in more than one piece, 336 have every gap under
 * 0.75 and are untouched. The largest genuine word space in the corpus is 0.53
 * (hsbc "Northern Ireland"), and jonleverrier's headline — the case above — is 0.11.
 */
export const INK_CLUSTER = {gap: 0.75};

/**
 * The groups of ink inside `r`, left to right, or [] if it holds none.
 *
 * One group is what `inkBounds` returns; the usual case is exactly that. `edges` must be
 * the same coordinate space as `r`, which is what segment guarantees.
 */
export function inkClusters(edges, width, height, r, opts = INK_CLUSTER) {
    const {gap} = {...INK_CLUSTER, ...opts};
    const x0 = Math.max(0, r.x);
    const x1 = Math.min(width, r.x + r.w);
    const y0 = Math.max(0, r.y);
    const y1 = Math.min(height, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return [];

    // Per column: does it carry ink, and between which rows. The vertical extent is kept
    // per column so each group reports its own height rather than the whole box's.
    const top = new Int32Array(x1 - x0).fill(-1);
    const bottom = new Int32Array(x1 - x0).fill(-1);
    for (let y = y0; y < y1; y++) {
        const base = y * width;
        for (let x = x0; x < x1; x++) {
            if (!edges[base + x]) continue;
            const i = x - x0;
            if (top[i] < 0) top[i] = y;
            bottom[i] = y;
        }
    }

    // Maximal runs of inked columns.
    const runs = [];
    let start = -1;
    for (let i = 0; i <= top.length; i++) {
        const inked = i < top.length && top[i] >= 0;
        if (inked && start < 0) start = i;
        if (!inked && start >= 0) {
            runs.push(group(start, i - 1));
            start = -1;
        }
    }
    if (runs.length === 0) return [];

    // Merge neighbours separated by no more than a word space. The normaliser is the
    // SHORTER of the two, exactly as in textRuns: a tall neighbour must not license a
    // wide gap to a short one.
    const merged = [runs[0]];
    for (let i = 1; i < runs.length; i++) {
        const held = merged[merged.length - 1];
        const next = runs[i];
        const between = next.x - (held.x + held.w);
        if (between <= gap * Math.min(held.h, next.h)) {
            const y = Math.min(held.y, next.y);
            merged[merged.length - 1] = {
                x: held.x,
                y,
                w: next.x + next.w - held.x,
                h: Math.max(held.y + held.h, next.y + next.h) - y,
                tag: r.tag,
                text: r.text,
            };
        } else {
            merged.push(next);
        }
    }

    return merged;

    function group(from, to) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = from; i <= to; i++) {
            if (top[i] < lo) lo = top[i];
            if (bottom[i] > hi) hi = bottom[i];
        }

        return {x: x0 + from, y: lo, w: to - from + 1, h: hi - lo + 1, tag: r.tag, text: r.text};
    }
}

/** The headings in `rects`, each shrunk to the groups of ink it actually holds. */
export function inkedTextRects(edges, width, height, rects, opts = INK_CLUSTER) {
    return textRects(rects).flatMap((r) => inkClusters(edges, width, height, r, opts));
}

/**
 * A RUN OF TEXT ON ONE LINE IS ONE THING, and `inkedTextRects` cannot see that, because
 * it protects each element separately.
 *
 * tpagency.com pins a panel across two viewports and each one shows a single line —
 * "Lead with Strategy & Insight" — built from two <span>s. Their ink is 389-611 and
 * 629-1041 with an 18px space between, which is a perfectly legal gutter, so a vertical
 * cut went down it and the 900px-tall pinned region came out as five columns of black
 * cut between the words. Every rule in this file was working as written; the premise was
 * wrong. A reader sees one line. The segmenter saw four.
 *
 * So merge the parts of a line into one span and protect that. What follows is the
 * evidence for each threshold, measured over the 27 captured pages in the review sweep
 * plus both committed fixtures. `must merge` is tpagency's headline; `must not` is every
 * grid, card row and footer whose columns are real boundaries.
 */
export const TEXT_RUN = {
    /**
     * A LINE, NOT A BLOCK: the ink is at least this many times as wide as it is tall.
     *
     * The gap thresholds below are fractions of the ink's height, and that only means
     * anything if the ink is one line of type. A card's text block is ink too: switch.je
     * stacks three 437x246 case-study cards whose gaps are 24px, which against 246px of
     * "line height" is 0.10 and merges the whole row into one span — killing the three
     * column cuts that are right there in the debug image. Requiring a line shape is what
     * keeps the normaliser honest.
     *
     * Measured: the squattest run-mate that MUST merge is tpagency's "Lead with" at
     * 222x38, or 5.8:1. The flattest block that must NOT is dept's article-card summary
     * at 329x84, 3.9:1; every other offender is flatter still (milk 2.0:1, gcsc 1.5:1,
     * hett 1.0:1). 4 sits between them.
     *
     * The cost is real and worth stating: a single short word is not 4:1, so kohde's
     * "Kohde builds businesses with design" — each word its own <span> — does not merge.
     * That is a miss, not a wrong answer: nothing is protected that should not be.
     */
    lineAspect: 4,
    /**
     * ONE LINE BOX HOLDS BOTH, at most this many times the taller ink's height.
     *
     * Pixel geometry alone cannot finish this job, and the measurement says so plainly.
     * tpagency's gap is 18px against 38px of ink — 0.47 — and natwest's footer, three
     * accordion headings that MUST stay in three columns, is 27px against 56px: 0.48.
     * There is no threshold between 0.47 and 0.48. altum's four-column footer is the
     * same shape at 0.68. So ask the DOM instead: the smallest rect containing both
     * run-mates is a line box (tpagency's <p>, 77px tall against 63px of ink, 1.22) or it
     * is a column wrapper (natwest 380px against 56px, 6.2; altum 6.2; switch.je 4.0).
     *
     * 2 is "not tall enough to hold a second line". The margin around it is the whole
     * range 1.22 to 6.23 — nothing in the corpus lands between.
     */
    lineBox: 2,
    /**
     * THE SAME LINE: vertical ink overlap, as a fraction of the shorter ink's height.
     *
     * Overlapping vertically is not enough on its own — a headline wrapped onto two
     * lines overlaps itself, and two cards of different heights overlap each other. The
     * distribution is sharply bimodal: of 3,652 horizontally-near pairs across the
     * corpus, 3,380 do not overlap at all and 241 overlap by 0.95 or more. The 31 in
     * between are all pairs of DIFFERENT things at different heights — milk's two card
     * blurbs at 0.62, dept's section heading against its "view all" link at 0.82,
     * jerseyfinance's headline against a nav label at 0.89 — and the highest of them is
     * 0.93. Above 0.95 the shorter span's ink lies inside the taller's, which is what
     * a superscript, a currency mark or a descender-free word does.
     */
    sameLine: 0.95,
    /**
     * CLOSE ENOUGH TO READ AS CONTINUOUS: the gap, as a fraction of the shorter ink's
     * height. A word space scales with the type, so this cannot be a pixel count.
     *
     * Measured: tpagency's word space is 18px against 38px of ink, 0.47. M&S's product
     * grid — the case that breaks if this is generous — puts two card titles 17px apart
     * against 15px of ink, 1.13, and its footer link columns run from 8.9 to 18.7. Its
     * legal-link row is 1.07. 0.75 sits between 0.47 and 1.07 with room either side.
     */
    gap: 0.75,
};

/**
 * The lines of text in `rects`, each shrunk to its ink.
 *
 * INNERMOST ONLY. A rect's `text` is its descendants' too — see lib/capture.mjs — so a
 * <p> holding two <span>s reports the whole line and each <span> reports its own part.
 * Protecting all three would be harmless but merging them would not: the <p> already
 * spans the gap, and a run built from it would say nothing. The parts are what carry the
 * evidence, so keep only rects that contain no smaller text-bearing rect.
 */
export function lineSpans(edges, width, height, rects, opts = TEXT_RUN, inkOpts = INK_CLUSTER) {
    if (!rects || rects.length === 0) return [];
    const {lineAspect} = {...TEXT_RUN, ...opts};

    const bearing = rects.filter((r) => (r.text || '').trim().length > 0 && isContentRect(r));
    const spans = [];
    for (let i = 0; i < bearing.length; i++) {
        const r = bearing[i];
        if (bearing.some((n, j) => j !== i && containsRect(r, n) && n.w * n.h < r.w * r.h)) continue;
        // GROUPS OF INK, NOT THE SPAN BETWEEN THEIR FAR ENDS — see inkClusters. A backdrop
        // that puts a few pixels of ink across the whole box would otherwise hand the
        // aspect test a "line" the element does not contain, and the run built from it
        // would veto cuts nowhere near any words.
        // `inkOpts`, never `opts`: TEXT_RUN happens to carry a `gap` too and it answers a
        // different question about different things.
        for (const ink of inkClusters(edges, width, height, r, inkOpts)) {
            if (ink.w < lineAspect * ink.h) continue;
            spans.push({...ink, box: r});
        }
    }

    return spans;
}

/**
 * Runs of text: the lines of `rects`, with the parts of each line merged into one span.
 *
 * ONLY RUNS COME BACK, never a lone line, and that restraint is deliberate. Protecting
 * every text element was tried before and is worse than useless — see
 * test/headings.test.mjs, where jonleverrier's 1315px copyright line vetoed every cut on
 * its axis and merged the four footer columns into one block. The new fact here is
 * narrow: a gap BETWEEN two parts of one line is not a boundary. Everything else about
 * what is protected stays exactly as it was.
 */
export function textRuns(edges, width, height, rects, opts = TEXT_RUN, inkOpts = INK_CLUSTER) {
    const {lineBox, sameLine, gap} = {...TEXT_RUN, ...opts};
    const spans = lineSpans(edges, width, height, rects, opts, inkOpts);
    if (spans.length < 2) return [];
    spans.sort((a, b) => a.x - b.x || a.y - b.y);

    // The smallest rect holding both runs of WORDS, or null. Pairs that get this far are
    // few: they have already passed the shape, band and gap tests.
    //
    // The ink, not the boxes, and that is not a preference. tpagency's last pinned
    // headline has its <p> at y=5621 h=77 and the <span> inside it at y=5622 h=77 — the
    // child ends one pixel BELOW its own parent, because the browser rounded them apart.
    // Asked about boxes, no element in the census holds that line, and it stayed cut
    // between "Lead" and "with" while its four identical siblings were fixed. The ink is
    // measured from the pixels and has no rounding to disagree about.
    const lineBoxOf = (a, b) => {
        let held = null;
        for (const c of rects) {
            if (c === a.box || c === b.box) continue;
            if (!containsRect(c, a) || !containsRect(c, b)) continue;
            if (!held || c.w * c.h < held.w * held.h) held = c;
        }

        return held;
    };

    // Merge by chaining: a, b, c on one line with a-b and b-c both close is one run. The
    // union is taken over ink, so the run is the words and not the boxes around them.
    const runs = [];
    const joined = new Array(spans.length).fill(false);
    for (let i = 0; i < spans.length; i++) {
        if (joined[i]) continue;
        let run = null;
        let last = spans[i];
        for (let j = i + 1; j < spans.length; j++) {
            if (joined[j]) continue;
            const next = spans[j];
            const shorter = Math.min(last.h, next.h);
            const between = next.x - (last.x + last.w);
            if (between < 0 || between > gap * shorter) continue;
            const over = Math.min(last.y + last.h, next.y + next.h) - Math.max(last.y, next.y);
            if (over < sameLine * shorter) continue;
            const box = lineBoxOf(last, next);
            if (!box || box.h > lineBox * Math.max(last.h, next.h)) continue;
            const seed = run ?? {x: last.x, y: last.y, w: last.w, h: last.h};
            const x0 = Math.min(seed.x, next.x);
            const y0 = Math.min(seed.y, next.y);
            run = {
                x: x0,
                y: y0,
                w: Math.max(seed.x + seed.w, next.x + next.w) - x0,
                h: Math.max(seed.y + seed.h, next.y + next.h) - y0,
            };
            joined[j] = true;
            last = next;
        }
        if (run) runs.push({...run, tag: 'run', text: 'text run'});
    }

    return runs;
}

/**
 * The MODULES a cut may not pass through, in one list.
 *
 * THREE POPULATIONS, ONE REJECTION, selected by three unrelated kinds of evidence: a tag
 * and a page-width for a hero (fullBleedMedia), a tag and an area for a picture
 * (mediaModules), a drawn box and a containment test for a card (moduleContainers). What
 * happens to a cut landing inside any of them is identical, so the rejection is written
 * once — see cutsInsideProtected — and all three feed it.
 *
 * A REPEATED RUN IS NOT HERE, and neither list below holds one: a run is a region this
 * file inferred rather than something the page declared, its outer edge is already an
 * ordinary candidate because its members are content rects, and licensing a cut there
 * produced a 63px sliver on the jonleverrier fixture. It is a veto and nothing else, so
 * `segment` puts it with the other vetoes.
 *
 * `offsetY` says where the slice these rects were shifted into sits in the page; without
 * it the backdrop test cannot be asked at all. See isBackdrop.
 */
export function protectedRects(rects, width, pageHeight, offsetY = 0) {
    return [
        ...fullBleedMedia(rects, width),
        ...mediaModules(rects, width, pageHeight),
        ...moduleContainers(rects, width, pageHeight),
    ].filter((r) => !isBackdrop(r, width, pageHeight, offsetY));
}

/**
 * The subset of `protectedRects` whose own EDGES are boundaries.
 *
 * Being uncuttable and being a boundary are two different claims, and only one of them
 * follows from being a picture. A full-bleed element spans the page, so its top and bottom
 * ARE where one band of the page stops and the next starts; a module container is a card,
 * a header or a figure, and its edge is where that module stops. A 311x404 product
 * photograph inside a grid is neither. Its interior must not be cut — that is what
 * mediaModules is for — but its side edge is one element edge among the hundreds
 * `edgeCandidates` already offers, and promoting it to a module boundary gives it three
 * privileges it has not earned: a snap prefers it over a nearer edge, `isASeam` may bridge
 * out of a gutter to reach it, and a cut landing on it waives the size floor.
 *
 * MEASURED ON THE RETAIL FIXTURE, which is why the distinction exists at all. Its five
 * product photographs have their side edges at x=335, 650, 965, 969 and 1280; promoted to
 * boundaries, those outranked the element edges that the FOOTER's own column gutters
 * offered 1,700 pixels below, and all three footer column cuts moved. The cuts were still
 * inside their gutters and the footer still came out in four columns — but the coordinate
 * was chosen by a photograph that is nowhere near it, which is the file's coordinate-only
 * limitation being made worse rather than a new answer.
 */
export function boundingRects(rects, width, pageHeight, offsetY = 0) {
    return [
        ...fullBleedMedia(rects, width),
        ...moduleContainers(rects, width, pageHeight),
    ].filter((r) => !isBackdrop(r, width, pageHeight, offsetY));
}

/**
 * Each protected element's two edges on one axis, mapped to the [start, end] span the
 * edge belongs to. One coordinate can bound several modules, so the value is a list.
 *
 * A bare set of edge coordinates cannot answer the question bridging has to ask — is
 * this gutter INSIDE the module I am reaching for, or merely beside it — because the
 * coordinate on its own has lost the module it came from. See MODULE_BRIDGE.
 */
export function edgeSpans(keepWhole, horizontal) {
    const spans = new Map();
    const add = (at, span) => {
        const held = spans.get(at);
        if (held) {
            held.push(span);
        } else {
            spans.set(at, [span]);
        }
    };
    for (const m of keepWhole) {
        const span = horizontal ? [m.y, m.y + m.h] : [m.x, m.x + m.w];
        add(span[0], span);
        add(span[1], span);
    }

    return spans;
}

/**
 * Would a cut at `at` — an ABSOLUTE coordinate in the segmented image's space, the same
 * space `keepWhole` is in — run through the interior of a protected element?
 *
 * The element's OWN EDGES ARE FINE, and are in fact exactly where we want the cut: the
 * test is strict inequality on both sides. Only the interior is protected.
 *
 * The cut is a line segment across `rect`, not a point, so the other axis matters too: a
 * horizontal cut only touches the element if the region it crosses actually overlaps the
 * element's columns. Touching at a single edge is not overlapping, hence `<` on the span.
 */
export function cutsInsideProtected(keepWhole, rect, at, horizontal) {
    for (const m of keepWhole) {
        if (horizontal) {
            if (at <= m.y || at >= m.y + m.h) continue;
            if (Math.max(rect.x, m.x) < Math.min(rect.x + rect.w, m.x + m.w)) return true;
        } else {
            if (at <= m.x || at >= m.x + m.w) continue;
            if (Math.max(rect.y, m.y) < Math.min(rect.y + rect.h, m.y + m.h)) return true;
        }
    }

    return false;
}

// `landmarkRule` above 1 switches the last-resort landmark cut off, the way
// `moduleBridge: 0` switches bridging off: no row's density can exceed 1, so nothing
// qualifies. The tests use both, to assert what the rules refuse as well as what they reach.
export const SEGMENT_DEFAULTS = {
    maxDepth: 4,
    minAreaFraction: 0.02,
    minSide: 120,
    moduleBridge: MODULE_BRIDGE,
    landmarkRule: LANDMARK_RULE,
    // Where the top of this slice sits in the whole page. 0 unless segmentTall is cutting
    // a tile or a band, and it says so. Only `isBackdrop` reads it — see there for why a
    // page-relative question cannot be asked in a tile's own coordinates.
    pageOffsetY: 0,
};

/**
 * Recursive XY-cut. Considers every gutter on both axes, widest first, and splits on
 * the first one whose two halves are both big enough to be a block.
 *
 * WIDEST-FIRST IS A PREFERENCE, NOT THE ONLY CANDIDATE. Collapsing each axis to its
 * single widest gutter before the size check meant one undersized child abandoned the
 * region for good, so a whole page came out as five to nine leaves: the split that
 * failed was usually a wide margin near an edge, while a perfectly good gutter two
 * pixels narrower sat in the middle of the region, never tried. The order is total and
 * stable — width descending, then horizontal before vertical, then start ascending —
 * so the tree does not depend on how the gutter lists happened to be built.
 *
 * THE SPLIT PARTITIONS, IT DOES NOT TRIM. The cut lands on one coordinate inside the
 * chosen gutter — a real element edge when `opts.rects` is supplied, the midpoint
 * otherwise — and every pixel goes to one child or the other, so children exactly tile
 * the parent and total area is conserved at every depth.
 *
 * That is not a tidiness point, it is the measurement. Trim blocks to their content
 * instead and the gutters fall out of every leaf, so cutting a nine-card grid into
 * nine blocks quietly SHRINKS the measured area of that grid and inflates the
 * unassigned residual — the headline percentage would then depend on --depth, which
 * is indefensible in a report somebody is reading about their own site. With a true
 * partition, depth changes which labels get applied and never the arithmetic.
 */
export function segment(edges, width, height, opts = {}) {
    const {maxDepth, minAreaFraction, minSide, moduleBridge, landmarkRule, rects, pageHeight, pageOffsetY, textRun, inkCluster} = {...SEGMENT_DEFAULTS, ...opts};
    const minArea = width * height * minAreaFraction;
    const yCandidates = edgeCandidates(rects, true);
    const xCandidates = edgeCandidates(rects, false);
    // `height` is this slice's height; the whole page's is only different when segmentTall
    // called us for a tile or a band, and it says so.
    const keepWhole = protectedRects(rects, width, pageHeight ?? height, pageOffsetY);
    // The subset whose own edges are boundaries. A picture's edge is not one — see
    // boundingRects — so it steers no snap, bridges no seam and waives no size floor.
    const bounds = boundingRects(rects, width, pageHeight ?? height, pageOffsetY);
    // Rejection only. These never steer a snap and never excuse the size floor — they
    // are a veto on cutting through words, not a statement about module boundaries.
    // Shrunk to their ink: a heading box is as wide as its column and the words rarely
    // fill it, so the box would veto the gutter beside the heading. See inkBounds.
    // A line assembled from several elements is one span too, or the space between two
    // words is a legal gutter and a headline gets cut between them. See textRuns.
    // A REPEATED RUN IS A VETO AND NOTHING ELSE, which is why it sits here rather than in
    // `keepWhole`: every member of a run takes the same label, so the gutters between them
    // are not boundaries worth having — but the run is not a module the page declared, so
    // it may not steer a snap or waive the size floor. See REPEAT and protectedRects.
    const runs = repeatedRuns(rects, width, pageHeight ?? height);
    const keepIntact = [
        ...inkedTextRects(edges, width, height, rects, inkCluster),
        ...textRuns(edges, width, height, rects, textRun, inkCluster),
        ...runs.filter((r) => !r.stacked),
    ];
    // A column of repeated siblings forbids only the cut that would separate it, which is
    // the horizontal one. See REPEAT: a line's box is mostly padding, and the vertical
    // gutter a reader sees between two columns of links is strictly inside both.
    const keepStacked = runs.filter((r) => r.stacked);
    // The page's own header and footer. A boundary in their own right, on terms the
    // module population does not get — see pageLandmarks. Their top and bottom edges
    // only: the side edges are the page margin.
    const landmarks = pageLandmarks(rects, width);
    const landmarkY = new Set(landmarks.flatMap((l) => [l.y, l.y + l.h]));
    // The coordinates a snap should reach for when the gutter offers a choice. Taken from
    // `bounds`, never from `keepWhole`: see boundingRects.
    const moduleEdgeY = new Set(bounds.flatMap((m) => [m.y, m.y + m.h]));
    const moduleEdgeX = new Set(bounds.flatMap((m) => [m.x, m.x + m.w]));
    // The same edges, each keeping the module it belongs to, so a snap can ask whether
    // the gutter it is bridging out of is that module's own whitespace. See
    // MODULE_BRIDGE: the edge alone is not enough to tell a hairline from a margin.
    const moduleSpanY = edgeSpans(bounds, true);
    const moduleSpanX = edgeSpans(bounds, false);
    const tooSmall = (r) => r.w * r.h < minArea || Math.min(r.w, r.h) < minSide;

    const cut = (rect) => {
        if (rect.depth >= maxDepth) return rect;

        // Kept rather than discarded: the landmark rule below asks this same profile
        // whether a boundary is drawn.
        const rowD = rowDensity(edges, width, rect);
        const colD = colDensity(edges, width, rect);
        const rows = findGutters(rowD);
        const cols = findGutters(colD);
        // COLUMNS ARE A TWO-DIMENSIONAL STRUCTURE, AND A LINE IS NOT ONE. A cut on either
        // axis needs the region's ink to reach across the OTHER axis by at least as much
        // as a gutter is wide; below that there is a line or a speck, not two things side
        // by side. Measured on tpagency.com, where the 1440x150 strip above the footer is
        // blank apart from the 1px rule drawing the footer's own top edge: the dither
        // along that single row broke into 32 column runs, and the empty strip was cut
        // into eight columns of nothing. No density threshold can answer that — the
        // region's median is 0, so every threshold is the floor — but the question "how
        // many rows have anything in them at all" answers it in one number: two.
        const inked = (d) => {
            let n = 0;
            for (let i = 0; i < d.length; i++) if (d[i] > 0) n++;

            return n;
        };
        const cuttable = {horizontal: inked(colD) >= GUTTER.minRun, vertical: inked(rowD) >= GUTTER.minRun};
        // Gutters touching an edge of the region are padding, not a divider: splitting
        // on one produces an empty child and a copy of the parent, which recurses
        // forever without making progress.
        const inner = (gs, extent) => gs.filter((g) => g.start > 0 && g.end < extent);

        // A DRAWN LANDMARK BOUNDARY IS EVIDENCE OF ITS OWN, AND IT IS THE LAST RESORT.
        //
        // Everywhere else in this file a cut needs whitespace to justify it, and it
        // should: a boundary the pixels do not show is one nobody reading the report can
        // see either. This is the one exception, and it is not a weaker standard but the
        // same one met a different way — the standard MODULE_BRIDGE states, that the
        // pixels, the DOM and the eye all agree. A rule or a colour step drawn along a
        // `<header>`'s bottom edge IS the boundary, visible to anyone looking at the page;
        // whitespace is simply not the only way a page can draw one.
        //
        // andybudd.com is why it is here and shows what it costs to do without. Its
        // header ends at y=105 under a rule covering 89% of the width, and the rows
        // either side of that rule run 0.017-0.025 against an adaptive threshold of
        // 0.0128 — not because the page has no whitespace, but because a decorative dot
        // matrix occupies the left 306px of every row from y=10 down. No gutter is found,
        // and the header, the hero and the portrait came back as one 1440x821 block.
        // Lowering the gutter threshold to reach those rows was measured as the
        // alternative and is the wrong tool by a wide margin: at the lowest setting that
        // finds them, switch.je gains 8 leaves, liquidlight 11, dept 9, atkearney 8, and
        // the jonleverrier fixture moves.
        //
        // DRAWN, MEASURED: the density of the row at the boundary or the one above it.
        // Over the 51 landmark edges in the 29 captured pages and both fixtures the
        // population is sharply bimodal — 30 edges at 0.131 and above (20 of them at
        // 0.997+, a full-width rule or a colour step) and 21 at 0.023 and below, with
        // nothing in between. LANDMARK_RULE sits in that gap. Undrawn boundaries lose
        // nothing by it: they are the ones with whitespace around them, which the gutters
        // and MODULE_BRIDGE already reach — jersey.com's header edge at y=134 measures
        // 0.000 here and is cut anyway, by the 74-row gutter that holds it.
        //
        // ZERO WIDTH IS HOW IT RANKS LAST, not a trick: the order is width descending, so
        // a landmark boundary is considered only after every gutter the pixels actually
        // found has been tried and refused. It then faces every other test unchanged —
        // the heading and text-run vetoes, the partition, and the degenerate-child floor.
        const landmarkGutters = landmarks
            .flatMap((l) => [l.y, l.y + l.h])
            .filter((e) => e > rect.y && e < rect.y + rect.h)
            .filter((e) => Math.max(rowD[e - rect.y - 1], rowD[e - rect.y]) >= landmarkRule)
            .map((e) => ({g: {start: e - rect.y, end: e - rect.y}, horizontal: true}));

        // Width descending, then axis, then start. Two distinct candidates can never
        // compare equal: same axis and same start is the same gutter, because
        // findGutters returns disjoint runs.
        const ranked = [
            ...(cuttable.horizontal ? inner(rows, rect.h).map((g) => ({g, horizontal: true})) : []),
            ...(cuttable.vertical ? inner(cols, rect.w).map((g) => ({g, horizontal: false})) : []),
            ...(cuttable.horizontal ? landmarkGutters : []),
        ].sort((p, q) => {
            const byWidth = (q.g.end - q.g.start) - (p.g.end - p.g.start);
            if (byWidth !== 0) return byWidth;
            if (p.horizontal !== q.horizontal) return p.horizontal ? -1 : 1;

            return p.g.start - q.g.start;
        });

        for (const {g, horizontal} of ranked) {
            // `extent` is what lets a snap bridge a hairline to a module boundary just
            // outside this gutter, and it is also what keeps such a cut off the region's
            // own frame. See MODULE_BRIDGE.
            const at = snapToEdge(
                g,
                horizontal ? yCandidates : xCandidates,
                horizontal ? rect.y : rect.x,
                horizontal ? moduleEdgeY : moduleEdgeX,
                {
                    bridge: moduleBridge,
                    extent: horizontal ? rect.h : rect.w,
                    spans: horizontal ? moduleSpanY : moduleSpanX,
                    landmarks: horizontal ? landmarkY : null,
                },
            );
            // REJECT, NEVER RELOCATE. Tested after the snap, because the snap is what
            // decides where the cut actually lands; a gutter straddling a protected
            // element's own edge is kept precisely when the snap put the cut on that
            // edge. Rejection only shortens `ranked`, so no cut ever moves and the
            // partition is untouched. If every candidate goes, the region is a leaf —
            // which is the right answer for a region that is entirely one module.
            //
            // A PAGE LANDMARK'S OWN BOUNDARY IS EXEMPT FROM THAT ONE REJECTION, because a
            // header drawn on top of a hero image is not the image's interior. See
            // pageLandmarks. The exemption stops there: `keepIntact` is a veto on cutting
            // through words, and a landmark boundary running through a headline would be
            // as wrong as any other cut that does.
            const here = (horizontal ? rect.y : rect.x) + at;
            const landmarkHere = onLandmarkBoundary(landmarks, rect, here, horizontal);
            if (!landmarkHere && cutsInsideProtected(keepWhole, rect, here, horizontal)) continue;
            if (cutsInsideProtected(keepIntact, rect, here, horizontal)) continue;
            if (horizontal && cutsInsideProtected(keepStacked, rect, here, true)) continue;
            const a = horizontal
                ? {x: rect.x, y: rect.y, w: rect.w, h: at, depth: rect.depth + 1, children: []}
                : {x: rect.x, y: rect.y, w: at, h: rect.h, depth: rect.depth + 1, children: []};
            const b = horizontal
                ? {x: rect.x, y: rect.y + at, w: rect.w, h: rect.h - at, depth: rect.depth + 1, children: []}
                : {x: rect.x + at, y: rect.y, w: rect.w - at, h: rect.h, depth: rect.depth + 1, children: []};

            // A MODULE'S OWN BOUNDARY OUTRANKS THE SIZE FLOOR. minSide exists to stop
            // slivers, and it cannot tell a sliver from a genuinely short module: a 76px
            // header strip is a real block, and refusing it merged switch.je's header,
            // logo and primary nav into its headline. A container has already passed the
            // 0.5% area gate, so cutting on its edge cannot produce the slivers minSide
            // was defending against.
            //
            // A BRIDGED CUT LANDS ON A MODULE EDGE TOO and is waived by the same rule. It
            // cannot widen this hole: bridging only reaches the seam between two stacked
            // modules, so a child ending there is a module rather than a leftover. The
            // narrower reading — waive only the child that holds the module — was
            // measured and is not needed: with the seam rule in place both fixtures,
            // kohde and HSBC are identical either way, and the narrower reading on its own
            // moved jonleverrier to 11 leaves and retail to 24 with a cut 4px out.
            // AND THE MODULE HAS TO BE HERE. A coordinate on its own has no position on
            // the other axis, so matching one anywhere on the page licensed a cut
            // anywhere on that line. tpagency.com is the case that found it: a 288x288
            // card in the hero at y=746 has its left edge at x=408, and that waived the
            // size floor for a vertical cut at x=408 down inside a pinned panel 1,500px
            // below it, producing 38px-wide slivers of black. On any page with a card
            // grid, every card's left and right edge became a licensed cut line for the
            // whole page.
            // A PAGE LANDMARK'S EDGE WAIVES IT TOO, and for the reason the rule was
            // written: a header strip is a real block. jtcgroup.com's is 94px tall and
            // jerseyfinance.com's is 58px, both under the 120px floor, and both are
            // exactly the block this tool is trying to measure.
            const onModuleEdge = landmarkHere || bounds.some((m) => (horizontal
                ? (here === m.y || here === m.y + m.h)
                    && m.x < rect.x + rect.w && rect.x < m.x + m.w
                : (here === m.x || here === m.x + m.w)
                    && m.y < rect.y + rect.h && rect.y < m.y + m.h));

            // A BOUNDARY OUTRANKS THE SIZE FLOOR, NOT THE DEFINITION OF A BLOCK. The
            // waiver says a short module is a real block; it cannot say a 1px strip is.
            // Measured on atkearney.com, whose `<footer>` begins at y=8597 one pixel
            // inside a band the stitch had already ended at 8596: the waiver took the
            // cut and the page gained a leaf of 1440x1. BAND_MIN_HEIGHT is the project's
            // existing answer to how short is too short to be a block, so it is the
            // answer here too rather than a second number.
            const degenerate = Math.min(a.w, a.h) < BAND_MIN_HEIGHT || Math.min(b.w, b.h) < BAND_MIN_HEIGHT;

            if ((!onModuleEdge || degenerate) && (tooSmall(a) || tooSmall(b))) continue;

            rect.children = [cut(a), cut(b)];

            return rect;
        }

        return rect;
    };

    return cut({x: 0, y: 0, w: width, h: height, depth: 0, children: []});
}

export const TILE_HEIGHT = 900;   // the capture viewport
// Enough that a module straddling a seam is in one tile's INTERIOR, where a real gutter
// around it can be found. The overlap does not make the seam harmless on its own: a
// tile's own frame is not evidence of a boundary and is discarded when cut lines are
// harvested (see segmentTall), so the overlap is what lets the genuine gutter near a
// seam survive — the neighbouring tile contributes it from inside itself.
export const TILE_OVERLAP = 150;

/**
 * Translate a block tree by (dx, dy) and renumber depth to continue from
 * `depth` at this node, `depth + 1` for its children, and so on. Used to graft
 * a band's own `segment()` subtree onto `segmentTall`'s root.
 */
function translate(node, dx, dy, depth) {
    return {
        x: node.x + dx,
        y: node.y + dy,
        w: node.w,
        h: node.h,
        depth,
        children: node.children.map((c) => translate(c, dx, dy, depth + 1)),
    };
}

/**
 * Rects arrive in PAGE coordinates; a tile or band is segmented in its own space,
 * where y = 0 is the slice's top. Shifting by -origin is what makes a snapped cut land
 * where the element actually is. Get the sign or the origin wrong and nothing fails
 * loudly — the partition still holds, the cuts are just confidently in the wrong place.
 *
 * Only y moves: every slice segmentTall takes spans the full page width, so dx is
 * always 0.
 */
function shiftRects(rects, dy) {
    if (!rects || rects.length === 0 || dy === 0) return rects;

    return rects.map((r) => ({...r, y: r.y + dy}));
}

/**
 * Segment a tall page in overlapping tiles, then stitch.
 *
 * Why tile at all: the widest gutter on a 12,000px page is whatever the biggest
 * whitespace band happens to be, so a single global XY-cut spends its first few
 * splits on one arbitrary band and never looks at structure elsewhere. Tiling forces
 * the cut to consider every part of the page at comparable scale.
 *
 * The seam rule: a tile's own edges are not real gutters (see `inner` in segment), so
 * tiles are cut independently — but `segment` always returns leaves that touch their
 * region's frame, so every tile top and bottom arrived in the cut set as if it were a
 * boundary. It is not: it is where the loop happened to stop. A uniformly dense stretch
 * with no gutter for thousands of pixels was still being chopped every 600 and 150
 * pixels, purely by tile arithmetic. So a line coinciding with its own tile's frame is
 * DISCARDED; 0 and `height` survive because they are the page's real extremes. A
 * genuine gutter next to a seam is unaffected, because the overlapping neighbour sees
 * it in its interior and contributes it from there — that is what TILE_OVERLAP is for.
 *
 * A harvested line is discarded for a second reason too: the stitch turns it into a
 * cut ACROSS THE WHOLE PAGE, so a line that is fine inside the column that produced it
 * can still run through a protected module in the column beside it. See the loop.
 *
 * THE HORIZONTAL BANDS ARE NOT THE ANSWER, THEY ARE THE SCAFFOLD. Harvesting only
 * the y-cut lines that tiles agree on and returning those bands as bare full-width
 * leaves would silently throw away every vertical cut the tiles found — a two-column
 * section or a row of cards would come out as one full-width block. Worse, the area
 * invariant would still hold (full-width bands tile the image perfectly), so nothing
 * in the partition tests would catch it. So each band is re-segmented in full 2D:
 * once tiling has cut the page down to a band short enough that no single arbitrary
 * gutter dominates it, a plain `segment()` on that band is the right tool, and its
 * result — including whatever columns it finds — becomes the band's subtree.
 */
/**
 * The shortest a stitched band is allowed to be.
 *
 * Not `minSide`: this is a floor on the STITCH, which has different work to do from the
 * splitter. Measured — at 8 the 11px band survives, and at 12 or more the merge starts
 * taking real boundaries with it.
 */
export const BAND_MIN_HEIGHT = 16;

/**
 * Collapse cut lines that sit closer together than a band is allowed to be.
 *
 * `segment` refuses to make a child below `minSide`, but the stitch built its bands from
 * the union of every tile's cut lines and checked only that the height was positive. Two
 * overlapping tiles that disagree by a pixel therefore produced a 1px band — seen on a
 * real page as `x=0 y=3978 w=1440 h=1`. Applying a floor here is not a new rule, it is an
 * existing one reaching the one path that skipped it.
 *
 * WHICH OF THE PAIR TO KEEP IS THE WHOLE POINT, and keeping the earlier one is wrong. On
 * switch.je the close pair was y=2517 (11px from any element) and y=2528 (exactly an
 * element edge); dropping by position threw away the only true boundary of the two. So
 * prefer the cut that lands on a real element edge, and fall back to the earlier one when
 * neither does or both do.
 *
 * The page's own top edge is never displaced, and the bottom edge is not negotiable — if
 * keeping it would leave a sliver, the cut before it is the one that goes.
 */
export function mergeNearbyCuts(ys, minBand, edgeSet = null) {
    if (ys.length <= 2) {
        return [...ys];
    }

    const onEdge = (y) => edgeSet !== null && edgeSet.has(y);

    const kept = [ys[0]];
    for (let i = 1; i < ys.length - 1; i++) {
        const y = ys[i];
        const previous = kept[kept.length - 1];
        if (y - previous >= minBand) {
            kept.push(y);
            continue;
        }
        if (onEdge(y) && !onEdge(previous) && kept.length > 1) {
            kept[kept.length - 1] = y;
        }
    }

    const last = ys[ys.length - 1];
    while (kept.length > 1 && last - kept[kept.length - 1] < minBand) {
        kept.pop();
    }
    kept.push(last);

    return kept;
}

export function segmentTall(edges, width, height, opts = {}) {
    if (height <= TILE_HEIGHT) {
        return segment(edges, width, height, opts);
    }

    const step = TILE_HEIGHT - TILE_OVERLAP;
    const cuts = new Set([0, height]);
    // Page coordinates, unshifted: a harvested line is a page coordinate too.
    const keepWhole = protectedRects(opts.rects, width, height);
    // BOTH of `segment`'s rejection populations, because a harvested line is judged
    // against the whole page and a heading is no more cuttable here than there. Ink, not
    // boxes, for the same reason segment uses ink — see inkBounds. Runs of text as well,
    // for the same reason both populations are here: this is the same rule, promoted.
    // A harvested line is always horizontal, so both kinds of repeated run apply to it and
    // there is nothing to separate here. See REPEAT.
    const keepIntact = [
        ...inkedTextRects(edges, width, height, opts.rects, opts.inkCluster),
        ...textRuns(edges, width, height, opts.rects, opts.textRun, opts.inkCluster),
        ...repeatedRuns(opts.rects, width, height),
    ];
    // Page coordinates too. A harvested line on a landmark's own edge is exempt from the
    // module rejection for the same reason it is inside `segment` — see pageLandmarks —
    // and this is the path that was actually dropping andybudd.com's header cut, which a
    // tile had already found: a 306x306 decorative dot patch spans y=-101 to 205 and the
    // stitch judged the line at y=105 against it.
    const landmarks = pageLandmarks(opts.rects, width);
    const page = {x: 0, y: 0, w: width, h: height};
    for (let top = 0; top < height; top += step) {
        const h = Math.min(TILE_HEIGHT, height - top);
        if (h <= 0) break;
        // Segment the tile in its own coordinate space, rects and all, then translate up.
        const slice = edges.subarray(top * width, (top + h) * width);
        const sub = segment(slice, width, h, {...opts, pageHeight: height, pageOffsetY: top, rects: shiftRects(opts.rects, -top)});
        for (const l of leaves(sub)) {
            for (const line of [l.y + top, l.y + l.h + top]) {
                // This tile's own frame is not evidence of a boundary.
                if ((line === top || line === top + h) && line !== 0 && line !== height) continue;
                // A BAND BOUNDARY IS A FULL-WIDTH CUT, whatever produced it. `segment`
                // only ever rejected cuts that crossed a protected element WITHIN THE
                // REGION BEING SPLIT, which is right there and wrong here: a cut at the
                // top of a stat card in the right-hand column is perfectly legal inside
                // that column, and the stitch then promotes it to a line across the whole
                // page — straight through the testimonial card beside it. That is how
                // switch.je's Jersey Finance quote stayed split after the interior of the
                // card was protected. So test the harvested line as what it will become.
                // Full-bleed media never exposed this, because a full-bleed element spans
                // the page and no region could produce such a cut in the first place.
                //
                // BOTH POPULATIONS, and the second one is here because it was once
                // missing: heading protection was added to `segment` alone, so a band
                // boundary taken from the right column's whitespace went on slicing a
                // left-column headline. Every rule `segment` applies to a cut applies
                // here too — this is the same line, promoted.
                if (!onLandmarkBoundary(landmarks, page, line, true)
                    && cutsInsideProtected(keepWhole, page, line, true)) continue;
                if (cutsInsideProtected(keepIntact, page, line, true)) continue;
                cuts.add(line);
            }
        }
        if (top + h >= height) break;
    }

    // Overlapping tiles produce duplicate and partial rows. Rebuild one clean
    // vertical partition from the distinct horizontal cut lines they agree on.
    const sortedCuts = [...cuts].filter((y) => y >= 0 && y <= height).sort((a, b) => a - b);
    const ys = mergeNearbyCuts(
        sortedCuts,
        opts.minBand ?? BAND_MIN_HEIGHT,
        new Set(edgeCandidates(opts.rects, true)),
    );

    const children = [];
    for (let i = 0; i < ys.length - 1; i++) {
        const y = ys[i];
        const h = ys[i + 1] - y;
        if (h <= 0) continue;
        // Re-segment the band in 2D instead of emitting it as a bare full-width leaf,
        // so vertical structure inside the band survives the stitch. The band slice
        // spans the full width, so translating by (0, y) is enough to place it.
        const bandSlice = edges.subarray(y * width, (y + h) * width);
        const bandRoot = segment(bandSlice, width, h, {...opts, pageHeight: height, pageOffsetY: y, rects: shiftRects(opts.rects, -y)});
        children.push(translate(bandRoot, 0, y, 1));
    }

    return {x: 0, y: 0, w: width, h: height, depth: 0, children};
}
