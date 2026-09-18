/**
 * XY-CUT
 *
 * Density profiles, gutter finding, and the recursive partition (`segment`) that
 * turns an edge map into a tree of blocks.
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
