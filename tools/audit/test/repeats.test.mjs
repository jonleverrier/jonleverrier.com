/**
 * REPEATS, PICTURES AND BACKDROPS
 *
 * The three populations task 19 added: a run of repeated siblings, a picture that is not
 * full-bleed, and an element that leaves the page on more than one side.
 *
 *   node --test tools/audit/test/repeats.test.mjs
 *
 * All three were found by a person looking at a debug image — a product grid cut per card,
 * a photograph cut into thirteen, a header and hero fused behind decoration — and no
 * invariant could have caught any of them, because each produces a perfectly valid
 * partition of exactly the wrong shape. So these tests assert what each rule ADMITS and
 * what it REFUSES, on the geometry of the pages that found them, and never a leaf count.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isBackdrop, mediaModules, repeatedRuns, protectedRects, boundingRects, REPEAT, MODULE_AREA} from '../lib/xycut.mjs';

const PAGE = {w: 1440, h: 10000};
const rect = (tag, x, y, w, h, extra = {}) => ({tag, x, y, w, h, boxed: false, text: '', ...extra});

// A row of `n` boxes `w` x `h` starting at `x0`, `y`, with `gap` between them.
const row = (n, x0, y, w, h, gap, tag = 'div') => Array.from(
    {length: n},
    (_, i) => rect(tag, x0 + i * (w + gap), y, w, h),
);
// The same, stacked.
const column = (n, x, y0, w, h, gap, tag = 'li') => Array.from(
    {length: n},
    (_, i) => rect(tag, x, y0 + i * (h + gap), w, h),
);

const boxes = (rs) => rs.map((r) => `${r.x},${r.y} ${r.w}x${r.h}`);

// --- backdrops -------------------------------------------------------------------------

test('an element hanging off two sides of the page is a backdrop', () => {
    // gcsc.gg, measured: six of these blanket the top of the page.
    assert.equal(isBackdrop(rect('img', -319, -274, 1606, 1569), PAGE.w, PAGE.h), true);
    assert.equal(isBackdrop(rect('img', 192, -394, 1492, 1457), PAGE.w, PAGE.h), true);
});

test('one side is ordinary and stays a module', () => {
    // A hero wider than the viewport, a panel off the bottom, an off-canvas menu.
    assert.equal(isBackdrop(rect('img', -80, 100, 1600, 800), PAGE.w, PAGE.h), false);
    assert.equal(isBackdrop(rect('img', 0, 9800, 1440, 400), PAGE.w, PAGE.h), false);
    assert.equal(isBackdrop(rect('nav', -400, 0, 400, 900), PAGE.w, PAGE.h), false);
    // switch.je's decorative curve: the `svg` exclusion in MEDIA_TAGS is still doing the
    // work here, because this shape leaves the page on exactly one side.
    assert.equal(isBackdrop(rect('svg', 0, -76, 1440, 810), PAGE.w, PAGE.h), false);
});

test('an element inside the page is never a backdrop, however big', () => {
    assert.equal(isBackdrop(rect('img', 0, 0, 1440, 10000), PAGE.w, PAGE.h), false);
});

test('the test is asked in PAGE coordinates, not the slice it was handed', () => {
    // A full-width hero at page y=0..860, seen from a tile whose top is at y=1800. In the
    // tile's own space it starts 1800px "above the page", which is not a fact about it.
    const heroInTile = rect('img', -80, -1800, 1600, 860);

    assert.equal(isBackdrop(heroInTile, PAGE.w, PAGE.h), true, 'without the offset it looks like a backdrop');
    assert.equal(isBackdrop(heroInTile, PAGE.w, PAGE.h, 1800), false, 'with it, one side');
});

test('a backdrop is in none of the protected populations', () => {
    const backdrop = rect('img', -319, -274, 1606, 1569, {boxed: true});
    const ordinary = rect('img', 100, 200, 600, 500);
    const held = protectedRects([backdrop, ordinary], PAGE.w, PAGE.h);

    assert.deepEqual(boxes(held.filter((r) => r.x === backdrop.x && r.y === backdrop.y)), []);
    assert.ok(held.length > 0, 'and the ordinary picture is still there');
});

// --- pictures --------------------------------------------------------------------------

test('a picture inside the module band is one module', () => {
    // dept.agency, measured: 571x714 is 2.08% of its page and came out as 13 blocks.
    const photo = rect('img', 21, 2434, 571, 714);
    const page = 1440 * 13586;

    assert.ok(photo.w * photo.h / page > MODULE_AREA.min, 'the measurement this rests on');
    assert.equal(mediaModules([photo], 1440, 13586).length, 1);
});

test('an icon is below the band and a backdrop-sized picture is above it', () => {
    assert.deepEqual(mediaModules([rect('img', 10, 10, 40, 40)], PAGE.w, PAGE.h), []);
    assert.deepEqual(mediaModules([rect('img', 0, 0, 1440, 9000)], PAGE.w, PAGE.h), []);
});

test('only media tags; a card is the other population\'s business', () => {
    assert.deepEqual(mediaModules([rect('div', 100, 100, 600, 500, {boxed: true})], PAGE.w, PAGE.h), []);
    for (const tag of ['img', 'video', 'canvas', 'picture']) {
        assert.equal(mediaModules([rect(tag, 100, 100, 600, 500)], PAGE.w, PAGE.h).length, 1, tag);
    }
});

test('a picture is uncuttable but its edge is not a boundary', () => {
    const photo = rect('img', 21, 2434, 571, 714);
    const hero = rect('img', 0, 0, 1440, 800);
    const inProtected = protectedRects([photo, hero], PAGE.w, PAGE.h);
    const inBounds = boundingRects([photo, hero], PAGE.w, PAGE.h);

    assert.ok(boxes(inProtected).includes('21,2434 571x714'), 'a cut may not pass through it');
    assert.ok(!boxes(inBounds).includes('21,2434 571x714'), 'but it steers no snap');
    assert.ok(boxes(inBounds).includes('0,0 1440x800'), 'a full-bleed element still does');
});

// --- repeated runs ---------------------------------------------------------------------

test('four evenly-spaced boxes in a row are one run', () => {
    // pola.co.jp's product carousel: 259x475 cards at x=142, 441, 740, 1039.
    const cards = row(4, 142, 2132, 259, 475, 40);

    assert.deepEqual(boxes(repeatedRuns(cards, 1440, 10455)), ['142,2132 1156x475']);
});

test('THREE is a composition and is left alone', () => {
    // andybudd.com's Coaching / Educating / Speaking, which `dfbf10d` cost work to cut.
    const columns = row(3, 192, 874, 286, 286, 154, 'figure');

    assert.deepEqual(repeatedRuns(columns, 1440, 2911), []);
});

test('a nav of differently-sized labels at one gap is a run', () => {
    // clearleft.com: widths 59, 37, 60, 46, 43, 58 at gaps of 40, 39, 40, 40, 40.
    const at = [800, 899, 975, 1075, 1161, 1244];
    const w = [59, 37, 60, 46, 43, 58];
    const nav = at.map((x, i) => rect('li', x, 60, w[i], 21, {text: 'Services'}));

    assert.deepEqual(boxes(repeatedRuns(nav, 1440, 4904)), ['800,60 502x21']);
});

test('a stack of line-shaped links is a run; a row of them is not', () => {
    // whitepaper.co.uk's nine 301x44 topic links, and the row of four footer columns that
    // every horizontal slice through a footer looks like.
    const list = column(9, 401, 1062, 301, 43, 1);
    assert.equal(repeatedRuns(list, 1440, 1778).length, 1);

    const slice = row(4, 24, 3048, 312, 42, 40);
    assert.deepEqual(repeatedRuns(slice, 1440, 3752), [], 'a row of lines is a slice across columns');
});

test('a column only forbids the cut that would separate it', () => {
    const list = column(9, 401, 1062, 301, 43, 1);
    const [run] = repeatedRuns(list, 1440, 1778);

    assert.equal(run.stacked, true);
    const [rowRun] = repeatedRuns(row(4, 142, 2132, 259, 475, 40), 1440, 10455);
    assert.equal(rowRun.stacked, false);
});

test('unevenly spaced siblings are not a run', () => {
    // boondmanager scatters four 96x96 logos across 1,382px.
    const scattered = [29, 500, 900, 1315].map((x) => rect('div', x, 4495, 96, 96));

    assert.deepEqual(repeatedRuns(scattered, 1440, 10567), []);
});

test('overlapping siblings are not a run', () => {
    // jerseyfinance stacks twelve 322x34 dropdown labels, each 34px below and over the last.
    const stacked = Array.from({length: 12}, (_, i) => rect('div', 44, 140 + i * 20, 322, 34));

    assert.deepEqual(repeatedRuns(stacked, 1440, 3568), []);
});

test('siblings repeated once per viewport are too far apart to be a list', () => {
    // alchemy.je and kohde.agency pin a panel per viewport, so the stitched capture carries
    // the same element once per 900px slice. Left in, one of them vetoed every band
    // boundary it crossed and the page fell from 89 leaves to 39.
    const perSlice = column(5, 188, 2945, 360, 360, 540, 'g');

    assert.deepEqual(repeatedRuns(perSlice, 1440, 8637), []);
});

test('a run may not claim the page', () => {
    // weightmans' four 301x440 columns are 22% of a short page.
    const wide = row(4, 66, 1018, 301, 440, 34);

    assert.deepEqual(repeatedRuns(wide, 1440, 1778), []);
});

test('a container is not a sibling of what is inside it', () => {
    // A column layout gives the list, its wrapper and every item the same x and width.
    const list = column(9, 401, 1062, 301, 43, 1);
    const withWrappers = [
        rect('div', 401, 1018, 301, 440),
        rect('p', 401, 1024, 301, 21, {text: 'Current Topics'}),
        rect('ul', 401, 1061, 301, 397),
        ...list,
    ];

    assert.equal(repeatedRuns(withWrappers, 1440, 1778).length, 1, 'the wrapper must not veto the list');
});

test('a run is found even when something else shares its edge', () => {
    // The heading above whitepaper's list sits 17px from it; the list is 0 or 1px apart.
    const withHeading = [rect('p', 401, 1000, 301, 21, {text: 'Current Topics'}), ...column(9, 401, 1062, 301, 43, 1)];

    assert.equal(repeatedRuns(withHeading, 1440, 1778).length, 1);
});

test('no rects means no runs, and every threshold is a positive number', () => {
    assert.deepEqual(repeatedRuns([], 1440, 1000), []);
    assert.deepEqual(repeatedRuns(undefined, 1440, 1000), []);
    for (const [name, value] of Object.entries(REPEAT)) {
        assert.equal(typeof value, 'number', name);
        assert.ok(value > 0, name);
    }
});

test('the output is deterministic and independent of the order rects arrive in', () => {
    const rects = [...row(4, 142, 2132, 259, 475, 40), ...column(9, 401, 3062, 301, 43, 1)];
    const forwards = boxes(repeatedRuns(rects, 1440, 10455));
    const backwards = boxes(repeatedRuns([...rects].reverse(), 1440, 10455));

    assert.deepEqual([...forwards].sort(), [...backwards].sort());
});

// --- and the page that found each one ---------------------------------------------------

test('tools/audit/fixtures/retail.png: the product grid is one run, the footer columns are four', () => {
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));
    const runs = repeatedRuns(rects, 1440, 3752);

    const grid = runs.filter((r) => r.y === 1257 && !r.stacked);
    assert.ok(grid.length > 0, 'the 5-up product carousel at y=1257 is a row run');

    const footer = runs.filter((r) => r.stacked && r.y >= 3000 && r.y < 3400);
    assert.ok(footer.length >= 3, `the footer link columns are column runs, got ${footer.length}`);
    for (const f of footer) {
        assert.ok(f.w < 1440, 'each is one column wide, not the whole footer');
    }
});
