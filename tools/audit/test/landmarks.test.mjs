/**
 * A PAGE LANDMARK'S OWN BOUNDARY
 *
 * Brand and navigation are two of the four categories this tool reports, and both live
 * in the `<header>`. A page whose header is fused into its hero cannot be measured at
 * all, and four of the twenty-nine captured pages came back exactly that way.
 *
 *   node --test tools/audit/test/landmarks.test.mjs
 *
 * Three separate rules each refused the cut, every one of them right about the
 * population it was written for:
 *
 *   jtcgroup.com   `<header>` ends at y=94 between gutters of 68-93 and 97-120. The
 *                  MODULE_BRIDGE seam rule needs one module to END there and another to
 *                  BEGIN there, and nothing begins where a header ends.
 *   jerseyfinance  the same shape at y=58, and its `<header>` is not even in the
 *                  protected population: it contains a `<nav>`, so the innermost-box
 *                  rule keeps the nav and drops the header.
 *   jersey.com     the gutter 99-173 holds the header's edge at y=134 perfectly, and
 *                  `cutsInsideProtected` threw the cut away because a 1440x860 full-bleed
 *                  `<img>` is drawn underneath it.
 *   andybudd.com   no gutter near the boundary at all — a decorative dot matrix holds
 *                  every row from y=10 down at 0.017-0.025 against a 0.0128 threshold —
 *                  but a rule covering 89% of the width is drawn along it.
 *
 * This file is the other half of bridge.test.mjs. That one is about the MODULE
 * population and its fixtures are inset by a pixel to keep them out of this one; these
 * span the viewport edge to edge, which is what makes them landmarks. The refusals
 * matter as much as the reaches: an inset landmark gets nothing, an undrawn boundary
 * with no whitespace gets nothing, and a landmark boundary still cannot cut through
 * words.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {segment, segmentTall, pageLandmarks, onLandmarkBoundary, LANDMARK_RULE} from '../lib/xycut.mjs';
import {leaves, assertPartition, totalArea} from '../lib/blocks.mjs';

/** A w x h edge map, every pixel on except the rows listed as quiet. `end` is exclusive. */
const denseExcept = (width, height, quiet) => {
    const edges = new Uint8Array(width * height);
    const isQuiet = (y) => quiet.some(([a, b]) => y >= a && y < b);
    for (let y = 0; y < height; y++) {
        if (isQuiet(y)) continue;
        edges.fill(1, y * width, (y + 1) * width);
    }

    return edges;
};

const WIDTH = 400;
const HEIGHT = 1200;
const BOUNDARY = 56;
// Edge to edge, which is what makes it the page's own band rather than a card inside it.
const BANNER = {x: 0, y: 0, w: WIDTH, h: BOUNDARY, tag: 'header', boxed: false, text: ''};
const OPTS = {maxDepth: 1, minSide: 120, minAreaFraction: 0.02};
const endsAtBoundary = (ls) => ls.some((l) => l.y === 0 && l.y + l.h === BOUNDARY);

test('the fixtures are the shape this file is about', () => {
    assert.equal(pageLandmarks([BANNER], WIDTH).length, 1, 'edge to edge is a landmark');
    assert.equal(
        pageLandmarks([{...BANNER, x: 1, w: WIDTH - 2}], WIDTH).length,
        0,
        'inset by a pixel is a card, not the page band',
    );
});

// jtcgroup.com and jerseyfinance.com: the gutter is the header's own trailing padding,
// one row of rule sits between it and the boundary, and NOTHING BEGINS THERE.
test('a header edge one pixel past its own gutter is cut, with no module beyond it', () => {
    const edges = denseExcept(WIDTH, HEIGHT, [[36, BOUNDARY - 1]]);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [BANNER]}));

    assert.ok(endsAtBoundary(ls), `the header should end at y=${BOUNDARY}, got ${JSON.stringify(ls)}`);
});

// andybudd.com's shape: the only whitespace near the boundary is BELOW the rule, which
// is not the header's own padding at all. The seam rule could not reach it from there;
// a landmark is reachable from either side.
test('a header edge is reachable from the gutter below it as well', () => {
    const edges = denseExcept(WIDTH, HEIGHT, [[BOUNDARY + 1, 90]]);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [BANNER]}));

    assert.ok(endsAtBoundary(ls), `the header should end at y=${BOUNDARY}, got ${JSON.stringify(ls)}`);
});

