import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findGutters, widestGutter, rowDensity, segment, segmentTall, adaptiveMaxDensity, GUTTER} from '../lib/xycut.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {leaves, totalArea, area, assertPartition, overlaps} from '../lib/blocks.mjs';

const FIXTURES = ['tools/audit/fixtures/jonleverrier.png', 'tools/audit/fixtures/retail.png'];

test('findGutters finds a run below the density threshold', () => {
    const d = Float32Array.from([0.5, 0.5, 0, 0, 0, 0, 0.5, 0.5]);
    const g = findGutters(d, {minRun: 3, maxDensity: 0.01});
    assert.deepEqual(g, [{start: 2, end: 6}]);
});

test('findGutters ignores runs shorter than minRun', () => {
    const d = Float32Array.from([0.5, 0, 0, 0.5]);
    assert.deepEqual(findGutters(d, {minRun: 3, maxDensity: 0.01}), []);
});

test('findGutters includes a run that reaches the end', () => {
    const d = Float32Array.from([0.5, 0, 0, 0, 0]);
    assert.deepEqual(findGutters(d, {minRun: 3, maxDensity: 0.01}), [{start: 1, end: 5}]);
});

test('widestGutter picks the longest run, not the first', () => {
    const g = [{start: 0, end: 4}, {start: 10, end: 20}, {start: 30, end: 33}];
    assert.deepEqual(widestGutter(g), {start: 10, end: 20});
});

test('widestGutter returns null when there are none', () => {
    assert.equal(widestGutter([]), null);
});

test('rowDensity counts only pixels inside the rect', () => {
    // 4x2 image, top row all edges, bottom row none
    const edges = Uint8Array.from([1, 1, 1, 1, 0, 0, 0, 0]);
    const d = rowDensity(edges, 4, {x: 0, y: 0, w: 2, h: 2, depth: 0, children: []});
    assert.equal(d[0], 1);
    assert.equal(d[1], 0);
});

for (const fixture of FIXTURES) {
    test(`${fixture}: leaves exactly tile the image at every depth`, async () => {
        const {edges, width, height} = await edgeMapFromPng(fixture);
        for (const maxDepth of [2, 4, 6]) {
            const root = segment(edges, width, height, {maxDepth});
            assert.doesNotThrow(() => assertPartition(root), `depth ${maxDepth}`);
            assert.equal(
                totalArea(leaves(root)),
                width * height,
                `depth ${maxDepth}: leaf area must equal image area`,
            );
        }
    });

    test(`${fixture}: no two leaves overlap`, async () => {
        const {edges, width, height} = await edgeMapFromPng(fixture);
        const ls = leaves(segment(edges, width, height, {maxDepth: 4}));
        for (let i = 0; i < ls.length; i++) {
            for (let j = i + 1; j < ls.length; j++) {
                assert.equal(overlaps(ls[i], ls[j]), false, `${JSON.stringify(ls[i])} vs ${JSON.stringify(ls[j])}`);
            }
        }
    });

    test(`${fixture}: deeper never means fewer blocks`, async () => {
        const {edges, width, height} = await edgeMapFromPng(fixture);
        const n2 = leaves(segment(edges, width, height, {maxDepth: 2})).length;
        const n6 = leaves(segment(edges, width, height, {maxDepth: 6})).length;
        assert.ok(n6 >= n2, `depth 6 gave ${n6} blocks, depth 2 gave ${n2}`);
    });

    test(`${fixture}: segmentation is deterministic`, async () => {
        const {edges, width, height} = await edgeMapFromPng(fixture);
        const a = JSON.stringify(segment(edges, width, height, {maxDepth: 4}));
        const b = JSON.stringify(segment(edges, width, height, {maxDepth: 4}));
        assert.equal(a, b);
    });

    test(`${fixture}: every leaf respects the minimum size`, async () => {
        const {edges, width, height} = await edgeMapFromPng(fixture);
        const root = segment(edges, width, height, {maxDepth: 6, minSide: 120});
        // A leaf may be small only because its PARENT could not be split further,
        // so assert the rule that is actually enforced: no split produced a child
        // below the floor. A leaf smaller than minSide must therefore have no sibling.
        for (const l of leaves(root)) {
            if (Math.min(l.w, l.h) < 120) {
                assert.equal(l.depth, 0, 'an undersized leaf can only be an unsplit root');
            }
        }
    });
}

