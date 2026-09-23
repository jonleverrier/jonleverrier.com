/**
 * PURPOSE
 *
 *   node --test tools/audit/test/purpose.test.mjs
 *
 * WHAT THE PAGE SAYS IT IS FOR, and how that is got out of the capture.
 *
 * The claim is EXTRACTED, not generated, and these tests are mostly about that. A model
 * asked to summarise a page will write a sentence the page never contained, and this one
 * goes on a cover where a prospect reads it as their own words. So the words come out of
 * rects.json in code, and the model is only asked to say which of five kinds the page is —
 * a classification, which it cannot invent its way out of.
 *
 * PURPOSE IS NOT SECTOR. It is what the page is trying to make happen, which is what makes
 * its own shape readable: routing at 69% is a directory doing its job and a shop that
 * forgot to sell. A sector label would need comparative data we do not have; this needs
 * only the page.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    heroText, parsePurposeReply, PURPOSES, PURPOSE_PROMPT, CLAIM_MAX, CONTEXT_MAX, FIRST_SCREEN,
} from '../lib/purpose.mjs';

const rect = (y, h, tag, text, x = 0, w = 1440) => ({x, y, w, h, tag, text});

/** A page whose hero is a heading, a sentence under it, and a wrapper repeating both. */
const govuk = {
    tree: {
        children: [
            {x: 0, y: 0, w: 1440, h: 64, label: {category: 'navigation', what: 'header'}},
            {x: 0, y: 64, w: 1440, h: 423, label: {category: 'hero', what: 'blue hero with search'}},
            {x: 0, y: 487, w: 1440, h: 321, label: {category: 'routing', what: 'popular links'}},
        ],
    },
};
const govukRects = [
    rect(0, 64, 'div', 'GOV.UK Menu Search'),
    rect(64, 423, 'div', 'The best place to find government services and information Search'),
    rect(120, 180, 'h1', 'The best place to find government services and information'),
    rect(320, 40, 'p', 'Find out about the coronavirus pandemic'),
    rect(500, 60, 'a', 'Benefits'),
];

/* ------------------------------------------------------------------- the claim */

test('the claim is the heading inside the hero, in the page’s own words', () => {
    const {claim} = heroText(govuk, govukRects);
    assert.equal(claim, 'The best place to find government services and information');
});

test('a wrapper that repeats its children is not the claim', () => {
    // The hero <div> holds the heading AND the search box, so its textContent is the
    // heading plus noise. Taking the largest box would quote that back at the reader.
    const {claim} = heroText(govuk, govukRects);
    assert.equal(claim.includes('Search'), false, `swallowed the wrapper: ${claim}`);
});

test('nothing outside the hero band reaches the claim', () => {
    const {claim, context} = heroText(govuk, govukRects);
    assert.equal(/Benefits/.test(`${claim} ${context}`), false, 'a routing link is not the pitch');
});

test('the context carries more than the claim, for the classifier', () => {
    const {claim, context} = heroText(govuk, govukRects);
    assert.ok(context.includes(claim), 'the claim is part of the context');
    assert.ok(context.includes('coronavirus'), 'the supporting line belongs in the context');
});

test('a claim is capped, because a hero can hold a paragraph', () => {
    const long = 'word '.repeat(200).trim();
    const {claim} = heroText(
        {tree: {children: [{x: 0, y: 0, w: 1440, h: 400, label: {category: 'hero'}}]}},
        [rect(10, 100, 'h1', long)],
    );
    assert.ok(claim.length <= CLAIM_MAX, `${claim.length} > ${CLAIM_MAX}`);
});

test('the context is capped too', () => {
    const rects = Array.from({length: 60}, (_, i) => rect(i * 5, 4, 'p', `sentence number ${i} on this page`));
    const {context} = heroText({tree: {children: [{x: 0, y: 0, w: 1440, h: 400, label: {category: 'hero'}}]}}, rects);
    assert.ok(context.length <= CONTEXT_MAX, `${context.length} > ${CONTEXT_MAX}`);
});

/* -------------------------------------------------------------- when there is no hero */

/**
 * gov.je. Its first screen is 69% links and 31% navigation and it has no hero at all, so
 * there is no band to read the claim out of. The page still has a purpose, and the first
 * screen is still where a visitor looks for it.
 */
test('a page with no hero falls back to its first screen', () => {
    const noHero = {
        tree: {
            children: [
                {x: 0, y: 0, w: 1440, h: 200, label: {category: 'navigation', what: 'header'}},
                {x: 0, y: 200, w: 1440, h: 1700, label: {category: 'routing', what: 'link directory'}},
            ],
        },
    };
    const rects = [
        rect(40, 40, 'a', 'Government of Jersey'),
        rect(240, 60, 'h2', 'Information and public services for the Island of Jersey'),
        rect(1200, 60, 'a', 'Something far below the fold'),
    ];
    const {claim, context, from} = heroText(noHero, rects);
    assert.equal(from, 'first-screen');
    assert.match(context, /Island of Jersey/);
    assert.equal(/far below the fold/.test(`${claim} ${context}`), false,
        `the fallback must stop at ${FIRST_SCREEN}px`);
});

test('a page with nothing readable says so rather than inventing', () => {
    const {claim, context} = heroText({tree: {children: []}}, []);
    assert.equal(claim, null);
    assert.equal(context, '');
});

/* ------------------------------------------------------------------- the reply */

test('the five kinds are the ones we settled on', () => {
    assert.deepEqual(PURPOSES, ['route', 'sell', 'enquire', 'publish', 'unclear']);
});

test('the prompt defines every kind, or the model is guessing at the word', () => {
    for (const k of PURPOSES) {
        assert.match(PURPOSE_PROMPT, new RegExp(`"${k}"`), k);
    }
});

test('a good reply is read', () => {
    const got = parsePurposeReply('{"kind": "route", "confidence": 0.9}');
    assert.deepEqual(got, {kind: 'route', confidence: 0.9});
});

test('a reply in a code fence is still read', () => {
    const got = parsePurposeReply('```json\n{"kind": "sell", "confidence": 0.7}\n```');
    assert.equal(got.kind, 'sell');
});

test('a kind we do not recognise becomes unclear rather than itself', () => {
    assert.equal(parsePurposeReply('{"kind": "ecommerce", "confidence": 1}').kind, 'unclear');
});

test('a reply that is not JSON at all is unclear, not a throw', () => {
    const got = parsePurposeReply('I think this is a shop.');
    assert.deepEqual(got, {kind: 'unclear', confidence: 0});
});

test('confidence is clamped, because a model will write 1.5', () => {
    assert.equal(parsePurposeReply('{"kind": "publish", "confidence": 1.5}').confidence, 1);
    assert.equal(parsePurposeReply('{"kind": "publish", "confidence": -2}').confidence, 0);
});

test('unclear always carries no confidence, whatever it claimed', () => {
    // "I am certain I do not know" is not a thing the report should act on.
    assert.equal(parsePurposeReply('{"kind": "unclear", "confidence": 0.95}').confidence, 0);
});
