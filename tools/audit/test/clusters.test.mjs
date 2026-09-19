/**
 * INK IN MORE THAN ONE PIECE
 *
 * `inkBounds` shrinks a heading's box to the pixels that have ink in them, so that the
 * box being wider than the words cannot veto the gutter beside them. It takes the
 * leftmost and rightmost lit pixel anywhere in the box, which is the right answer while
 * the ink is one piece and the wrong one the moment it is not.
 *
 *   node --test tools/audit/test/clusters.test.mjs
 *
 * andybudd.com found it. Its `<h4>` "Popular articles" is a 1276x27 box, the words
 * occupy x=82..285, and the page draws a decorative dot matrix that clips through BOTH
 * ENDS of that box — about 100 to 190 lit pixels per row, spread right across it. The
 * shrink returned the full 1276px, and that one element vetoed every vertical cut in its
 * region: the three columns of the Coaching / Educating / Speaking row stayed in one
 * 1440x1219 block with 42px-wide gutters, four times quieter than the threshold, sitting
 * unused. Nothing about that is specific to one page — any textured, noisy or
 * photographic backdrop behind a heading defeats a shrink to ink the same way, silently.
 *
 * The rule has to hold BOTH ends. What the population exists for is jonleverrier's
 * headline, where the gap between "How" and "can" is a 268px-tall column of background
 * and a vertical cut went straight down it. So the question is the one TEXT_RUN.gap
 * already answers between two elements of a line, asked inside one element: is this gap
 * a word space?
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inkClusters, inkedTextRects, lineSpans, segment, INK_CLUSTER} from '../lib/xycut.mjs';
import {leaves} from '../lib/blocks.mjs';

const WIDTH = 1000;
const HEIGHT = 400;
const INK_H = 30;

/**
 * The andybudd shape: words at one end of the box, decoration at the other, and two
 * columns of real content below with a wide gutter between them.
 */
const page = ({words = [10, 200], decoration = [900, 990]} = {}) => {
    const edges = new Uint8Array(WIDTH * HEIGHT);
    const fill = (x0, x1, y0, y1) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) edges[y * WIDTH + x] = 1;
    };
    fill(words[0], words[1], 0, INK_H);
    if (decoration) fill(decoration[0], decoration[1], 0, INK_H);
    // Two columns of content, with 400..600 empty between them.
    fill(0, 400, 100, 300);
    fill(600, WIDTH, 100, 300);

    return edges;
};

const HEADING = {x: 0, y: 0, w: WIDTH, h: INK_H, tag: 'h4', boxed: false, text: 'Popular articles'};
const OPTS = {maxDepth: 1, minSide: 120, minAreaFraction: 0.02};
const cutBetweenTheColumns = (ls) => ls.some((l) => l.x === 0 && l.w > 400 && l.w < 600);

test('ink in two pieces is two clusters, not one span across the gap', () => {
    const got = inkClusters(page(), WIDTH, HEIGHT, HEADING);

    assert.equal(got.length, 2, `two pieces of ink, got ${JSON.stringify(got)}`);
    assert.equal(got[0].x, 10);
    assert.equal(got[0].x + got[0].w, 200);
    assert.equal(got[1].x, 900);
    assert.equal(got[1].x + got[1].w, 990);
});

// jonleverrier's headline. A word space is not a boundary, and nothing about this change
// may make it one.
test('a word space keeps one line in one piece', () => {
    const gap = Math.floor(0.5 * INK_H);
    const got = inkClusters(page({words: [10, 200], decoration: [200 + gap, 400]}), WIDTH, HEIGHT, HEADING);

    assert.equal(got.length, 1, `${gap}px against ${INK_H}px of ink is a word space`);
    assert.equal(got[0].x, 10);
    assert.equal(got[0].x + got[0].w, 400);
});

test('a box with no ink in it holds no clusters', () => {
    const blank = new Uint8Array(WIDTH * HEIGHT);

    assert.deepEqual(inkClusters(blank, WIDTH, HEIGHT, HEADING), []);
    assert.deepEqual(inkedTextRects(blank, WIDTH, HEIGHT, [HEADING]), []);
});

test('a heading off the edge of the image holds no clusters', () => {
    assert.deepEqual(inkClusters(page(), WIDTH, HEIGHT, {...HEADING, x: WIDTH + 10}), []);
});

// Each cluster's height is its own, so a tall neighbour cannot license a wide gap to a
// short one — the same normaliser textRuns uses.
test('a cluster reports its own vertical extent, not the whole box', () => {
    const edges = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 0; y < 10; y++) for (let x = 10; x < 200; x++) edges[y * WIDTH + x] = 1;
    for (let y = 0; y < 30; y++) for (let x = 900; x < 990; x++) edges[y * WIDTH + x] = 1;
    const got = inkClusters(edges, WIDTH, HEIGHT, HEADING);

    assert.equal(got.length, 2);
    assert.equal(got[0].h, 10, 'the short piece is 10px of ink');
    assert.equal(got[1].h, 30, 'the tall piece is 30px');
});

// The defect itself, and its control on identical pixels.
test('a heading whose ink is in two pieces does not veto the gutter between them', () => {
    const ls = leaves(segment(page(), WIDTH, HEIGHT, {...OPTS, rects: [HEADING]}));

    assert.ok(cutBetweenTheColumns(ls), `the columns should separate, got ${JSON.stringify(ls)}`);
});

test('without clustering the same page keeps its columns in one block', () => {
    // A gap tolerance this large merges every piece of ink into one span again, which is
    // exactly the behaviour this file exists to change.
    const ls = leaves(segment(page(), WIDTH, HEIGHT, {...OPTS, inkCluster: {gap: 1000}, rects: [HEADING]}));

    assert.equal(cutBetweenTheColumns(ls), false, 'otherwise this file tests nothing');
});

// The protection still works: a heading whose ink really does span the gutter still
// vetoes it. This is the M&S footer case the shrink was written for, from the other side.
test('a heading whose ink genuinely spans the gutter still vetoes it', () => {
    const ls = leaves(segment(page({words: [10, 990], decoration: null}), WIDTH, HEIGHT, {...OPTS, rects: [HEADING]}));

    assert.equal(cutBetweenTheColumns(ls), false, 'unbroken ink across x=500 is still ink across x=500');
});

// lineSpans has the same premise and needed the same fix: a backdrop that puts ink across
// a box would otherwise hand the 4:1 aspect test a "line" the element does not contain.
test('a line is measured from its ink, not from the far ends of the box', () => {
    const spans = lineSpans(page(), WIDTH, HEIGHT, [{...HEADING, tag: 'p'}]);

    assert.equal(spans.length, 1, 'only the piece that is line-shaped counts');
    assert.equal(spans[0].x, 10);
    assert.equal(spans[0].x + spans[0].w, 200, 'and it stops where the words do');
});

test('the gap tolerance is the one TEXT_RUN measured for the same question', () => {
    assert.equal(INK_CLUSTER.gap, 0.75);
});
