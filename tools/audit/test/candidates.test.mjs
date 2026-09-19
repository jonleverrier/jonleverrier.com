/**
 * CANDIDATES
 *
 * The coordinates a block boundary may land on.
 *
 *   node --test tools/audit/test/candidates.test.mjs
 *
 * These assert the CONTRACT — which rects qualify, and that the answer is sorted and
 * de-duplicated — rather than any particular page's numbers. The thresholds themselves
 * are asserted once, because every committed fixture and every measurement in
 * PROGRESS.md was taken against them.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONTENT_RECT, isContentRect, edgeCandidates} from '../lib/candidates.mjs';

const r = (x, y, w, h) => ({x, y, w, h, tag: 'div', boxed: false, text: 'x'});

test('the thresholds are the ones the corpus was measured against', () => {
    assert.deepEqual(CONTENT_RECT, {maxH: 700, minW: 60, minH: 12});
});

test('a page-level wrapper is not a snap target', () => {
    assert.equal(isContentRect(r(0, 0, 1440, 9000)), false);
});

test('a hairline and an icon are not snap targets', () => {
    assert.equal(isContentRect(r(0, 0, 1440, 4)), false);
    assert.equal(isContentRect(r(0, 0, 20, 20)), false);
});

test('an ordinary element is', () => {
    assert.equal(isContentRect(r(0, 0, 400, 100)), true);
});

test('candidates are both edges, sorted and de-duplicated', () => {
    const got = edgeCandidates([r(0, 100, 400, 50), r(0, 150, 400, 50)], true);
    assert.deepEqual(got, [100, 150, 200]);
});

test('the other axis asks for x', () => {
    assert.deepEqual(edgeCandidates([r(120, 0, 400, 100)], false), [120, 520]);
});

test('no rects, no candidates', () => {
    assert.deepEqual(edgeCandidates([], true), []);
    assert.deepEqual(edgeCandidates(undefined, true), []);
});
