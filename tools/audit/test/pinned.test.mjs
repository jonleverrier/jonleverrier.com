/**
 * PINNED
 *
 *   node --test tools/audit/test/pinned.test.mjs
 *
 * No browser. Everything here is the arithmetic of the two questions lib/pinned.mjs asks —
 * did this element hold the viewport, and does it draw the same pixels every time — which
 * is where those decisions belong and where they can be checked without waiting for a page.
 *
 * The whole-capture behaviour is in test/slices.test.mjs, against a local page built to
 * carry every shape at once: a fixed header, a sticky nav that repeats, a sticky panel that
 * does not, and a card held in the viewport by script.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    PIN_DRIFT_FRACTION, SAME_PIXELS_MAX, choosePairs, comparableRegion, groupDisjoint,
    chromeVerdict, newCensus, pinnedBetween, pixelChange, preferredPairs, recordStep, samePixels,
} from '../lib/pinned.mjs';

/* ------------------------------------------------------------------ pinned or not */

const box = (id, x, y, w, h) => [id, x, y, w, h];

test('an element carried by the scroll is not pinned; one that holds its place is', () => {
    // The whole population question, and there is nothing in between on any page measured:
    // carried elements move by the full delta, pinned ones by nothing.
    const before = [box(1, 0, 0, 1440, 60), box(2, 0, 200, 1440, 400)];
    const after = [box(1, 0, 0, 1440, 60), box(2, 0, -700, 1440, 400)];
    assert.deepEqual(pinnedBetween(before, after, 900), [1]);
});

test('a header that slides itself out of view while the page moves 900 is still pinned', () => {
    // jerseyfinance.com, measured: the header travels 52px of its own accord while the page
    // travels 900. A strict "same box" test calls that carried, does not hide it, and it
    // paints a white band and a hairline across the middle of a paragraph.
    const before = [box(1, 0, 0, 1440, 58)];
    const after = [box(1, 0, -52, 1440, 58)];
    assert.deepEqual(pinnedBetween(before, after, 900), [1]);
});

test('the boundary is half the scroll, whatever the scroll was', () => {
    // The last scroll of a page is clamped and can be 70px, so the test has to be a share
    // of what actually moved rather than a pixel count.
    const at = (drift, delta) => pinnedBetween([box(1, 0, 0, 100, 100)], [box(1, 0, -drift, 100, 100)], delta);
    assert.deepEqual(at(34, 70), [1], 'just inside on a 70px clamped scroll');
    assert.deepEqual(at(35, 70), [], 'and just outside');
    assert.equal(PIN_DRIFT_FRACTION, 0.5);
});

test('sideways movement is never a pin', () => {
    // A carousel slide holds its vertical place and moves horizontally. It is not chrome.
    const before = [box(1, 0, 100, 400, 300)];
    const after = [box(1, -400, 100, 400, 300)];
    assert.deepEqual(pinnedBetween(before, after, 900), []);
});

test('an element in only one of the two measurements is no answer either way', () => {
    assert.deepEqual(pinnedBetween([box(1, 0, 0, 10, 10)], [box(2, 0, 0, 10, 10)], 900), []);
});

test('a page that did not move, or moved by nothing measurable, decides nothing', () => {
    // A scroll lock, an inner scroller, the bottom of the page: everything holds its place
    // when nothing moves, and calling all of it chrome would empty the image. A delta that
    // is not a number at all — a scroll position that came back undefined — must not be
    // read as "everything is pinned" either, which is what the arithmetic alone does.
    const same = [box(1, 0, 0, 1440, 60), box(2, 0, 200, 1440, 400)];
    assert.deepEqual(pinnedBetween(same, same, 0), []);
    assert.deepEqual(pinnedBetween(same, same, undefined), []);
    assert.deepEqual(pinnedBetween(same, same, -900), [], 'nor a page that went backwards');
});

/* ---------------------------------------------------------------------- the census */

