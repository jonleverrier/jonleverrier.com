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
import {parseTileReply, CATEGORIES, TILE_PROMPT, apiKey} from '../lib/vision.mjs';

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
    const {blocks} = parseTileReply('[{"y0":0,"y1":100,"cols":1,"what":"x","category":"trust","confidence":0.8}]', tile);
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
    assert.deepEqual(CATEGORIES,
        ['brand', 'navigation', 'routing', 'promotion', 'other', 'unclassified']);
});

test('the prompt tells the model to answer in this tile only', () => {
    assert.match(TILE_PROMPT, /0 is the top of THIS image/);
    assert.match(TILE_PROMPT, /Do not add any offset/);
});

/** The precedence from the spec's Judgement call 1, which settles the named edge cases. */
test('the prompt carries the category definitions and their precedence', () => {
    for (const c of ['promotion', 'routing', 'navigation', 'brand', 'other', 'unclassified']) {
        assert.match(TILE_PROMPT, new RegExp(`"${c}"`), c);
    }
    assert.match(TILE_PROMPT, /first match wins/);
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
