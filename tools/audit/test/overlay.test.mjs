/**
 * OVERLAY
 *
 * Chrome that escaped every DOM rule, found in the pixels.
 *
 *   node --test tools/audit/test/overlay.test.mjs
 *
 * The synthetic images here are built so that each test fails for the reason it is
 * testing: a repeat with no detail, a repeat too small, a repeat in too few slices. The
 * real proof is the corpus — one detection in twenty-six sites, on the one page that has
 * a chat widget — and that is recorded in the module rather than asserted here, because a
 * committed 10MB capture would cost more than it proves.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    overlayRegions, overlayWarning, cellDetail, cellDifference,
    CELL, AGREE_FRACTION, AGREE_MIN, MIN_CELLS, DETAIL_MIN,
} from '../lib/overlay.mjs';

const WIDTH = 400;
const SLICE = 200;

/** A page of `slices` slices, flat grey, with an optional detailed box at a slice offset. */
const page = (slices, box = null, {inEvery = true} = {}) => {
    const height = SLICE * slices;
    const px = Buffer.alloc(WIDTH * height * 3, 128);
    if (box) {
        for (let s = 0; s < slices; s++) {
            if (!inEvery && s === slices - 1) continue;
            for (let y = 0; y < box.h; y++) {
                for (let x = 0; x < box.w; x++) {
                    const i = ((s * SLICE + box.y + y) * WIDTH + box.x + x) * 3;
                    // A chequer, so the cell has detail rather than being flat.
                    const on = ((x >> 2) + (y >> 2)) % 2 === 0;
                    px[i] = on ? 20 : 240;
                    px[i + 1] = on ? 20 : 240;
                    px[i + 2] = on ? 20 : 240;
                }
            }
        }
    }

    return {px, height};
};

test('a detailed box repeated in every slice is an overlay', () => {
    const {px, height} = page(6, {x: 240, y: 40, w: 80, h: 80});
    const found = overlayRegions(px, WIDTH, height, SLICE);
    assert.equal(found.length, 1);
    assert.equal(found[0].x, 240);
    assert.equal(found[0].y, 40);
    assert.equal(found[0].of, 6);
});

test('a page with nothing repeated has no overlay', () => {
    const {px, height} = page(6);
    assert.deepEqual(overlayRegions(px, WIDTH, height, SLICE), []);
});

/** Flat colour agrees with every slice and is a margin, not a widget. */
test('a repeated region with no detail is not an overlay', () => {
    const {px, height} = page(6);
    // Paint a flat block: agrees perfectly, carries no detail.
    for (let s = 0; s < 6; s++) {
        for (let y = 0; y < 80; y++) {
            for (let x = 0; x < 80; x++) {
                const i = ((s * SLICE + 40 + y) * WIDTH + 240 + x) * 3;
                px[i] = 200; px[i + 1] = 200; px[i + 2] = 200;
            }
        }
    }
    assert.deepEqual(overlayRegions(px, WIDTH, height, SLICE), []);
});

test('a repeat smaller than the minimum is a coincidence, not a widget', () => {
    const {px, height} = page(6, {x: 240, y: 40, w: CELL, h: CELL});
    assert.deepEqual(overlayRegions(px, WIDTH, height, SLICE), []);
    assert.equal(MIN_CELLS, 4);
});

/**
 * The threshold that was measured the wrong way round first: a fixed dissent allowance
 * let a four-slice page qualify on one agreeing slice, and hsbc.co.uk produced nineteen
 * regions of noise.
 */
test('too few slices to tell a repeat from a coincidence returns nothing', () => {
    const {px, height} = page(4, {x: 240, y: 40, w: 80, h: 80});
    assert.deepEqual(overlayRegions(px, WIDTH, height, SLICE), []);
});

test('agreement is a share of the slices, with a floor', () => {
    assert.equal(AGREE_FRACTION, 0.8);
    assert.equal(AGREE_MIN, 4);
});

test('a box missing from one slice of many is still an overlay', () => {
    const {px, height} = page(8, {x: 240, y: 40, w: 80, h: 80}, {inEvery: false});
    const found = overlayRegions(px, WIDTH, height, SLICE);
    assert.equal(found.length, 1);
    assert.ok(found[0].slices < found[0].of, 'it should record that one slice disagreed');
});

/* --------------------------------------------------------------------- the pieces */

test('cellDetail is zero for flat colour and large for a chequer', () => {
    const flat = Buffer.alloc(WIDTH * 200 * 3, 128);
    assert.equal(cellDetail(flat, WIDTH, 0, 0), 0);
    const {px} = page(1, {x: 0, y: 0, w: CELL, h: CELL});
    assert.ok(cellDetail(px, WIDTH, 0, 0) > DETAIL_MIN);
});

test('cellDifference is zero for the same pixels', () => {
    const {px} = page(2, {x: 0, y: 0, w: CELL, h: CELL});
    assert.equal(cellDifference(px, WIDTH, 0, 0, 0, SLICE), 0);
});

/* -------------------------------------------------------------------- the warning */

test('nothing found says nothing', () => {
    assert.equal(overlayWarning([], 5000), null);
    assert.equal(overlayWarning(null, 5000), null);
});

test('the warning names the region and calls it unmeasured, not empty', () => {
    const w = overlayWarning([{x: 1280, y: 680, w: 120, h: 120, slices: 8, of: 8}], 7405);
    assert.match(w, /120x120/);
    assert.match(w, /1280,680/);
    assert.match(w, /8 of 8/);
    assert.match(w, /unmeasured rather than content/);
});
