/**
 * STITCH
 *
 * Sliver bands: the tall-page stitch making blocks a pixel tall.
 *
 *   node --test tools/audit/test/stitch.test.mjs
 *
 * `segment` refuses to make a child below `minSide`, but `segmentTall` built its bands
 * from the union of every tile's cut lines and checked only that the height was positive.
 * Two overlapping tiles disagreeing by a pixel therefore produced `x=0 y=3978 w=1440 h=1`
 * on a real page, plus an 11px band. Applying a floor in the stitch is not a new rule,
 * it is the existing one reaching the one path that skipped it.
 *
 * The numbers below are real coordinates from switch.je, kept because the tie-break is
 * the whole point and an invented pair would not show why.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mergeNearbyCuts, BAND_MIN_HEIGHT, segmentTall} from '../lib/xycut.mjs';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {leaves, assertPartition, totalArea} from '../lib/blocks.mjs';

test('a cut that would leave a sliver band is dropped', () => {
    assert.deepEqual(mergeNearbyCuts([0, 500, 501, 1000], 16, null), [0, 500, 1000]);
});

test('well-spaced cuts are left alone', () => {
    const ys = [0, 200, 400, 600, 800];
    assert.deepEqual(mergeNearbyCuts(ys, 16, null), ys);
});

// THE POINT OF THE WHOLE RULE, and the version that keeps the earlier cut gets it wrong.
// The real pair was y=2517, eleven pixels from any element, and y=2528, exactly an
// element edge. Dropping by position threw away the only true boundary of the two.
test('the cut sitting on a real element edge is the one kept', () => {
    assert.deepEqual(
        mergeNearbyCuts([0, 2517, 2528, 3000], 16, new Set([2528])),
        [0, 2528, 3000],
        'the element edge should survive, not the earlier cut',
    );
});

test('with neither cut on an edge, the earlier one wins', () => {
    assert.deepEqual(mergeNearbyCuts([0, 3978, 3979, 4831], 16, new Set()), [0, 3978, 4831]);
});

test('with both cuts on an edge, the earlier one wins', () => {
    assert.deepEqual(mergeNearbyCuts([0, 500, 505, 1000], 16, new Set([500, 505])), [0, 500, 1000]);
});

// The page's own bottom edge is not negotiable, so the cut before it is what gives way.
test('no sliver is left against the final boundary', () => {
    assert.deepEqual(mergeNearbyCuts([0, 500, 995, 1000], 16, null), [0, 500, 1000]);
});

test('the page top is never displaced by a nearby cut', () => {
    assert.deepEqual(mergeNearbyCuts([0, 5, 1000], 16, new Set([5])), [0, 1000]);
});

test('degenerate input comes back unchanged', () => {
    assert.deepEqual(mergeNearbyCuts([0, 100], 16, null), [0, 100]);
    assert.deepEqual(mergeNearbyCuts([0], 16, null), [0]);
});

// Both paths, because a 1px band is wrong whether or not the DOM was available.
test('no stitched leaf is thinner than a band is allowed to be', async () => {
    const {edges, width, height} = await edgeMapFromPng('tools/audit/fixtures/retail.png');
    const rects = JSON.parse(readFileSync('tools/audit/fixtures/retail.rects.json', 'utf8'));
    for (const opts of [{maxDepth: 4, rects}, {maxDepth: 4}]) {
        const root = segmentTall(edges, width, height, opts);
        const ls = leaves(root);
        const slivers = ls.filter((l) => l.h < BAND_MIN_HEIGHT && l.w === width);
        assert.deepEqual(slivers, [], 'a full-width band below the floor is a stitch artefact');

        // Merging cut lines must not disturb what the whole tool rests on.
        assert.doesNotThrow(() => assertPartition(root));
        assert.equal(totalArea(ls), width * height);
    }
});
