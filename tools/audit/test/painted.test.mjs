/**
 * PAINTED
 *
 * DOM content that never made it into the pixels.
 *
 *   node --test tools/audit/test/painted.test.mjs
 *
 * boondmanager.com's testimonial cards are in `rects.json` and absent from the
 * screenshot, because the capture forces reduced motion and the reveal never fired. The
 * README called that undetectable. It is detectable, and the difficulty is entirely in
 * the false positive: klark.ai's logo strip is six logos with generous padding, 4.3% ink,
 * and completely correct. So these tests are mostly about what must NOT be flagged.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {
    inkPrefix, inkFraction, inkCount, contentRects, unpaintedBlocks, unpaintedWarning, UNPAINTED,
    blankRegions, blankRegionWarning, BLANK_REGION,
} from '../lib/painted.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {segmentTall} from '../lib/xycut.mjs';
import {leaves} from '../lib/blocks.mjs';
import {loadRects} from '../lib/rects.mjs';
import {runNotes} from '../lib/notes.mjs';

const run = promisify(execFile);
const WIDTH = 400;
const HEIGHT = 600;

/** A page of flat `colour`, with `marks` painted in a contrasting one. */
const painted = (width, height, colour, marks = []) => {
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        pixels[i * 3] = colour[0];
        pixels[i * 3 + 1] = colour[1];
        pixels[i * 3 + 2] = colour[2];
    }
    for (const m of marks) {
        for (let y = m.y; y < m.y + m.h; y++) {
            for (let x = m.x; x < m.x + m.w; x++) {
                const p = (y * width + x) * 3;
                pixels[p] = m.colour[0];
                pixels[p + 1] = m.colour[1];
                pixels[p + 2] = m.colour[2];
            }
        }
    }

    return {pixels, width, height};
};

/** `n` text elements stacked down a region, each 200x20. */
const elements = (n, top, tag = 'p') => Array.from({length: n}, (_, i) => ({
    x: 40, y: top + i * 30, w: 200, h: 20, tag, boxed: false, text: `line ${i}`,
}));

const page = (raw) => inkPrefix(raw.pixels, raw.width, raw.height);
const WHOLE = {x: 0, y: 0, w: WIDTH, h: HEIGHT};

test('a flat block has no ink, and a mark on it does', () => {
    const flat = page(painted(WIDTH, HEIGHT, [253, 245, 234]));
    assert.equal(inkFraction(flat, WHOLE), 0);

    const marked = page(painted(WIDTH, HEIGHT, [253, 245, 234], [{x: 10, y: 10, w: 100, h: 50, colour: [20, 20, 20]}]));
    assert.ok(inkFraction(marked, WHOLE) > 0.02, 'a 100x50 mark is ink');
    assert.ok(inkFraction(marked, WHOLE) < 0.03, 'and only that mark');
});

// THE MEASURE IS AGAINST THE BACKGROUND EACH ROW SITS ON. boondmanager's empty region is
// a dark void with a pale band across the bottom eighth of it; one colour for the whole
// block makes that band read as 12% ink and the region looks painted, when the band is
// the part of it painted with nothing.
test('a second background band is background, not ink', () => {
    const raw = painted(WIDTH, HEIGHT, [40, 42, 54]);
    for (let y = 520; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const p = (y * WIDTH + x) * 3;
            raw.pixels[p] = 235;
            raw.pixels[p + 1] = 238;
            raw.pixels[p + 2] = 250;
        }
    }

    assert.equal(inkFraction(page(raw), WHOLE), 0, 'two flat bands are two backgrounds');
});

// And a mark in EITHER band still counts, which is what makes the row-local background a
// measurement rather than a way of finding nothing.
test('a mark in either band is still ink', () => {
    const raw = painted(WIDTH, HEIGHT, [40, 42, 54]);
    for (let y = 300; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const p = (y * WIDTH + x) * 3;
            raw.pixels[p] = 235;
            raw.pixels[p + 1] = 238;
            raw.pixels[p + 2] = 250;
        }
    }
    for (const mark of [{y: 100, colour: [255, 255, 255]}, {y: 400, colour: [0, 0, 0]}]) {
        for (let y = mark.y; y < mark.y + 20; y++) {
            for (let x = 20; x < 120; x++) {
                const p = (y * WIDTH + x) * 3;
                raw.pixels[p] = mark.colour[0];
                raw.pixels[p + 1] = mark.colour[1];
                raw.pixels[p + 2] = mark.colour[2];
            }
        }
    }
    const measured = page(raw);

    assert.ok(inkCount(measured, {x: 0, y: 100, w: WIDTH, h: 20}) > 0, 'light on dark is ink');
    assert.ok(inkCount(measured, {x: 0, y: 400, w: WIDTH, h: 20}) > 0, 'dark on light is ink');
});

