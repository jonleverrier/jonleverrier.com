/**
 * HEADINGS
 *
 * A cut may not pass through a heading.
 *
 *   node --test tools/audit/test/headings.test.mjs
 *
 * The space between two words in a large headline is a run of quiet pixels, which is
 * precisely what a gutter is. On jonleverrier the gap between "How" and "can" is a
 * 268px-tall column of background and a vertical cut went straight down it, splitting
 * the headline in half.
 *
 * HEADINGS ONLY, and that narrowness is the point. The first attempt protected every
 * text-bearing element, which reads as the more principled rule and is worse: one
 * full-width line of text vetoes every cut on that axis across the region it occupies.
 * jonleverrier's copyright line is 1315px wide at the foot of the footer, so protecting
 * it merged all four footer columns into a single block — the exact structure that most
 * needs to stay apart, because those columns carry different labels.
 *
 * A heading is a single phrase, always short, and never the thing you want to cut
 * through. Body text is left cuttable and the columns survive.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {textRects, TEXT_TAGS, segmentTall} from '../lib/xycut.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {leaves} from '../lib/blocks.mjs';

const rect = (tag, x, y, w, h, text = 'words') => ({x, y, w, h, tag, boxed: false, text});

test('headings are protected', () => {
    assert.equal(textRects([rect('h1', 0, 0, 400, 100)]).length, 1);
    assert.equal(textRects([rect('h3', 0, 0, 400, 100)]).length, 1);
});

// Deliberately NOT protected — see the header comment.
test('body text is not protected', () => {
    for (const tag of ['p', 'li', 'blockquote', 'span', 'a', 'button', 'td']) {
        assert.deepEqual(textRects([rect(tag, 0, 0, 400, 100)]), [], tag);
        assert.equal(TEXT_TAGS.has(tag), false, tag);
    }
});

test('an empty heading protects nothing', () => {
    assert.deepEqual(textRects([rect('h1', 0, 0, 400, 100, '   ')]), []);
});

test('a heading too small to be a content rect is ignored', () => {
    assert.deepEqual(textRects([rect('h1', 0, 0, 20, 8)]), []);
});

test('no rects means nothing protected', () => {
    assert.deepEqual(textRects([]), []);
    assert.deepEqual(textRects(undefined), []);
});

test('the jonleverrier headline is not cut in half', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/jonleverrier.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/jonleverrier.rects.json', 'utf8'));
    const h1 = rects.find((r) => r.tag === 'h1');
    assert.ok(h1, 'the fixture must still contain an h1');

    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const through = ls.filter((l) => l.x > h1.x && l.x < h1.x + h1.w
        && l.y < h1.y + h1.h && l.y + l.h > h1.y);

    assert.deepEqual(through, [], 'no block boundary may start inside the headline');
});

// The regression the narrowing exists to prevent.
test('the jonleverrier footer columns stay separate', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/jonleverrier.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/jonleverrier.rects.json', 'utf8'));

    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const columns = ls.filter((l) => l.y >= 940 && l.y < 1120);

    assert.ok(columns.length > 1, `the footer should be in columns, got ${columns.length} block(s)`);
});
