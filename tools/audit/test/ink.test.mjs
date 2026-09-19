/**
 * INK
 *
 * A heading protects the pixels it actually uses, not the box it was given.
 *
 *   node --test tools/audit/test/ink.test.mjs
 *
 * A heading's element box is as wide as its column and the words rarely fill it. M&S's
 * footer headings are 336px boxes holding "Here to Help" — 121px of ink — and each
 * column's gutter begins EXACTLY where that heading's ink ends: 161 against ink ending at
 * 146, 557 against 556, 898 against 897. Protecting the box rejected all three column
 * cuts, so the four link columns came back as one full-width band with the columns below
 * it cut short.
 *
 * Shrinking to ink loses nothing that mattered. On jonleverrier the headline's ink spans
 * 511-932 inside a 440-1000 box, and the cut that must stay refused — between "How" and
 * "can" at x=745 — is inside the ink either way.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inkBounds, inkedTextRects, segmentTall} from '../lib/xycut.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {leaves} from '../lib/blocks.mjs';

/** A w x h map with ink only in the columns [from, to). */
const inkAt = (width, height, from, to) => {
    const edges = new Uint8Array(width * height);
    for (let y = 2; y < height - 2; y++) {
        for (let x = from; x < to; x++) edges[y * width + x] = 1;
    }

    return edges;
};

test('a box wider than its ink shrinks to the ink', () => {
    const edges = inkAt(400, 40, 10, 60);
    const box = {x: 0, y: 0, w: 300, h: 40, tag: 'h2', text: 'short'};

    const ink = inkBounds(edges, 400, 40, box);
    assert.equal(ink.x, 10);
    assert.equal(ink.x + ink.w, 60);
    assert.ok(ink.w < box.w, 'the ink must be narrower than the box it came from');
});

test('a box with no ink protects nothing', () => {
    assert.equal(inkBounds(new Uint8Array(400 * 40), 400, 40, {x: 0, y: 0, w: 300, h: 40}), null);
});

test('a box reaching outside the image is clamped, not read out of bounds', () => {
    const edges = inkAt(100, 20, 90, 100);
    const ink = inkBounds(edges, 100, 20, {x: 50, y: -10, w: 500, h: 200, tag: 'h1', text: 'x'});
    assert.ok(ink.x >= 0 && ink.x + ink.w <= 100);
    assert.ok(ink.y >= 0 && ink.y + ink.h <= 20);
});

test('a box entirely outside the image yields nothing', () => {
    assert.equal(inkBounds(inkAt(100, 20, 0, 50), 100, 20, {x: 500, y: 0, w: 50, h: 20}), null);
});

/**
 * The third rect used to be a `<p>`, as an example of a tag outside the protected
 * population. `<p>` is IN the population now — see TEXT_TAGS — so the control has moved
 * to `<span>`, which is inline, is everywhere on a page, and is still deliberately out.
 * The subject of the test is unchanged: no ink, no protection.
 */
test('inkedTextRects drops text with no ink and keeps the rest', () => {
    const edges = inkAt(400, 40, 10, 60);
    const rects = [
        {x: 0, y: 0, w: 300, h: 40, tag: 'h2', boxed: false, text: 'inked'},
        {x: 300, y: 0, w: 90, h: 40, tag: 'h2', boxed: false, text: 'blank'},
        {x: 0, y: 0, w: 300, h: 40, tag: 'span', boxed: false, text: 'not in the population'},
    ];

    const got = inkedTextRects(edges, 400, 40, rects);
    assert.equal(got.length, 1, 'only the inked heading survives');
    assert.equal(got[0].text, 'inked');
});

/** …and the same question asked of body text, which now IS in the population. */
test('inkedTextRects protects an inked paragraph and drops a blank one', () => {
    const edges = inkAt(400, 40, 10, 60);
    const rects = [
        {x: 0, y: 0, w: 300, h: 40, tag: 'p', boxed: false, text: 'inked prose'},
        {x: 300, y: 0, w: 90, h: 40, tag: 'p', boxed: false, text: 'blank prose'},
    ];

    const got = inkedTextRects(edges, 400, 40, rects);
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'inked prose');
});

// The real pair, both directions, on the committed fixtures.
test("M&S's footer columns are not vetoed by their own headings", async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));

    const heading = rects.find((r) => r.tag === 'h2' && (r.text || '').includes('Here to Help'));
    assert.ok(heading, 'the fixture must still contain the footer headings');
    const ink = inkBounds(edges, width, height, heading);
    assert.ok(ink.x + ink.w < heading.x + heading.w, 'the heading box must be wider than its words');

    // Every column block starts at the top of the heading row, not below it.
    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const columns = ls.filter((l) => l.y === heading.y - 32 && l.w < width);
    assert.ok(columns.length > 1, `the footer headings row should be in columns, got ${columns.length}`);
});

test('the jonleverrier headline is still not cut in half', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/jonleverrier.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/jonleverrier.rects.json', 'utf8'));
    const h1 = rects.find((r) => r.tag === 'h1');

    const ink = inkBounds(edges, width, height, h1);
    assert.ok(ink.x > h1.x && ink.x + ink.w < h1.x + h1.w, 'the headline should sit inside its box');

    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const through = ls.filter((l) => l.x > ink.x && l.x < ink.x + ink.w
        && l.y < ink.y + ink.h && l.y + l.h > ink.y);
    assert.deepEqual(through, [], 'no block boundary may start inside the headline ink');
});
