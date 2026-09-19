/**
 * TILES
 *
 * Cutting a capture into pieces a model can read.
 *
 *   node --test tools/audit/test/tiles.test.mjs
 *
 * The invariant that matters is that the tiles EXACTLY tile the page: no gap, no overlap,
 * starting at 0 and finishing at the page's height. Everything downstream translates
 * tile-local coordinates back to page coordinates by adding a tile's top, so a plan that
 * did not tile exactly would put blocks in the wrong place with nothing to notice.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tilePlan, TILE_HEIGHT, TILE_SCALE} from '../lib/tiles.mjs';

test('a short page is one tile', () => {
    assert.deepEqual(tilePlan(900), [{index: 0, top: 0, height: 900}]);
});

test('tiles tile the page exactly, with no gap and no overlap', () => {
    for (const height of [900, 1400, 1401, 5717, 13586, 24746]) {
        const plan = tilePlan(height);
        assert.equal(plan[0].top, 0, `${height}: starts at the top`);
        for (let i = 1; i < plan.length; i++) {
            assert.equal(plan[i].top, plan[i - 1].top + plan[i - 1].height, `${height}: tile ${i} abuts`);
        }
        const last = plan[plan.length - 1];
        assert.equal(last.top + last.height, height, `${height}: reaches the bottom`);
    }
});

test('no tile is taller than the ceiling', () => {
    for (const t of tilePlan(24746)) assert.ok(t.height <= TILE_HEIGHT);
});

test('indices are sequential from zero', () => {
    assert.deepEqual(tilePlan(4000).map((t) => t.index), [0, 1, 2]);
});

test('a zero-height page yields no tiles rather than throwing', () => {
    assert.deepEqual(tilePlan(0), []);
});

test('the scale is the one the sweep was measured at', () => {
    assert.equal(TILE_SCALE, 0.75);
    assert.equal(TILE_HEIGHT, 1400);
});
