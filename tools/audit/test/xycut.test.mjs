import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findGutters, widestGutter, rowDensity, segment, segmentTall} from '../lib/xycut.mjs';
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
