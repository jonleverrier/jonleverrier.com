/**
 * SURFACE
 *
 * The number the report prints.
 *
 *   node --test tools/audit/test/surface.test.mjs
 *
 * Two things are asserted hardest here, because both are ways a percentage can be wrong
 * while looking right: that the shares sum to one over the area actually measured, and
 * that `unclassified` is reported as itself rather than shared out among the four
 * categories a prospect is reading about.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {surfaceArea} from '../lib/surface.mjs';

const leaf = (y, h, category, coverage = 0.5) => ({
    x: 0, y, w: 1000, h, depth: 1, children: [], coverage,
    label: {category, what: 'x', cols: 1, confidence: 0.9},
});
const tree = (children) => ({x: 0, y: 0, w: 1000, h: children.reduce((a, c) => a + c.h, 0), depth: 0, children});

test('shares are of the whole image and sum to one', () => {
    const {full} = surfaceArea(tree([leaf(0, 400, 'brand'), leaf(400, 600, 'routing')]), 900);
    const sum = full.reduce((a, s) => a + s.share, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `shares summed to ${sum}`);
    assert.equal(full.find((s) => s.category === 'brand').share, 0.4);
});

test('blocks of the same category are added together', () => {
    // 200 + 300 of an 800px page.
    const {full} = surfaceArea(tree([leaf(0, 200, 'navigation'), leaf(200, 300, 'routing'), leaf(500, 300, 'navigation')]), 900);
    assert.equal(full.find((s) => s.category === 'navigation').share, 0.625);
    assert.equal(full.find((s) => s.category === 'routing').share, 0.375);
});

test('categories come back in the order the report prints them', () => {
    const {full} = surfaceArea(tree([leaf(0, 100, 'other'), leaf(100, 100, 'brand'), leaf(200, 100, 'promotion')]), 900);
    assert.deepEqual(full.map((s) => s.category), ['brand', 'promotion', 'other']);
});

/* ------------------------------------------------------------- above the fold */

test('the first viewport is measured separately and over its own area', () => {
    const {firstViewport} = surfaceArea(tree([leaf(0, 450, 'brand'), leaf(450, 1350, 'other')]), 900);
    assert.equal(firstViewport.find((s) => s.category === 'brand').share, 0.5);
});

test('a block straddling the fold counts only the part above it', () => {
    const {firstViewport} = surfaceArea(tree([leaf(0, 1800, 'brand')]), 900);
    assert.equal(firstViewport.find((s) => s.category === 'brand').share, 1);
});

test('a block entirely below the fold is not in the first viewport at all', () => {
    const {firstViewport} = surfaceArea(tree([leaf(0, 900, 'brand'), leaf(900, 900, 'promotion')]), 900);
    assert.equal(firstViewport.some((s) => s.category === 'promotion'), false);
});

/* ------------------------------------------------------------- honesty */

test('unclassified is reported, never shared out', () => {
    const {full, unmeasured} = surfaceArea(tree([leaf(0, 500, 'brand'), leaf(500, 500, 'unclassified')]), 900);
    assert.equal(full.find((s) => s.category === 'unclassified').share, 0.5);
    assert.equal(full.find((s) => s.category === 'brand').share, 0.5);
    assert.equal(unmeasured, 0.5);
});

/** The user's ruling: space is a measure across blocks, not a kind of block. */
test('each category carries how much of its area actually has ink', () => {
    const {full} = surfaceArea(tree([leaf(0, 500, 'routing', 0.04), leaf(500, 500, 'other', 0.6)]), 900);
    assert.equal(full.find((s) => s.category === 'routing').coverage, 0.04);
});

test('coverage across categories is area-weighted, not averaged', () => {
    const {coverage} = surfaceArea(tree([leaf(0, 900, 'routing', 0.1), leaf(900, 100, 'other', 0.9)]), 900);
    assert.ok(Math.abs(coverage - 0.18) < 1e-9, `got ${coverage}`);
});

/**
 * THIS TEST USED TO ASSERT THE OPPOSITE, and it encoded a bug. Treating "no coverage
 * recorded" as "fully covered" printed `100.0% ink` for every category of
 * visionarygrid.studio — a 24,746px page the ink pass declines on its memory budget —
 * directly beneath a note saying the figure was not available. A measurement we did not
 * take is null, and the report prints a dash.
 */
test('a leaf with no coverage recorded is unmeasured, not fully covered', () => {
    const bare = {x: 0, y: 0, w: 1000, h: 900, depth: 1, children: [],
        label: {category: 'brand', what: 'x', cols: 1, confidence: 1}};
    const {full, coverage} = surfaceArea(tree([bare]), 900);
    assert.equal(coverage, null);
    assert.equal(full.find((s) => s.category === 'brand').coverage, null);
});

test('a category measured in part reports coverage over the part that was measured', () => {
    const measured = {x: 0, y: 0, w: 1000, h: 500, depth: 1, children: [], coverage: 0.4,
        label: {category: 'brand', what: 'x', cols: 1, confidence: 1}};
    const not = {x: 0, y: 500, w: 1000, h: 500, depth: 1, children: [],
        label: {category: 'brand', what: 'y', cols: 1, confidence: 1}};
    const {full} = surfaceArea(tree([measured, not]), 900);
    assert.equal(full.find((s) => s.category === 'brand').coverage, 0.4);
});

test('a tree with no leaves does not divide by zero', () => {
    const empty = {x: 0, y: 0, w: 1000, h: 0, depth: 0, children: []};
    assert.doesNotThrow(() => surfaceArea(empty, 900));
});
