/**
 * UNRENDERED
 *
 * The height-gap check: does the page claim more height than its captured content
 * accounts for, and is that worth telling a human about?
 *
 *   node --test tools/audit/test/unrendered.test.mjs
 *
 * No browser. The decision under test is arithmetic on rects, which is where it belongs.
 *
 * The numbers in the first test are REAL, from switch.je: scrollHeight 4831, deepest
 * captured element ending at 4088, and a visible `position: fixed` footer of 1440x745 at
 * y=4086 that neither the screenshot nor rects.json contains.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    contentBottom, heightGap, unrenderedWarning, shotTruncationWarning, GAP_MIN_PX,
} from '../lib/unrendered.mjs';

const rect = (y, h, tag = 'div') => ({x: 0, y, w: 1440, h, tag, text: ''});

test('the real switch.je shape is flagged, and names the footer', () => {
    const g = heightGap(4831, [rect(0, 4088)], [{x: 0, y: 4086, w: 1440, h: 745, tag: 'footer'}]);
    assert.equal(g.contentBottom, 4088);
    assert.equal(g.gap, 743);
    assert.equal(g.significant, true);
    assert.equal(g.likelyCause.tag, 'footer');

    const w = unrenderedWarning({heightGap: g});
    assert.match(w, /743px/);
    assert.match(w, /<footer>/);
    assert.match(w, /unmeasured, not as empty space/);
});

test('a page whose content reaches the bottom is not flagged', () => {
    const g = heightGap(4000, [rect(0, 4000)]);
    assert.equal(g.gap, 0);
    assert.equal(g.significant, false);
    assert.equal(unrenderedWarning({heightGap: g}), null);
});

// Both conditions have to hold, and each one alone has to NOT be enough.
test('a gap that is large in pixels but tiny in proportion is not flagged', () => {
    const g = heightGap(20000, [rect(0, 19850)]); // 150px, but 0.75% of the page
    assert.ok(g.gap > GAP_MIN_PX);
    assert.equal(g.significant, false);
});

test('a gap that is proportionally large but tiny in pixels is not flagged', () => {
    const g = heightGap(900, [rect(0, 840)]); // 6.7% of the page, but only 60px
    assert.ok(g.fraction > 0.02);
    assert.equal(g.significant, false);
});

test('a significant gap with no fixed element still flags, without naming a cause', () => {
    const g = heightGap(4000, [rect(0, 3000)]);
    assert.equal(g.significant, true);
    assert.equal(g.likelyCause, null);
    const w = unrenderedWarning({heightGap: g});
    assert.match(w, /1000px/);
    assert.doesNotMatch(w, /fixed </);
});

// Otherwise the warning blames a back-to-top chip for a missing footer.
test('the largest fixed element in the band is named, not merely the first', () => {
    const g = heightGap(4000, [rect(0, 3000)], [
        {x: 1380, y: 3900, w: 48, h: 48, tag: 'button'},
        {x: 0, y: 3000, w: 1440, h: 1000, tag: 'footer'},
    ]);
    assert.equal(g.likelyCause.tag, 'footer');
});

test('small fixed furniture is never blamed', () => {
    const g = heightGap(4000, [rect(0, 3000)], [{x: 1380, y: 3900, w: 48, h: 48, tag: 'button'}]);
    assert.equal(g.significant, true);
    assert.equal(g.likelyCause, null, 'a 48x48 chip does not explain a 1000px gap');
});

// THE REAL switch.je SHAPE, both of its pinned elements. The fullscreen-menu overlay is
// LARGER than the footer and covers exactly as much of the unexplained band, so ranking by
// raw area names a mobile menu as the reason a footer is missing.
test('the element that begins where the content stopped is named, not merely the biggest', () => {
    const g = heightGap(4831, [rect(0, 4088)], [
        {x: 0, y: 3931, w: 1440, h: 900, tag: 'div', via: 'both'},
        {x: 0, y: 4086, w: 1440, h: 745, tag: 'footer', via: 'both'},
    ]);
    assert.equal(g.significant, true);
    assert.equal(g.likelyCause.tag, 'footer');
    assert.match(unrenderedWarning({heightGap: g}), /<footer>/);
});

test('an element covering more of the unexplained band outranks one that barely reaches it', () => {
    const g = heightGap(4000, [rect(0, 3000)], [
        {x: 0, y: 2000, w: 1440, h: 1100, tag: 'section'},
        {x: 0, y: 3000, w: 1000, h: 1000, tag: 'footer'},
    ]);
    assert.equal(g.likelyCause.tag, 'footer', 'the section reaches 100px into a 1000px band');
});

test('a fixed element above the content bottom is not a suspect', () => {
    // A sticky header is fixed and visible, but it explains nothing about the foot.
    const g = heightGap(4000, [rect(0, 3000)], [{x: 0, y: 0, w: 1440, h: 80, tag: 'header'}]);
    assert.equal(g.likelyCause, null);
});

test('contentBottom handles an empty or missing rect list', () => {
    assert.equal(contentBottom([]), 0);
    assert.equal(contentBottom(undefined), 0);
    assert.equal(heightGap(1000, []).gap, 1000);
});

test('a missing heightGap never throws', () => {
    for (const meta of [undefined, null, {}, {heightGap: null}]) {
        assert.equal(unrenderedWarning(meta), null);
    }
});

// The page height and the image height were never compared, so a screenshot that stopped
// early was undetectable once the browser had closed — and phase 2 divides by the image,
// so every percentage would have been of a prefix of the page with nothing saying so.
test('a screenshot shorter than the page is flagged, with both numbers', () => {
    const w = shotTruncationWarning({fullHeight: 20000, image: {width: 1440, height: 16384}});
    assert.match(w, /16384/);
    assert.match(w, /20000/);
    assert.match(w, /3616px was never captured/);
});

test('an image that matches the page is not flagged', () => {
    assert.equal(shotTruncationWarning({fullHeight: 4831, image: {width: 1440, height: 4831}}), null);
});

// scrollHeight is an integer rounding of a fractional layout height, so one pixel either
// way is arithmetic, not truncation.
test('a one-pixel shortfall is rounding, not truncation', () => {
    assert.equal(shotTruncationWarning({fullHeight: 4831, image: {width: 1440, height: 4830}}), null);
    assert.ok(shotTruncationWarning({fullHeight: 4831, image: {width: 1440, height: 4829}}));
});

test('an image taller than the page is not a truncation', () => {
    assert.equal(shotTruncationWarning({fullHeight: 96, image: {width: 1440, height: 900}}), null);
});

test('a meta with no image or no height never throws', () => {
    for (const meta of [undefined, null, {}, {fullHeight: 0, image: {height: 0}}, {fullHeight: 900}, {image: {height: 900}}]) {
        assert.equal(shotTruncationWarning(meta), null);
    }
});