test('content is what carries text or media, and only what is inside the block', () => {
    const block = {x: 0, y: 0, w: 200, h: 200};
    const rects = [
        {x: 10, y: 10, w: 50, h: 20, tag: 'p', boxed: false, text: 'hello'},
        {x: 10, y: 40, w: 50, h: 20, tag: 'img', boxed: false, text: ''},
        {x: 10, y: 70, w: 50, h: 20, tag: 'div', boxed: false, text: '   '},
        {x: 190, y: 10, w: 50, h: 20, tag: 'p', boxed: false, text: 'straddles the edge'},
        {x: 10, y: 300, w: 50, h: 20, tag: 'p', boxed: false, text: 'below the block'},
    ];

    assert.deepEqual(contentRects(rects, block).map((r) => r.tag), ['p', 'img']);
});

// The defect itself: elements that say there is content, over pixels that say there is
// not. The block is blank and every element in it is blank with it.
test('a region full of elements and empty of pixels is flagged', () => {
    const blocks = [WHOLE];
    const rects = elements(20, 10);
    const found = unpaintedBlocks(page(painted(WIDTH, HEIGHT, [255, 255, 255])), blocks, rects);

    assert.equal(found.length, 1);
    assert.equal(found[0].domRects, 20);
    assert.equal(found[0].blankRects, 20);
    assert.equal(found[0].ink, 0);
    assert.match(unpaintedWarning(found), /never painted/);
});

// THE TRAP. klark.ai's logo strip: few elements, each of them painted, lots of space
// around them. Ink alone would flag it; the contradiction does not exist here.
test('a sparse block whose elements are all painted is not flagged', () => {
    const marks = [];
    const rects = elements(8, 40, 'img');
    for (const r of rects) {
        marks.push({x: r.x + 4, y: r.y + 4, w: 12, h: 12, colour: [10, 10, 10]});
    }
    const raw = painted(WIDTH, HEIGHT, [253, 245, 234], marks);
    const measured = page(raw);

    assert.ok(inkFraction(measured, WHOLE) < 0.02, 'this block IS sparse: under 2% ink');
    assert.deepEqual(unpaintedBlocks(measured, [WHOLE], rects), [], 'and every element of it is painted');
});

// The gates are two and they are separate: a handful of blank elements is an icon that
// did not load, not a region that failed.
test('a couple of blank elements is not a failed region', () => {
    const rects = elements(UNPAINTED.minRects - 1, 40);
    const found = unpaintedBlocks(page(painted(WIDTH, HEIGHT, [255, 255, 255])), [WHOLE], rects);

    assert.deepEqual(found, []);
});

test('a block where most elements did paint is not flagged', () => {
    const rects = elements(20, 10);
    const marks = rects.slice(0, 15).map((r) => ({x: r.x + 2, y: r.y + 2, w: 40, h: 12, colour: [0, 0, 0]}));
    const found = unpaintedBlocks(page(painted(WIDTH, HEIGHT, [255, 255, 255], marks)), [WHOLE], rects);

    assert.deepEqual(found, [], '5 blank of 20 is below the share this claims');
});

test('with no rects nothing is claimed', () => {
    const measured = page(painted(WIDTH, HEIGHT, [255, 255, 255]));

    assert.deepEqual(unpaintedBlocks(measured, [WHOLE], []), []);
    assert.deepEqual(unpaintedBlocks(measured, [WHOLE], null), []);
    assert.deepEqual(unpaintedBlocks(null, [WHOLE], elements(20, 10)), []);
    assert.equal(unpaintedWarning([]), null);
    assert.equal(unpaintedWarning(null), null);
});

// The real pages, which is the only check that can catch a threshold that works on
// invented pixels and not on a screenshot.
for (const fixture of ['jonleverrier', 'retail']) {
    test(`the ${fixture} fixture has nothing unpainted`, async () => {
        const png = `tools/audit/fixtures/${fixture}.png`;
        const {rects} = loadRects(`tools/audit/fixtures/${fixture}.rects.json`);
        const {edges, width, height} = await edgeMapFromPng(png);
        const ls = leaves(segmentTall(edges, width, height, {maxDepth: 4, rects}));
        const raw = await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject: true});
        const measured = inkPrefix(raw.data, raw.info.width, raw.info.height);

        assert.deepEqual(unpaintedBlocks(measured, ls, rects), [], 'a correctly rendered page is never flagged');
    });
}

test('the note is unmeasured and carries the blocks', () => {
    const meta = {url: 'https://a.com/', capturedUrl: 'https://a.com/', httpStatus: 200, fullHeight: 600,
        image: {width: WIDTH, height: HEIGHT}, consentDismissed: true, scrollCapHit: false};
    const found = unpaintedBlocks(page(painted(WIDTH, HEIGHT, [255, 255, 255])), [WHOLE], elements(20, 10));
    const notes = runNotes(meta, 'missing', null, found);

    assert.ok('contentNotPainted' in notes.conditions);
    assert.equal(notes.conditions.contentNotPainted.effect, 'unmeasured');
    assert.deepEqual(notes.conditions.contentNotPainted.facts.blocks, found);
    assert.equal('contentNotPainted' in runNotes(meta).conditions, false, 'and it needs the measurement');
});

