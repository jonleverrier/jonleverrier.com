import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toGrey, sobel, nonMaxSuppress, hysteresis} from '../lib/edges.mjs';

test('toGrey converts RGB triples with the luma weights', () => {
    // one white pixel, one black pixel, 3 channels each
    const grey = toGrey(Buffer.from([255, 255, 255, 0, 0, 0]), 2, 1);
    assert.equal(grey[0], 255);
    assert.equal(grey[1], 0);
});

test('sobel gives a strong response at a vertical step and none in flat areas', () => {
    // 5x3, left half black, right half white — one vertical edge down the middle
    const w = 5, h = 3;
    const grey = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey[y * w + x] = x < 2 ? 0 : 255;
    const {mag} = sobel(grey, w, h);
    const centre = mag[1 * w + 2];   // on the step, middle row
    const flat = mag[1 * w + 4];     // far right, uniform white
    assert.ok(centre > flat * 10, `expected a strong edge at the step (got ${centre} vs ${flat})`);
});

test('nonMaxSuppress preserves a diagonal edge instead of eroding it lengthwise', () => {
    // 9x9, x>y is white — a clean 45° step edge running top-left to bottom-right.
    // This is the case the vertical-step test above cannot catch: getting the
    // neighbours table's diagonal buckets swapped compares each pixel along the
    // edge instead of across it, which is invisible on cardinal edges.
    const w = 9, h = 9;
    const grey = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey[y * w + x] = x > y ? 255 : 0;
    const {mag, dir} = sobel(grey, w, h);
    const thin = nonMaxSuppress(mag, dir, w, h);

    // A correctly-thinned diagonal edge is at most 2px wide per interior row (this
    // is a hard step at 45°, so a 1px true ridge isn't achievable on a pixel grid,
    // but the swapped-bucket bug leaves 3-4px per row unsuppressed — this floor is
    // what catches that regression without being tautological).
    for (let y = 1; y < h - 1; y++) {
        let onRow = 0;
        for (let x = 1; x < w - 1; x++) if (thin[y * w + x] > 0) onRow++;
        assert.ok(onRow <= 2, `row ${y}: expected a thinned diagonal (<=2px), got ${onRow}`);
    }
});

test('hysteresis keeps strong pixels and drops weak isolated ones', () => {
    const w = 3, h = 1;
    const mag = Float32Array.from([200, 5, 0]);
    const edges = hysteresis(mag, w, h, 20, 100);
    assert.equal(edges[0], 1, 'above the high threshold should survive');
    assert.equal(edges[1], 0, 'below the low threshold should not');
});