test('segmentTall conserves area on a tall synthetic edge map', () => {
    // 200 wide, 3000 tall — taller than one 900px tile, with quiet bands every 300px
    const width = 200, height = 3000;
    const edges = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const quiet = y % 300 < 30;
        if (quiet) continue;
        for (let x = 0; x < width; x += 3) edges[y * width + x] = 1;
    }
    const root = segmentTall(edges, width, height, {maxDepth: 4, minSide: 20, minAreaFraction: 0.001});
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('segmentTall and segment agree when the page fits in one tile', () => {
    const width = 200, height = 800;
    const edges = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        if (y % 300 < 30) continue;
        for (let x = 0; x < width; x += 3) edges[y * width + x] = 1;
    }
    const opts = {maxDepth: 3, minSide: 20, minAreaFraction: 0.001};
    assert.equal(
        JSON.stringify(segmentTall(edges, width, height, opts)),
        JSON.stringify(segment(edges, width, height, opts)),
    );
});

test('segmentTall keeps vertical structure inside a band instead of flattening it to a full-width leaf', () => {
    // Same tall/quiet-band shape as above, but with a genuine vertical gutter
    // (columns 90..110 carry no edges anywhere) running through every content
    // band. A bare-full-width-band stitch can never produce a leaf narrower
    // than the page, no matter what the input looks like — this is the test
    // that would have caught that defect.
    const width = 200, height = 3000;
    const edges = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        if (y % 300 < 30) continue; // quiet horizontal band -> tile seams land here
        for (let x = 0; x < width; x += 3) {
            if (x >= 90 && x < 110) continue; // quiet vertical gutter -> column split
            edges[y * width + x] = 1;
        }
    }
    const root = segmentTall(edges, width, height, {maxDepth: 6, minSide: 20, minAreaFraction: 0.001});
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
    assert.ok(
        leaves(root).some((l) => l.w < width),
        'expected at least one leaf narrower than the full image width',
    );
});

// ---------------------------------------------------------------------------
// Task 8: the cuts must land on real layout boundaries.
//
// A gutter says "a boundary is somewhere in this run". Everything below is about
// the three ways the original algorithm answered "where" badly: it cut in the
// middle of the whitespace, it invented cuts out of tile arithmetic, and it gave
// up on a region forever the first time one candidate produced a runt child.
// ---------------------------------------------------------------------------

/** A w x h edge map, every pixel on except the rows listed as quiet. */
const denseExcept = (width, height, quiet) => {
    const edges = new Uint8Array(width * height);
    const isQuiet = (y) => quiet.some(([a, b]) => y >= a && y < b);
    for (let y = 0; y < height; y++) {
        if (isQuiet(y)) continue;
        edges.fill(1, y * width, (y + 1) * width);
    }

    return edges;
};

/** Every distinct horizontal cut line in the tree, page extremes excluded. */
const interiorCuts = (root, height) => {
    const ys = new Set();
    for (const l of leaves(root)) {
        ys.add(l.y);
        ys.add(l.y + l.h);
    }
    ys.delete(0);
    ys.delete(height);

    return [...ys].sort((a, b) => a - b);
};

test('a cut snaps to a real element edge inside the gutter, not the gutter midpoint', () => {
    // Rows 150..249 are the only quiet run, so the gutter is {start: 150, end: 250}
    // and its midpoint is 200. A content element ENDS at y=170, 30px off that
    // midpoint: 170 is where the layout actually stops and 200 is 30px of element
    // handed to the wrong block.
    const width = 200, height = 400;
    const edges = denseExcept(width, height, [[150, 250]]);
    const rects = [{x: 0, y: 20, w: 200, h: 150, tag: 'section', text: ''}];
    const opts = {maxDepth: 1, minSide: 20, minAreaFraction: 0.001};

    const snapped = segment(edges, width, height, {...opts, rects});
    assert.deepEqual(interiorCuts(snapped, height), [170], 'should cut at the element edge');
    assert.doesNotThrow(() => assertPartition(snapped));
    assert.equal(totalArea(leaves(snapped)), width * height);
});

