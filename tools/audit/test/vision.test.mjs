/**
 * VISION
 *
 * Reading what the model sent back.
 *
 *   node --test tools/audit/test/vision.test.mjs
 *
 * NOT ONE OF THESE MAKES A NETWORK CALL. They assert the two things that can be asserted
 * without one: that a tile's coordinates become page coordinates correctly, and that every
 * way a reply can be wrong is an error with a reason rather than a plausible-looking
 * number. The model's judgement is measured against the corpus, not here.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTileReply, CATEGORIES, TILE_PROMPT, apiKey, carryOver, worthRetrying, TILE_ATTEMPTS} from '../lib/vision.mjs';

const tile = {index: 2, top: 2800, height: 1400, scale: 0.75};

test('tile-local coordinates become page coordinates', () => {
    // 0..1050 at 0.75 scale is the whole 1400px tile, which starts at 2800.
    const {blocks} = parseTileReply('[{"y0":0,"y1":1050,"cols":1,"what":"hero","category":"brand","confidence":0.9}]', tile);
    assert.equal(blocks[0].y0, 2800);
    assert.equal(blocks[0].y1, 4200);
});

test('a fenced reply is still read', () => {
    const {blocks} = parseTileReply('```json\n[{"y0":0,"y1":100,"cols":1,"what":"x","category":"other","confidence":0.5}]\n```', tile);
    assert.equal(blocks.length, 1);
});

test('prose around the JSON is tolerated', () => {
    const {blocks} = parseTileReply('Here you go:\n[{"y0":0,"y1":100,"cols":1,"what":"x","category":"other","confidence":0.5}]\nHope that helps.', tile);
    assert.equal(blocks.length, 1);
});

test('no JSON at all is an error, not a throw', () => {
    assert.ok(parseTileReply('I cannot see the image.', tile).error);
});

test('malformed JSON is an error, not a throw', () => {
    assert.ok(parseTileReply('[{"y0":0,', tile).error);
});

/**
 * The failure this whole module is shaped around. dept.agency came back with coordinates
 * running to 17,586px on a 13,586px page when the model was asked to add tile offsets
 * itself. A block outside the tile it was shown means the model lost track of which image
 * it is looking at, and the honest response is to fail rather than clamp it into range.
 */
test('a block outside the tile is an error, not clamped', () => {
    // 1400 at 0.75 scale is 1866px of tile, past the 1050 the model was shown.
    assert.ok(parseTileReply('[{"y0":0,"y1":1400,"cols":1,"what":"x","category":"other","confidence":1}]', tile).error);
});

test('an unknown category becomes unclassified rather than being trusted', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"cols":1,"what":"x","category":"vibes","confidence":0.8}]', tile);
    assert.equal(blocks[0].category, 'unclassified');
});

/** `other` was a real category once and is not one now; it must not sneak back in. */
test('the retired other category is no longer accepted', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"cols":1,"what":"x","category":"other","confidence":0.9}]', tile);
    assert.equal(blocks[0].category, 'unclassified');
});

test('a missing confidence is treated as no confidence', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"cols":1,"what":"x","category":"brand"}]', tile);
    assert.equal(blocks[0].confidence, 0);
});

test('cols defaults to 1 and is never below it', () => {
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"what":"x","category":"brand","confidence":1},'
        + '{"y0":100,"y1":200,"cols":0,"what":"y","category":"brand","confidence":1}]', tile);
    assert.deepEqual(blocks.map((b) => b.cols), [1, 1]);
});

test('a block with no usable extent is an error', () => {
    assert.ok(parseTileReply('[{"y0":100,"y1":100,"cols":1,"what":"x","category":"brand","confidence":1}]', tile).error);
    assert.ok(parseTileReply('[{"y0":200,"y1":100,"cols":1,"what":"x","category":"brand","confidence":1}]', tile).error);
});

test('an empty array is an error rather than a page with no blocks', () => {
    assert.ok(parseTileReply('[]', tile).error);
});

