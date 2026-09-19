/**
 * SIGNATURE
 *
 * Has this page changed since it was last measured?
 *
 *   node --test tools/audit/test/signature.test.mjs
 *
 * The two halves of the contract are asserted directly, because getting either wrong
 * costs money or credibility: a page whose CONTENT changed must produce a different
 * signature, and a page that merely looks different — a carousel showing another
 * photograph, elements arriving in another order — must produce the same one.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageSignature, signatureFacts} from '../lib/signature.mjs';

const meta = {image: {width: 1440, height: 5717}, fullHeight: 5717};
const rects = [
    {x: 0, y: 0, w: 1440, h: 88, tag: 'header', boxed: true, text: 'Kohde'},
    {x: 40, y: 200, w: 600, h: 120, tag: 'h1', boxed: false, text: 'Kohde builds businesses'},
];

test('the same capture gives the same signature', () => {
    assert.equal(pageSignature(meta, rects), pageSignature(meta, rects));
});

test('a different page height changes it', () => {
    assert.notEqual(pageSignature(meta, rects), pageSignature({...meta, image: {width: 1440, height: 5800}}, rects));
});

test('changed copy changes it', () => {
    const edited = [rects[0], {...rects[1], text: 'Kohde builds something else'}];
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, edited));
});

test('a moved element changes it', () => {
    const moved = [rects[0], {...rects[1], y: 260}];
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, moved));
});

test('a resized element changes it', () => {
    const bigger = [rects[0], {...rects[1], h: 180}];
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, bigger));
});

test('an added element changes it', () => {
    const more = [...rects, {x: 0, y: 900, w: 300, h: 40, tag: 'p', text: 'new'}];
    assert.notEqual(pageSignature(meta, rects), pageSignature(meta, more));
});

/**
 * The point of the whole thing. A page whose CONTENT is unchanged must not be re-audited
 * because a carousel happened to show a different photograph — which is why this is not a
 * hash of the screenshot. Rect order is the DOM's and is not stable between captures
 * either, so the digest must not depend on it.
 */
test('reordered rects do not change it', () => {
    assert.equal(pageSignature(meta, rects), pageSignature(meta, [rects[1], rects[0]]));
});

test('the facts behind it are inspectable, so a mismatch can be explained', () => {
    const f = signatureFacts(meta, rects);
    assert.equal(f.height, 5717);
    assert.equal(f.rectCount, 2);
    assert.ok(f.textDigest.length > 0);
    assert.ok(f.edgeDigest.length > 0);
});

test('no rects is a usable signature, not a crash', () => {
    assert.ok(pageSignature(meta, []).length > 0);
    assert.ok(pageSignature(meta, undefined).length > 0);
});

test('an empty page and a populated one do not collide', () => {
    assert.notEqual(pageSignature(meta, []), pageSignature(meta, rects));
});
