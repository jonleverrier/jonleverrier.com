/**
 * NOTES
 *
 * The honesty layer, in a shape something other than a terminal can read.
 *
 *   node --test tools/audit/test/notes.test.mjs
 *
 * These assert the CONTRACT — codes, effects, the meta-was-missing distinction, and that
 * a message is safe to print while its facts stay raw — rather than the wording of any
 * sentence. The wording belongs to webgl.mjs and unrendered.mjs and is tested there.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runNotes, noteCodes, anyUnmeasured, EFFECTS} from '../lib/notes.mjs';
import {webglWarning} from '../lib/webgl.mjs';
import {shotTruncationWarning, unrenderedWarning} from '../lib/unrendered.mjs';

/** A capture with nothing wrong with it. */
const clean = (over = {}) => ({
    url: 'https://example.com/',
    capturedUrl: 'https://example.com/',
    fullHeight: 2000,
    image: {width: 1440, height: 2000},
    consentDismissed: true,
    consentVia: 'vendor selector',
    consentNavigatedAway: false,
    scrollCapHit: false,
    webgl: {renderer: 'Apple GPU', software: false, requested: [], draws: 0, blind: false},
    heightGap: {contentBottom: 2000, gap: 0, fraction: 0, significant: false, likelyCause: null},
    ...over,
});

const ESC = String.fromCharCode(0x1b);
const inert = (s) => ![...s].some((c) => {
    const n = c.charCodeAt(0);

    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029
        || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
});

test('a clean capture has no conditions, and says the record was read', () => {
    const notes = runNotes(clean());
    assert.equal(notes.metaRead, true);
    assert.deepEqual(noteCodes(notes), []);
    assert.equal(anyUnmeasured(notes), false);
});

test('no meta.json is a declared unknown, never a clean run', () => {
    // The distinction this file exists for: "nothing was wrong" and "we could not tell"
    // used to be the same clean-looking exit 0.
    const notes = runNotes(null);
    assert.equal(notes.metaRead, false, 'a consumer must be able to tell without reading prose');
    assert.deepEqual(noteCodes(notes), ['metaMissing']);
    assert.equal(notes.conditions.metaMissing.effect, 'unknown');
    assert.equal(notes.conditions.metaMissing.facts.reason, 'missing');
});

test('an unreadable meta.json is distinguished from an absent one', () => {
    const notes = runNotes(null, 'unreadable');
    assert.equal(notes.metaRead, false);
    assert.equal(notes.conditions.metaMissing.facts.reason, 'unreadable');
    assert.notEqual(notes.conditions.metaMissing.message, runNotes(null).conditions.metaMissing.message);
});

test('the scroll cap reaches the notes, having reached no warning function before', () => {
    const notes = runNotes(clean({scrollCapHit: true}));
    assert.ok('scrollCapHit' in notes.conditions);
    assert.equal(notes.conditions.scrollCapHit.effect, 'unmeasured');
    assert.equal(anyUnmeasured(notes), true);
});

test('a banner that was not dismissed reaches the notes, and is not called unmeasured', () => {
    // It IS in the measurement, which is the right answer — a consent wall is real
    // surface area. The note exists so the number can be explained, not discounted.
    const notes = runNotes(clean({consentDismissed: false, consentBannerSeen: true, consentNavigatedAway: true, consentVia: null}));
    assert.equal(notes.conditions.consentNotDismissed.effect, 'included');
    assert.equal(notes.conditions.consentNotDismissed.facts.navigatedAway, true);
    assert.equal(anyUnmeasured(notes), false, 'nothing is missing from the image');
});

test('a capture that ended somewhere else is an attribution problem, and comes first', () => {
    const notes = runNotes(clean({
        capturedUrl: 'https://elsewhere.example/',
        scrollCapHit: true,
    }));
    assert.equal(noteCodes(notes)[0], 'wrongPage', 'which page this is of outranks everything else');
    assert.equal(notes.conditions.wrongPage.effect, 'attribution');
    assert.equal(notes.conditions.wrongPage.facts.captured, 'https://elsewhere.example/');
    assert.equal(notes.conditions.wrongPage.facts.requested, 'https://example.com/');
});

test('the three existing warnings keep their own wording, from their own modules', () => {
    // Deriving the terminal's sentences from the notes is only safe if the notes carry
    // the same sentence. If these ever diverge, one of the two is now saying something
    // the other does not.
    const meta = clean({
        image: {width: 1440, height: 1200},
        webgl: {renderer: 'SwiftShader', software: true, requested: ['webgl'], draws: 0, blind: true},
        heightGap: {contentBottom: 1200, gap: 800, fraction: 0.4, significant: true, likelyCause: null},
    });
    const {conditions} = runNotes(meta);
    assert.equal(conditions.shotTruncated.message, shotTruncationWarning(meta));
    assert.equal(conditions.webglBlind.message, webglWarning(meta.webgl));
    assert.equal(conditions.unrenderedGap.message, unrenderedWarning(meta));
});

test('every condition declares an effect from the closed set', () => {
    const notes = runNotes(clean({
        capturedUrl: 'https://elsewhere.example/',
        scrollCapHit: true,
        consentDismissed: false,
        consentBannerSeen: true,
        image: {width: 1440, height: 1200},
        webgl: {renderer: 'SwiftShader', software: true, requested: ['webgl'], draws: 0, blind: true},
        heightGap: {contentBottom: 1200, gap: 800, fraction: 0.4, significant: true, likelyCause: {tag: 'footer', w: 1440, h: 700}},
    }));
    assert.ok(noteCodes(notes).length >= 5, 'this meta should trip most of them');
    for (const [code, c] of Object.entries(notes.conditions)) {
        assert.ok(EFFECTS.includes(c.effect), `${code} has an effect outside the set: ${c.effect}`);
        assert.equal(typeof c.message, 'string');
        assert.ok(c.message.length > 0, `${code} must say something`);
        assert.equal(typeof c.facts, 'object');
    }
});

