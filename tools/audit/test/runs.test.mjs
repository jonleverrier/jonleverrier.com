/**
 * TEXT RUNS
 *
 * A line of text is one thing, not one thing per element.
 *
 *   node --test tools/audit/test/runs.test.mjs
 *
 * tpagency.com pins a panel across two viewports, each showing a single line — "Lead
 * with Strategy & Insight" — built from two <span>s with an 18px space between their
 * ink. That space is a run of quiet pixels spanning the whole region, which is exactly
 * what a gutter is, so a vertical cut went down it and a 900px-tall panel of black came
 * back as five columns cut between the words. `inkedTextRects` could not help: it
 * protects each element on its own, and each element here is half a sentence.
 *
 * THREE PIECES OF EVIDENCE, and the third one is here because pixels alone could not
 * finish the job. tpagency's word space is 18px against 38px of ink, 0.47 of the line;
 * natwest's footer — three accordion headings that MUST stay in three columns — is 27px
 * against 56px, 0.48. No threshold fits between them. The DOM knows the difference: one
 * pair shares a 77px line box, the other is two columns of a 380px wrapper.
 *
 * See TEXT_RUN in lib/xycut.mjs for every threshold and the measurement behind it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lineSpans, textRuns, segmentTall, TEXT_RUN} from '../lib/xycut.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {leaves} from '../lib/blocks.mjs';

const WIDTH = 1440;
const HEIGHT = 1200;

/** A blank edge map, and a brush for laying ink into it. */
const canvas = (width = WIDTH, height = HEIGHT) => {
    const edges = new Uint8Array(width * height);
    const ink = (x0, x1, y0, y1) => {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) edges[y * width + x] = 1;
        }
    };

    return {edges, ink};
};

const rect = (tag, x, y, w, h, text = 'words') => ({x, y, w, h, tag, boxed: false, text});

/**
 * The tpagency shape: one line, two elements, a line box around both.
 * `containerHeight` is what separates a line box from a column wrapper.
 */
const oneLine = ({gap = 17, containerHeight = 77, secondInkTop = 214} = {}) => {
    const {edges, ink} = canvas();
    const aLeft = 389;
    const aRight = 612;
    const bLeft = aRight + gap;
    const bRight = bLeft + 412;
    ink(aLeft, aRight, 214, 253);
    ink(bLeft, bRight, secondInkTop, secondInkTop + 64);
    const rects = [
        // Wide enough that the line box is never what refuses a pair: each test should
        // fail for the reason it is testing and no other.
        rect('p', 320, 200, 1000, containerHeight, 'Lead with Strategy & Insight'),
        rect('span', aLeft, 200, aRight - aLeft, 77, 'Lead with'),
        rect('span', bLeft, secondInkTop - 14, bRight - bLeft, 77, 'Strategy & Insight'),
    ];

    return {edges, rects, aLeft, bRight};
};

test('two elements on one line, inside one line box, are one run', () => {
    const {edges, rects, aLeft, bRight} = oneLine();

    const runs = textRuns(edges, WIDTH, HEIGHT, rects);
    assert.equal(runs.length, 1, 'the line should come back as a single run');
    assert.ok(runs[0].x <= aLeft, 'the run must start no later than the first word');
    assert.ok(runs[0].x + runs[0].w >= bRight, 'the run must reach past the last word');
});

test('a run spans the gap, so no cut can land between the words', () => {
    const {edges, rects, aLeft, bRight} = oneLine();

    const ls = leaves(segmentTall(edges, WIDTH, HEIGHT, {rects}));
    const through = ls.filter((l) => l.x > aLeft && l.x < bRight);
    assert.deepEqual(through, [], 'no block may start inside the line');
});

// The defect itself: without the run, that word space IS a gutter and the cut happens.
test('without the run the same page is cut between the words', () => {
    const {edges, rects, aLeft, bRight} = oneLine();

    // Same page, but nothing in it reads as a line: ask for an impossible line shape.
    const ls = leaves(segmentTall(edges, WIDTH, HEIGHT, {rects, textRun: {lineAspect: 1e6}}));
    const through = ls.filter((l) => l.x > aLeft && l.x < bRight);
    assert.ok(through.length > 0, 'the unprotected page must still show the cut this fixes');
});

test('a gap too wide to read as a word space is not merged', () => {
    const {edges, rects} = oneLine({gap: 200});

    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, rects), []);
});

test('two lines that merely overlap vertically are not one run', () => {
    // Half of the shorter line's ink is inside the taller's band, which is what a
    // wrapped headline's two lines look like. A superscript on the same baseline is
    // wholly inside it; this is not.
    const {edges, rects} = oneLine({secondInkTop: 234, containerHeight: 120});

    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, rects), []);
});

