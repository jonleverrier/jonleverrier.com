/**
 * RECTS
 *
 * What a rects file has to be before the segmenter is allowed to believe it.
 *
 *   node --test tools/audit/test/rects.test.mjs
 *
 * The premise these defend is `lib/blocks.mjs`'s: "every rect is whole pixels, so there
 * is no tolerance to tune and no floating-point slack to hide a bug in". Until this
 * module existed, nothing checked it — `JSON.parse` handed the file straight to the
 * segmenter, and a single thirds fraction was enough to void the invariant.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normaliseRects, loadRects} from '../lib/rects.mjs';

const rect = (over = {}) => ({x: 0, y: 100, w: 240, h: 100, tag: 'section', boxed: false, text: '', ...over});

const fileWith = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-rects-'));
    const path = join(dir, 'rects.json');
    writeFileSync(path, body);

    return path;
};

test('a whole-pixel file is passed through unchanged, and counted as unrepaired', () => {
    const input = [rect(), rect({y: 300, tag: 'div'})];
    const {rects, rounded, dropped} = normaliseRects(input);
    assert.deepEqual(rects, input);
    assert.equal(rounded, 0);
    assert.equal(dropped, 0);
});

test('a fractional coordinate is rounded, not rejected', () => {
    // 100.33333333333334 is what getBoundingClientRect returns for a three-column grid.
    const {rects, rounded, dropped} = normaliseRects([rect({h: 100.33333333333334})]);
    assert.equal(rects.length, 1, 'the rect is usable and must survive');
    assert.equal(rects[0].h, 100);
    assert.equal(rounded, 1);
    assert.equal(dropped, 0);
});

test('every coordinate of every kept rect is a whole number, whatever went in', () => {
    // The property, not the arithmetic: this is the premise assertPartition assumes.
    const {rects} = normaliseRects([
        rect({x: 0.5, y: 1.4999, w: 239.5, h: 100.33333333333334}),
        rect({x: -0.2, y: 12.6, w: 60.5, h: 12.5}),
    ]);
    assert.ok(rects.length > 0);
    for (const r of rects) {
        for (const k of ['x', 'y', 'w', 'h']) {
            assert.ok(Number.isInteger(r[k]), `${k} = ${r[k]} is not a whole pixel`);
        }
    }
});

test('rounding moves a coordinate by less than a pixel', () => {
    const before = rect({x: 10.4, y: 100.6, w: 240.5, h: 100.33333333333334});
    const [after] = normaliseRects([before]).rects;
    for (const k of ['x', 'y', 'w', 'h']) {
        assert.ok(Math.abs(after[k] - before[k]) <= 0.5, `${k} moved by more than half a pixel`);
    }
});

for (const [name, bad] of [
    ['a null coordinate', rect({y: null})],
    ['a string coordinate', rect({y: '100'})],
    ['a missing coordinate', {x: 0, w: 240, h: 100, tag: 'section'}],
    ['NaN', rect({h: NaN})],
    ['Infinity', rect({h: Infinity})],
    ['no tag', {x: 0, y: 100, w: 240, h: 100}],
    ['a non-string tag', rect({tag: 42})],
    ['nothing left after rounding', rect({h: 0.4})],
    ['a negative size', rect({h: -100})],
    ['not an object at all', 7],
    ['null', null],
]) {
    test(`a rect with ${name} is dropped and counted, and the good ones survive`, () => {
        // `{y: null}` is the one that mattered most: null coerces to 0, so y + h became a
        // cut candidate 50px from where anything actually is, and the cut moved.
        const {rects, dropped} = normaliseRects([rect(), bad, rect({y: 300})]);
        assert.equal(rects.length, 2);
        assert.equal(dropped, 1);
        assert.ok(rects.every((r) => Number.isInteger(r.y)), 'and are still whole pixels');
    });
}

test('text and boxed are repaired rather than costing a sound rect its place', () => {
    // An absent `boxed` already means false and an absent `text` means none, so a bad one
    // means the same thing. They only decorate — a heading, a module container — and the
    // geometry is what the partition depends on.
    const {rects, dropped} = normaliseRects([rect({text: 42, boxed: 'yes'})]);
    assert.equal(dropped, 0);
    assert.equal(rects[0].text, '');
    assert.equal(rects[0].boxed, false);
});

test('an empty array is a real answer, not an error', () => {
    const {rects, rounded, dropped} = normaliseRects([]);
    assert.deepEqual(rects, []);
    assert.equal(rounded + dropped, 0);
});

for (const notAnArray of [null, {x: 0, y: 0, w: 1, h: 1, tag: 'div'}, 'rects', 7, undefined]) {
    test(`${JSON.stringify(notAnArray) ?? 'undefined'} is not a rects file and says so`, () => {
        assert.throws(() => normaliseRects(notAnArray), /array/);
    });
}

test('an array in which nothing is a rect is an error, not an empty answer', () => {
    // [1,2,3] used to be accepted, with stderr announcing "snapping cuts to 3 DOM rects"
    // while snapping to nothing at all. Saying something false is worse than failing.
    assert.throws(() => normaliseRects([1, 2, 3]), /none/);
    assert.throws(() => normaliseRects([null]), /none/);
});

test('loadRects returns null only when the file is genuinely absent', () => {
    assert.equal(loadRects(join(tmpdir(), 'audit-rects-definitely-not-here', 'rects.json')), null);
});

test('a file that exists and parses to nothing is never reported as absent', () => {
    // The same words used to cover "you never captured rects" and "your rects are broken".
    assert.notEqual(loadRects(fileWith('[]')), null);
    assert.throws(() => loadRects(fileWith('null')), /rects\.json/);
    assert.throws(() => loadRects(fileWith('[1,2,3]')), /rects\.json/);
});

test('a file that is not JSON names itself in the error', () => {
    assert.throws(() => loadRects(fileWith('not json at all')), /rects\.json.*not valid JSON/s);
});

test('a real file round-trips: the fixture rects are already whole pixels', () => {
    // If this ever starts reporting repairs, phase 1 has stopped rounding.
    const {rects, rounded, dropped} = loadRects('tools/audit/fixtures/retail.rects.json');
    assert.ok(rects.length > 0);
    assert.equal(rounded, 0, 'a capture writes whole pixels');
    assert.equal(dropped, 0, 'and writes nothing unusable');
});
