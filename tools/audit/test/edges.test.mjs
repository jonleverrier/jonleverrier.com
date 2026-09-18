/**
 * EDGES
 *
 *   node --test tools/audit/test/edges.test.mjs
 *
 * The hysteresis tests below are a REGRESSION HARNESS, not a specification: the stack
 * became a typed array to bound its memory, and the only acceptable outcome of that was
 * the same edge map, pixel for pixel. `referenceHysteresis` is the implementation it
 * replaced, verbatim, so the comparison is against the real previous behaviour rather
 * than against a fresh opinion about what it should do.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {
    toGrey, sobel, nonMaxSuppress, hysteresis, edgeMapFromPng, MAX_IMAGE_HEIGHT,
    CANNY_LOW, CANNY_HIGH,
} from '../lib/edges.mjs';

/** The implementation the typed-array stack replaced, kept exactly as it was. */
function referenceHysteresis(mag, width, height, low = CANNY_LOW, high = CANNY_HIGH) {
    const edges = new Uint8Array(width * height);
    const stack = [];
    for (let i = 0; i < mag.length; i++) {
        if (mag[i] >= high) {
            edges[i] = 1;
            stack.push(i);
        }
    }
    while (stack.length) {
        const i = stack.pop();
        const x = i % width;
        const y = (i / width) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const n = ny * width + nx;
                if (!edges[n] && mag[n] >= low) {
                    edges[n] = 1;
                    stack.push(n);
                }
            }
        }
    }

    return edges;
}

/** A deterministic PRNG: a test that disagrees must disagree the same way every run. */
const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const identical = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

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

test('hysteresis is unchanged, pixel for pixel, at every density', () => {
    // Sparse through saturated. The last one matters most: every pixel is a seed, so the
    // stack holds one entry per pixel and a capacity that is even one short would drop a
    // push and lose a weak neighbour somewhere downstream.
    for (const [seed, strongFraction, weakFraction] of [
        [1, 0.0, 0.0], [2, 0.01, 0.2], [3, 0.1, 0.5], [4, 0.5, 0.9], [5, 1.0, 1.0],
    ]) {
        const w = 64, h = 48;
        const rnd = lcg(seed);
        const mag = new Float32Array(w * h);
        for (let i = 0; i < mag.length; i++) {
            const r = rnd();
            mag[i] = r < strongFraction ? CANNY_HIGH + 10 : r < weakFraction ? CANNY_LOW + 1 : 0;
        }
        assert.ok(
            identical(hysteresis(mag, w, h), referenceHysteresis(mag, w, h)),
            `strong ${strongFraction}, weak ${weakFraction}: the edge map must not have moved`,
        );
    }
});

test('a dense page with a faint foot comes out the same, so the stack is big enough', () => {
    // The density sweep above cannot catch a stack that is too SMALL: writing past the
    // end of a typed array is silently ignored, and in a uniform map the pixels whose
    // pushes are dropped were already marked anyway, so the edge map is unchanged.
    //
    // This shape does catch it. Three quarters of the image is strong, so the seeding
    // loop alone fills most of the buffer; the last row is a weak trail reachable only
    // through one strong anchor at the very bottom, which is seeded LAST and is
    // therefore the first thing an undersized buffer loses. Measured against the
    // reference: at w*h it is identical, at half w*h the trail disappears.
    const w = 64, h = 48;
    const split = Math.floor(h * 0.75);
    const mag = new Float32Array(w * h);
    for (let y = 0; y < split; y++) {
        for (let x = 0; x < w; x++) mag[y * w + x] = CANNY_HIGH + 10;
    }
    mag[(h - 1) * w] = CANNY_HIGH + 10;
    for (let x = 1; x < w; x++) mag[(h - 1) * w + x] = CANNY_LOW + 1;

    const before = referenceHysteresis(mag, w, h);
    assert.ok(before[(h - 1) * w + w - 1] === 1, 'the far end of the trail must survive, or this proves nothing');
    assert.ok(identical(hysteresis(mag, w, h), before));
});

test('hysteresis is unchanged on a real page', async () => {
    // The synthetic maps above are noise; this is the shape of an actual page, where
    // edges are long connected runs and the propagation loop does most of the work.
    const {data, info} = await sharp('tools/audit/fixtures/jonleverrier.png')
        .removeAlpha().raw().toBuffer({resolveWithObject: true});
    const {width, height} = info;
    const {mag, dir} = sobel(toGrey(data, width, height), width, height);
    const thin = nonMaxSuppress(mag, dir, width, height);
    const before = referenceHysteresis(thin, width, height);
    const after = hysteresis(thin, width, height);
    assert.ok(identical(after, before), 'the fixture edge map must be identical');
    assert.ok(before.some((v) => v === 1), 'and must not be empty, or this proves nothing');
});

/** A PNG of a given size, on disk. Four pixels wide, so a tall one is still cheap. */
const pngOfHeight = async (height) => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-tall-'));
    const path = join(dir, `${height}.png`);
    const width = 4;
    await sharp(Buffer.alloc(width * height * 3, 128), {raw: {width, height, channels: 3}})
        .png().toFile(path);

    return path;
};

test('an image taller than the cap is declined, and says so in pixels', async () => {
    const path = await pngOfHeight(MAX_IMAGE_HEIGHT + 1);
    await assert.rejects(
        () => edgeMapFromPng(path),
        (e) => {
            assert.match(e.message, new RegExp(String(MAX_IMAGE_HEIGHT + 1)), 'name the height it got');
            assert.match(e.message, new RegExp(String(MAX_IMAGE_HEIGHT)), 'and the limit it broke');

            return true;
        },
    );
});

test('an image exactly at the cap is still segmented', async () => {
    // The cap is a limit, not a margin: the tallest page Chromium can screenshot has to
    // go through, or the check has quietly moved the ceiling down by one pixel.
    const {width, height, edges} = await edgeMapFromPng(await pngOfHeight(MAX_IMAGE_HEIGHT));
    assert.equal(height, MAX_IMAGE_HEIGHT);
    assert.equal(edges.length, width * height);
});
