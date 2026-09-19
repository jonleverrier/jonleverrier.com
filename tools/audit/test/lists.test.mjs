/**
 * LISTS
 *
 * A `<ul>` or `<ol>` is one thing, at any length.
 *
 *   node --test tools/audit/test/lists.test.mjs
 *
 * `repeatedRuns` reaches the same conclusion from the layout, and needs four members and
 * an adjacency threshold to do it — so a three-link column was cut per link for want of a
 * fourth item. whitepaper.co.uk's footer is the case: "Current Topics" has nine links and
 * merged, "Legal" and "Quick Links" have three each and did not. A rule that fires at
 * four and not at three is a rule about counting, not about lists. The markup already
 * says which elements belong together.
 *
 * A VETO, NOT A MODULE, and that was measured the wrong way round first. Putting lists in
 * `protectedRects` broke both fixtures' footers: a band boundary is a full-width line
 * tested against every protected rect on the page, so a 128px column of links vetoed the
 * page-wide line that separated the footer's rows — and that line was what created the
 * band the columns were then cut in.
 *
 * The limitation worth knowing: this reads `<li>` containment geometrically, because
 * phase 1 reports rects and not the DOM tree. A list whose items are positioned outside
 * their own parent's box will not be recognised, and a `<ul>` used purely for layout will
 * be protected as though it were a list. The first has not appeared in the corpus; the
 * second is usually the right answer anyway, since such a `<ul>` is holding siblings.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {listContainers, LIST_MIN_ITEMS, segmentTall} from '../lib/xycut.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {leaves} from '../lib/blocks.mjs';

const at = (tag, x, y, w, h) => ({x, y, w, h, tag, boxed: false, text: 'x'});
/** A list of `n` items stacked down, each `itemH` tall. */
const column = (x, y, w, itemH, n) => [
    at('ul', x, y, w, itemH * n),
    ...Array.from({length: n}, (_, i) => at('li', x, y + i * itemH, w, itemH)),
];

test('a list of two or more items is recognised', () => {
    assert.equal(listContainers(column(0, 0, 200, 30, 2), 1440, 4000).length, 1);
    assert.equal(listContainers(column(0, 0, 200, 30, 9), 1440, 4000).length, 1);
});

test('the minimum is two, and one item is not a list', () => {
    assert.equal(LIST_MIN_ITEMS, 2);
    assert.deepEqual(listContainers(column(0, 0, 200, 30, 1), 1440, 4000), []);
});

/** The whole point: three is as much a list as nine. `repeatedRuns` needs four. */
test('three items are as much a list as nine', () => {
    assert.equal(listContainers(column(0, 0, 200, 30, 3), 1440, 4000).length, 1);
});

test('an empty list protects nothing', () => {
    assert.deepEqual(listContainers([at('ul', 0, 0, 200, 90)], 1440, 4000), []);
});

test('no rects, no lists', () => {
    assert.deepEqual(listContainers([], 1440, 4000), []);
    assert.deepEqual(listContainers(undefined, 1440, 4000), []);
});

/**
 * The axis, which is the half that keeps footer columns apart. A column of links forbids
 * the horizontal cut that would slice it; the vertical gutter BETWEEN two such columns
 * has to stay legal or the footer comes back as one block.
 */
test('a column of links is stacked', () => {
    const [list] = listContainers(column(0, 0, 200, 30, 5), 1440, 4000);
    assert.equal(list.stacked, true);
});

test('a row of links is not', () => {
    const row = [
        at('ul', 0, 0, 600, 30),
        at('li', 0, 0, 140, 30), at('li', 150, 0, 140, 30),
        at('li', 300, 0, 140, 30), at('li', 450, 0, 140, 30),
    ];
    const [list] = listContainers(row, 1440, 4000);
    assert.equal(list.stacked, false);
});

/** A layout device spanning more of the page than a module ever should is not a list. */
test('something far larger than a module is not a list', () => {
    const huge = [at('ul', 0, 0, 1440, 2000), at('li', 0, 0, 1440, 1000), at('li', 0, 1000, 1440, 1000)];
    assert.deepEqual(listContainers(huge, 1440, 4000), []);
});

test('items outside the parent box are not counted', () => {
    const detached = [at('ul', 0, 0, 200, 60), at('li', 900, 0, 200, 30), at('li', 900, 30, 200, 30)];
    assert.deepEqual(listContainers(detached, 1440, 4000), []);
});

/* ------------------------------------------------------------------ the real pages */

test('the retail fixture keeps its four footer columns apart', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));

    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const footer = ls.filter((l) => l.y >= 3000 && l.y < 3320);
    assert.ok(footer.length > 1, `the footer should be in columns, got ${footer.length} block(s)`);
});

test('the jonleverrier fixture keeps its footer columns apart', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/jonleverrier.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/jonleverrier.rects.json', 'utf8'));

    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const footer = ls.filter((l) => l.y >= 940 && l.y < 1120);
    assert.ok(footer.length > 1, `the footer should be in columns, got ${footer.length} block(s)`);
});
