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
 * BLOCK-LEVEL TEXT, WHICH USED TO MEAN HEADINGS ONLY. The first attempt protected every
 * text-bearing element and was reverted, for a good reason: a protected rect was its own
 * BOX, so one full-width line vetoed every cut on that axis across the region it
 * occupies. jonleverrier's copyright line is 1315px wide at the foot of the footer, and
 * protecting it merged all four footer columns into a single block — the exact structure
 * that most needs to stay apart, because those columns carry different labels.
 *
 * That reason expired. `inkBounds` and `inkClusters` arrived afterwards and shrink a
 * protected rect to the pixels it actually draws, so that copyright line now protects the
 * width of its own sentence and nothing else. Body text rejoined the population once the
 * old regression was re-measured and did not come back: both fixtures unmoved, and all
 * four corpus pages with real multi-column footers keeping their columns. Three pages
 * were being cut through the middle of a paragraph for want of it.
 *
 * Inline elements — `<span>`, `<a>` — are still out. They are everywhere, and a run of
 * them that reads as one line is `textRuns`' job rather than this one's.
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

/**
 * THIS TEST USED TO ASSERT THE OPPOSITE, and the change is deliberate. Body text was
 * excluded because protecting every text element merged four footer columns — a 1315px
 * copyright line vetoed the whole axis. `inkBounds` and `inkClusters` arrived afterwards
 * and shrink a protected rect to the ink it actually draws, so that line now protects the
 * width of its own sentence. Three pages in the corpus were being cut through the middle
 * of a paragraph for want of this; both fixtures are unmoved by it.
 *
 * The block-level tags below hold words directly. The inline ones still must not be here:
 * they are everywhere, and a run of them that reads as one line is `textRuns`' job.
 */
test('block-level body text is protected', () => {
    for (const tag of ['p', 'li', 'blockquote', 'figcaption', 'dd', 'dt']) {
        assert.equal(TEXT_TAGS.has(tag), true, tag);
        assert.deepEqual(textRects([rect(tag, 0, 0, 400, 100)]).map((r) => r.tag), [tag], tag);
    }
});

test('inline and interactive elements are still not protected', () => {
    for (const tag of ['span', 'a', 'button', 'td', 'div', 'section']) {
        assert.deepEqual(textRects([rect(tag, 0, 0, 400, 100)]), [], tag);
        assert.equal(TEXT_TAGS.has(tag), false, tag);
    }
});

/**
 * The regression that forced the original narrowing, asserted directly so that widening
 * the population again cannot quietly bring it back. A full-width copyright line whose
 * ink is a short sentence at the left must not veto a cut on the right.
 */
test('a full-width line of small print does not veto the whole axis', () => {
    const line = rect('p', 0, 0, 1315, 20, '(c) 2026 Example Limited. All rights reserved.');
    const [protectedRect] = textRects([line]);

    assert.ok(protectedRect, 'it is protected');
    assert.equal(protectedRect.w, 1315, 'as a BOX it still spans the page — inkBounds is what narrows it');
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

/* ------------------------------------------------- a headline taller than a wrapper */

/**
 * alchemy.je's `<h1>` is 1408x704 — FOUR PIXELS over `CONTENT_RECT.maxH` — so its
 * headline was protected by nothing and got cut between its words and in places between
 * its letters, taking about 19 of that page's 91 blocks.
 *
 * The ceiling belongs to the SNAP CANDIDATE question, where it keeps page-level wrappers
 * out of a list they would otherwise dominate. An element in TEXT_TAGS holds words
 * directly and cannot be a page wrapper, so the ceiling never applied here.
 */
test('a display headline taller than the content-rect ceiling is still protected', () => {
    const headline = rect('h1', 16, 212, 1408, 704, 'Igniting business success. Through the power of difference.');

    assert.deepEqual(textRects([headline]).map((r) => r.h), [704]);
});

test('a hairline and an icon are still too small to protect', () => {
    assert.deepEqual(textRects([rect('h1', 0, 0, 1408, 4, 'hairline')]), []);
    assert.deepEqual(textRects([rect('p', 0, 0, 20, 20, 'icon')]), []);
});
