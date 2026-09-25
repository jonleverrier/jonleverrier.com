/**
 * ERROR PAGE, SERVED AS A SUCCESS
 *
 * A page that says it failed, on a page that has nothing on it, answered with HTTP 200.
 *
 *   node --test tools/audit/test/errorpage.test.mjs
 *
 * lloydsbank.com answers a headless browser with 200 and this:
 *
 *   h1          "We are sorry an error has occurred, please try again later."
 *   rects       65            (natwest.com, for comparison: 768)
 *   fullHeight  1032px        (natwest: 7405px)
 *
 * It segmented into 12 blocks with area conserved and no notes at all — a clean-looking
 * measurement of somebody's bot mitigation. The status-code check cannot see it, because
 * the status is 200; that check catches the hard block (a CloudFront 403) and a soft
 * error page is how bot mitigation usually presents.
 *
 * WHAT THIS IS WILLING TO CLAIM, and it is deliberately one narrow thing: THE PAGE SAYS
 * IT FAILED AND HAS ALMOST NOTHING ON IT. Neither half is evidence on its own and each
 * has an obvious false positive:
 *
 *   - Wording alone flags a site whose subject IS failure. An error-monitoring product,
 *     a status page, an insurance claims page: "something went wrong" is a headline
 *     somebody sells.
 *   - Sparseness alone flags a homepage that is genuinely minimal, which is a design
 *     choice and not a fault. The jonleverrier fixture is one: 123 rects, and correct.
 *
 * Together they describe a page nobody publishes on purpose. The cost is recall — a bot
 * wall that says "checking your browser" rather than apologising is not caught, and
 * neither is a rich, well-populated error page — and those are the right things to give
 * up, because a false note is read and dismissed while a false refusal produces nothing
 * at all.
 *
 * IT IS A NOTE, NOT A REFUSAL, which is the other half of the decision. `httpError`
 * refuses because a 4xx is unambiguous: the server said this is not the page. Here the
 * server said 200 and the evidence is circumstantial, so the honest answer is to measure
 * the page and say loudly what it appears to be.
 *
 * THE H1, NOT THE BODY. The h1 is in `rects.json` for every capture ever taken. A page
 * whose error wording is in a `<p>` with no h1 at all is therefore missed; that is a false
 * negative and it is declared. Phase 1 now records the <title> too, and that is a
 * separate, stronger check — see blockedHeadReason, which refuses where this only notes.
 */
import {printable} from './printable.mjs';

/**
 * Phrases an error page uses and a homepage does not.
 *
 * Each one is a sentence about THIS REQUEST having failed, rather than a word that could
 * head a real page: `error` alone would match an error-monitoring product, `sorry` alone
 * a restaurant's opening hours. Matching is case-insensitive and whitespace-tolerant,
 * because these arrive as rendered text with whatever markup put in it.
 */
export const ERROR_PHRASES = [
    /an\s+error\s+has\s+occurred/i,
    /an?\s+error\s+occurred/i,
    /something\s+went\s+wrong/i,
    /(try|come\s+back)\s+again\s+later/i,
    /temporarily\s+(unavailable|down)/i,
    /service\s+unavailable/i,
    /page\s+(could\s+not\s+be\s+found|not\s+found)/i,
    /access\s+denied/i,
    /request\s+(was\s+)?blocked/i,
    /under\s+maintenance/i,
];

/**
 * The rect count below which a homepage is implausibly empty.
 *
 * MEASURED. The error page has 65 rects. The sparsest genuine homepage available is the
 * jonleverrier fixture at 123 — a deliberately minimal one-screen personal site, which
 * is the shape most likely to be flagged by mistake — and the next sparsest is
 * clearleft.com at 243. Everything else measured runs 246 to 1033 (kohde 249, klark 306,
 * retail 411, hsbc 471, natwest 768, boondmanager 1033). 100 sits between the error page
 * and the sparsest real one with room on both sides: the error page would have to gain
 * 54% more elements to escape, and jonleverrier would have to lose 19% of its own to be
 * caught — and it would still need an apology in its h1.
 */
export const SPARSE_RECTS = 100;

/** The h1 text in a rects file, in the order phase 1 collected it. */
const headings = (rects) => (rects ?? [])
    .filter((r) => r.tag === 'h1' && typeof r.text === 'string' && r.text.trim() !== '')
    .map((r) => r.text.trim());

/**
 * The evidence that this is an error page, or null.
 *
 * Returned as facts rather than a sentence so that the raw heading reaches `blocks.json`
 * exactly as the page wrote it — see notes.mjs on why `facts` is never sanitised.
 */
