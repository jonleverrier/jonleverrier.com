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
 * `segment` is the reason this file exists: the block tree it produces is a TRUE
 * PARTITION at every level. See segment's own doc comment for why that is the
 * measurement, not a tidiness detail.
 */

import {leaves} from './blocks.mjs';

export const GUTTER = {minRun: 8, maxDensity: 0.005};

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

/** Runs where density stays at or below maxDensity for at least minRun. `end` is exclusive. */
export function findGutters(density, opts = GUTTER) {
    const {minRun, maxDensity} = opts;
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

export const SEGMENT_DEFAULTS = {maxDepth: 4, minAreaFraction: 0.02, minSide: 120};

/**
 * Recursive XY-cut. Splits on the widest gutter, horizontal or vertical, whichever
 * is wider, and recurses into both halves.
 *
 * THE SPLIT PARTITIONS, IT DOES NOT TRIM. The cut lands at the gutter's MIDPOINT and
 * every pixel goes to one child or the other, so children exactly tile the parent and
 * total area is conserved at every depth.
 *
 * That is not a tidiness point, it is the measurement. Trim blocks to their content
 * instead and the gutters fall out of every leaf, so cutting a nine-card grid into
 * nine blocks quietly SHRINKS the measured area of that grid and inflates the
 * unassigned residual — the headline percentage would then depend on --depth, which
 * is indefensible in a report somebody is reading about their own site. With a true
 * partition, depth changes which labels get applied and never the arithmetic.
 */
export function segment(edges, width, height, opts = {}) {
    const {maxDepth, minAreaFraction, minSide} = {...SEGMENT_DEFAULTS, ...opts};
    const minArea = width * height * minAreaFraction;

    const cut = (rect) => {
        if (rect.depth >= maxDepth) return rect;

        const rows = findGutters(rowDensity(edges, width, rect));
        const cols = findGutters(colDensity(edges, width, rect));
        // Gutters touching an edge of the region are padding, not a divider: splitting
        // on one produces an empty child and a copy of the parent, which recurses
        // forever without making progress.
        const inner = (gs, extent) => gs.filter((g) => g.start > 0 && g.end < extent);
        const row = widestGutter(inner(rows, rect.h));
        const col = widestGutter(inner(cols, rect.w));

        const rowW = row ? row.end - row.start : 0;
        const colW = col ? col.end - col.start : 0;
        if (rowW === 0 && colW === 0) return rect;

        const horizontal = rowW >= colW;
        const g = horizontal ? row : col;
        const mid = (g.start + g.end) >> 1;

        const a = horizontal
            ? {x: rect.x, y: rect.y, w: rect.w, h: mid, depth: rect.depth + 1, children: []}
            : {x: rect.x, y: rect.y, w: mid, h: rect.h, depth: rect.depth + 1, children: []};
        const b = horizontal
            ? {x: rect.x, y: rect.y + mid, w: rect.w, h: rect.h - mid, depth: rect.depth + 1, children: []}
            : {x: rect.x + mid, y: rect.y, w: rect.w - mid, h: rect.h, depth: rect.depth + 1, children: []};

        const tooSmall = (r) => r.w * r.h < minArea || Math.min(r.w, r.h) < minSide;
        if (tooSmall(a) || tooSmall(b)) return rect;

        rect.children = [cut(a), cut(b)];

        return rect;
    };

    return cut({x: 0, y: 0, w: width, h: height, depth: 0, children: []});
}

export const TILE_HEIGHT = 900;   // the capture viewport
export const TILE_OVERLAP = 150;  // enough that a module straddling a seam appears whole in one tile

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
 * Segment a tall page in overlapping tiles, then stitch.
 *
 * Why tile at all: the widest gutter on a 12,000px page is whatever the biggest
 * whitespace band happens to be, so a single global XY-cut spends its first few
 * splits on one arbitrary band and never looks at structure elsewhere. Tiling forces
 * the cut to consider every part of the page at comparable scale.
 *
 * The seam rule: a tile's own edges are not real gutters (see `inner` in segment),
 * so tiles are cut independently and their leaf rows are then merged where they
 * ABUT — same x-extent, touching at the seam. Merging keeps the partition exact
 * because two abutting rects of equal width sum to their union.
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
    const rows = [];
    for (let top = 0; top < height; top += step) {
        const h = Math.min(TILE_HEIGHT, height - top);
        if (h <= 0) break;
        // Segment the tile in its own coordinate space, then translate down.
        const slice = edges.subarray(top * width, (top + h) * width);
        const sub = segment(slice, width, h, opts);
        for (const l of leaves(sub)) {
            rows.push({x: l.x, y: l.y + top, w: l.w, h: l.h, depth: 1, children: []});
        }
        if (top + h >= height) break;
    }

    // Overlapping tiles produce duplicate and partial rows. Rebuild one clean
    // vertical partition from the distinct horizontal cut lines they agree on.
    const cuts = new Set([0, height]);
    for (const r of rows) {
        cuts.add(r.y);
        cuts.add(r.y + r.h);
    }
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
        const bandRoot = segment(bandSlice, width, h, opts);
        children.push(translate(bandRoot, 0, y, 1));
    }

    return {x: 0, y: 0, w: width, h: height, depth: 0, children};
}
