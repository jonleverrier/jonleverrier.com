/**
 * SAME URL, and the paint limit
 *
 * Two defects found by running the tool against a page nobody had tried.
 *
 *   node --test tools/audit/test/sameurl.test.mjs
 *
 * visionarygrid.studio produced both at once: a wrong-page warning that was wrong, and
 * no warning at all about the third of the page that was missing.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sameUrl, canonicalUrl} from '../lib/sameurl.mjs';
import {paintLimitWarning, PAINT_LIMIT_PX} from '../lib/unrendered.mjs';
import {runNotes} from '../lib/notes.mjs';

// The exact pair that cried wolf: asking for a bare host lands on the same host with the
// empty path the browser fills in, and the old check called that a different page.
test('a trailing slash the browser added is not a different page', () => {
    assert.equal(sameUrl('https://www.visionarygrid.studio', 'https://www.visionarygrid.studio/'), true);
});

test('a differing host, scheme or port IS a different page', () => {
    assert.equal(sameUrl('https://a.com/', 'https://b.com/'), false);
    assert.equal(sameUrl('http://a.com/', 'https://a.com/'), false);
    assert.equal(sameUrl('https://a.com/', 'https://a.com:8443/'), false);
});

// The whole point of the check is catching a navigation, so a real path change must
// survive the normalising.
test('a real path, query or fragment change IS a different page', () => {
    assert.equal(sameUrl('https://a.com/', 'https://a.com/other'), false);
    assert.equal(sameUrl('https://a.com/x', 'https://a.com/x?q=1'), false);
    assert.equal(sameUrl('https://a.com/x', 'https://a.com/x#frag'), false);
});

test('a trailing slash on a real path is still not a difference', () => {
    assert.equal(sameUrl('https://a.com/work', 'https://a.com/work/'), true);
});

test('host case is not a difference, path case is', () => {
    assert.equal(sameUrl('https://A.com/x', 'https://a.com/x'), true);
    assert.equal(sameUrl('https://a.com/X', 'https://a.com/x'), false);
});

// Falling back to an exact comparison can only produce a warning that should be read.
test('an unparseable url falls back to exact comparison', () => {
    assert.equal(canonicalUrl('not a url'), null);
    assert.equal(sameUrl('not a url', 'not a url'), true);
    assert.equal(sameUrl('not a url', 'also not'), false);
});

test('a missing url is never the same page', () => {
    for (const pair of [[null, 'https://a.com/'], ['https://a.com/', undefined], ['', '']]) {
        assert.equal(sameUrl(pair[0], pair[1]), false);
    }
});

// The real numbers: the page is 24,746px and content stops dead at y=16382.
test('a page taller than Chromium paints is reported with the missing amount', () => {
    const w = paintLimitWarning({fullHeight: 24746});
    assert.match(w, /24746/);
    assert.match(w, /16384/);
    assert.match(w, /8362/);
    assert.match(w, /33\.8%/);
});

test('a page within the paint limit says nothing', () => {
    assert.equal(paintLimitWarning({fullHeight: PAINT_LIMIT_PX}), null);
    assert.equal(paintLimitWarning({fullHeight: 3752}), null);
    for (const meta of [undefined, null, {}, {fullHeight: 0}]) {
        assert.equal(paintLimitWarning(meta), null);
    }
});

// This is the condition shotTruncated CANNOT see: the PNG is the full height and the rows
// below the limit are background, so comparing the two heights finds nothing wrong.
test('the paint limit is noted even when the image height matches the page', () => {
    const notes = runNotes({
        url: 'https://a.com/',
        capturedUrl: 'https://a.com/',
        fullHeight: 24746,
        image: {width: 1440, height: 24746},
        consentDismissed: true,
        scrollCapHit: false,
    });

    assert.ok('paintLimit' in notes.conditions, 'a 24746px page must be noted');
    assert.equal(notes.conditions.paintLimit.effect, 'unmeasured');
    assert.equal(notes.conditions.paintLimit.facts.missing, 24746 - PAINT_LIMIT_PX);
    assert.equal('shotTruncated' in notes.conditions, false, 'the heights agree, so that one cannot fire');
});

test('a trailing slash does not raise a wrongPage note', () => {
    const notes = runNotes({
        url: 'https://www.visionarygrid.studio',
        capturedUrl: 'https://www.visionarygrid.studio/',
        fullHeight: 3752,
        image: {width: 1440, height: 3752},
        consentDismissed: true,
        scrollCapHit: false,
    });

    assert.equal('wrongPage' in notes.conditions, false);
});
