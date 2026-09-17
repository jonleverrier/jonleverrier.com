import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findGutters, widestGutter, rowDensity} from '../lib/xycut.mjs';

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