// The jonleverrier fixture, whose header is 17,51 1406x65 in a 1440px page. Admitting
// an inset landmark cut two 17px slivers of empty margin off its header band.
test('an inset landmark is not a page band and reaches nothing', () => {
    const edges = denseExcept(WIDTH, HEIGHT, [[36, BOUNDARY - 1]]);
    const inset = {...BANNER, x: 1, w: WIDTH - 2};
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [inset]}));

    assert.equal(endsAtBoundary(ls), false, 'a card inset in the page is the module rule\'s business');
});

// A landmark's side edges are the page margin. The answer is given once, in
// onLandmarkBoundary, so that no call site can forget it.
test('a landmark says nothing about the vertical axis', () => {
    const region = {x: 0, y: 0, w: WIDTH, h: HEIGHT};

    assert.equal(onLandmarkBoundary([BANNER], region, BOUNDARY, true), true, 'its bottom edge is a boundary');
    assert.equal(onLandmarkBoundary([BANNER], region, 0, false), false, 'its left edge is not');
    assert.equal(onLandmarkBoundary([BANNER], region, WIDTH, false), false, 'nor its right');
});

test('a landmark that does not reach this region says nothing about it', () => {
    const elsewhere = {x: 0, y: 0, w: 100, h: BOUNDARY, tag: 'header', boxed: false, text: ''};
    const region = {x: 200, y: 0, w: 200, h: HEIGHT};

    assert.equal(onLandmarkBoundary([elsewhere], region, BOUNDARY, true), false);
});

test('a full-width nav is not a landmark, and neither is main', () => {
    const nav = {x: 0, y: 0, w: WIDTH, h: 40, tag: 'nav', boxed: false, text: ''};
    const main = {x: 0, y: 0, w: WIDTH, h: 900, tag: 'main', boxed: false, text: ''};

    assert.deepEqual(pageLandmarks([nav, main], WIDTH), []);
});

// jersey.com: the gutter holds the header's edge perfectly and the cut was thrown away
// because a full-bleed hero image is drawn underneath. A landmark drawn ON an element is
// not that element's interior.
test('a landmark boundary cuts through the full-bleed element it is drawn on', () => {
    const hero = {x: 0, y: 0, w: WIDTH, h: 800, tag: 'img', boxed: false, text: ''};
    const edges = denseExcept(WIDTH, HEIGHT, [[40, 80]]);

    const withoutBanner = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [hero]}));
    assert.equal(
        withoutBanner.some((l) => l.y === 0 && l.y + l.h > 0 && l.y + l.h < 800),
        false,
        'with no landmark the hero interior is off limits, as it must stay',
    );

    const withBanner = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [hero, BANNER]}));
    assert.ok(endsAtBoundary(withBanner), `the header should end at y=${BOUNDARY}, got ${JSON.stringify(withBanner)}`);
});

// The exemption stops at the words. `keepIntact` is a veto on cutting through a heading
// or a run of text, and a landmark boundary running through one would be as wrong as any
// other cut that does.
test('a landmark boundary still cannot cut through a heading', () => {
    const edges = denseExcept(WIDTH, HEIGHT, [[36, BOUNDARY - 1]]);
    const heading = {x: 20, y: 20, w: 360, h: 80, tag: 'h1', boxed: false, text: 'across the boundary'};
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [BANNER, heading]}));

    assert.equal(endsAtBoundary(ls), false, 'the heading ink spans y=56, so no cut may land there');
});

// A header strip is a real block. minSide cannot tell one from a sliver, which is why the
// module rule already waives it — and the landmark rule waives it for the same reason.
//
// THE BANNER HERE IS TOO BIG TO BE A MODULE CONTAINER, at 13.3% of the page against
// MODULE_AREA's 12% ceiling, so nothing but the landmark rule can waive anything. With a
// banner inside the band the module waiver covers the same cut and this asserts nothing.
// jerseyfinance.com is the real shape of that: its `<header>` is not in the protected
// population either, because it contains a `<nav>` and the innermost-box rule keeps the
// nav instead.
test('a landmark boundary waives the size floor with no module in play', () => {
    const tallBanner = {...BANNER, h: 160};
    const edges = denseExcept(WIDTH, HEIGHT, [[140, 159]]);
    const opts = {...OPTS, minSide: 400, rects: [tallBanner]};
    const ls = leaves(segment(edges, WIDTH, HEIGHT, opts));

    assert.ok(
        ls.some((l) => l.y === 0 && l.y + l.h === 160),
        `a 160px header is a block even under a 400px floor, got ${JSON.stringify(ls)}`,
    );
});