test('the categories are the ones the report promises', () => {
    assert.deepEqual(CATEGORIES, [
        'brand', 'navigation', 'hero', 'explainer', 'promotion', 'trust', 'routing', 'editorial',
        'footer', 'unclassified',
    ]);
});

test('the prompt tells the model to answer in this tile only', () => {
    assert.match(TILE_PROMPT, /0 is the top of THIS image/);
    assert.match(TILE_PROMPT, /Do not add any offset/);
});

/** Every category has to be DEFINED in the prompt, or the model is guessing at the word. */
test('the prompt carries a definition for every category', () => {
    for (const c of CATEGORIES) {
        assert.match(TILE_PROMPT, new RegExp(`"${c}"`), c);
    }
});

test('the prompt is explicit that one block takes one category, first fit', () => {
    assert.match(TILE_PROMPT, /take the FIRST that fits/);
});

/** The three cases that could legitimately take more than one label. */
test('the prompt settles article cards, client logos and USP rows', () => {
    assert.match(TILE_PROMPT, /is "routing", not "editorial"/);
    assert.match(TILE_PROMPT, /are "trust", not "brand"/);
    assert.match(TILE_PROMPT, /is "explainer", not "trust"/);
});

/**
 * THE SPLIT THAT MADE `hero` MEAN SOMETHING. It was "the claim at the top, and ALSO any
 * later section doing the same job", which is most of a homepage: atkinsonsca.co.uk came
 * back with seven hero blocks covering 49.5% of the page. The two are the same voice, so
 * the prompt has to separate them BY POSITION or the model has nothing to go on.
 */
test('the prompt tells hero and explainer apart by position, not by wording', () => {
    assert.match(TILE_PROMPT, /ONLY AT THE TOP/);
    assert.match(TILE_PROMPT, /ANYWHERE BELOW THE HERO/);
    assert.match(TILE_PROMPT, /told apart BY POSITION/);
});

/** And explainer must not swallow editorial: the discriminator is who the passage is about. */
test('the prompt keeps explainer out of editorial', () => {
    assert.match(TILE_PROMPT, /is "explainer"; a section explaining a SUBJECT/);
});

/**
 * kohde.agency block 4. A 330px white card reading "A belief system in design systems." with
 * a client name and an arrow, sitting on 899px of dark green graphic. The model described
 * what dominated the slice, read the tagline as the company's own voice, and called it
 * `explainer` at 0.6 — the lowest confidence on the page, against 0.72 for a more obvious
 * case study card higher up. A case study describes THE WORK, and the link is the only
 * reliable tell.
 */
test('the prompt sends a case study card to routing, whatever the imagery around it', () => {
    assert.match(TILE_PROMPT, /naming a CLIENT or a PROJECT and linking to it is "routing"/);
    assert.match(TILE_PROMPT, /Ask what the link points at/);
});

/**
 * The discriminator between a pitch and its proof, which a reader supplied after seeing
 * whitepaper.co.uk's three USP columns come back as `trust`. The model had read "we are
 * good at X" as evidence rather than as a claim.
 */
