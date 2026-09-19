/**
 * VISION
 *
 * Ask a model where a page's blocks are and what each one is.
 *
 *   node tools/audit/analyse.mjs <outDir>
 *
 * ONE TILE PER REQUEST, ANSWERED IN THAT TILE'S OWN COORDINATES. The model is never asked
 * to add an offset or divide by a scale, and this is the whole reason the module is shaped
 * this way. Asked to do that arithmetic across ten tiles, dept.agency came back with
 * coordinates running to 17,586px on a 13,586px page — four thousand pixels of accumulated
 * error — and tpagency.com overran by 1,972px. The sections both of them NAMED were right.
 * Offsets are applied here, in parseTileReply, where they cannot drift.
 *
 * WHAT COMES BACK IS NOT TRUSTED. A reply may be prose, may be fenced, may be truncated
 * mid-array, and may place a block outside the tile it was shown. Each of those is an
 * error with a reason, never a throw and never a silently repaired number — a capture that
 * cannot be read is one we decline to measure, which is the same rule phase 1 applies to
 * a 403.
 *
 * The limitation worth knowing: a section taller than one tile is seen in pieces. The
 * model can only describe what is in front of it, so two halves of one hero arrive as two
 * blocks with the same label, and are put back together by lib/bands.mjs at the seam.
 */
import {readFileSync} from 'node:fs';
import {tilePlan, tileImages, TILE_SCALE} from './tiles.mjs';

export const MODEL = 'claude-opus-5';
export const API = 'https://api.anthropic.com/v1/messages';
export const MAX_TOKENS = 4000;

/**
 * The closed set.
 *
 * `unclassified` is a real answer and is reported as itself — never redistributed into the
 * others, because a percentage that absorbs our own uncertainty is the confident wrong
 * number this tool exists to avoid.
 */
export const CATEGORIES = ['brand', 'navigation', 'routing', 'promotion', 'other', 'unclassified'];

/**
 * The definitions and their precedence are the spec's, copied rather than paraphrased.
 * They settle the named edge cases: a hero with an offer is promotion, a hero of imagery
 * and a positioning line is brand, and a product grid is routing at any depth — otherwise
 * promotion swallows all of commerce and the headline number stops meaning anything.
 */
export const TILE_PROMPT = `You are shown ONE horizontal slice of a homepage screenshot.

Identify the LAYOUT BLOCKS visible in this slice: the regions a designer would say are
distinct parts of the page.

What counts as ONE block:
- A header, a hero, a section, a footer are each one block.
- A grid or carousel of cards is ONE block, not one per card.
- A list of links is ONE block, however many links.
- A heading and the body copy that belongs to it are ONE block.
- Side-by-side columns carrying the same KIND of content are one block; say how many in "cols".

What forces TWO blocks:
- A change of background colour or image.
- Side-by-side regions carrying different kinds of content.

Give each block a category. These are the definitions, and the precedence is first match wins:
- "promotion"  - asks the visitor to act now: an offer, urgency, a price, or a capture form.
- "routing"    - points at specific internal destinations: a product grid, a card row, in-page links.
- "navigation" - persistent wayfinding chrome that would appear on any page of this site.
- "brand"      - identity with no offer and no destination: a logo, a positioning line, hero imagery.
- "other"      - the page's own substantive content, and structural whitespace.
- "unclassified" - you are not confident which of the above it is. Say so rather than guessing.

COORDINATES. Answer in THIS IMAGE's pixels: 0 is the top of THIS image, not of the page.
Do not add any offset and do not rescale. Cover this image top to bottom with no gaps and
no overlaps.

Return ONLY a JSON array, no prose and no code fence:
[{"y0": <int>, "y1": <int>, "cols": <int>, "what": "<3-5 words>", "category": "<one of the six>", "confidence": <0 to 1>}]`;

/**
 * What the slice above ended with, so a section cut by a seam is recognised as continuing.
 *
 * natwest.com is why this exists. Its "Supporting 18 million customers" section straddles
 * the seam at y=5600, and without this the two halves came back as `other` "Supporting 18
 * million section start" and `brand` "hero heading, app badges, phone" — one section, two
 * categories, and a number that moved because of where a 1400px grid happened to fall. The
 * prize draw above it split the same way into two `promotion` blocks, which cost nothing
 * but looked wrong to the person reading it.
 *
 * Told what came immediately before, the model can give the continuation the same category
 * and description, and lib/bands.mjs then merges them at the seam.
 */
export const carryOver = (previous) => (previous
    ? `\nThe slice immediately above this one ended with a block described as "${previous.what}", `
        + `category "${previous.category}". If the region at the very top of THIS image is a `
        + 'continuation of it, give it the same description and the same category so the two '
        + 'can be rejoined. If it is something else, describe it as what it is.\n'
    : '');

/**
 * The key. `KEY_ANTHROPIC_API` in this repo, NOT `ANTHROPIC_API_KEY`.
 *
 * THE ENVIRONMENT FIRST, then the file. The Craft queue job that will run this on Forge
 * has the variable and may not have a readable `craft/.env` relative to its working
 * directory; a git worktree has neither, since the file is gitignored and does not travel.
 * Reading the environment first means the same code runs in both without a flag.
 *
 * The error says which places were tried, because "no API key" with no path is the kind of
 * message that costs somebody twenty minutes.
 */