test('the census only ever compares consecutive measurements', () => {
    // An element carried past the viewport and back — a slide in a loop — can sit at the
    // same place two viewports apart without ever having held it. Comparing step 0 with
    // step 2 would call that pinned and delete it.
    const census = newCensus();
    recordStep(census, {scrollY: 0, boxes: [box(1, 0, 100, 200, 200)]});
    recordStep(census, {scrollY: 900, boxes: [box(1, 0, -800, 200, 200)]});
    recordStep(census, {scrollY: 1800, boxes: [box(1, 0, 100, 200, 200)]});
    assert.equal(census.pinnedAt.has(1), false);
});

test('the census records which pairs an element was pinned across', () => {
    const census = newCensus();
    recordStep(census, {scrollY: 0, boxes: [box(7, 0, 0, 1440, 60)]});
    recordStep(census, {scrollY: 900, boxes: [box(7, 0, 0, 1440, 60)]});
    recordStep(census, {scrollY: 1800, boxes: [box(7, 0, 0, 1440, 60)]});
    assert.deepEqual(census.pinnedAt.get(7), [0, 1]);
    assert.deepEqual(census.steps, [0, 900, 1800]);
});

/* -------------------------------------------------------------- what to compare */

test('only the part of the element on screen at BOTH offsets is compared', () => {
    // A header that has slid half out of view is only comparable over the part of itself
    // that both shots contain — in element-local pixels, not viewport ones.
    const region = comparableRegion([0, 0, 1440, 58], [0, -52, 1440, 58], 1440, 900);
    assert.ok(region.h > 0 && region.h < 10, `the overlap is the bottom few rows: ${region.h}`);
    assert.equal(region.ay - 0, region.by - -52, 'the same element-local row in both images');
});

test('an element with nothing on screen at both offsets cannot be decided', () => {
    // Entirely above the viewport at the second offset: there is no comparison to make, and
    // saying so is the only honest answer.
    assert.equal(comparableRegion([0, 0, 1440, 58], [0, -58, 1440, 58], 1440, 900), null);
});

test('the outermost pixel of the box is left out of the comparison', () => {
    // Where a neighbour's paint and a fractional border land. A 44x44 box compares 42x42.
    const region = comparableRegion([100, 100, 44, 44], [100, 100, 44, 44], 1440, 900);
    assert.deepEqual([region.w, region.h], [42, 42]);
});

/* ------------------------------------------------------------------- same pixels */

/** A raw RGB image with a filled rectangle, for the comparisons below. */
const image = (width, height, fills) => {
    const data = Buffer.alloc(width * height * 3, 255);
    for (const [x, y, w, h, colour] of fills) {
        for (let row = y; row < y + h; row++) {
            for (let col = x; col < x + w; col++) {
                const p = (row * width + col) * 3;
                data[p] = colour[0];
                data[p + 1] = colour[1];
                data[p + 2] = colour[2];
            }
        }
    }

    return data;
};

const W = 200;
const H = 120;

test('the same rendering twice is the same pixels', () => {
    const a = image(W, H, [[10, 10, 100, 50, [255, 0, 0]]]);
    const b = image(W, H, [[10, 10, 100, 50, [255, 0, 0]]]);
    const change = pixelChange(a, b, [10, 10, 100, 50], [10, 10, 100, 50], W, H);
    assert.equal(change.fraction, 0);
    assert.equal(samePixels(change), true);
});

