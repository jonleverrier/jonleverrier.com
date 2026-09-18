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
 * however the pixels look, and a cut may not land strictly inside one. Two populations
 * earn that, chosen by different rules and rejected by the same one — a full-bleed
 * `<video>`, `<img>` or `<canvas>` whose interior is only noise (FULL_BLEED), and a
 * module container: a card, a header, a testimonial box, whose interior gaps are its
 * own padding (MODULE_AREA). See protectedRects and cutsInsideProtected. Rects are
 * OPTIONAL throughout — without them every cut falls back to the gutter midpoint,
 * nothing is protected, and the pure-pixel path still works exactly as it did.
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

export function widestGutter(gutters) {
    let best = null;
    for (const g of gutters) {
        if (!best || g.end - g.start > best.end - best.start) best = g;
    }

    return best;
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
 * Where to cut inside gutter `g`, returned in `g`'s own index space (offsets from the
 * region's origin, which is what `segment` builds children from).
 *
 * `candidates` are absolute coordinates in the segmented image's space, so `origin` —
 * the region's x or y — converts between the two. The chosen candidate is the one
 * NEAREST THE MIDPOINT, not the first in the run: nearest-to-midpoint is unbiased,
 * deterministic, and by construction cannot leave the gutter. With no candidate in
 * range the midpoint stands.
 */
export function snapToEdge(g, candidates, origin, preferred = null) {
    const mid = (g.start + g.end) >> 1;
    if (!candidates || candidates.length === 0) return mid;

    const lo = origin + g.start;
    const hi = origin + g.end;
    const absMid = origin + mid;

    // A MODULE'S OWN BOUNDARY BEATS A NEARER ELEMENT EDGE. Both are real edges, but one
    // of them ends a module and the other merely ends some element inside the next one,
    // and a gutter wide enough to hold both is exactly where that distinction decides
    // the block. On jonleverrier the gutter below the header runs 115-307: its midpoint
    // is 211, the header's bottom edge is at 116 and the headline's top at 288, so
    // nearest-to-midpoint chose 288 by 18px and handed the header 170px of empty olive.
    //
    // Only ever picks between candidates ALREADY INSIDE this gutter, so no cut moves
    // outside the whitespace the pixels chose and the partition is untouched.
    let best = null;
    let bestDistance = Infinity;
    let bestPreferred = null;
    let bestPreferredDistance = Infinity;
    for (const c of candidates) {
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
 * Everything a cut may not pass through, in one list.
 *
 * TWO POPULATIONS, ONE REJECTION. Full-bleed media and module containers are selected by
 * completely different evidence — a tag and a size for one, a drawn box and a containment
 * test for the other — but what happens to a cut landing inside either is identical, so
 * the rejection is written once and both feed it.
 */
export const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

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

    return rects.filter((r) => TEXT_TAGS.has(r.tag) && (r.text || '').trim().length > 0 && isContentRect(r));
}

export function protectedRects(rects, width, pageHeight) {
    return [...fullBleedMedia(rects, width), ...moduleContainers(rects, width, pageHeight)];
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

export const SEGMENT_DEFAULTS = {maxDepth: 4, minAreaFraction: 0.02, minSide: 120};

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
    const {maxDepth, minAreaFraction, minSide, rects, pageHeight} = {...SEGMENT_DEFAULTS, ...opts};
    const minArea = width * height * minAreaFraction;
    const yCandidates = edgeCandidates(rects, true);
    const xCandidates = edgeCandidates(rects, false);
    // `height` is this slice's height; the whole page's is only different when segmentTall
    // called us for a tile or a band, and it says so.
    const keepWhole = protectedRects(rects, width, pageHeight ?? height);
    // Rejection only. These never steer a snap and never excuse the size floor — they
    // are a veto on cutting through words, not a statement about module boundaries.
    const keepIntact = textRects(rects);
    // The coordinates a snap should reach for when the gutter offers a choice.
    const moduleEdgeY = new Set(keepWhole.flatMap((m) => [m.y, m.y + m.h]));
    const moduleEdgeX = new Set(keepWhole.flatMap((m) => [m.x, m.x + m.w]));
    const tooSmall = (r) => r.w * r.h < minArea || Math.min(r.w, r.h) < minSide;

    const cut = (rect) => {
        if (rect.depth >= maxDepth) return rect;

        const rows = findGutters(rowDensity(edges, width, rect));
        const cols = findGutters(colDensity(edges, width, rect));
        // Gutters touching an edge of the region are padding, not a divider: splitting
        // on one produces an empty child and a copy of the parent, which recurses
        // forever without making progress.
        const inner = (gs, extent) => gs.filter((g) => g.start > 0 && g.end < extent);

        // Width descending, then axis, then start. Two distinct candidates can never
        // compare equal: same axis and same start is the same gutter, because
        // findGutters returns disjoint runs.
        const ranked = [
            ...inner(rows, rect.h).map((g) => ({g, horizontal: true})),
            ...inner(cols, rect.w).map((g) => ({g, horizontal: false})),
        ].sort((p, q) => {
            const byWidth = (q.g.end - q.g.start) - (p.g.end - p.g.start);
            if (byWidth !== 0) return byWidth;
            if (p.horizontal !== q.horizontal) return p.horizontal ? -1 : 1;

            return p.g.start - q.g.start;
        });

        for (const {g, horizontal} of ranked) {
            const at = snapToEdge(
                g,
                horizontal ? yCandidates : xCandidates,
                horizontal ? rect.y : rect.x,
                horizontal ? moduleEdgeY : moduleEdgeX,
            );
            // REJECT, NEVER RELOCATE. Tested after the snap, because the snap is what
            // decides where the cut actually lands; a gutter straddling a protected
            // element's own edge is kept precisely when the snap put the cut on that
            // edge. Rejection only shortens `ranked`, so no cut ever moves and the
            // partition is untouched. If every candidate goes, the region is a leaf —
            // which is the right answer for a region that is entirely one module.
            if (cutsInsideProtected(keepWhole, rect, (horizontal ? rect.y : rect.x) + at, horizontal)) continue;
            if (cutsInsideProtected(keepIntact, rect, (horizontal ? rect.y : rect.x) + at, horizontal)) continue;
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
            const absolute = (horizontal ? rect.y : rect.x) + at;
            const onModuleEdge = keepWhole.some((m) => (horizontal
                ? absolute === m.y || absolute === m.y + m.h
                : absolute === m.x || absolute === m.x + m.w));

            if (!onModuleEdge && (tooSmall(a) || tooSmall(b))) continue;

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
    // against the whole page and a heading is no more cuttable here than there.
    const keepIntact = textRects(opts.rects);
    const page = {x: 0, y: 0, w: width, h: height};
    for (let top = 0; top < height; top += step) {
        const h = Math.min(TILE_HEIGHT, height - top);
        if (h <= 0) break;
        // Segment the tile in its own coordinate space, rects and all, then translate up.
        const slice = edges.subarray(top * width, (top + h) * width);
        const sub = segment(slice, width, h, {...opts, pageHeight: height, rects: shiftRects(opts.rects, -top)});
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
                if (cutsInsideProtected(keepWhole, page, line, true)) continue;
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
        const bandRoot = segment(bandSlice, width, h, {...opts, pageHeight: height, rects: shiftRects(opts.rects, -y)});
        children.push(translate(bandRoot, 0, y, 1));
    }

    return {x: 0, y: 0, w: width, h: height, depth: 0, children};
}