test('a message is safe to print and its facts are not sanitised', () => {
    // The contract: `message` has been through printable() because stderr prints it;
    // `facts` is the record, and a URL has to stay byte-exact to be worth comparing.
    const hostile = `https://example.com/${ESC}[2K`;
    const notes = runNotes(clean({
        capturedUrl: hostile,
        webgl: {renderer: `Swift${ESC}[31mShader`, software: true, requested: [`webgl${ESC}[0m`], draws: 0, blind: true},
    }));
    for (const [code, c] of Object.entries(notes.conditions)) {
        assert.ok(inert(c.message), `${code}: a message is printed, so it must be printable`);
    }
    assert.equal(notes.conditions.wrongPage.facts.captured, hostile, 'the record keeps the real URL');
});

test('the same meta always produces the same JSON, key order included', () => {
    // blocks.json has to be byte-identical across two runs of the same input, and the
    // notes are now part of that file.
    const meta = clean({scrollCapHit: true, consentDismissed: false});
    assert.equal(JSON.stringify(runNotes(meta)), JSON.stringify(runNotes(meta)));
});

test('conditions are keyed by code, so a code cannot appear twice', () => {
    const notes = runNotes(clean({scrollCapHit: true}));
    assert.equal(Object.keys(notes.conditions).length, new Set(Object.keys(notes.conditions)).size);
    assert.ok('scrollCapHit' in notes.conditions, 'membership is the cheap question this shape answers');
});

// THE FALSE ALARM THIS DISTINCTION EXISTS FOR. `consentDismissed: false` used to mean
// both "there was a wall we could not get past" and "this page has no cookie banner", so
// the note fired on liquidlight.co.uk and vaiie.com — neither of which has one —
// announcing that their measurements were "largely a measurement of the wall". On most of
// the web, in other words.
test('a page with no banner at all raises no consent note', () => {
    const notes = runNotes(clean({consentDismissed: false, consentBannerSeen: false}));
    assert.equal('consentNotDismissed' in notes.conditions, false);
});

test('a banner that was found and left standing still raises one', () => {
    const notes = runNotes(clean({consentDismissed: false, consentBannerSeen: true}));
    assert.equal(notes.conditions.consentNotDismissed.effect, 'included');
    assert.match(notes.conditions.consentNotDismissed.message, /found and not dismissed/);
});

// An older capture has no such field, and must not start claiming a wall that was never
// recorded either way.
test('a capture predating the field raises no consent note', () => {
    const notes = runNotes(clean({consentDismissed: false}));
    assert.equal('consentNotDismissed' in notes.conditions, false);
});

// webreality.co.uk answers a headless browser with a CloudFront 403. The capture recorded
// that as an ordinary success — two blocks, area conserved, exit 0 — because the HTTP
// status was read and thrown away. Percentages of a block page are not a weaker
// measurement of the site; they are a measurement of something else entirely.
test("a non-2xx response is an attribution problem, not a weaker measurement", () => {
    const notes = runNotes(clean({httpStatus: 403}));
    assert.equal(notes.conditions.httpError.effect, "attribution");
    assert.equal(notes.conditions.httpError.facts.status, 403);
    assert.match(notes.conditions.httpError.message, /403/);
});

test("every non-2xx status is caught, not just the ones we happened to meet", () => {
    for (const status of [301, 302, 400, 403, 404, 429, 500, 503]) {
        assert.ok("httpError" in runNotes(clean({httpStatus: status})).conditions, String(status));
    }
});

test("a 2xx response raises nothing", () => {
    for (const status of [200, 201, 204]) {
        assert.equal("httpError" in runNotes(clean({httpStatus: status})).conditions, false, String(status));
    }
});

// A same-document navigation has no response to read, and a capture predating the field
// never recorded one. Neither is an error, and inventing one would be the same mistake
// the consent note just made.
test("no status recorded is not an error", () => {
    assert.equal("httpError" in runNotes(clean({httpStatus: null})).conditions, false);
    assert.equal("httpError" in runNotes(clean({})).conditions, false);
});

/* --------------------------------------------------- elements that arrived too late */

/**
 * natwest.com's pinned census found 13 candidates in its early probe, DECIDED NONE of
 * them, and recorded 15 arrivals after the decision. Its "Chat to Cora" widget is painted
 * four times down the stitched image and `notes` read `none` — the condition reached the
 * phase 1 CLI's stdout and nothing that blocks.json or the Craft job can see, which is
 * the mistake scrollCapHit and consentNotDismissed were written to correct.
 */
test('a capture that decided nothing and saw late arrivals says so', () => {
    const notes = runNotes(clean({
        capture: {mode: 'stitched', slices: 9, pinned: {earlyPinned: 13, decided: 0, lateArrivals: 15}},
    }));

    assert.ok('lateArrivals' in notes.conditions, 'the condition must reach blocks.json, not only a terminal');
    assert.equal(notes.conditions.lateArrivals.effect, 'unmeasured');
    assert.equal(notes.conditions.lateArrivals.facts.lateArrivals, 15);
});

test('a capture with nothing arriving late stays quiet about it', () => {
    const notes = runNotes(clean({
        capture: {mode: 'stitched', slices: 6, pinned: {earlyPinned: 203, decided: 4, lateArrivals: 0}},
    }));

    assert.equal('lateArrivals' in notes.conditions, false);
});

test('a capture with no pinned census at all does not invent the condition', () => {
    assert.equal('lateArrivals' in runNotes(clean({})).conditions, false);
});
