/**
 * XY-CUT
 *
 * Density profiles and gutter finding. The recursive partition is in this file too,
 * added in the task after this one.
 *
 *   node --test tools/audit/test/xycut.test.mjs
 *
 * A gutter is a run of rows or columns, spanning the full width or height of the
 * CURRENT REGION, whose edge density is near zero. minRun exists because line
 * spacing is also a near-zero run: without it, every paragraph cuts into separate
 * lines and the tree is meaningless.
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