test('a rendering shifted by a pixel INSIDE the same box is still the same pixels', () => {
    // A pinned element is not always at a whole pixel: the box comes back rounded to the
    // same place while the paint lands a device pixel lower. Measured on
    // jerseyfinance.com's header, which had slid 52.4px — the box said one thing and the
    // border row another, and without the shift it read as a different element.
    // A box that does not move, with a mark inside it that lands one row lower.
    const a = image(W, H, [[10, 10, 100, 50, [255, 0, 0]], [10, 30, 100, 10, [255, 255, 255]]]);
    const b = image(W, H, [[10, 10, 100, 50, [255, 0, 0]], [10, 31, 100, 10, [255, 255, 255]]]);
    const box$ = [10, 10, 100, 50];
    assert.ok(
        pixelChange(a, b, box$, box$, W, H).fraction <= SAME_PIXELS_MAX,
        'the same paint one row down is the same paint',
    );
    // …and the shift is doing the work: aligned edge to edge, two rows of it differ.
    const plain = comparableRegion(box$, box$, W, H);
    let differing = 0;
    for (let y = 0; y < plain.h; y++) {
        for (let x = 0; x < plain.w; x++) {
            const pa = ((plain.ay + y) * W + plain.ax + x) * 3;
            const pb = ((plain.by + y) * W + plain.bx + x) * 3;
            if (a[pa] !== b[pb] || a[pa + 1] !== b[pb + 1] || a[pa + 2] !== b[pb + 2]) differing++;
        }
    }
    assert.ok(differing / (plain.w * plain.h) > SAME_PIXELS_MAX, `without the shift: ${differing} pixels`);
});

test('a panel that swaps its content is NOT the same pixels', () => {
    // tpagency.com in miniature, and the reason this measurement exists at all: the panel
    // is the same size, in the same place, drawn on the same background, and a line of it
    // has changed. Comparing rects or text would call it chrome and delete 45% of the page.
    const a = image(W, H, [[0, 0, 200, 120, [0, 0, 0]], [20, 40, 60, 20, [255, 255, 255]]]);
    const b = image(W, H, [[0, 0, 200, 120, [0, 0, 0]], [20, 40, 60, 20, [255, 0, 128]]]);
    const change = pixelChange(a, b, [0, 0, 200, 120], [0, 0, 200, 120], W, H);
    assert.ok(change.fraction > SAME_PIXELS_MAX, `a swapped line is a change: ${change.fraction}`);
    assert.equal(samePixels(change), false);
});

test('a difference too small to be the content is tolerated', () => {
    // One stray pixel of a neighbour's antialiasing is not a page swapping its panel.
    const a = image(W, H, [[0, 0, 200, 120, [0, 0, 0]]]);
    const b = image(W, H, [[0, 0, 200, 120, [0, 0, 0]], [100, 60, 1, 1, [255, 255, 255]]]);
    assert.equal(samePixels(pixelChange(a, b, [0, 0, 200, 120], [0, 0, 200, 120], W, H)), true);
});

test('nothing to compare is not the same pixels', () => {
    assert.equal(samePixels(null), false, 'undecided must never be read as chrome');
});

/* ------------------------------------------------------- which offsets to visit */

test('the pair starting at the top of the page is the last resort, not the first', () => {
    // At scroll 0 a page is in a state it is never in again — a back-to-top button has not
    // faded in, a nav has not swapped to its scrolled theme. Measured on jerseyfinance.com:
    // comparing the top against a scrolled offset made its back-to-top button 93% different
    // from itself, which would have left it repeating down the page.
    assert.deepEqual(preferredPairs([0, 1, 2]), [1, 2]);
    assert.deepEqual(preferredPairs([0]), [0], 'but a header only comparable there still is');
});

test('the fewest offsets that can decide everything are visited', () => {
    const want = new Map([[1, [2, 3]], [2, [2]], [3, [3]], [4, [2]]]);
    const chosen = choosePairs(want);
    assert.equal(chosen.length, 2);
    assert.deepEqual(chosen.map((c) => c.pair), [2, 3]);
    assert.deepEqual(chosen[0].ids.sort(), [1, 2, 4]);
});

test('the number of offsets visited is capped', () => {
    const want = new Map([[1, [0]], [2, [1]], [3, [2]], [4, [3]], [5, [4]]]);
    assert.equal(choosePairs(want, 2).length, 2);
});

/* ---------------------------------------------------- who can share a photograph */

