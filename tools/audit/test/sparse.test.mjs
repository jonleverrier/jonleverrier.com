/**
 * A LINE IS NOT A SET OF COLUMNS
 *
 * Columns are a two-dimensional structure. A region whose ink lies in one or two rows
 * has a line in it, not two things side by side, and any vertical cut through it is an
 * accident of how that line happens to dither.
 *
 *   node --test tools/audit/test/sparse.test.mjs
 *
 * tpagency.com is the page that showed it. The 1440x150 strip above its footer is blank
 * apart from the 1px rule drawing the footer's own top edge; that single row lights about
 * 700 scattered pixels, each column scoring 1/150 = 0.0067 against the 0.005 density
 * floor, so 32 column runs formed and the empty strip came out cut into eight columns of
 * nothing. Six more pages had the same thing somewhere: alchemy, altum, dept, milk, pola
 * and switch.je all had a blank band cut into columns by the colour step that bounds it.
 *
 * No density threshold can answer this. The region's median is zero, so every threshold
 * is the floor, and lowering the floor makes MORE columns quiet rather than fewer — that
 * was measured and is worse everywhere else. Counting how many rows have anything in them
 * at all answers it in one number, and `GUTTER.minRun` is the number already in hand: a
 * gutter must be at least that wide to be a gutter, so ink reaching across less than that
 * is not what a gutter separates.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {segment, GUTTER} from '../lib/xycut.mjs';
import {leaves, assertPartition, totalArea} from '../lib/blocks.mjs';

const WIDTH = 1440;
const HEIGHT = 300;
const OPTS = {maxDepth: 2, minSide: 120, minAreaFraction: 0.02};

/** A blank region with `rows` rows of dithered ink at the bottom, as a rule would draw. */
const rule = (rows) => {
    const edges = new Uint8Array(WIDTH * HEIGHT);
    for (let y = HEIGHT - rows; y < HEIGHT; y++) {
        // Dithered, not solid: every third pixel, which is what broke into 32 runs.
        for (let x = 0; x < WIDTH; x += 3) edges[y * WIDTH + x] = 1;
    }

    return edges;
};

test('a blank band bounded by a rule is not cut into columns', () => {
    const ls = leaves(segment(rule(1), WIDTH, HEIGHT, OPTS));

    assert.equal(ls.length, 1, `one rule of ink is not a column structure, got ${JSON.stringify(ls)}`);
});

test('two rows are not enough either', () => {
    const ls = leaves(segment(rule(2), WIDTH, HEIGHT, OPTS));

    assert.equal(ls.length, 1, `got ${JSON.stringify(ls)}`);
});

/** Two bars of solid ink with a 240px gap between them, `rows` rows tall. */
const bars = (rows) => {
    const edges = new Uint8Array(WIDTH * HEIGHT);
    for (let y = HEIGHT - rows; y < HEIGHT; y++) {
        for (let x = 0; x < 600; x++) edges[y * WIDTH + x] = 1;
        for (let x = 840; x < WIDTH; x++) edges[y * WIDTH + x] = 1;
    }

    return edges;
};

// The threshold is GUTTER.minRun, asserted from both sides on identical geometry: the
// same two bars with the same gutter between them, differing only in how many rows of
// the region they reach across.
test('ink reaching across a gutter-width of rows is cuttable again', () => {
    const below = leaves(segment(bars(GUTTER.minRun - 1), WIDTH, HEIGHT, OPTS));
    const above = leaves(segment(bars(GUTTER.minRun), WIDTH, HEIGHT, OPTS));

    assert.equal(below.length, 1, 'one row short of a gutter is still a line');
    assert.ok(above.length > 1, `at ${GUTTER.minRun} rows it is content, got ${JSON.stringify(above)}`);
});

// The guard is per axis and per region: a region with plenty of vertical extent is
// untouched, which is nearly every region on nearly every page.
test('a region with real content on both axes is cut as it always was', () => {
    const edges = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 40; y < 260; y++) {
        for (let x = 0; x < 600; x++) edges[y * WIDTH + x] = 1;
        for (let x = 840; x < WIDTH; x++) edges[y * WIDTH + x] = 1;
    }
    const ls = leaves(segment(edges, WIDTH, HEIGHT, OPTS));

    assert.ok(ls.length > 1, `two columns of content must still separate, got ${JSON.stringify(ls)}`);
});

test('a region the guard refuses is still a partition', () => {
    const root = segment(rule(1), WIDTH, HEIGHT, {...OPTS, maxDepth: 4});

    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), WIDTH * HEIGHT);
});

test('an utterly empty region is a leaf and nothing else', () => {
    const ls = leaves(segment(new Uint8Array(WIDTH * HEIGHT), WIDTH, HEIGHT, OPTS));

    assert.equal(ls.length, 1);
});