export function errorPageEvidence(rects) {
    if (!Array.isArray(rects) || rects.length === 0 || rects.length >= SPARSE_RECTS) {
        return null;
    }
    for (const heading of headings(rects)) {
        const phrase = ERROR_PHRASES.find((p) => p.test(heading));
        if (phrase) {
            return {heading, phrase: phrase.source, rectCount: rects.length, sparseBelow: SPARSE_RECTS};
        }
    }

    return null;
}

/** The sentence for a terminal and for `notes`. Page text goes through printable(). */
export function errorPageWarning(rects) {
    const evidence = errorPageEvidence(rects);
    if (!evidence) {
        return null;
    }

    return `this looks like an error page rather than the homepage: its heading reads `
        + `"${printable(evidence.heading, 120)}" and the page has only ${evidence.rectCount} elements on it. `
        + 'The server answered 200, so nothing else about the capture looks wrong — but percentages '
        + 'taken from it describe whatever was served instead of the site';
}

/**
 * Wording a location block uses. Tested against the TITLE to decide, and against the
 * description only to decide which kind of block a title has already admitted to — a
 * description is marketing copy, and "only available in the UK" is how a florist
 * describes its delivery.
 */
export const GEO_PHRASES = [
    /(only|currently)\s+available\s+(in|to)\b/i,
    /(not|isn'?t)\s+(yet\s+)?available\s+in\s+your\s+(country|region|location|area)/i,
    /unavailable\s+in\s+your\s+(country|region|location|area)/i,
    /\bgeo-?\s*(blocked|restricted)\b/i,
];

/**
 * WHY A 200 CAPTURE IS REFUSED ANYWAY, from its head, or null.
 *
 * wahio.design, from a UK server: a geo block rendered INSIDE the site's own layout —
 * header, footer, well over SPARSE_RECTS — answered 200, so neither the status check nor
 * errorPageEvidence fired, and the report quoted "only available in the European Union"
 * as the site's own words. Its <title> was "Service Unavailable". A homepage does not
 * title itself with a sentence about this request failing, so unlike the h1 check this
 * needs no sparseness to back it up, and it REFUSES rather than notes: the head is the
 * page naming itself, not circumstantial evidence.
 *
 * THE TITLE DECIDES. The description is quoted when there is one, because it is usually
 * the page explaining itself ("…only available in the European Union"), and a geo phrase
 * in either one is what makes the sentence say "by location".
 *
 * Non-2xx is left to httpErrorReason, which words the firewall case.
 */
export function blockedHeadReason(meta) {
    if (meta?.httpStatus !== 200) {
        return null;
    }
    const title = String(meta.head?.title ?? '').trim();
    const description = String(meta.head?.description ?? '').trim();
    const geoTitle = GEO_PHRASES.some((p) => p.test(title));
    if (!title || !(geoTitle || ERROR_PHRASES.some((p) => p.test(title)))) {
        return null;
    }
    const quoted = `a page titled "${printable(title, 120)}"`
        + (description ? ` ("${printable(description, 160)}")` : '');
    if (geoTitle || GEO_PHRASES.some((p) => p.test(description))) {
        return `the site blocked the capture by location: it answered 200 with ${quoted}, `
            + 'so this is what a visitor from our capture server\'s country sees, not the homepage';
    }

    return `the server answered 200 with ${quoted}, so this is an error page rather than the homepage`;
}

/**
 * A title a block page wears. Checked only on a page that already answered non-2xx, so
 * the bar is lower than ERROR_PHRASES': the status has said this is not the site, and the
 * title only decides whether to name WHO turned us away.
 */
const BLOCK_TITLE = /\bblock(ed)?\b|\bdenied\b|\bforbidden\b|attention required|captcha|verify you are human/i;

/**
 * WHY A NON-2xx CAPTURE IS REFUSED, in the words the entry shows.
 *
 * "The server answered 500" read as the site being down. gov.gg's 500 was its firewall's
 * block page — titled "The URL you requested has been blocked", with an Attack ID — and
 * the title phase 1 records says so. It is quoted whenever there is one, and when it reads
 * as a block the sentence leads with that. `answered <status>` stays in every form.
 */
export function httpErrorReason(meta) {
    const status = meta.httpStatus;
    const title = printable(String(meta.head?.title ?? '').trim(), 120);
    if (title && BLOCK_TITLE.test(title)) {
        return `the site's firewall blocked the capture: it answered ${status} with a page titled "${title}"`;
    }
    if (title) {
        return `the server answered ${status} with a page titled "${title}", so this is an error page rather than the site`;
    }

    return `the server answered ${status}, so this is an error page rather than the site`;
}
