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
