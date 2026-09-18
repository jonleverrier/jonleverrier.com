/**
 * SNAP PREFERENCE
 *
 * Which edge a cut lands on when a gutter offers more than one.
 *
 *   node --test tools/audit/test/snap.test.mjs
 *
 * Both edges in that contest are real, but one of them ends a MODULE and the other
 * merely ends some element inside the next one. A gutter wide enough to hold both is
 * exactly where that distinction decides the block, and nearest-to-midpoint gets it
 * wrong: on jonleverrier the gutter below the header runs 115-307, its midpoint is 211,
 * the header's bottom edge is 116 and the headline's top is 288 — so the nearer
 * candidate won by 18px and handed the header 170px of empty background.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapToEdge} from '../lib/xycut.mjs';

// The real jonleverrier numbers, origin 0 so gutter coordinates are page coordinates.
const GUTTER = {start: 115, end: 307};
const CANDIDATES = [116, 288];

test('without a preference the nearest candidate to the midpoint wins', () => {
    assert.equal(snapToEdge(GUTTER, CANDIDATES, 0), 288);
});

test('a module boundary inside the gutter wins even when it is further away', () => {
    assert.equal(snapToEdge(GUTTER, CANDIDATES, 0, new Set([116])), 116);
});

test('a preferred coordinate outside the gutter is ignored', () => {
    // 400 is a module edge, but not in this gutter, so it cannot be chosen.
    assert.equal(snapToEdge(GUTTER, CANDIDATES, 0, new Set([400])), 288);
});

test('among several module boundaries the nearest to the midpoint is taken', () => {
    // Midpoint 210. Module edges at 120 and 300 are both 90 away; 200 is nearer but is
    // not a module edge, so it loses. The tie resolves to the earlier coordinate, which
    // is what keeps the result independent of the candidate list's order.
    assert.equal(snapToEdge({start: 100, end: 320}, [120, 200, 300], 0, new Set([120, 300])), 120);
});

test('a module boundary nearer the midpoint beats a further one', () => {
    // Midpoint 210: 200 is a module edge and only 10 away, so it wins outright.
    assert.equal(snapToEdge({start: 100, end: 320}, [120, 200, 300], 0, new Set([120, 200])), 200);
});

test('with no candidates at all the midpoint still applies', () => {
    assert.equal(snapToEdge(GUTTER, [], 0, new Set([116])), (115 + 307) >> 1);
});

test('the origin is respected, so tile and band slices snap correctly', () => {
    // Same gutter expressed 1000px down the page: candidates are absolute, the result
    // is relative to the region.
    assert.equal(snapToEdge(GUTTER, [1116, 1288], 1000, new Set([1116])), 116);
});
