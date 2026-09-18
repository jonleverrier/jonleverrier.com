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

// The scheme line is the DOWNGRADE: `sameUrl(captured, requested)`, so this is asking
// for https and being answered over http. The upgrade is forgiven and this is not.
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

// ---------------------------------------------------------------------------
// The canonical redirect. `http://boondmanager.com` lands on
// `https://www.boondmanager.com/` — an upgrade and a `www.` prefix at once, which is what
// most of the web does with a bare hostname, and the old check called it another page.
// ---------------------------------------------------------------------------

test('an http request answered over https on www is not a different page', () => {
    assert.equal(sameUrl('https://www.boondmanager.com/', 'http://boondmanager.com'), true);
});

test('a www prefix is not a difference, whichever side it turns up on', () => {
    assert.equal(sameUrl('https://www.klark.ai/', 'https://klark.ai'), true);
    assert.equal(sameUrl('https://klark.ai/', 'https://www.klark.ai'), true);
});

// The upgrade is forgiven in ONE direction. Being moved off TLS is worth knowing about,
// and it is what a symmetric scheme rule would swallow along with the upgrade.
test('an https request answered over http IS a different page', () => {
    assert.equal(sameUrl('http://www.a.com/', 'https://a.com'), false);
    assert.equal(sameUrl('http://a.com/', 'https://www.a.com'), false);
});

// Forgiving the prefix must not merge two sites, and `www.com` is a registrable domain in
// its own right rather than a prefix on one.
test('forgiving www does not merge different hosts', () => {
    assert.equal(sameUrl('https://www.a.com/', 'https://www.b.com/'), false);
    assert.equal(sameUrl('https://www.a.com/', 'https://b.com/'), false);
    assert.equal(sameUrl('https://www.com/', 'https://com/'), false);
});

// The reason the check exists at all: a consent click carrying the capture onto another
// page. Everything forgiven above is forgiven only while the page is the same one.
test('a navigation away still fires, upgrade and www notwithstanding', () => {
    assert.equal(sameUrl('https://www.a.com/cookie-policy', 'http://a.com'), false);
    assert.equal(sameUrl('https://www.a.com/?consent=1', 'http://a.com'), false);
    assert.equal(sameUrl('https://www.a.com:8443/', 'http://a.com'), false);
});

test('canonicalUrl says what it compares: scheme kept, www gone', () => {
    assert.equal(canonicalUrl('https://www.a.com/work/'), 'https://a.com/work');
    assert.equal(canonicalUrl('http://A.COM'), 'http://a.com');
});

// Through the notes, because that is what reaches blocks.json and the terminal.
test('the ordinary canonical redirect raises no wrongPage note', () => {
    const notes = runNotes({
        url: 'http://boondmanager.com',
        capturedUrl: 'https://www.boondmanager.com/',
        fullHeight: 10619,
        image: {width: 1440, height: 10619},
        httpStatus: 200,
        consentDismissed: true,
        scrollCapHit: false,
    });

    assert.equal('wrongPage' in notes.conditions, false);
});

test('a capture that ended on another page still raises wrongPage', () => {
    const notes = runNotes({
        url: 'http://boondmanager.com',
        capturedUrl: 'https://www.boondmanager.com/cookie-policy',
        fullHeight: 10619,
        image: {width: 1440, height: 10619},
        httpStatus: 200,
        consentDismissed: true,
        scrollCapHit: false,
    });

    assert.ok('wrongPage' in notes.conditions);
    assert.equal(notes.conditions.wrongPage.effect, 'attribution');
    assert.equal(notes.conditions.wrongPage.facts.captured, 'https://www.boondmanager.com/cookie-policy');
});
