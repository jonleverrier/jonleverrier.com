/**
 * BRIDGING A HAIRLINE
 *
 * The divider rule under a header is what stops the header being cut off.
 *
 *   node --test tools/audit/test/bridge.test.mjs
 *
 * On hsbc.co.uk the `<nav>` ends at y=118, the gutters either side of it are 98-117 and
 * 121-139, and the one row between them — y=117, density 0.4139 — is the rule that draws
 * the boundary. The edge everyone can see is in neither gutter, so `snapToEdge` never
 * offered it, a cut at 117 would have left an 82px child for minSide to refuse, and the
 * header, the nav and the hero came back as one 767px block. natwest.com is the same
 * shape a pixel tighter; kohde.agency stacks two full-bleed 1440x900 videos whose seam at
 * y=900 is a colour step rather than a rule, and is the same defect with no border at all.
 *
 * What may be bridged to is a SEAM — one module ends there, the next begins there, and
 * the gutter is the whitespace of one of them. The tests below are as much about what
 * that refuses as about what it reaches: a module's own outer edge with nothing beyond
 * it is a page margin, and reaching for those moved the jonleverrier fixture from 12
 * leaves to 17 while it was being built.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {segment, MODULE_BRIDGE, edgeSpans, snapToEdge} from '../lib/xycut.mjs';
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
// Two stacked modules meeting at y=56, each 4.7% of the page — inside MODULE_AREA, and
// neither containing the other, so both survive the innermost-box rule.
const HEADER = {x: 0, y: 0, w: WIDTH, h: 56, tag: 'header', boxed: false, text: ''};
const BELOW = {x: 0, y: 56, w: WIDTH, h: 56, tag: 'nav', boxed: false, text: ''};
// The header's trailing padding, then one row of rule at y=55, then the seam at 56.
const HAIRLINE = [[36, 55]];
const OPTS = {maxDepth: 1, minSide: 120, minAreaFraction: 0.02};

test('the map really has the shape this file is about', () => {
    const edges = denseExcept(WIDTH, HEIGHT, HAIRLINE);
    const row = (y) => edges[y * WIDTH];

    assert.equal(row(54), 0, 'the gutter must reach y=54');
    assert.equal(row(55), 1, 'y=55 must be the rule — a content row between gutter and seam');
    assert.equal(row(56), 1, 'the page must carry on below the seam');
    assert.equal(HEADER.y + HEADER.h, BELOW.y, 'the two modules must actually meet');
    assert.ok(BELOW.y - 55 <= MODULE_BRIDGE, 'the seam must be within the tolerance of the gutter');
});

test('a seam one pixel past a gutter is cut', () => {
    const edges = denseExcept(WIDTH, HEIGHT, HAIRLINE);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [HEADER, BELOW]}));

    assert.ok(
        ls.some((l) => l.y === 0 && l.y + l.h === BELOW.y),
        `the header should end at the seam y=${BELOW.y}, got ${JSON.stringify(ls)}`,
    );
});

// The control, and the whole of the difference: `moduleBridge: 0` is the behaviour this
// file exists to change. The cut it would make is inside the header's own padding and is
// then refused for being a sliver, so the header stays merged into everything below it.
test('without the bridge the same page cannot reach that seam', () => {
    const edges = denseExcept(WIDTH, HEIGHT, HAIRLINE);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [HEADER, BELOW], moduleBridge: 0}));

    assert.equal(
        ls.some((l) => l.y === 0 && l.y + l.h === BELOW.y),
        false,
        'the unbridged segmenter must not find the seam — otherwise this file tests nothing',
    );
});

// A module edge with nothing on the other side of it is an outer edge, not a seam. This
// is the jonleverrier case: its header runs 17-1423 in a 1440px page, its own left
// padding is a gutter, and bridging to the header's left edge made the 17px page margin
// a block. Same map as above, minus the module below the rule.
test('a lone module edge across a rule is not bridged', () => {
    const edges = denseExcept(WIDTH, HEIGHT, HAIRLINE);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [HEADER]}));

    assert.equal(
        ls.some((l) => l.y + l.h === HEADER.y + HEADER.h),
        false,
        'an edge that nothing begins at is a margin, and must stay out of reach',
    );
});

// The gutter has to belong to one of the two modules. A gutter lying OUTSIDE both, a
// hairline away from where they meet, is somebody else's whitespace.
test('a gutter outside both modules is not bridged into them', () => {
    // The modules sit lower down, so the gutter at 36-55 is above both of them.
    const header = {...HEADER, y: 56, h: 56};
    const below = {...BELOW, y: 112, h: 56};
    const edges = denseExcept(WIDTH, HEIGHT, HAIRLINE);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [header, below]}));

    assert.equal(
        ls.some((l) => l.y + l.h === header.y),
        false,
        'the gutter is not the whitespace of either module, so their edge is out of reach',
    );
});

// THE CUT IS STILL A PARTITION, which is the one thing a bridged cut could break that
// nothing else here would notice: it is the only cut that lands outside the gutter, so
// it is the only one that can reach the region's own frame. A zero-height child keeps
// every area equal and passes assertPartition — see the second assertion.
test('a seam at the region frame cannot produce an empty block', () => {
    // A gutter inside the lower module, one pixel below the seam, reaching BACK to it.
    const edges = denseExcept(WIDTH, HEIGHT, [[36, 55], [57, 75]]);
    const root = segment(edges, WIDTH, HEIGHT, {...OPTS, maxDepth: 4, rects: [HEADER, BELOW]});
    const ls = leaves(root);

    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(ls), WIDTH * HEIGHT, 'leaves must still tile the image');
    for (const l of ls) {
        assert.ok(l.w > 0 && l.h > 0, `every block must have area: ${JSON.stringify(l)}`);
    }
});

// THE OTHER SHAPE THE SEAM ARRIVES IN, and it is the more common one: gutters on BOTH
// sides of the rule, so the boundary is a one-pixel gap between two big runs of
// whitespace rather than the last thing before the next section starts. jtcgroup.com has
// 86px either side of its `<section>` boundary; kohde.agency has 86 and 118 either side
// of the colour step between two videos. Widest-first then offers the gutter BELOW the
// seam as well, which is the case the rule has to answer twice.
test('a seam in a one-pixel gap between two gutters is cut', () => {
    const edges = denseExcept(WIDTH, HEIGHT, [[36, 55], [57, 90]]);
    const ls = leaves(segment(edges, WIDTH, HEIGHT, {...OPTS, rects: [HEADER, BELOW]}));

    assert.ok(
        ls.some((l) => l.y === 0 && l.y + l.h === BELOW.y),
        `the seam at y=${BELOW.y} should be the cut, got ${JSON.stringify(ls)}`,
    );
});

// snapToEdge on its own, because `segment` decides several things at once and this is the
// one of them under test. Both halves of the rule are checked against the same gutter.
test('snapToEdge reaches a seam and refuses a lone edge', () => {
    const gutter = {start: 36, end: 55};
    const candidates = [0, 56, 112];
    const seam = edgeSpans([HEADER, BELOW], true);
    const lone = edgeSpans([HEADER], true);
    const preferred = new Set([0, 56, 112]);
    const opts = {extent: HEIGHT, spans: seam};

    assert.equal(snapToEdge(gutter, candidates, 0, preferred, opts), 56, 'the seam is reachable');
    assert.equal(
        snapToEdge(gutter, candidates, 0, preferred, {...opts, spans: lone}),
        (36 + 55) >> 1,
        'with nothing beginning at 56 the gutter midpoint stands',
    );
    assert.equal(
        snapToEdge(gutter, candidates, 0, preferred, {extent: HEIGHT, spans: seam, bridge: 0}),
        (36 + 55) >> 1,
        'and a zero tolerance reaches nothing at all',
    );
});

// The seam that mattered on kohde.agency is not in `candidates` at all: CONTENT_RECT
// excludes anything 700px or taller, so two stacked 1440x900 videos have no candidate
// edge between them. The bridged population is taken from the protected modules.
test('a seam is reachable even when it is not a content-rect edge', () => {
    const width = 400;
    const height = 2400;
    const above = {x: 0, y: 0, w: width, h: 800, tag: 'video', boxed: false, text: ''};
    const under = {x: 0, y: 800, w: width, h: 800, tag: 'video', boxed: false, text: ''};
    // The upper video's last rows are quiet, then one row of colour step at 799.
    const edges = denseExcept(width, height, [[700, 799]]);
    const rects = [above, under];
    const ls = leaves(segment(edges, width, height, {maxDepth: 1, minSide: 120, minAreaFraction: 0.02, rects}));

    assert.ok(
        ls.some((l) => l.y === 0 && l.y + l.h === 800),
        `the video seam at y=800 should be the cut, got ${JSON.stringify(ls)}`,
    );
});
