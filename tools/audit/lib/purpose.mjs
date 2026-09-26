/**
 * PURPOSE
 *
 * What the page says it is for, and which of five jobs that makes it.
 *
 *   node --test tools/audit/test/purpose.test.mjs
 *
 * WHY IT EXISTS. A segment share is not good or bad on its own. Routing at 69% is a
 * directory doing exactly its job, and a shop that forgot to sell; promotion at 1.7% is
 * correct for a government portal and a page that never asks for anything; no testimonials
 * is a gap on a consultancy and irrelevant on gov.uk. Nothing about the measurement
 * changes — only what it is read against.
 *
 * PURPOSE IS NOT SECTOR, and the difference is the whole reason this file is small. A
 * sector ("charity or organisation") would need a corpus of measured homepages per sector
 * before it could say whether 69% is high, and we do not have one. A purpose needs only
 * the page: it says which segments are the point, which are optional, and which absences
 * are not gaps. gov.uk lands in "charity or organisation" beside faith groups and clubs,
 * which tells you nothing; it is a "route", which tells you all three.
 *
 * THE CLAIM IS EXTRACTED AND ONLY THE KIND IS ASKED FOR. A model told to summarise a page
 * writes a sentence the page never contained, and this sentence goes on a document where a
 * prospect reads it as their own words. So the words come out of rects.json in code and
 * the model answers a multiple choice, which it cannot invent its way out of. It is also
 * why the report quotes the claim rather than asserting the kind: a reader who thinks we
 * have misread their page can see the premise and say so, the same way the weight verdict
 * names the HTTP Archive median beside it.
 *
 * The limitation worth knowing: a wrong purpose flips every judgement built on it, which is
 * why `unclear` exists and why the caller is expected to print NOTHING rather than hedge.
 * A page that will not say what it is for is a finding of its own, and not one this file
 * should paper over.
 */
import {apiKey, API, MODEL} from './vision.mjs';

/** The five jobs. `unclear` is a real answer, as `unclassified` is for a block. */
export const PURPOSES = ['route', 'sell', 'enquire', 'publish', 'unclear'];

/** The quoted line. Long enough for a real headline, short enough to sit on a cover. */
export const CLAIM_MAX = 140;

/** What the classifier is shown. More than the claim, because a headline alone is thin. */
export const CONTEXT_MAX = 600;

/** The capture viewport, as lib/capture.mjs sets it. The fallback reads this much. */
export const FIRST_SCREEN = 900;

/**
 * Which elements are worth reading words out of.
 *
 * NOT `div`. A wrapper's textContent is its children's, joined, so the hero `<div>` on
 * gov.uk reads "The best place to find government services and information Search" — the
 * claim with the search box stuck to the end of it. Quoting that back at a reader is the
 * failure this list exists to prevent.
 */
const READABLE = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'li', 'a', 'button', 'strong', 'em', 'blockquote']);

/** Headings first, then prose, then the rest: the order a person reads a hero in. */
const RANK = {h1: 0, h2: 1, h3: 2, h4: 3, p: 4, blockquote: 5, strong: 6, em: 7, li: 8, a: 9, button: 10};

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

/**
 * A line long enough to be saying something rather than shouting it.
 *
 * "Work Smart, Grow Fast." is 22 characters and tells a reader nothing about what
 * boondmanager.com sells; it is also the biggest heading in their hero, so it is what the
 * old code quoted and classified from. A slogan is not a claim, and the difference is
 * roughly this long.
 */
export const CLAIM_MIN = 30;

/** The hero band, if the page has one. */
const heroBand = (blocks) => (blocks?.tree?.children ?? [])
    .find((b) => b?.label?.category === 'hero') ?? null;

/** The explainer bands: "the company still describing itself", per lib/vision.mjs. */
const explainerBands = (blocks) => (blocks?.tree?.children ?? [])
    .filter((b) => b?.label?.category === 'explainer');

/**
 * The page's own words, out of the capture.
 *
 * Returns `{claim, context, from}` — `claim` being the single strongest line, `context`
 * that line plus what surrounds it for the classifier, and `from` saying which band they
 * came from so a caller can say whether the page has a hero at all.
 *
 * THE FALLBACK IS THE FIRST SCREEN, for gov.je: 69% links and 31% navigation and no hero
 * anywhere, so there is no band to read a claim out of. The page still has a purpose, and
 * the first screen is still where a visitor looks for it.
 */
