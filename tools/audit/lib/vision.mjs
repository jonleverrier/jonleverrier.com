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
 * EIGHT, AND `other` IS GONE. The first six were brand, navigation, routing, promotion,
 * other and unclassified, and the corpus showed `other` doing too much work: 37% of
 * natwest.com fell into it — Security in our DNA, Supporting 18 million customers, service
 * quality survey results — so the headline described a minority of the page. A bucket that
 * large is not a category, it is a failure to have one.
 *
 * `footer` and `hero` are first-class because a reader thinks of them that way and the
 * numbers were wrong without them. whitepaper.co.uk read as 53.7% navigation purely
 * because its footer's link columns were counted as wayfinding chrome; split out, the
 * footer is the footer and navigation is the nav.
 *
 * `unclassified` is NOT a ninth category. It is the model declining to guess, reported as
 * itself and never redistributed — because a percentage that absorbs our own uncertainty
 * is the confident wrong number this tool exists to avoid.
 *
 * `brand` READ 0% ON ALL 27 SITES AND WAS NEARLY DELETED FOR IT. The cause was not that
 * pages have no brand; it was that this list named the category and the prompt below never
 * defined it, so the only thing the model was ever told about brand was that client logos
 * are not it. A category with no definition cannot be chosen. atkinsonsca.co.uk is the case
 * that found it: three full-width decorative photo bands, no text and nothing to click,
 * came back `unclassified` twice and `hero` once at confidence 0.4 — a page saying nothing
 * cannot be making a claim. Before deleting a category that reads zero, check it is
 * reachable.
 *
 * `explainer` SPLITS A BUCKET THAT HAD BECOME THE SECOND `other`. `hero` was defined as the
 * company's own claim "at the top, and ALSO any later section doing the same job", which is
 * true of most of a homepage: atkinsonsca.co.uk returned SEVEN hero blocks covering 49.5% of
 * the page — a case study image, a family-firm story, a services breakdown, a Xero
 * explanation, a "why choose us". A reader seeing "hero 49.5%" assumes we mean their top
 * banner, and half a page under one label answers nothing. The line is POSITION AND JOB
 * TOGETHER: the opening statement is the hero, every later section still describing the
 * company is an explainer. Splitting them turns one dead number into two live ones.
 */
export const CATEGORIES = [
    'brand', 'navigation', 'hero', 'explainer', 'promotion', 'trust', 'routing', 'editorial',
    'footer', 'unclassified',
];

/**
 * The definitions and their precedence are the spec's, copied rather than paraphrased.
 * They settle the named edge cases: a hero with an offer is promotion, a hero of imagery
 * and a positioning line is brand, and a product grid is routing at any depth — otherwise
 * promotion swallows all of commerce and the headline number stops meaning anything.
 */
