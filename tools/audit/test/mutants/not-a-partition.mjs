/**
 * A MUTANT SEGMENTER, for one test.
 *
 * Module hooks that replace lib/xycut.mjs with a `segmentTall` returning two children
 * that overlap by a pixel. Everything else about the run is real.
 *
 * WHY A MUTANT AND NOT AN INPUT. The CLI's partition gate used to be reachable from
 * outside: a fractional rect in rects.json produced a tree whose children did not sum to
 * their parent. Validating rects closed that door on purpose, and with it the only way a
 * test could make the real segmenter emit a broken tree — the reviewer's 6,000
 * randomised integer-rect runs found no other. So the gate is now exercised by breaking
 * the segmenter rather than the input, which is also what it is actually there to catch:
 * a bug in this code, not a bad file.
 *
 * Used as `node --import test/mutants/register-not-a-partition.mjs tools/audit/segment.mjs`.
 * These live in a subdirectory so the `tools/audit/test/*.mjs` glob does not run them.
 */
export async function load(url, context, nextLoad) {
    if (url.endsWith('/lib/xycut.mjs')) {
        return {
            format: 'module',
            shortCircuit: true,
            // Two full-width children, the first one pixel too tall. Their areas do not
            // sum to the parent's and they overlap on one row — the two separate things
            // assertPartition checks.
            source: 'export function segmentTall(edges, width, height) {'
                + ' const half = Math.floor(height / 2);'
                + ' return {x: 0, y: 0, w: width, h: height, depth: 0, children: ['
                + '  {x: 0, y: 0, w: width, h: half + 1, depth: 1, children: []},'
                + '  {x: 0, y: half, w: width, h: height - half, depth: 1, children: []},'
                + ']};'
                + '}',
        };
    }

    return nextLoad(url, context);
}