export function heroText(blocks, rects) {
    const hero = heroBand(blocks);
    const band = hero
        ? {top: hero.y, bottom: hero.y + hero.h, from: 'hero'}
        : {top: 0, bottom: FIRST_SCREEN, from: 'first-screen'};

    const lines = (top, bottom) => {
        const inBand = (rects ?? [])
            .filter((r) => READABLE.has(r.tag) && r.y >= top && r.y + r.h <= bottom)
            .map((r) => ({...r, words: tidy(r.text)}))
            .filter((r) => r.words.length > 1);

        // Headings before prose, and within a tag the one nearer the top of the band. Not
        // by area: the biggest box in a hero is usually the one wrapping everything else.
        inBand.sort((a, b) => (RANK[a.tag] ?? 99) - (RANK[b.tag] ?? 99) || a.y - b.y);

        const kept = [];
        for (const r of inBand) {
            // Already said. rects.json records every visible element, so a heading and the
            // link inside it arrive as two records carrying the same words.
            if (kept.some((k) => k.includes(r.words) || r.words.includes(k))) continue;
            kept.push(r.words);
            if (kept.join(' ').length >= CONTEXT_MAX) break;
        }

        return kept;
    };

    const kept = lines(band.top, band.bottom);

    // THE EXPLAINER, WHEN THE HERO IS ONLY A SLOGAN. The claim is printed under "In its
    // own words", so it has to be worth reading — and a hero whose largest line is "Work
    // Smart, Grow Fast." gives a reader nothing. The explainer is the model's own label for
    // "the company still describing itself", which is exactly the sentence wanted here, and
    // it is visible page text like the hero, so the quote stays honest.
    let claim = kept.find((line) => line.length >= CLAIM_MIN) ?? kept[0] ?? null;
    let from = kept.length ? band.from : null;
    let extra = [];

    if (!claim || claim.length < CLAIM_MIN) {
        for (const b of explainerBands(blocks)) {
            extra = lines(b.y, b.y + b.h);
            const better = extra.find((line) => line.length >= CLAIM_MIN);
            if (better) {
                claim = better;
                from = 'explainer';
                break;
            }
        }
    }

    return {
        claim: claim ? clip(claim, CLAIM_MAX) : null,
        // Everything found, hero first: the classifier is better off with more, and the
        // explainer's words are the ones that say what the company actually does.
        context: clip([...kept, ...extra].join(' '), CONTEXT_MAX),
        from,
    };
}

/**
 * The question. Deliberately a classification and nothing else.
 *
 * The definitions are the ones the expectations table is written against, so a kind that
 * drifts here quietly changes what the report says is a gap. Each carries the one-line
 * test that settles it.
 */
export const PURPOSE_PROMPT = `You are told what a website's homepage says at the top of it.

Decide what the page is FOR: what it is trying to make happen. Not what industry it is in.

- "route"    - its job is to send you somewhere. Take the links away and nothing is left.
               A government or council portal, a service directory, a marketplace index.
- "sell"     - its job is a transaction or a signup. There is a price, a cart, a trial, a
               plan, or a "get started" that ends in an account.
- "enquire"  - its job is to start a conversation. The thing it wants is a form, a call or
               an email, not a purchase. An agency, a consultancy, a professional service.
- "publish"  - its job is to be read. The writing IS the product: a publication, a news
               site, a magazine, a blog that is the whole point of the site.
- "unclear"  - the words do not say. This is a real answer and is better than a wrong one,
               because everything downstream is read against whatever you choose here.

A page that plainly wants a signup OR a conversation - "Get started" beside "Contact",
"Start a trial" beside "Book a demo" - is NOT unclear: choose "sell" if its main ask ends in
an account or a purchase, "enquire" if it ends in talking to someone. "unclear" is for a page
whose words do not say what it is for at all.

Judge only by the words you are given. Do not guess from the domain name.

You may be given the page's title, its meta description, its social or structured-data
description, and the words on the page itself. A description is written for someone who has
never heard of the company and is usually the plainest statement of what it does; the words
on the page may be a slogan. Weigh them accordingly.

Return ONLY a JSON object, no prose and no code fence:
{"kind": "<one of the words above>", "confidence": <0 to 1>}`;

/**
 * A reply, made safe.
 *
 * Anything unrecognised becomes `unclear` rather than itself, and `unclear` never carries
 * confidence: "I am certain I do not know" is not something the report should act on.
 */
export function parsePurposeReply(text) {
    const none = {kind: 'unclear', confidence: 0};
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) {
        return none;
    }

    let body;
    try {
        body = JSON.parse(match[0]);
    } catch {
        return none;
    }

    const kind = PURPOSES.includes(body?.kind) ? body.kind : 'unclear';
    if (kind === 'unclear') {
        return none;
    }

    const raw = Number(body?.confidence);

    return {kind, confidence: Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0};
}

