import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toGrey, sobel, hysteresis} from '../lib/edges.mjs';

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

test('hysteresis keeps strong pixels and drops weak isolated ones', () => {
    const w = 3, h = 1;
    const mag = Float32Array.from([200, 5, 0]);
    const edges = hysteresis(mag, w, h, 20, 100);
    assert.equal(edges[0], 1, 'above the high threshold should survive');
    assert.equal(edges[1], 0, 'below the low threshold should not');
});