export function apiKey(envPath = 'craft/.env') {
    if (process.env.KEY_ANTHROPIC_API) {
        return process.env.KEY_ANTHROPIC_API;
    }

    let file = '';
    try {
        file = readFileSync(envPath, 'utf8');
    } catch {
        throw new Error(`no KEY_ANTHROPIC_API in the environment, and ${envPath} could not be read`);
    }
    const found = (file.match(/^KEY_ANTHROPIC_API\s*=\s*"?([^"\n\r]+)"?/m) ?? [])[1];
    if (!found) {
        throw new Error(`no KEY_ANTHROPIC_API in the environment or in ${envPath}`);
    }

    return found;
}

/**
 * A tile's reply, in page coordinates, or an error with a reason.
 *
 * EVERY REPAIR HERE IS A REFUSAL OR A DOWNGRADE, NEVER AN INVENTION. An unknown category
 * becomes `unclassified`; a missing confidence becomes 0; and a block outside the tile
 * fails the whole tile rather than being clamped into it. Clamping would turn a model that
 * had lost track of which image it was looking at into a plausible-looking answer, which
 * is precisely the failure mode the tiling was introduced to remove.
 */
export function parseTileReply(text, tile) {
    const m = String(text ?? '').match(/\[[\s\S]*\]/);
    if (!m) {
        return {error: `no JSON array in the reply: ${String(text ?? '').slice(0, 120)}`};
    }

    let raw;
    try {
        raw = JSON.parse(m[0]);
    } catch (e) {
        return {error: `unparseable JSON: ${e.message}`};
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        return {error: 'the reply held no blocks'};
    }

    // The tile is this many pixels tall as the model saw it.
    const limit = Math.round(tile.height * tile.scale);
    const blocks = [];
    for (const b of raw) {
        const y0 = Number(b?.y0);
        const y1 = Number(b?.y1);
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) {
            return {error: `a block has no usable extent: ${JSON.stringify(b).slice(0, 80)}`};
        }
        // Two pixels of slack for a rounded edge, and no more: a block past the bottom of
        // its own tile is the accumulated-offset failure, not a rounding one.
        if (y0 < 0 || y1 > limit + 2) {
            return {error: `a block runs from ${y0} to ${y1}, outside a ${limit}px tile`};
        }
        blocks.push({
            y0: tile.top + Math.round(y0 / tile.scale),
            y1: tile.top + Math.round(y1 / tile.scale),
            cols: Math.max(1, Math.round(Number(b?.cols) || 1)),
            what: String(b?.what ?? '').slice(0, 80),
            category: CATEGORIES.includes(b?.category) ? b.category : 'unclassified',
            confidence: Number.isFinite(Number(b?.confidence)) ? Number(b.confidence) : 0,
        });
    }

    return {blocks};
}

/** One tile, one request. */
export async function askTile(tile, pageSize, opts = {}) {
    const key = opts.key ?? apiKey(opts.envPath);
    const started = Date.now();
    const res = await fetch(API, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'},
        body: JSON.stringify({
            model: opts.model ?? MODEL,
            max_tokens: MAX_TOKENS,
            thinking: {type: 'adaptive'},
            messages: [{
                role: 'user',
                content: [
                    {type: 'image', source: {type: 'base64', media_type: 'image/png', data: tile.b64}},
                    {
                        type: 'text',
                        text: `This slice is ${Math.round(pageSize.width * tile.scale)}x`
                            + `${Math.round(tile.height * tile.scale)} pixels.`
                            + `${carryOver(opts.previous)}\n\n${TILE_PROMPT}`,
                    },
                ],
            }],
        }),
    });
    const json = await res.json();
    if (!res.ok) {
        return {error: `API ${res.status}: ${JSON.stringify(json).slice(0, 200)}`};
    }
    // A truncated array can still parse — the regex would find a shorter one — so this is
    // checked before the text is read, not after.
    if (json.stop_reason === 'max_tokens') {
        return {error: `tile ${tile.index}: the reply was cut off at the token limit`};
    }

    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const parsed = parseTileReply(text, tile);
    if (parsed.error) {
        return {error: `tile ${tile.index}: ${parsed.error}`};
    }

    return {blocks: parsed.blocks, usage: json.usage ?? {}, secs: (Date.now() - started) / 1000};
}

/**
 * Every tile of a page, in order.
 *
 * ONE BAD TILE FAILS THE PAGE. A page measured from nine tiles out of ten is a percentage
 * of a prefix of that page with nothing declaring it, which is the defect this tool was
 * built to avoid in the first place.
 */
export async function askPage(pngPath, meta, opts = {}) {
    const {width, height} = meta.image;
    const plan = tilePlan(height);
    const tiles = await tileImages(pngPath, plan, width, opts.scale ?? TILE_SCALE);

    const blocks = [];
    const usage = {input_tokens: 0, output_tokens: 0};
    let secs = 0;
    for (const tile of tiles) {
        // Each tile is told what the one above it ended with, so a section cut by a seam
        // is recognised as continuing rather than described twice. See carryOver.
        const r = await askTile(tile, {width, height}, {...opts, previous: blocks[blocks.length - 1]});
        if (r.error) {
            return {error: r.error, tiles: tiles.length};
        }
        blocks.push(...r.blocks);
        usage.input_tokens += r.usage.input_tokens ?? 0;
        usage.output_tokens += r.usage.output_tokens ?? 0;
        secs += r.secs;
    }

    return {blocks, usage, secs, tiles: tiles.length};
}