test('two elements that overlap are photographed separately', () => {
    // Otherwise each is part of the other's picture. Measured: a full-viewport pinned panel
    // covers a fixed header at one offset and not at the other, and the header's own band
    // came out 99.8% different — magenta against red — and was about to be called content.
    const boxes = new Map([[1, [0, 0, 1440, 900]], [2, [0, 0, 1440, 60]]]);
    const {groups} = groupDisjoint([1, 2], [boxes]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0], [1], 'the largest goes first, so it is the one left alone');
});

test('elements that do not overlap share one photograph', () => {
    const boxes = new Map([[1, [0, 0, 1440, 60]], [2, [0, 860, 1440, 40]], [3, [20, 500, 240, 120]]]);
    const {groups} = groupDisjoint([1, 2, 3], [boxes]);
    assert.equal(groups.length, 1);
});

test('an overlap at EITHER offset separates them', () => {
    // The panel is only over the header at one of the two offsets, which is exactly how the
    // defect appeared: identical at one end, covered at the other.
    const atA = new Map([[1, [0, 60, 1440, 900]], [2, [0, 0, 1440, 60]]]);
    const atB = new Map([[1, [0, 0, 1440, 900]], [2, [0, 0, 1440, 60]]]);
    assert.equal(groupDisjoint([1, 2], [atA, atB]).groups.length, 2);
    assert.equal(groupDisjoint([1, 2], [atA]).groups.length, 1, 'and one offset alone would not have seen it');
});

test('past the group cap, the rest are left undecided rather than compared wrongly', () => {
    const boxes = new Map([[1, [0, 0, 100, 100]], [2, [0, 0, 100, 100]], [3, [0, 0, 100, 100]]]);
    const {groups, left} = groupDisjoint([1, 2, 3], [boxes], 2);
    assert.equal(groups.length, 2);
    assert.deepEqual(left, [3]);
});

/* ------------------------------------------------------------- chrome, content, neither */

const VIEWPORT_H = 900;
const at = (y, h) => ({box: [0, y, 1440, h]});

test('pixels that match convict; pixels that differ acquit', () => {
    const same = {fraction: 0, compared: 1000};
    const moved = {fraction: 0.8, compared: 1000};
    assert.equal(chromeVerdict(same, at(0, 100), at(0, 100), VIEWPORT_H).verdict, 'chrome');
    assert.equal(chromeVerdict(moved, at(0, 100), at(0, 100), VIEWPORT_H).verdict, 'content');
});

/**
 * jerseyfinance.com. A header that retracts on scroll down is above the viewport by the
 * time the page has moved 900, so no two offsets show the same part of it. Left undecided
 * it painted its half-retracted remains across the middle of a paragraph.
 */
test('an element that has scrolled up out of view is chrome', () => {
    const got = chromeVerdict(null, at(-58, 58), at(-58, 58), VIEWPORT_H);
    assert.equal(got.verdict, 'chrome');
    assert.match(got.why, /off screen/);
});

/**
 * jersey.com. Its footer sat 1,064px BELOW the fold at both sampled offsets — never
 * photographed, never compared, nothing learned. Convicted, it was hidden from every
 * slice and the capture came back with 1,694px of white where a footer is.
 */
test('an element below the fold at both offsets is not convicted', () => {
    const got = chromeVerdict(null, at(1964, 821), at(1064, 821), VIEWPORT_H);
    assert.equal(got.verdict, 'undecided', 'nothing was seen, so nothing may be concluded');
    assert.match(got.why, /below the fold/);
});

test('an element on screen at one offset and below the fold at the other is still chrome', () => {
    // It was seen going; that is the retracting case, not the never-reached one.
    assert.equal(chromeVerdict(null, at(400, 200), at(1200, 200), VIEWPORT_H).verdict, 'chrome');
});

test('an element nobody could describe is undecided', () => {
    assert.equal(chromeVerdict(null, null, at(0, 100), VIEWPORT_H).verdict, 'undecided');
    assert.equal(chromeVerdict(null, at(0, 100), null, VIEWPORT_H).verdict, 'undecided');
});
