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
 * the run. Rects are OPTIONAL throughout — without them every cut falls back to the
 * gutter midpoint and the pure-pixel path still works.
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
export function snapToEdge(g, candidates, origin) {
    const mid = (g.start + g.end) >> 1;
    if (!candidates || candidates.length === 0) return mid;

    const lo = origin + g.start;
    const hi = origin + g.end;
    const absMid = origin + mid;
    let best = null;
    let bestDistance = Infinity;
    for (const c of candidates) {
        if (c < lo) continue;
        if (c > hi) break;
        const d = Math.abs(c - absMid);
        if (d < bestDistance) {
            bestDistance = d;
            best = c;
        }
    }

    return best === null ? mid : best - origin;
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
    const {maxDepth, minAreaFraction, minSide, rects} = {...SEGMENT_DEFAULTS, ...opts};
    const minArea = width * height * minAreaFraction;
    const yCandidates = edgeCandidates(rects, true);
    const xCandidates = edgeCandidates(rects, false);
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
            const at = snapToEdge(g, horizontal ? yCandidates : xCandidates, horizontal ? rect.y : rect.x);
            const a = horizontal
                ? {x: rect.x, y: rect.y, w: rect.w, h: at, depth: rect.depth + 1, children: []}
                : {x: rect.x, y: rect.y, w: at, h: rect.h, depth: rect.depth + 1, children: []};
            const b = horizontal
                ? {x: rect.x, y: rect.y + at, w: rect.w, h: rect.h - at, depth: rect.depth + 1, children: []}
                : {x: rect.x + at, y: rect.y, w: rect.w - at, h: rect.h, depth: rect.depth + 1, children: []};

            if (tooSmall(a) || tooSmall(b)) continue;

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
export function segmentTall(edges, width, height, opts = {}) {
    if (height <= TILE_HEIGHT) {
        return segment(edges, width, height, opts);
    }

    const step = TILE_HEIGHT - TILE_OVERLAP;
    const cuts = new Set([0, height]);
    for (let top = 0; top < height; top += step) {
        const h = Math.min(TILE_HEIGHT, height - top);
        if (h <= 0) break;
        // Segment the tile in its own coordinate space, rects and all, then translate up.
        const slice = edges.subarray(top * width, (top + h) * width);
        const sub = segment(slice, width, h, {...opts, rects: shiftRects(opts.rects, -top)});
        for (const l of leaves(sub)) {
            for (const line of [l.y + top, l.y + l.h + top]) {
                // This tile's own frame is not evidence of a boundary.
                if ((line === top || line === top + h) && line !== 0 && line !== height) continue;
                cuts.add(line);
            }
        }
        if (top + h >= height) break;
    }

    // Overlapping tiles produce duplicate and partial rows. Rebuild one clean
    // vertical partition from the distinct horizontal cut lines they agree on.
    const ys = [...cuts].filter((y) => y >= 0 && y <= height).sort((a, b) => a - b);

    const children = [];
    for (let i = 0; i < ys.length - 1; i++) {
        const y = ys[i];
        const h = ys[i + 1] - y;
        if (h <= 0) continue;
        // Re-segment the band in 2D instead of emitting it as a bare full-width leaf,
        // so vertical structure inside the band survives the stitch. The band slice
        // spans the full width, so translating by (0, y) is enough to place it.
        const bandSlice = edges.subarray(y * width, (y + h) * width);
        const bandRoot = segment(bandSlice, width, h, {...opts, rects: shiftRects(opts.rects, -y)});
        children.push(translate(bandRoot, 0, y, 1));
    }

    return {x: 0, y: 0, w: width, h: height, depth: 0, children};
}