// atkearney.com: its `<footer>` begins one pixel inside a band the stitch had already
// ended, and the waiver produced a leaf of 1440x1. A boundary outranks the size floor,
// not the definition of a block.
test('the waiver does not stretch to a degenerate block', () => {
    const thin = {x: 0, y: 0, w: WIDTH, h: 4, tag: 'header', boxed: false, text: ''};
    const edges = denseExcept(WIDTH, HEIGHT, [[5, 40]]);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [thin]}));

    assert.equal(ls.some((l) => l.h < 16), false, `no block may be a strip, got ${JSON.stringify(ls)}`);
});

// andybudd.com: no gutter anywhere near the boundary, and a rule drawn along it. This is
// the only cut in the file that whitespace does not justify, so both halves are asserted.
test('a drawn landmark boundary is cut where there is no whitespace at all', () => {
    const edges = denseExcept(WIDTH, HEIGHT, []);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [BANNER]}));

    assert.ok(endsAtBoundary(ls), `a drawn boundary is evidence, got ${JSON.stringify(ls)}`);
});

test('with the last-resort rule off, the same page cannot reach that boundary', () => {
    const edges = denseExcept(WIDTH, HEIGHT, []);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, landmarkRule: 2, rects: [BANNER]}));

    assert.equal(endsAtBoundary(ls), false, 'otherwise this file tests nothing about that rule');
});

// An UNDRAWN boundary with no whitespace gets nothing: too few quiet rows to be a
// gutter, and no ink along the line either. jersey.com's header edge measures 0.000
// here and is cut anyway, by the gutter that holds it — that is the other test above.
test('an undrawn boundary with no gutter is not cut', () => {
    // Four quiet rows straddling the boundary: below minRun, so no gutter, and the rows
    // at the boundary itself are empty, so nothing is drawn there either.
    const edges = denseExcept(WIDTH, HEIGHT, [[BOUNDARY - 2, BOUNDARY + 2]]);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [BANNER]}));

    assert.equal(endsAtBoundary(ls), false, 'the DOM alone is not enough');
});

test('the drawn threshold sits in the gap the corpus measured', () => {
    assert.ok(LANDMARK_RULE > 0.023, 'above every undrawn landmark edge in the corpus');
    assert.ok(LANDMARK_RULE < 0.131, 'below every drawn one');
});

// THE STITCH JUDGES A HARVESTED LINE AGAIN, AS A FULL-WIDTH CUT, and it was this path
// that actually dropped andybudd.com's header: a tile had already found the cut at y=105
// and `segmentTall` threw it away, because a 306x306 decorative dot patch spans y=-101 to
// 205 and the line runs through it. Every rule segment applies to a cut applies here too,
// this exemption included.
// THE ASSERTION IS ON THE BANDS, not on the leaves, and it has to be: `segmentTall` hands
// each band back to `segment`, which carries the same exemption, so a leaf ending at the
// boundary turns up either way and proves nothing about the stitch. A BAND ending there
// can only have come from a harvested line surviving.
test('a harvested landmark boundary survives the stitch', () => {
    const tall = 1200;
    const edges = denseExcept(WIDTH, tall, [[36, BOUNDARY - 1]]);
    // 8.3% of the page, boxed, innermost: a module container, and the boundary runs
    // straight through its interior.
    const patch = {x: 100, y: 0, w: 200, h: 200, tag: 'div', boxed: true, text: ''};
    const root = segmentTall(edges, WIDTH, tall, {...OPTS, maxDepth: 2, rects: [BANNER, patch]});

    assert.ok(
        root.children.some((c) => c.y === 0 && c.h === BOUNDARY),
        `a band should end at y=${BOUNDARY}, got ${JSON.stringify(root.children.map((c) => `${c.y}+${c.h}`))}`,
    );
});

// The one cut that lands outside a gutter is the one that could reach the region's own
// frame, and a zero-height child keeps every area equal while breaking the partition.
test('landmark cuts keep the partition', () => {
    const edges = denseExcept(WIDTH, HEIGHT, [[36, BOUNDARY - 1]]);
    const footer = {x: 0, y: 1100, w: WIDTH, h: 100, tag: 'footer', boxed: false, text: ''};
    const root = segment(edges, WIDTH, HEIGHT, {...OPTS, maxDepth: 4, rects: [BANNER, footer]});
    const ls = leaves(root);

    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(ls), WIDTH * HEIGHT, 'leaves must still tile the image');
    for (const l of ls) assert.ok(l.w > 0 && l.h > 0, `every block must have area: ${JSON.stringify(l)}`);
});