// The M&S footer case, in miniature: same line, same gap, but a column wrapper.
test('columns of a tall wrapper are not one run, however close they sit', () => {
    const {edges, ink} = canvas();
    const rects = [rect('div', 52, 190, 1069, 281, 'Latest Asset Classes Services Company')];
    for (let i = 0; i < 4; i++) {
        const x = 343 + i * 261;
        ink(x, x + 233, 200, 241);
        rects.push(rect('div', x, 190, 233, 66, `column ${i}`));
    }

    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, rects), [],
        'four footer columns on one row must stay four things');
});

test('the same columns inside a line box ARE one run', () => {
    // Identical pixels and identical gaps; only the wrapper's height differs. This is
    // the measurement that says the wrapper is the evidence, not the geometry.
    const {edges, ink} = canvas();
    const rects = [rect('div', 52, 190, 1069, 66, 'Latest Asset Classes Services Company')];
    for (let i = 0; i < 4; i++) {
        const x = 343 + i * 261;
        ink(x, x + 233, 200, 241);
        rects.push(rect('div', x, 190, 233, 66, `part ${i}`));
    }

    assert.equal(textRuns(edges, WIDTH, HEIGHT, rects).length, 1);
});

test('a block of text is not a line, so a row of cards never merges', () => {
    const {edges, ink} = canvas();
    const rects = [rect('div', 16, 190, 1408, 400, 'three cards')];
    for (let i = 0; i < 3; i++) {
        const x = 16 + i * 360;
        ink(x, x + 328, 200, 526);   // 328 x 326: a card, not a line
        rects.push(rect('a', x, 190, 328, 340, `card ${i}`));
    }

    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, rects), []);
});

test('a lone line is never protected on its own', () => {
    const {edges, ink} = canvas();
    ink(100, 1300, 214, 232);
    const rects = [rect('p', 90, 200, 1220, 40, 'a wide single line of body text')];

    assert.equal(lineSpans(edges, WIDTH, HEIGHT, rects).length, 1, 'it is a line');
    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, rects), [], 'but one line is not a run');
});

test('three parts of a line chain into one run', () => {
    const {edges, ink} = canvas();
    const rects = [rect('p', 300, 200, 800, 60, 'one two three')];
    for (let i = 0; i < 3; i++) {
        const x = 320 + i * 260;
        ink(x, x + 240, 210, 250);
        rects.push(rect('span', x, 200, 240, 60, `part ${i}`));
    }

    const runs = textRuns(edges, WIDTH, HEIGHT, rects);
    assert.equal(runs.length, 1, 'one run, not two');
    assert.ok(runs[0].w > 700, `the run should span all three parts, got ${runs[0].w}`);
});

test('a rect whose words belong to a smaller rect inside it is not a line span', () => {
    const {edges, ink} = canvas();
    ink(400, 1000, 214, 253);
    const rects = [
        rect('div', 300, 200, 800, 77, 'Lead with Strategy'),
        rect('span', 390, 200, 620, 77, 'Lead with Strategy'),
    ];

    const spans = lineSpans(edges, WIDTH, HEIGHT, rects);
    assert.equal(spans.length, 1, 'only the innermost carrier counts');
    assert.equal(spans[0].box.tag, 'span');
});

test('an element with no ink, and one with no text, are not lines', () => {
    const {edges, ink} = canvas();
    ink(400, 1000, 214, 253);
    assert.deepEqual(lineSpans(edges, WIDTH, HEIGHT, [rect('p', 300, 600, 800, 40, 'below the ink')]), []);
    assert.deepEqual(lineSpans(edges, WIDTH, HEIGHT, [rect('p', 300, 200, 800, 77, '  ')]), []);
});

test('no rects means no runs', () => {
    const {edges} = canvas();
    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, []), []);
    assert.deepEqual(textRuns(edges, WIDTH, HEIGHT, undefined), []);
    assert.deepEqual(lineSpans(edges, WIDTH, HEIGHT, undefined), []);
});

test('every threshold is a positive number the caller can override', () => {
    for (const [name, value] of Object.entries(TEXT_RUN)) {
        assert.equal(typeof value, 'number', name);
        assert.ok(value > 0, name);
    }
});

// The guard the brief names: the product grid is what breaks if "close enough" is loose.
test('tools/audit/fixtures/retail.png: the product grid keeps its columns', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));

    const runs = textRuns(edges, width, height, rects);
    const titles = rects.filter((r) => r.tag === 'h2' && r.w < 400 && r.h < 100);
    assert.ok(titles.length >= 4, 'the fixture must still hold a row of product titles');
    for (const run of runs) {
        const spanned = titles.filter((t) => t.x >= run.x && t.x + t.w <= run.x + run.w
            && t.y < run.y + run.h && t.y + t.h > run.y);
        assert.ok(spanned.length < 2, `a run swallowed ${spanned.length} product titles at y=${run.y}`);
    }
});

test('tools/audit/fixtures/retail.png: the footer columns stay separate', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));

    const heading = rects.find((r) => r.tag === 'h2' && (r.text || '').includes('Here to Help'));
    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const columns = ls.filter((l) => l.y === heading.y - 32 && l.w < width);
    assert.ok(columns.length > 1, `the footer headings row should be in columns, got ${columns.length}`);
});