test('the prompt asks whose word it is', () => {
    assert.match(TILE_PROMPT, /WHOSE WORD IT IS/);
    assert.match(TILE_PROMPT, /EVIDENCE FROM OUTSIDE THE COMPANY/);
    assert.match(TILE_PROMPT, /THE COMPANY'S OWN CLAIM/);
});

/* -------------------------------------------------------------------------- the key */

/**
 * The environment first, then the file. A Craft queue job on Forge has the variable and
 * may not have a readable craft/.env relative to its working directory; a git worktree has
 * neither, because the file is gitignored and does not travel with the checkout.
 */
test('the environment is preferred over the file', () => {
    const held = process.env.KEY_ANTHROPIC_API;
    process.env.KEY_ANTHROPIC_API = 'from-the-environment';
    try {
        assert.equal(apiKey('/nonexistent/.env'), 'from-the-environment');
    } finally {
        if (held === undefined) delete process.env.KEY_ANTHROPIC_API;
        else process.env.KEY_ANTHROPIC_API = held;
    }
});

test('an unreadable file says so, and says where it looked', () => {
    const held = process.env.KEY_ANTHROPIC_API;
    delete process.env.KEY_ANTHROPIC_API;
    try {
        assert.throws(() => apiKey('/nonexistent/.env'), /\/nonexistent\/\.env could not be read/);
    } finally {
        if (held !== undefined) process.env.KEY_ANTHROPIC_API = held;
    }
});

/* ----------------------------------------------------------------- the granularity */

/**
 * The rules a reader asked for after looking at real output. kohde.agency returned its
 * light case-study panel as three blocks — a whitespace strip, the card, and the artwork
 * — and natwest.com split its app section from its own eligibility disclaimer. Both are
 * one section to anybody reading the page.
 *
 * The whitespace rule is the user's ruling from phase 2, now stated where the model can
 * act on it: space is a measure across blocks, not a kind of block.
 */
test('the prompt tells the model to be coarse', () => {
    assert.match(TILE_PROMPT, /BE COARSE/);
    assert.match(TILE_PROMPT, /it is part of the one above it/);
});

test('the prompt forbids a block that is only empty space', () => {
    assert.match(TILE_PROMPT, /NEVER RETURN A BLOCK THAT IS ONLY EMPTY SPACE/);
    assert.match(TILE_PROMPT, /not a kind of block/);
});

test('the prompt keeps a section whole, small print and all', () => {
    assert.match(TILE_PROMPT, /its small print and its disclaimer/);
    assert.match(TILE_PROMPT, /Do not split a\s+section into those parts/);
});

/** The seam carry-over, which is what stops one section being read as two. */
test('a slice is told what the one above it ended with', () => {
    // A confidence is required: an uncertain answer is deliberately not passed on.
    const text = carryOver({what: 'prize draw promotion', category: 'promotion', confidence: 0.9});
    assert.match(text, /prize draw promotion/);
    assert.match(text, /same category/);
});

test('the first slice is told nothing, because nothing came before it', () => {
    assert.equal(carryOver(undefined), '');
    assert.equal(carryOver(null), '');
});

/* ----------------------------------------------------------------------- retrying */

/**
 * A tall page is a dozen or more sequential requests, and one reset connection used to
 * throw away every tile that had already succeeded: visionarygrid.studio at 18 tiles and
 * boondmanager.com at 12 were both abandoned entirely in the first full sweep, with the
 * bare message "fetch failed".
 *
 * Only failures that might not recur are worth another go. A 400 is a request this code
 * built wrongly and will build wrongly again.
 */
test('a dead connection is worth retrying', () => {
    assert.equal(worthRetrying(null), true);
});

test('a rate limit and a server error are worth retrying', () => {
    assert.equal(worthRetrying(429), true);
    assert.equal(worthRetrying(500), true);
    assert.equal(worthRetrying(503), true);
});

test('a request we built wrongly is not', () => {
    assert.equal(worthRetrying(400), false);
    assert.equal(worthRetrying(401), false);
    assert.equal(worthRetrying(404), false);
    assert.equal(worthRetrying(413), false);
});

test('three attempts, because one retry is a coin toss and ten is a hang', () => {
    assert.equal(TILE_ATTEMPTS, 3);
});

/**
 * A confident answer is worth continuing across a seam; an uncertain one is worth nothing,
 * and passing it on actively harms the next slice. masonbreese.com inherited "grey section
 * begins" — a guess made from 133 pixels — for 814px of a section the next slice could see
 * in full, and came back 22% unclassified.
 */
test('an uncertain previous block is not carried over', () => {
    assert.equal(carryOver({what: 'grey section begins', category: 'unclassified', confidence: 0.4}), '');
});

test('a confident previous block is', () => {
    const text = carryOver({what: 'prize draw promotion', category: 'promotion', confidence: 0.9});
    assert.match(text, /prize draw promotion/);
});
