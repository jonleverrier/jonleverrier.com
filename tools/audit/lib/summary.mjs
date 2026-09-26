/**
 * SUMMARY
 *
 * Which few facts go on the cover.
 *
 *   node --test tools/audit/test/summary.test.mjs
 *
 * CHOSEN, NOT FILLED IN, and that is the whole file. The cover used to carry four fixed
 * slots — biggest segment, weight, deferral, duplicate colours — printing whatever they
 * happened to hold. On a real comparison that gave "69.3% of the page is routing, against
 * 67.8% on gov.je", two numbers a point and a half apart presented as a contrast, and "No
 * two colours on the page are ones a person could confuse. gov.je has none", which is a
 * fault report about an absence of faults. Half the cover said nothing. Meanwhile the same
 * two captures held a competitor with NO HERO AT ALL and a fivefold difference in weight,
 * and no slot existed that could have noticed either.
 *
 * So every candidate says whether it is worth printing and how big a difference it
 * describes, and the cover takes the biggest few. Three rules decide `worth`:
 *
 *   - A comparison of two numbers that are LEVEL is not a finding. See LEVEL.
 *   - A CLEAN RESULT is not a finding. Nothing wrong with either page is not news.
 *   - A measurement that did not happen is not a finding, and never a sentence with a
 *     hole in it.
 *
 * THE WORDING IS HERE AND NOT IN THE TEMPLATE, for the reason data.mjs exists: a Twig
 * template that assembled these would be a second place where the arithmetic lives, and
 * the first anyone would know is a cover and a table disagreeing about the same page.
 *
 * The limitation worth knowing: a finding is a formed sentence, so this file is the only
 * place the report's voice is written in JavaScript. It stays narrow on purpose — plain
 * statements, a figure first, no adjectives — and anything that wants to INTERPRET a
 * number belongs in the Summary section under Segments, where the page's own purpose is
 * there to license it.
 */

/**
 * How far apart two shares have to be before the difference is worth a reader's time.
 *
 * Five points. gov.uk and gov.je are 1.5 apart on routing and that comparison was
 * meaningless; the same two are 20 points apart on navigation and that is a different
 * page. Expressed as a share, not percentage points, because everything here is 0..1.
 */
export const LEVEL = 0.05;

/** Below this a segment is a rounding error, and its absence elsewhere is not news. */
export const WORTH_MENTIONING = 0.02;

/** The bytes in a megabyte, as bytes.mjs counts them. */
const MB = 1048576;

const pc = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * A mark to one place, rounding HALF UP as the cover's Twig `round` does. `toFixed` rounds
 * the binary value, and vaiie.com's 8.95 is stored as 8.9499…: the cover said 9.0 and the
 * summary line under it said 8.9.
 */
const mark = (v) => (Math.round(v * 10 + 1e-9) / 10).toFixed(1);

/** As r.bytes() prints it in the report, so a cover and a table never disagree. */
const bytes = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** A site's bare host, as a person would say it. */
const host = (url) => {
    try {
        return new URL(url).host.replace(/^www\./i, '');
    } catch {
        return url;
    }
};

const segment = (report, name) => (report?.categories ?? []).find((c) => c.category === name) ?? null;
const biggest = (report) => (report?.categories ?? []).filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share)[0] ?? null;

/**
 * The marks averaged, as the cover prints it. Null unless speed, technical and consistency
 * are all there; PROPOSITION IS THE FOURTH when the report has one (26 Sep 2026), and an
 * audit from before it existed keeps the three-way average it was sent with.
 */
export function overall(report) {
    const marks = [
        report?.speed ? report.speed.score / 10 : null,
        report?.technical ? report.technical.score : null,
        report?.brand ? report.brand.score : null,
    ];
    if (!marks.every((m) => m !== null)) return null;
    const proposition = report?.proposition?.score?.score;
    if (typeof proposition === 'number') marks.push(proposition);

    return marks.reduce((s, m) => s + m, 0) / marks.length;
}

/**
 * Every fact the cover COULD carry, each saying whether it is worth carrying.
 *
 * `gap` is what ranks them and is always 0..1. It is deliberately not comparable between
 * kinds — a fivefold weight difference and a twenty-point share difference are not the
 * same quantity — so it is normalised to "how striking is this", which is a judgement
 * this file is allowed to make and the tables are not.
 */
