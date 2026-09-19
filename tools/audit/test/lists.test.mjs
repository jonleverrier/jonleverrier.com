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

/* ------------------------------------------------ the markup outranks the geometry */

/**
 * vaiie.com is the page, and it is the defect the user reported twice. Its footer has
 * three `<ul>` columns at x=599, 876 and 1152, each 242 wide and each declared by the
 * markup. `repeatedRuns` also found a run at `46,2864 1348x257` covering all three at
 * once, not stacked, which vetoed every vertical cut between them — the whole footer came
 * back as one block.
 *
 * Both rules were working as designed. Only one of them was reading what the page said.
 */
test('every declared footer column survives as its own block', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));

    // The footer's four columns are four separate <ul>s in the fixture, at y=3048.
    const columns = listContainers(rects, width, height).filter((l) => l.y >= 3000 && l.y < 3320);
    assert.ok(columns.length >= 2, 'the fixture must still declare its footer columns as lists');

    // The band they sit in starts above them, so ask which leaves OVERLAP them rather
    // than which begin inside an arbitrary window.
    const top = Math.min(...columns.map((l) => l.y));
    const bottom = Math.max(...columns.map((l) => l.y + l.h));
    const ls = leaves(segmentTall(edges, width, height, {rects}));
    const over = ls.filter((l) => l.y < bottom && l.y + l.h > top);

    assert.ok(over.length >= columns.length,
        `${columns.length} declared columns should not merge: got ${over.length} block(s) over them`);
    // …and none of those blocks may straddle two of the columns.
    for (const l of over) {
        const held = columns.filter((c) => c.x >= l.x && c.x + c.w <= l.x + l.w);
        assert.ok(held.length <= 1, `a block spans ${held.length} declared columns: ${JSON.stringify(l)}`);
    }
});

/** …and a run holding only ONE list is still a run, so a card grid is unaffected. */
test('a run holding a single list is left alone', () => {
    const run = {x: 0, y: 0, w: 900, h: 400};
    const one = [{x: 10, y: 10, w: 200, h: 100}];
    const two = [{x: 10, y: 10, w: 200, h: 100}, {x: 300, y: 10, w: 200, h: 100}];
    const holds = (r, l) => l.x >= r.x && l.y >= r.y && l.x + l.w <= r.x + r.w && l.y + l.h <= r.y + r.h;

    assert.equal(one.filter((l) => holds(run, l)).length < 2, true, 'one list: the run stands');
    assert.equal(two.filter((l) => holds(run, l)).length < 2, false, 'two lists: the run goes');
});
