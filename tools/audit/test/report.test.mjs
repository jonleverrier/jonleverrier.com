/**
 * REPORT
 *
 * What a prospect reads.
 *
 *   node --test tools/audit/test/report.test.mjs
 *
 * The assertions are about HONESTY as much as arithmetic: that every note reaches the
 * reader as a caveat, that a capture whose provenance could not be checked says so before
 * anything else, and that unclassified area appears as its own line rather than being
 * folded into the four categories somebody is being told about.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportFor} from '../report.mjs';

const leaf = (y, h, category, coverage = 0.5) => ({
    x: 0, y, w: 1440, h, depth: 1, children: [], coverage,
    label: {category, what: 'x', cols: 1, confidence: 0.9},
});
const doc = (children, notes = {metaRead: true, conditions: {}}) => ({
    notes,
    tree: {x: 0, y: 0, w: 1440, h: children.reduce((a, c) => a + c.h, 0), depth: 0, children},
});

test('the headline names the four categories and their shares', () => {
    const r = reportFor(doc([leaf(0, 900, 'brand'), leaf(900, 900, 'navigation'),
        leaf(1800, 900, 'routing'), leaf(2700, 900, 'promotion')]), 900);
    assert.match(r.headline, /brand/);
    assert.match(r.headline, /25\.0%/);
});

/** `other` is the page's own content and is not a finding, so it stays out of the headline. */
test('the headline leaves out other and unclassified', () => {
    const r = reportFor(doc([leaf(0, 500, 'brand'), leaf(500, 500, 'other'), leaf(1000, 500, 'unclassified')]), 900);
    assert.match(r.headline, /brand/);
    assert.equal(/other/.test(r.headline), false);
    assert.equal(/unclassified/.test(r.headline), false);
});

test('a page with nothing in the four categories says so rather than printing an empty line', () => {
    const r = reportFor(doc([leaf(0, 900, 'other')]), 900);
    assert.match(r.headline, /nothing on this page classified/);
});

test('every note with a message becomes a caveat a reader sees', () => {
    const notes = {metaRead: true, conditions: {
        webglBlind: {effect: 'unmeasured', message: 'a canvas could not be read', facts: {}},
    }};
    const r = reportFor(doc([leaf(0, 900, 'other')], notes), 900);
    assert.equal(r.caveats.length, 1);
    assert.match(r.caveats[0], /canvas could not be read/);
});

test('a capture whose provenance could not be read says so first', () => {
    const notes = {metaRead: false, conditions: {
        webglBlind: {effect: 'unmeasured', message: 'a canvas could not be read', facts: {}},
    }};
    const r = reportFor(doc([leaf(0, 900, 'other')], notes), 900);
    assert.match(r.caveats[0], /could not be checked/);
});

test('unclassified area is reported as its own line, not folded away', () => {
    const r = reportFor(doc([leaf(0, 900, 'brand'), leaf(900, 900, 'unclassified')]), 900);
    assert.equal(r.unmeasured, 0.5);
    assert.ok(r.full.some((s) => s.category === 'unclassified'));
});

test('a sparse block is reported with its coverage, not as solid content', () => {
    const r = reportFor(doc([leaf(0, 900, 'routing', 0.04)]), 900);
    assert.equal(r.full.find((s) => s.category === 'routing').coverage, 0.04);
});

test('the first viewport is reported separately from the whole page', () => {
    const r = reportFor(doc([leaf(0, 900, 'promotion'), leaf(900, 2700, 'other')]), 900);
    assert.equal(r.full.find((s) => s.category === 'promotion').share, 0.25);
    assert.equal(r.firstViewport.find((s) => s.category === 'promotion').share, 1);
});