export function candidates(report, competitor = null) {
    const out = [];
    const them = competitor ? host(competitor.url) : null;
    const add = (id, worth, gap, text) => out.push({id, worth: Boolean(worth) && Boolean(text), gap, text});

    // ---- the overall mark ------------------------------------------------------------
    const mine = overall(report);
    const theirs = overall(competitor);
    if (mine !== null && theirs !== null) {
        // ON THE PRINTED NUMBERS: gov.je and gov.gg are 7.975 and 8.45, shown as 8.0 and 8.5.
        // Measured raw, 0.475 fell under the line and the cover summary came out empty
        // while the reader could see half a point between the two scores above it.
        const gap = Math.abs(Number(mark(mine)) - Number(mark(theirs))) / 10;
        add('overall', gap * 10 >= 0.5 - 1e-9, gap,
            `${mark(mine)} out of 10, against ${mark(theirs)} for ${them}.`);
    } else if (mine !== null) {
        add('overall', true, 0.3, `${mark(mine)} out of 10 across speed, technical`
            + `${typeof report?.proposition?.score?.score === 'number' ? ', consistency and proposition' : ' and consistency'}.`);
    }

    // ---- the proposition's most serious gap ------------------------------------------
    //
    // Its FIRST SENTENCE, because the cover has a line and the section has the rest:
    // "Nothing visible on the first two screens asks visitors to get in touch." is the
    // finding; the menu and the screen number are the working. Ranked by the finding's own
    // weight, which lib/proposition-reading.mjs gives the first screen (1) above the asks.
    // A proposition with no gap is a clean result, and a clean result is not news.
    const gaps = (report?.proposition?.findings ?? []).filter((f) => f.kind === 'gap')
        .sort((a, b) => b.weight - a.weight);
    if (gaps.length) {
        const first = gaps[0].text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? gaps[0].text;
        add('proposition', true, Math.min(1, gaps[0].weight * 0.9), first);
    } else {
        add('proposition', false, 0, null);
    }

    // ---- weight ----------------------------------------------------------------------
    const w = report?.weight?.measured ? report.weight.afterScroll.bytes : null;
    const wTheirs = competitor?.weight?.measured ? competitor.weight.afterScroll.bytes : null;
    if (w !== null && wTheirs !== null) {
        const ratio = Math.max(w, wTheirs) / Math.max(1, Math.min(w, wTheirs));
        // The page LENGTHS belong in this sentence: half the weight on twice the page is a
        // different fact from half the weight on the same page, and the reader cannot
        // supply the second number themselves.
        const longer = report.height / Math.max(1, competitor.height);
        const aside = longer >= 1.5 ? `, on a page nearly ${longer.toFixed(1)} times as long`
            : (longer <= 0.67 ? `, on a page ${(1 / longer).toFixed(1)} times shorter` : '');
        add('weight', ratio >= 1.25, Math.min(1, (ratio - 1) / 4),
            `${bytes(w)} against ${bytes(wTheirs)} for ${them}${aside}.`);
    } else if (w !== null) {
        const median = (report.technical?.medianMb ?? 2.3) * MB;
        const over = (w - median) / median;
        add('weight', Math.abs(over) >= 0.25, Math.min(1, Math.abs(over) / 2),
            `${bytes(w)}, ${pc(Math.abs(over))} ${over > 0 ? 'above' : 'below'} the median desktop page.`);
    }

    // ---- what waits for a scroll -----------------------------------------------------
    const d = report?.technical && !report.technical.shortPage ? report.technical.deferred : null;
    const dTheirs = competitor?.technical && !competitor.technical.shortPage ? competitor.technical.deferred : null;
    if (d !== null && dTheirs !== null) {
        add('deferred', Math.abs(d - dTheirs) >= LEVEL * 2, Math.abs(d - dTheirs),
            `${pc(d)} of the weight waits for a scroll. ${them}: ${pc(dTheirs)}.`);
    } else if (d !== null) {
        add('deferred', d < 0.1, 1 - d, `${pc(d)} of the weight waits until the visitor scrolls.`);
    }

    // ---- the biggest segment ---------------------------------------------------------
    const big = biggest(report);
    if (big) {
        const match = competitor ? segment(competitor, big.category) : null;
        if (match) {
            const gap = Math.abs(big.share - match.share);
            // THE RULE THIS FILE EXISTS FOR. 69.3 against 67.8 is not a comparison.
            add('biggest-segment', gap >= LEVEL, gap,
                `${pc(big.share)} of the page is ${big.category}, against ${pc(match.share)} on ${them}.`);
        } else {
            add('biggest-segment', true, big.share / 2,
                `${pc(big.share)} of the page is ${big.category}, across `
                + `${big.blocks?.length ?? 0} section${(big.blocks?.length ?? 0) === 1 ? '' : 's'}.`);
        }
    }

    // ---- a segment one page spends on and the other has not got ----------------------
    //
    // gov.je has no hero, so its first screen is 69% links and 31% navigation with nothing
    // saying what the site is. Nothing on the old cover could have noticed: every slot
    // compared a number against a number, and this is a number against an absence.
    if (competitor) {
        for (const c of report?.categories ?? []) {
            if (c.share < WORTH_MENTIONING) continue;
            const match = segment(competitor, c.category);
            if (match && match.share >= WORTH_MENTIONING) continue;
            const first = c.firstViewport ?? 0;
            add(`missing-${c.category}`, true, Math.max(c.share, first),
                `${them} has no ${c.category}: ${pc(c.share)} of this page is, `
                + `and ${pc(first)} of its first screen.`);
        }
    }

    // ---- colours a person cannot tell apart ------------------------------------------
    //
    // Only when there are some. "No two colours ... and they have none either" reports an
    // absence of faults on two pages at once.
    const groups = report?.brand?.groups ?? 0;
    if (groups) {
        add('duplicate-colours', true, Math.min(1, groups / 4),
            `${report.brand.colours} colours on the page are `
            + `${groups === 1 ? 'a pair' : `${groups} sets`} a person cannot tell apart.`);
    } else {
        add('duplicate-colours', false, 0, null);
    }

    return out;
}

/**
 * The cover's findings: worth printing, biggest difference first, at most `max`.
 *
 * FOUR IS THE CEILING because the cover has room for four and because a fifth is, by
 * construction, the least interesting thing that survived.
 */
export function summarise(report, competitor = null, max = 4) {
    return candidates(report, competitor)
        .filter((c) => c.worth)
        .sort((a, b) => b.gap - a.gap)
        .slice(0, max);
}
