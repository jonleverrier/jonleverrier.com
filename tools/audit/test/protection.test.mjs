/**
 * PROTECTION
 *
 * Two corrections to what the segmenter refuses to cut.
 *
 *   node --test tools/audit/test/protection.test.mjs
 *
 * Both were found by a person looking at a debug image and saying there were too few
 * cuts in one place and too many in another, which is exactly what the review gate is
 * for — no invariant could have caught either, because both produce a perfectly valid
 * partition of exactly the wrong shape.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {segment, fullBleedMedia} from '../lib/xycut.mjs';
import {leaves} from '../lib/blocks.mjs';

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

// switch.je draws a 1440x810 curve starting at y=-76 — above the page — across its
// header, headline, buttons and first two case studies. Treating that as full-bleed
// media protected everything beneath it and merged all of them into one 1132px block.
// A photograph or a video IS the module; a page-scale SVG is drawn OVER the modules.
test('a page-scale svg is not full-bleed media', () => {
    const swoosh = {x: 0, y: -76, w: 1440, h: 810, tag: 'svg', boxed: false, text: ''};

    assert.deepEqual(fullBleedMedia([swoosh], 1440), [], 'an svg decoration protects nothing');
});

test('a video hero is still full-bleed media', () => {
    const hero = {x: 0, y: 153, w: 1440, h: 698, tag: 'video', boxed: false, text: ''};

    assert.equal(fullBleedMedia([hero], 1440).length, 1);
});

// minSide stops slivers, but it cannot tell a sliver from a genuinely short module.
// switch.je's header strip is 76px, and refusing that cut merged the header, the logo
// and the primary nav into the headline below them.
test('a cut on a module boundary is allowed below the size floor', () => {
    const width = 400, height = 1200;
    const edges = denseExcept(width, height, [[76, 96]]);
    const header = {x: 0, y: 0, w: 400, h: 76, tag: 'header', boxed: false, text: ''};
    const opts = {maxDepth: 1, minSide: 120, minAreaFraction: 0.001};

    const withHeader = leaves(segment(edges, width, height, {...opts, rects: [header]}));
    assert.ok(
        withHeader.some((l) => l.y === 0 && l.h === 76),
        'the 76px header should become its own block despite minSide 120',
    );
});

// The override is not a general relaxation: with no module there, the floor still holds.
test('without a module boundary the size floor still refuses the cut', () => {
    const width = 400, height = 1200;
    const edges = denseExcept(width, height, [[76, 96]]);
    const bare = leaves(segment(edges, width, height, {maxDepth: 1, minSide: 120, minAreaFraction: 0.001}));

    assert.equal(bare.length, 1, 'no rects means no module boundary, so minSide applies');
});

// The floor is only overridden ON the boundary itself — a cut elsewhere in the same
// region gets no dispensation.
//
// `landmarkRule: 2` is the documented off-switch for the last-resort landmark cut, and
// it is here because this fixture is BOTH populations at once: a 400px-wide `<header>`
// in a 400px page is a module container and also a page landmark, and in a map this
// dense its bottom edge counts as drawn, so the landmark rule cuts at 76 on its own
// evidence. That is the right answer for that rule and it would hide this one. See
// pageLandmarks, and landmarks.test.mjs for the same boundary asserted from the
// other side.
test('the override applies to the module edge, not to the whole region', () => {
    const width = 400, height = 1200;
    // Quiet at 20-40, nowhere near the header's 76px boundary.
    const edges = denseExcept(width, height, [[20, 40]]);
    const header = {x: 0, y: 0, w: 400, h: 76, tag: 'header', boxed: false, text: ''};
    const opts = {maxDepth: 1, minSide: 120, minAreaFraction: 0.001, landmarkRule: 2, rects: [header]};
    const ls = leaves(segment(edges, width, height, opts));

    assert.equal(ls.length, 1, 'a 30px cut is still a sliver even with a module in the region');
});
