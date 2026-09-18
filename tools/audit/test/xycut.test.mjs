import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findGutters, widestGutter, rowDensity, segment} from '../lib/xycut.mjs';
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