test('no rects means the midpoint, no crash and no change', () => {
    // The pure-pixel path has to keep working: a caller may have a PNG and no DOM
    // at all. Same map as above, no rects -> the old midpoint answer, unchanged.
    const width = 200, height = 400;
    const edges = denseExcept(width, height, [[150, 250]]);
    const opts = {maxDepth: 1, minSide: 20, minAreaFraction: 0.001};

    assert.deepEqual(interiorCuts(segment(edges, width, height, opts), height), [200]);
    assert.deepEqual(
        JSON.stringify(segment(edges, width, height, {...opts, rects: undefined})),
        JSON.stringify(segment(edges, width, height, opts)),
        'an explicit undefined must behave exactly like an absent key',
    );
    assert.deepEqual(
        JSON.stringify(segment(edges, width, height, {...opts, rects: []})),
        JSON.stringify(segment(edges, width, height, opts)),
        'an empty rects list must behave exactly like no rects',
    );
});

test('a tile frame is not a cut: a uniformly dense tall page has no interior cut at all', () => {
    // No gutter anywhere, so nothing on this page justifies a single horizontal
    // boundary. segment() always returns leaves touching their region's frame, so
    // before this was fixed the tile loop alone chopped the page at 750, 900, 1500,
    // 1650, 2250 and 2400 -- pure arithmetic, zero evidence.
    const width = 200, height = 3000;
    const edges = denseExcept(width, height, []);
    const root = segmentTall(edges, width, height, {maxDepth: 4, minSide: 20, minAreaFraction: 0.001});

    assert.deepEqual(interiorCuts(root, height), [], 'tile geometry must not invent a boundary');
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('a failed widest split falls back to the next-widest gutter instead of giving up', () => {
    // The widest gutter (rows 10..40, 30 wide) sits near the top: cutting it leaves a
    // 25px child, under minSide. The next-widest (rows 190..210, 20 wide) halves the
    // region cleanly. Collapsing each axis to one candidate before the size check
    // abandoned the whole region here -- which is why whole pages came out as 5 leaves.
    const width = 200, height = 400;
    const edges = denseExcept(width, height, [[10, 40], [190, 210]]);
    const root = segment(edges, width, height, {maxDepth: 1, minSide: 50, minAreaFraction: 0.001});

    assert.deepEqual(interiorCuts(root, height), [200], 'should split on the narrower gutter');
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('rects reach a tile and a band in the right coordinate space', () => {
    // THE OFFSET IS THE EASY THING TO GET WRONG, and it fails silently: a rect list
    // shifted by the wrong origin still yields a valid partition, just with cuts
    // snapped confidently to the wrong places. So assert the exact page coordinates.
    //
    // Gutter A (1000..1100) is found by the TILE at top=750, in tile space; gutter B
    // (1200..1240) is narrower, so with maxDepth 1 the tile never reaches it and it is
    // found later by the BAND starting at y=1020, in band space. Two different origins,
    // two different non-midpoint answers: A's midpoint is 1050 and the element edge is
    // 1020; B's midpoint is 1220 and the element edge is 1215.
    const width = 200, height = 3000;
    const edges = denseExcept(width, height, [[1000, 1100], [1200, 1240]]);
    const rects = [
        {x: 0, y: 900, w: 200, h: 120, tag: 'section', text: ''},  // ends at 1020, inside A
        {x: 0, y: 1100, w: 200, h: 115, tag: 'section', text: ''}, // ends at 1215, inside B
    ];
    const root = segmentTall(edges, width, height, {maxDepth: 1, minSide: 20, minAreaFraction: 0.001, rects});

    assert.deepEqual(interiorCuts(root, height), [1020, 1215]);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('supplying rects changes the tree, and both runs are byte-identical', async () => {
    // Two halves. Byte-identical repeats are the determinism the CLI promises; the
    // inequality is what stops this test passing vacuously, because a build that
    // ignored opts.rects entirely would satisfy determinism on its own.
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));
    const opts = {maxDepth: 4, rects};

    const a = JSON.stringify(segmentTall(edges, width, height, opts));
    const b = JSON.stringify(segmentTall(edges, width, height, opts));
    assert.equal(a, b, 'two runs with rects must be byte-identical');
    assert.notEqual(
        a,
        JSON.stringify(segmentTall(edges, width, height, {maxDepth: 4})),
        'rects must actually reach the algorithm',
    );
});

// ---------------------------------------------------------------------------
// Adaptive gutter threshold
//
// The defect: a decorative curve drawn across a gap disqualifies it. On switch.je one
// loops through the 96px between the hero CTAs and the first case study, putting those
// rows at 0.010-0.028 against a flat 0.005 threshold -- so a CTA pair and a case-study
// card landed in one block. The gap is still ~16x quieter than its neighbours, which is
// what the relative threshold sees and the absolute one cannot.
// ---------------------------------------------------------------------------

test('adaptiveMaxDensity scales to a tenth of the region median', () => {
    // median 0.20 -> 0.02, comfortably above the floor
    const d = Float32Array.from([0.2, 0.2, 0.2, 0.2, 0.2]);
    assert.equal(Math.round(adaptiveMaxDensity(d) * 10000), 200);
});

test('adaptiveMaxDensity never drops below the absolute floor', () => {
    // An almost-empty region: a tenth of ~0 is ~0, which would find no gutters at all.
    const d = Float32Array.from([0, 0, 0, 0, 0.001]);
    assert.equal(adaptiveMaxDensity(d), GUTTER.maxDensity);
});

test('adaptiveMaxDensity is capped however dense the region gets', () => {
    const d = Float32Array.from([0.9, 0.9, 0.9, 0.9, 0.9]);
    assert.equal(adaptiveMaxDensity(d), GUTTER.ceiling);
});

test('a gutter something is drawn across is found; a flat threshold misses it', () => {
    // The switch.je shape: dense content, a quiet-but-not-empty band, dense content.
    // The band sits at 0.015 -- three times the 0.005 floor, a tenth of the 0.15 median.
    const d = Float32Array.from([
        ...Array(12).fill(0.15),
        ...Array(12).fill(0.015), // the gap, with a decoration crossing it
        ...Array(12).fill(0.15),
    ]);
    assert.deepEqual(findGutters(d, {minRun: 8}), [{start: 12, end: 24}], 'adaptive should find it');
    assert.deepEqual(findGutters(d, {minRun: 8, adaptive: false}), [], 'absolute should miss it');
});

test('a genuinely busy band is still not a gutter', () => {
    // Half the median rather than a tenth of it -- quieter, but not a gap.
    const d = Float32Array.from([
        ...Array(12).fill(0.15),
        ...Array(12).fill(0.075),
        ...Array(12).fill(0.15),
    ]);
    assert.deepEqual(findGutters(d, {minRun: 8}), []);
});

// ---------------------------------------------------------------------------
// Task 9: a full-bleed media element is ONE module.
//
// A blurred video or a photograph has no gutters, only noise — rows whose density
// happens to dip. The segmenter used to slice retail.png's 1440x698 hero <video> into
// four leaves at y=201, 335, 472 and 771, and two of those were the page's worst
// cut-accuracy outliers (134px and 271px from the nearest real element edge). Beyond
// tidiness: one module arriving as four blocks can collect four different labels from
// the vision model downstream.
//
// The ruling: a cut may NOT land strictly inside such an element. Its own edges stay
// valid — those are exactly where the cut belongs. Only candidates are removed, never
// moved, so the partition is untouched.
// ---------------------------------------------------------------------------

test('a cut cannot land strictly inside a full-bleed media element', () => {
    // Rows 150..249 are the only quiet run, so the gutter is {start: 150, end: 250} and
    // the cut would land on its midpoint, 200. A 200x250 <video> spans 100..350, so 200
    // is deep inside the picture and means nothing.
    const width = 200, height = 400;
    const edges = denseExcept(width, height, [[150, 250]]);
    const opts = {maxDepth: 1, minSide: 20, minAreaFraction: 0.001};
    const rects = [{x: 0, y: 100, w: 200, h: 250, tag: 'video', text: ''}];

    // FIRST prove the map contains the structure under test: without the video rect the
    // pixels really do cut here. A synthetic map that never had a gutter would make the
    // assertion below pass against any implementation at all.
    assert.deepEqual(interiorCuts(segment(edges, width, height, opts), height), [200]);

    const root = segment(edges, width, height, {...opts, rects});
    assert.deepEqual(interiorCuts(root, height), [], 'a region that is all hero has nothing to cut');
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test("a full-bleed element's own edge is still a valid cut", () => {
    // The gutter 330..370 straddles the <video>'s bottom edge at 350, which is where a
    // boundary genuinely is. Rejecting the whole gutter because it overlaps the video
    // would throw away the one cut worth making.
    const width = 200, height = 500;
    const edges = denseExcept(width, height, [[330, 370]]);
    const rects = [{x: 0, y: 100, w: 200, h: 250, tag: 'video', text: ''}];
    const root = segment(edges, width, height, {maxDepth: 1, minSide: 20, minAreaFraction: 0.001, rects});

    assert.deepEqual(interiorCuts(root, height), [350], 'the media boundary is exactly where we want the cut');
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('a narrow media element is ordinary content and does not protect a gutter', () => {
    // A 400x300 <img> on a 500px-wide page: tall enough, but 400 is under 90% of the
    // width. It is a product photo inside a grid, and that grid must still be cuttable.
    const width = 500, height = 400;
    const edges = denseExcept(width, height, [[150, 250]]);
    const rects = [{x: 50, y: 50, w: 400, h: 300, tag: 'img', text: ''}];
    const root = segment(edges, width, height, {maxDepth: 1, minSide: 20, minAreaFraction: 0.001, rects});

    assert.deepEqual(interiorCuts(root, height), [200], 'ordinary content must still be cuttable');
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('a short full-width media element is a strip, not a module, and does not protect a gutter', () => {
    // Full width, but 180px tall — a banner. Its edges sit outside the gutter, so the
    // cut is the midpoint 200, strictly inside the image, and must still happen.
    const width = 500, height = 400;
    const edges = denseExcept(width, height, [[150, 250]]);
    const rects = [{x: 0, y: 120, w: 500, h: 180, tag: 'img', text: ''}];
    const root = segment(edges, width, height, {maxDepth: 1, minSide: 20, minAreaFraction: 0.001, rects});

    assert.deepEqual(interiorCuts(root, height), [200]);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('with no rects nothing is protected and the tree is exactly what it was', async () => {
    // Rects are an improvement, never a requirement: a caller may have nothing but a
    // PNG. Same map as the protection test, no rects -> the cut still lands at 200.
    const width = 200, height = 400;
    const edges = denseExcept(width, height, [[150, 250]]);
    const opts = {maxDepth: 1, minSide: 20, minAreaFraction: 0.001};
    const bare = JSON.stringify(segment(edges, width, height, opts));

    assert.deepEqual(interiorCuts(JSON.parse(bare), height), [200]);
    assert.equal(JSON.stringify(segment(edges, width, height, {...opts, rects: undefined})), bare);
    assert.equal(JSON.stringify(segment(edges, width, height, {...opts, rects: []})), bare);

    // And on the real fixture: the pixel-only path still cuts straight through the hero,
    // because without the DOM there is nothing to tell it the hero is one element. 40
    // leaves is what this fixture produced before full-bleed protection existed.
    const {edges: e, width: w, height: h} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const heroRects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));
    const ls = leaves(segmentTall(e, w, h, {maxDepth: 4}));
    const guarded = leaves(segmentTall(e, w, h, {maxDepth: 4, rects: heroRects}));
    const insideHero = (blocks) => blocks.filter((l) => l.y > 153 && l.y + l.h < 851).length;

    // Stated as a RELATIONSHIP between the two paths rather than as a frozen leaf count.
    // This assertion was `ls.length === 40`, which broke the moment an unrelated fix
    // (merging sliver bands in the stitch) legitimately changed the pixel-only tree by one
    // block — a golden value encoding one run's output as truth, which is the thing this
    // suite is supposed to avoid. What actually matters is that protection needs the DOM.
    assert.ok(insideHero(ls) > 0, 'without rects the hero is not protected — documented behaviour');
    assert.equal(insideHero(guarded), 0, 'with rects it is protected');
    assert.ok(
        ls.length >= guarded.length,
        'protection can only ever merge blocks together, never create new ones',
    );
});

test('full-bleed rects reach a TILE in the right coordinate space', () => {
    // THE OFFSET FAILS SILENTLY. A media rect left in page coordinates while the tile is
    // segmented in its own still yields a valid partition — it just protects the wrong
    // stripe of the page. The only gutter (1000..1100, midpoint 1050) sits inside a
    // <video> spanning 960..1180, and the tile at top=750 is the one that sees it: get
    // the shift wrong and the video lands at tile-space 960..1180 (page 1710..1930),
    // nowhere near the cut, which then happens.
    const width = 200, height = 3000;
    const edges = denseExcept(width, height, [[1000, 1100]]);
    const rects = [{x: 0, y: 960, w: 200, h: 220, tag: 'video', text: ''}];
    const opts = {maxDepth: 1, minSide: 20, minAreaFraction: 0.001};

    assert.deepEqual(interiorCuts(segmentTall(edges, width, height, opts), height), [1050], 'the gutter is real');

    const root = segmentTall(edges, width, height, {...opts, rects});
    assert.deepEqual(interiorCuts(root, height), []);
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('full-bleed rects reach a BAND in the right coordinate space', () => {
    // Gutter A (1000..1100) is wide, unprotected, and splits the page at 1050. Gutter B
    // (1500..1540, midpoint 1520) is narrower, so no tile reaches it at maxDepth 1; it is
    // found later by the BAND starting at y=1050, in band space, where the <video>
    // spanning page 1400..1650 must appear at 350..600. Leave the band's rects unshifted
    // and the video lands at page 2450..2700 and B is cut.
    const width = 200, height = 3000;
    const edges = denseExcept(width, height, [[1000, 1100], [1500, 1540]]);
    const rects = [{x: 0, y: 1400, w: 200, h: 250, tag: 'video', text: ''}];
    const opts = {maxDepth: 1, minSide: 20, minAreaFraction: 0.001};

    assert.deepEqual(interiorCuts(segmentTall(edges, width, height, opts), height), [1050, 1520], 'both gutters are real');

    const root = segmentTall(edges, width, height, {...opts, rects});
    assert.deepEqual(interiorCuts(root, height), [1050], 'A survives, B is inside the video');
    assert.doesNotThrow(() => assertPartition(root));
    assert.equal(totalArea(leaves(root)), width * height);
});

test('tools/audit/fixtures/retail.png: the full-bleed hero video comes out as one block', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));
    const hero = rects.find((r) => r.tag === 'video' && r.w >= 0.9 * width && r.h >= 200);
    // The fixture is the evidence; assert it still holds the thing this test is about.
    assert.deepEqual(
        hero && {x: hero.x, y: hero.y, w: hero.w, h: hero.h},
        {x: 0, y: 153, w: 1440, h: 698},
        'retail.rects.json must still contain the 1440x698 hero video',
    );

    const ls = leaves(segmentTall(edges, width, height, {maxDepth: 4, rects}));
    const contains = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
    const sameBox = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    // The headline: four leaves used to sit entirely inside the video. None may.
    assert.deepEqual(
        ls.filter((l) => contains(hero, l) && !sameBox(l, hero)).map((l) => `${l.x},${l.y} ${l.w}x${l.h}`),
        [],
        'no leaf may sit strictly inside the hero video',
    );
    // …and the hero is ONE block, not several that merely avoid being strictly inside.
    const touching = ls.filter((l) => intersects(l, hero));
    assert.equal(touching.length, 1, `the hero should be covered by one block, got ${touching.length}`);
    assert.ok(contains(touching[0], hero), 'that block must contain the whole hero');

    // The rest of the page is untouched: 23 leaves lie entirely below the hero, before
    // and after. The protection removes cut candidates; it does not reshape the page.
    assert.equal(ls.filter((l) => l.y >= hero.y + hero.h).length, 23);
});