/** Tokens. A classification answer is a dozen; the ceiling is only there to bound a fault. */
export const MAX_TOKENS = 200;

/**
 * Ask which kind. One request, text only.
 *
 * NO IMAGE, which is why this is cheap enough to run on every audit: the tiles have
 * already been looked at, and what is left is a question about a sentence.
 *
 * A FAILURE IS `unclear`, NOT A THROW. The caller prints nothing on `unclear`, so a model
 * that is down costs the report one section rather than the whole document.
 */
export async function askPurpose(context, opts = {}) {
    // THE <head> TOO, WHEN THERE IS ONE. A meta description is written for a stranger who
    // has never heard of the company, which is the classifier's own question — and it is
    // often the only place a page says plainly what it sells. Labelled rather than merged
    // so the model can weigh a description differently from a slogan, and never quoted:
    // the report's "In its own words" is visible page text (see heroText).
    const head = opts.head ?? {};
    const said = [
        head.title ? `Title: ${tidy(head.title)}` : '',
        head.description ? `Meta description: ${tidy(head.description)}` : '',
        head.ogDescription && head.ogDescription !== head.description
            ? `Social description: ${tidy(head.ogDescription)}` : '',
        head.schemaDescription && head.schemaDescription !== head.description
            ? `Structured data: ${tidy(head.schemaDescription)}` : '',
        tidy(context) ? `On the page: ${tidy(context)}` : '',
    ].filter(Boolean).join('\n');

    const words = said;
    if (!words) {
        return {kind: 'unclear', confidence: 0, why: 'the page said nothing readable'};
    }

    try {
        const res = await fetch(API, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': opts.key ?? apiKey(opts.envPath),
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: opts.model ?? MODEL,
                max_tokens: MAX_TOKENS,
                messages: [{role: 'user', content: `${PURPOSE_PROMPT}\n\n${words}`}],
            }),
        });
        if (!res.ok) {
            return {kind: 'unclear', confidence: 0, why: `the model answered ${res.status}`};
        }
        const json = await res.json();
        const said = (json?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');

        return parsePurposeReply(said);
    } catch (e) {
        return {kind: 'unclear', confidence: 0, why: e.message};
    }
}

/**
 * How many times the purpose is asked. The confidence used to be the model's own rating,
 * and a model rounds and hedges: pages that fit two jobs sat on the 0.6 floor — vaiie.com
 * came back "unclear" in one audit and "enquire, 58%" on a re-run, abas-erp.com at exactly
 * 60% — so the reading under Segments came and went between runs of the same page. Asked
 * five times, the confidence is how many agreed: a measurement, not a self-report, and the
 * same idea lib/proposition.mjs uses for its line labels.
 */
export const PURPOSE_VOTES = 5;

/**
 * Several answers reduced to one. A failed ask (it carries `why`) is a missing vote, and
 * an `unclear` is an abstention unless most answers are `unclear`. The winner needs more
 * than half of the votes that chose; its confidence is its share of them. No majority is
 * `unclear` with no confidence. `votes` keeps each answer's kind, for the record.
 */
export function combinePurposes(answers) {
    const answered = answers.filter((a) => a && !a.why);
    const votes = answers.map((a) => (a && !a.why ? a.kind : null));
    if (!answered.length) {
        return {kind: 'unclear', confidence: 0, votes, why: answers.find((a) => a?.why)?.why ?? 'no answer came back'};
    }

    // "unclear" IS AN ABSTENTION, unless most voters give it. vaiie.com's runs were
    // [unclear, sell x4], [unclear x2, sell x3], [enquire, unclear x2, sell x2]: the voters who
    // chose chose sell every time, and counting the abstentions as votes left the third run
    // with no majority at all. A page nobody can read still comes out unclear.
    const decided = answered.filter((a) => a.kind !== 'unclear');
    if (decided.length * 2 <= answered.length) {
        return {kind: 'unclear', confidence: 0, votes};
    }
    const counts = new Map();
    for (const a of decided) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    const [kind, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (n * 2 <= decided.length) {
        return {kind: 'unclear', confidence: 0, votes};
    }

    return {kind, confidence: Number((n / decided.length).toFixed(2)), votes};
}

/** The purpose, asked PURPOSE_VOTES times in parallel and reduced to the majority. */
export async function askPurposeVoted(context, opts = {}) {
    const answers = await Promise.all(Array.from({length: opts.votes ?? PURPOSE_VOTES}, () => askPurpose(context, opts)));

    return combinePurposes(answers);
}