// End to end, because the CLI is where the pixels, the rects and the tree meet.
test('the CLI writes the condition into blocks.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-painted-'));
    const width = 1440;
    const height = 1200;
    // A page with a painted header strip and a large empty region below it.
    const marks = [];
    for (let i = 0; i < 20; i++) {
        marks.push({x: 40 + i * 60, y: 20, w: 40, h: 30, colour: [20, 20, 20]});
    }
    const raw = painted(width, height, [255, 255, 255], marks);
    await sharp(raw.pixels, {raw: {width, height, channels: 3}}).png().toFile(join(dir, 'fullpage.png'));
    const rects = [
        ...Array.from({length: 20}, (_, i) => ({
            x: 40 + i * 60, y: 20, w: 40, h: 30, tag: 'a', boxed: false, text: `nav ${i}`,
        })),
        ...elements(24, 400),
    ];
    writeFileSync(join(dir, 'rects.json'), JSON.stringify(rects));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        url: 'https://a.com', capturedUrl: 'https://a.com/', httpStatus: 200, fullHeight: height,
        image: {width, height}, consentDismissed: true, consentBannerSeen: false, scrollCapHit: false,
    }));

    const {stdout, stderr} = await run('node', ['tools/audit/segment.mjs', dir]);
    const written = JSON.parse(readFileSync(join(dir, 'blocks.json'), 'utf8'));
    const condition = written.notes.conditions.contentNotPainted;

    assert.match(stdout, /contentNotPainted/);
    assert.match(stderr, /never painted/);
    assert.equal(condition.effect, 'unmeasured');
    assert.ok(condition.facts.blocks.length >= 1);
    assert.ok(condition.facts.blocks.every((b) => b.blankRects >= UNPAINTED.minRects));
});

// ---------------------------------------------------------------------------
// A REGION EMPTY IN BOTH RECORDS. alchemy.je gives 49% of its page to a black void with a
// "Scroll" indicator in it, and tpagency.com 45%; the DOM says nothing is there either,
// so there is no contradiction to find and both pages came through with `notes none`.
// ---------------------------------------------------------------------------

test('a void across half the page is flagged even with no DOM content', () => {
    const height = 4000;
    const measured = page(painted(WIDTH, height, [0, 0, 0]));
    const block = {x: 0, y: 0, w: WIDTH, h: Math.round(height * 0.5)};
    const found = blankRegions(measured, [block]);

    assert.equal(found.length, 1);
    assert.equal(found[0].ink, 0);
    assert.ok(found[0].share >= BLANK_REGION.minShare);
    assert.match(blankRegionWarning(found), /nothing painted/);
    assert.deepEqual(unpaintedBlocks(measured, [block], []), [], 'and the contradiction rule stays quiet');
});

// The size gate is the one carrying this rule: a small band of flat colour is ordinary
// design, and every page measured has several.
test('a small empty band is ordinary design', () => {
    const height = 4000;
    const measured = page(painted(WIDTH, height, [250, 250, 250]));
    const band = {x: 0, y: 100, w: WIDTH, h: Math.round(height * BLANK_REGION.minShare) - 100};

    assert.deepEqual(blankRegions(measured, [band]), []);
});

// Not a full-width strip: that would be the background of the rows it covers, which is
// the whole point of measuring per row — see "a second background band" above.
test('a large block with something painted in it is not a void', () => {
    const height = 4000;
    const marks = [{x: 100, y: 500, w: 200, h: 100, colour: [255, 255, 255]}];
    const measured = page(painted(WIDTH, height, [0, 0, 0], marks));
    const block = {x: 0, y: 0, w: WIDTH, h: Math.round(height * 0.5)};

    assert.ok(inkFraction(measured, block) > BLANK_REGION.maxInk, 'the mark has to be enough ink to matter');
    assert.deepEqual(blankRegions(measured, [block]), []);
});

for (const fixture of ['jonleverrier', 'retail']) {
    test(`the ${fixture} fixture has no blank region`, async () => {
        const png = `tools/audit/fixtures/${fixture}.png`;
        const {rects} = loadRects(`tools/audit/fixtures/${fixture}.rects.json`);
        const {edges, width, height} = await edgeMapFromPng(png);
        const ls = leaves(segmentTall(edges, width, height, {maxDepth: 4, rects}));
        const raw = await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject: true});
        const measured = inkPrefix(raw.data, raw.info.width, raw.info.height);

        assert.deepEqual(blankRegions(measured, ls), []);
    });
}

test('the void note is unmeasured and carries the blocks', () => {
    const meta = {url: 'https://a.com/', capturedUrl: 'https://a.com/', httpStatus: 200, fullHeight: 4000,
        image: {width: WIDTH, height: 4000}, consentDismissed: true, scrollCapHit: false};
    const measured = page(painted(WIDTH, 4000, [0, 0, 0]));
    const found = blankRegions(measured, [{x: 0, y: 0, w: WIDTH, h: 2000}]);
    const notes = runNotes(meta, 'missing', null, null, found);

    assert.ok('blankRegion' in notes.conditions);
    assert.equal(notes.conditions.blankRegion.effect, 'unmeasured');
    assert.deepEqual(notes.conditions.blankRegion.facts.blocks, found);
    assert.equal('blankRegion' in runNotes(meta).conditions, false, 'and it needs the measurement');
});
