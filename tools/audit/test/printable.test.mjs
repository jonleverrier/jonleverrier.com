/**
 * PRINTABLE
 *
 * Page text on its way to a terminal.
 *
 *   node --test tools/audit/test/printable.test.mjs
 *
 * The defect: a consent button's label reached `console.log` exactly as the page wrote
 * it. `isAcceptLabel` only ever ran regexes over it, so a label of up to 60 characters
 * could carry any control character it liked into an operator's terminal — and the same
 * is true of the WebGL renderer string, a tag name and a redirect's URL.
 *
 * Every character here is built with String.fromCharCode rather than written as an
 * escape, so what the test feeds in is unambiguously the byte itself.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {printable, PRINTABLE_MAX} from '../lib/printable.mjs';

const ESC = String.fromCharCode(0x1b);
const CSI8 = String.fromCharCode(0x9b); // the 8-bit CSI: an ANSI introducer on its own
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const RLO = String.fromCharCode(0x202e); // right-to-left override

/** Nothing left that can act on a terminal, whatever it was to begin with. */
const inert = (s) => ![...s].some((c) => {
    const n = c.charCodeAt(0);

    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029
        || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
});

test('an ANSI sequence cannot survive', () => {
    const attack = `Accept${ESC}[2K${CR}area check   conserved`;
    const out = printable(attack);
    assert.ok(inert(out), out);
    assert.ok(!out.includes(ESC));
    assert.ok(out.startsWith('Accept'), 'the real label is still readable');
});

test('a newline cannot forge a second line', () => {
    const out = printable(`OK${LF}WARNING: nothing is wrong`);
    assert.equal(out.split(LF).length, 1);
    assert.ok(inert(out));
});

test('the 8-bit CSI and a bare NUL go too', () => {
    assert.ok(inert(printable(`${CSI8}[31mred`)));
    assert.ok(inert(printable(`a${NUL}b`)));
});

test('a bidi override cannot reorder what is printed', () => {
    assert.ok(inert(printable(`accept${RLO}moc.elpmaxe`)));
});

test('a stripped character leaves a mark rather than vanishing', () => {
    // Silently cleaning it would hide the one thing worth noticing.
    assert.equal(printable(`a${ESC}b`).length, 3);
    assert.ok(printable(`a${ESC}b`).includes('?'));
});

test('ordinary labels in any language pass through untouched', () => {
    for (const label of ['Accept all cookies', 'Zustimmen', 'Tout accepter', 'OK', 'Cookie-Einstellungen']) {
        assert.equal(printable(label), label);
    }
});

test('a label longer than the cap is cut, and a short one is not', () => {
    const long = 'x'.repeat(PRINTABLE_MAX * 2);
    assert.ok(printable(long).length < long.length);
    assert.ok(printable(long).startsWith('x'.repeat(PRINTABLE_MAX)));
    assert.equal(printable('short'), 'short');
});

test('the cap is per call, so a warning can afford a longer message than a label', () => {
    const s = 'y'.repeat(120);
    assert.ok(printable(s, 40).length < printable(s, 100).length);
});

test('a non-string is described rather than thrown over', () => {
    // These are interpolated into a message; throwing there would turn a cosmetic
    // problem into a failed run.
    assert.equal(printable(null), 'null');
    assert.equal(printable(undefined), 'undefined');
    assert.equal(printable(42), '42');
});