export const TILE_PROMPT = `You are shown ONE horizontal slice of a homepage screenshot.

Identify the LAYOUT BLOCKS visible in this slice: the regions a designer would say are
distinct parts of the page.

BE COARSE. A homepage has sections, not parts of sections. If you are unsure whether
something is its own block or part of the one above it, it is part of the one above it.

What counts as ONE block:
- A header, a hero, a section, a footer are each one block.
- A section includes EVERYTHING that belongs to it: its padding, its heading, its body
  copy, its buttons, its imagery, its small print and its disclaimer. Do not split a
  section into those parts.
- A grid or carousel of cards is ONE block, not one per card.
- A list of links is ONE block, however many links.
- Side-by-side columns carrying the same KIND of content are one block; say how many in "cols".

NEVER RETURN A BLOCK THAT IS ONLY EMPTY SPACE. Whitespace belongs to the section it sits
in — extend that section's block to cover it. Padding above a heading is part of that
heading's section; a gap between two sections belongs to one of them. Empty space is
measured separately and is not a kind of block.

What forces TWO blocks:
- A change of background colour or image.
- Side-by-side regions carrying different kinds of content.

Give each block ONE category. Work down this list and take the FIRST that fits:

- "footer"     - it is in the page's footer. Anything at all: links, legal text, social
                 icons, a newsletter box, payment marks. Position decides this, not content.
- "navigation" - persistent wayfinding chrome OUTSIDE the footer, which would appear on any
                 page of this site: the header bar, a utility strip, a mega-menu.
- "hero"       - the elevator pitch, and ONLY AT THE TOP: the opening statement of the page,
                 the first thing a visitor reads, THE COMPANY'S OWN CLAIM about what it does
                 and why you would care. Almost every page has exactly one. If you are
                 looking at a slice that is not the beginning of the page, it is almost
                 certainly "explainer" and not this.
- "explainer"  - the company still describing itself, ANYWHERE BELOW THE HERO: a row of USPs
                 or value propositions, a "why choose us", a "how it works", a services or
                 feature breakdown, an "about us" passage, a story about the firm. Same voice
                 as the hero, further down the page.
- "promotion"  - asks the visitor to act now: an offer, a price, urgency, a competition, a
                 download push, a demo request, a signup or capture form.
- "trust"      - EVIDENCE FROM OUTSIDE THE COMPANY that the claim is true: testimonials in
                 someone else's words, client logos, awards, ratings, certifications,
                 accreditations, audited or published statistics, survey results,
                 regulatory or security accreditation.
- "routing"    - points at specific internal destinations: a product grid, a case-study
                 row, a card list, a set of in-page links into the site's own inventory.
- "editorial"  - the page's own published writing, read on the page rather than linked to:
                 an article, a long explanatory passage, a news item in full.
- "brand"      - identity or atmosphere and NOTHING ELSE: a full-width decorative photo
                 band, a mood image, a logo panel. It makes no claim, asks for nothing and
                 links nowhere. Remove it and a visitor can still do everything they came
                 to do; the page just feels anonymous.
- "unclassified" - you are not confident which of the above it is. Say so rather than
                 guessing. This is a real answer and is better than a wrong one.

Four rules where blocks could take more than one:
- A card row of articles or blog posts is "routing", not "editorial": its job on a homepage
  is to send the reader somewhere.
- Client logos are "trust", not "brand": they are evidence, not this company's identity.
- A row of USPs or value propositions is "explainer", not "trust". Ask WHOSE WORD IT IS: a
  company saying "fast, secure, always on" is making its own claim, so it is the pitch. It
  only becomes trust when somebody else is vouching for it, or it is a figure that could be
  checked.
- "hero" and "explainer" are the same voice and are told apart BY POSITION, not by wording.
  The opening statement is the hero; everything later that still describes the company is an
  explainer. A page with two heroes is almost always a page with one hero and one explainer.
- A section explaining what the company does is "explainer"; a section explaining a SUBJECT,
  which would still be worth reading if another firm published it, is "editorial". Ask who
  the passage is about.
- A card naming a CLIENT or a PROJECT and linking to it is "routing", not "explainer" and
  not "brand", however small the card and however large the imagery around it. The words on
  a case study card describe THE WORK, not the company: "A belief system in design systems"
  beside a client name and an arrow is a link to a case study, not a claim about the firm.
  Ask what the link points at, not what the sentence sounds like.
- A photograph with no words on it and nothing to click is "brand", not "hero", not
  "explainer" and not "unclassified". A picture makes no claim. It becomes one of those only
  when words beside it say what the company does.

COORDINATES. Answer in THIS IMAGE's pixels: 0 is the top of THIS image, not of the page.
Do not add any offset and do not rescale. Cover this image top to bottom with no gaps and
no overlaps.

Return ONLY a JSON array, no prose and no code fence:
[{"y0": <int>, "y1": <int>, "cols": <int>, "what": "<3-5 words>", "category": "<one of the words listed above>", "confidence": <0 to 1>}]`;

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
/**
 * Below this, the previous slice's answer is a guess and is not worth passing on.
 *
 * masonbreese.com is why. A section starts 133px before the seam at y=1400, so the slice
 * above could see only its first sliver and said `unclassified`, confidence 0.4, "grey
 * section begins". The carry-over then handed that to the next slice — which could see the
 * whole section — and it dutifully continued the fragment. 814px of "What we do" inherited
 * a guess made from 133 pixels, and that page came back 22% unclassified.
 *
 * A confident answer is worth continuing. An uncertain one is worth nothing, and saying
 * nothing lets the slice that can actually see the section name it.
 */
export const CARRY_MIN_CONFIDENCE = 0.6;

export const carryOver = (previous) => ((previous && (previous.confidence ?? 0) >= CARRY_MIN_CONFIDENCE)
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

/**
 * How many times a tile is attempted before the page is given up on, and how long the
 * pause between attempts grows.
 *
 * A TRANSIENT SOCKET ERROR MUST NOT COST THE WHOLE PAGE. A tall page is a dozen or more
 * sequential requests, and `fetch` rejects with a bare "fetch failed" when a connection is
 * reset — which is what happened to visionarygrid.studio at 18 tiles and boondmanager.com
 * at 12 in the first full sweep. Both pages were abandoned entirely because one request in
 * the run died, throwing away every tile that had already succeeded.
 *
 * Only the CONNECTION and the 429/5xx responses are retried. A 400 is a request this code
 * built wrongly and will build wrongly again; retrying it would turn a clear error into
 * three slow ones.
 */
export const TILE_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 1500;

/** Is this worth another go, or is it the same answer every time? */
export function worthRetrying(status) {
    return status === null || status === 429 || (status >= 500 && status < 600);
}

const pause = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/** One tile, one request — retried when the failure is the kind that might not recur. */
export async function askTile(tile, pageSize, opts = {}) {
    const key = opts.key ?? apiKey(opts.envPath);
    const attempts = opts.attempts ?? TILE_ATTEMPTS;
    const started = Date.now();
    const body = JSON.stringify({
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
    });

    let res = null;
    let json = null;
    let lastError = 'no attempt was made';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let status = null;
        try {
            res = await fetch(API, {
                method: 'POST',
                headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'},
                body,
            });
            status = res.status;
            json = await res.json();
            if (res.ok) {
                lastError = null;
                break;
            }
            lastError = `API ${status}: ${JSON.stringify(json).slice(0, 200)}`;
        } catch (e) {
            // A rejected fetch is the connection, not the service: "fetch failed", a reset
            // socket, a DNS blip. There is no status to reason about.
            lastError = `the connection failed: ${e.message.slice(0, 120)}`;
        }
        if (!worthRetrying(status) || attempt === attempts) {
            break;
        }
        await pause(RETRY_BACKOFF_MS * attempt);
    }
    if (lastError) {
        return {error: `tile ${tile.index}: ${lastError}`};
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
