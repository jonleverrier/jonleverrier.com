/**
 * SUMMARY
 *
 *   node --test tools/audit/test/summary.test.mjs
 *
 * WHICH FOUR FACTS GO ON THE COVER, and nothing about how they are worded on the sheet.
 *
 * THE DEFECT THIS EXISTS FOR. The cover carried four FIXED SLOTS — biggest segment,
 * weight, deferral, duplicate colours — whatever they happened to say. On a real
 * comparison that produced "69.3% of the page is routing, against 67.8% on gov.je", two
 * numbers a point and a half apart presented as a contrast, and "No two colours on the
 * page are ones a person could confuse. gov.je has none", a fault report about an absence
 * of faults. Half the cover said nothing, while the same data held a page with no hero at
 * all and a fivefold difference in weight that no slot was looking for.
 *
 * So the cover is chosen rather than filled in, and the three rules are what these tests
 * are about: a comparison of two numbers that are level is not a finding, a clean result
 * is not a finding, and what is left is ranked by how big the difference is.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarise, candidates, LEVEL} from '../lib/summary.mjs';

/** The smallest report the summary can be asked about. Extended per test. */
const site = (over = {}) => ({
    url: 'https://example.com',
    width: 1440,
    height: 4000,
    categories: [
        {category: 'routing', share: 0.5, firstViewport: 0.4, blocks: [{what: 'links'}]},
        {category: 'hero', share: 0.2, firstViewport: 0.5, blocks: [{what: 'a hero'}]},
        {category: 'footer', share: 0.3, firstViewport: 0, blocks: [{what: 'a footer'}]},
    ],
    speed: {score: 90, lab: {lcpMs: 1000, tbtMs: 0, cls: 0}},
    weight: {measured: true, atLoad: {bytes: 500_000}, afterScroll: {bytes: 1_000_000, requests: 40}},
    technical: {score: 8, deferred: 0.5, shortPage: false, medianMb: 2.3},
    brand: {score: 10, colours: 6, groups: 0},
    ...over,
});

const texts = (a, b) => summarise(a, b).map((f) => f.text);

/* ------------------------------------------------------------------ the rules */

test('a comparison of two numbers that are level is not a finding', () => {
    // gov.uk 69.3% routing against gov.je 67.8%. The reader learns nothing from it, and
    // it occupied a quarter of the cover because the slot existed.
    const mine = site({categories: [{category: 'routing', share: 0.693, firstViewport: 0.46, blocks: [{}, {}]}]});
    const theirs = site({categories: [{category: 'routing', share: 0.678, firstViewport: 0.69, blocks: [{}, {}, {}]}]});
    const share = candidates(mine, theirs).find((c) => c.id === 'biggest-segment');
    assert.equal(share.worth, false, '1.5 points apart is level');
});

test('…and the same comparison IS a finding once the gap is real', () => {
    const mine = site({categories: [{category: 'routing', share: 0.693, firstViewport: 0.46, blocks: [{}]}]});
    const theirs = site({categories: [{category: 'routing', share: 0.2, firstViewport: 0.1, blocks: [{}]}]});
    const share = candidates(mine, theirs).find((c) => c.id === 'biggest-segment');
    assert.equal(share.worth, true);
});

test('LEVEL is the line between those two, and it is stated in points', () => {
    assert.ok(LEVEL > 0 && LEVEL < 0.2, 'a share gap under LEVEL is not worth printing');
});

test('a clean result is not a finding', () => {
    // "No two colours on the page are ones a person could confuse. gov.je has none."
    // Nothing is wrong with either page, so there is nothing to say about either.
    const clean = candidates(site(), site()).find((c) => c.id === 'duplicate-colours');
    assert.equal(clean.worth, false);
});

test('…and duplicate colours ARE a finding when there are some', () => {
    const mine = site({brand: {score: 6, colours: 11, groups: 2}});
    const found = candidates(mine, site()).find((c) => c.id === 'duplicate-colours');
    assert.equal(found.worth, true);
    assert.match(found.text, /2 sets/);
});

