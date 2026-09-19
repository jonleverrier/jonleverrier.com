/**
 * BANDS
 *
 * The model's boundaries, turned into the partition the measurement rests on.
 *
 *   node --test tools/audit/test/bands.test.mjs
 *
 * The invariant is the product, so most of this file asserts it directly: whatever the
 * model returns — gaps, overlaps, blocks that stop short of the page — the tree built from
 * it tiles the image exactly. A tree that does not is not a measurement of anything.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapBoundaries, mergeSeams, buildTree, SNAP_REACH} from '../lib/bands.mjs';
import {assertPartition, leaves, totalArea} from '../lib/blocks.mjs';

const b = (y0, y1, category = 'editorial', what = 'x', cols = 1) => ({y0, y1, category, what, cols, confidence: 0.9});

test('a boundary within reach moves to the element edge', () => {
    assert.deepEqual(snapBoundaries([118], [0, 120, 400]), [120]);
});

test('a boundary with no edge near it stays put', () => {
    assert.deepEqual(snapBoundaries([600], [0, 120, 400]), [600]);
});

/** The reach is INCLUSIVE: a boundary exactly SNAP_REACH away still moves. */
test('the reach is the one measured on the corpus', () => {
    assert.equal(SNAP_REACH, 40);
    assert.deepEqual(snapBoundaries([159], [200]), [159], 'a 41px gap is out of reach');
    assert.deepEqual(snapBoundaries([160], [200]), [200], 'a 40px gap is just inside it');
});

test('two boundaries snapping to one edge collapse', () => {
    assert.deepEqual(snapBoundaries([118, 122], [120]), [120]);
});

test('snapped boundaries come back sorted', () => {
    assert.deepEqual(snapBoundaries([400, 100], [100, 400]), [100, 400]);
});

test('no candidates leaves every boundary alone', () => {
    assert.deepEqual(snapBoundaries([100, 400], []), [100, 400]);
});

/* -------------------------------------------------------------------- tile seams */

test('blocks meeting at a seam with the same label merge', () => {
    const got = mergeSeams([b(0, 1400, 'brand', 'hero'), b(1400, 2000, 'brand', 'hero')], [1400]);
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].y0, got[0].y1], [0, 2000]);
});

test('blocks meeting at a seam with different labels do not', () => {
    const got = mergeSeams([b(0, 1400, 'brand', 'hero'), b(1400, 2000, 'routing', 'cards')], [1400]);
    assert.equal(got.length, 2);
});

/**
 * The guard on the merge. Two adjacent sections that happen to share a category are still
 * two sections, and merging them would hide a boundary a reader can see.
 */
test('blocks meeting away from a seam never merge, however alike', () => {
    const got = mergeSeams([b(0, 700, 'brand', 'hero'), b(700, 900, 'brand', 'hero')], [1400]);
    assert.equal(got.length, 2);
});

test('a merged run keeps the widest column count and the lowest confidence', () => {
    const a = {...b(0, 1400, 'routing', 'cards'), cols: 3, confidence: 0.9};
    const c = {...b(1400, 2000, 'routing', 'cards'), cols: 4, confidence: 0.6};
    const [got] = mergeSeams([a, c], [1400]);
    assert.equal(got.cols, 4);
    assert.equal(got.confidence, 0.6);
});

/* ------------------------------------------------------------------ the partition */

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

test('a block reaching past the page is clipped to it', () => {
    const root = buildTree([b(0, 5000)], 1440, 1200);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), 1440 * 1200);
});

test('every leaf keeps the label it came from', () => {
    const root = buildTree([b(0, 500, 'brand', 'logo'), b(500, 1200, 'navigation', 'nav')], 1440, 1200);
    assert.deepEqual(leaves(root).map((l) => l.label.category), ['brand', 'navigation']);
});

/** A region nothing covered is declared, never folded into whichever neighbour is nearer. */
test('a gap is labelled unclassified, not absorbed', () => {
    const root = buildTree([b(0, 500, 'brand'), b(600, 1200, 'routing')], 1440, 1200);
    const middle = leaves(root).find((l) => l.y === 500);
    assert.equal(middle.label.category, 'unclassified');
    assert.equal(middle.label.what, 'unlabelled region');
});

test('no blocks at all yields one leaf covering the page', () => {
    const root = buildTree([], 1440, 1200);
    const ls = leaves(root);
    assert.equal(ls.length, 1);
    assert.equal(ls[0].label.category, 'unclassified');
    assert.equal(totalArea(ls), 1440 * 1200);
});
