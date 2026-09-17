/**
 * BLOCKS TEST
 *
 * Unit tests for lib/blocks.mjs — the Block shape and the assertPartition()
 * invariant every later file in tools/audit relies on.
 *
 *   node --test tools/audit/test/blocks.test.mjs
 *
 * The limitation worth knowing: these are synthetic rectangles, not real captures.
 * They prove assertPartition's three checks (containment, overlap, area) each fire
 * on their own, but they say nothing about whether a real page's block tree is a
 * sensible one — that is what fixtures/ and debug.png are for.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {area, leaves, totalArea, overlaps, assertPartition} from '../lib/blocks.mjs';

const leaf = (x, y, w, h, depth = 1) => ({x, y, w, h, depth, children: []});

test('area multiplies width by height', () => {
    assert.equal(area(leaf(0, 0, 10, 4)), 40);
});

test('leaves returns only childless blocks, in tree order', () => {
    const root = {x: 0, y: 0, w: 10, h: 10, depth: 0, children: [leaf(0, 0, 10, 4), leaf(0, 4, 10, 6)]};
    assert.deepEqual(leaves(root).map((b) => b.h), [4, 6]);
});

test('leaves of a childless root is the root itself', () => {
    const root = leaf(0, 0, 10, 10, 0);
    assert.deepEqual(leaves(root), [root]);
});

test('overlaps is false for blocks that merely touch', () => {
    assert.equal(overlaps(leaf(0, 0, 10, 4), leaf(0, 4, 10, 6)), false);
});

test('overlaps is true for blocks sharing any pixel', () => {
    assert.equal(overlaps(leaf(0, 0, 10, 5), leaf(0, 4, 10, 6)), true);
});

test('assertPartition accepts children that exactly tile the parent', () => {
    const root = {x: 0, y: 0, w: 10, h: 10, depth: 0, children: [leaf(0, 0, 10, 4), leaf(0, 4, 10, 6)]};
    assert.doesNotThrow(() => assertPartition(root));
});

test('assertPartition rejects a gap between children', () => {
    const root = {x: 0, y: 0, w: 10, h: 10, depth: 0, children: [leaf(0, 0, 10, 4), leaf(0, 5, 10, 5)]};
    assert.throws(() => assertPartition(root), /area/i);
});

test('assertPartition rejects children that overlap', () => {
    // Areas sum to the parent's 100 (60 + 40) even though the children share
    // y=[4,6) — totalArea() adds each child's own w*h, it does not de-duplicate
    // shared pixels, so only the overlap check can catch this one.
    const root = {x: 0, y: 0, w: 10, h: 10, depth: 0, children: [leaf(0, 0, 10, 6), leaf(0, 4, 10, 4)]};
    assert.throws(() => assertPartition(root), /overlap/i);
});

test('assertPartition rejects a child that escapes its parent', () => {
    const root = {x: 0, y: 0, w: 10, h: 10, depth: 0, children: [leaf(0, 0, 12, 10)]};
    assert.throws(() => assertPartition(root), /escapes/i);
});