test('findings come back ranked, biggest difference first', () => {
    const mine = site();
    const theirs = site({
        weight: {measured: true, atLoad: {bytes: 2_300_000}, afterScroll: {bytes: 2_500_000, requests: 90}},
        technical: {score: 3, deferred: 0.08, shortPage: false, medianMb: 2.3},
        speed: {score: 55, lab: {lcpMs: 4000, tbtMs: 600, cls: 0.3}},
    });
    const gaps = summarise(mine, theirs).map((f) => f.gap);
    assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a), `not ranked: ${gaps}`);
});

test('at most four make the cover', () => {
    const theirs = site({
        weight: {measured: true, atLoad: {bytes: 2_300_000}, afterScroll: {bytes: 2_500_000, requests: 90}},
        technical: {score: 3, deferred: 0.08, shortPage: false, medianMb: 2.3},
        speed: {score: 40, lab: {lcpMs: 5000, tbtMs: 900, cls: 0.4}},
        brand: {score: 4, colours: 14, groups: 3},
        categories: [{category: 'routing', share: 0.95, firstViewport: 1, blocks: [{}]}],
    });
    assert.ok(summarise(site(), theirs).length <= 4);
});

/* ------------------------------------------------- the finding no slot looked for */

test('a segment the other page does not have at all is a finding', () => {
    // gov.je has no hero: its first screen is 69% links and 31% navigation, with nothing
    // saying what the site is. The old cover had no slot that could notice.
    const theirs = site({
        categories: [
            {category: 'routing', share: 0.688, firstViewport: 0.688, blocks: [{}]},
            {category: 'navigation', share: 0.312, firstViewport: 0.312, blocks: [{}]},
        ],
    });
    assert.ok(texts(site(), theirs).some((t) => /hero/i.test(t)), 'the missing hero must be named');
});

test('a missing segment is only a finding when the other page spends real space on it', () => {
    // Ours has a hero worth 0.4% of the page. That theirs has none is a rounding error,
    // not a difference in how the two pages open.
    const mine = site({
        categories: [
            {category: 'routing', share: 0.596, firstViewport: 0.4, blocks: [{}]},
            {category: 'hero', share: 0.004, firstViewport: 0.01, blocks: [{}]},
            {category: 'footer', share: 0.4, firstViewport: 0, blocks: [{}]},
        ],
    });
    const theirs = site({categories: [{category: 'routing', share: 1, firstViewport: 1, blocks: [{}]}]});
    assert.equal(texts(mine, theirs).some((t) => /hero/i.test(t)), false);
});

/* --------------------------------------------------------------- with no rival */

test('with no competitor every finding stands on its own', () => {
    for (const f of summarise(site(), null)) {
        assert.equal(f.text.includes('against'), false, `still comparing: ${f.text}`);
        assert.ok(f.text.length, 'a finding must say something');
    }
});

test('a finding with no competitor is measured against a published line where there is one', () => {
    // Weight has the HTTP Archive median and speed has Google's thresholds. Those are the
    // only two places a single page can be told it is over or under anything.
    const heavy = site({
        weight: {measured: true, atLoad: {bytes: 4_000_000}, afterScroll: {bytes: 4_500_000, requests: 120}},
        technical: {score: 2, deferred: 0.1, shortPage: false, medianMb: 2.3},
    });
    const weight = candidates(heavy, null).find((c) => c.id === 'weight');
    assert.equal(weight.worth, true);
    assert.match(weight.text, /median/i, 'the line has to be named, as the tables do');
});

test('every finding leads with a figure', () => {
    const theirs = site({
        weight: {measured: true, atLoad: {bytes: 2_300_000}, afterScroll: {bytes: 2_500_000, requests: 90}},
        technical: {score: 3, deferred: 0.08, shortPage: false, medianMb: 2.3},
    });
    for (const f of summarise(site(), theirs)) {
        assert.match(f.text, /\d/, `no figure in: ${f.text}`);
    }
});

/* ------------------------------------------------------------ nothing measured */

test('a measurement that did not happen is never a finding', () => {
    const blind = site({weight: {measured: false, why: 'too little recorded'}, technical: null, brand: null});
    assert.doesNotThrow(() => summarise(blind, null));
    for (const f of summarise(blind, null)) {
        assert.match(f.text, /\d/);
    }
});
