/**
 * SURFACE
 *
 * The number the report prints: how much of a homepage goes to each category.
 *
 *   node --test tools/audit/test/surface.test.mjs
 *
 * Two figures, because they answer different questions. THE FULL PAGE is what the site
 * spends its space on; THE FIRST VIEWPORT is what a visitor is given before they do
 * anything. A site can be 6% navigation overall and 31% navigation above the fold, and the
 * second number is the one that changes what somebody does about it.
 *
 * WHITESPACE IS A MEASURE ACROSS BLOCKS, NOT A KIND OF BLOCK. That ruling came from the
 * client logo strip on klark.ai, which is 4% ink and 96% space: labelled "routing" and
 * counted by area alone, its whitespace silently becomes routing, while a "space" category
 * would only ever capture the blocks nobody labelled — an accident of where boundaries
 * fell, and two sites with identical whitespace would report wildly different figures. So
 * every share carries its own `coverage`, and the report says both: "routing: 22% of the
 * page, at 31% coverage".
 *
 * UNCLASSIFIED IS NEVER REDISTRIBUTED. A percentage that quietly absorbs our own
 * uncertainty is the confident wrong number this tool exists to avoid, and the person
 * reading the report owns the site and is entitled to know how much of it we could not
 * name.
 *
 * The limitation worth knowing: `coverage` needs each leaf to carry one, measured from the
 * pixels by lib/painted.mjs, and on a page too tall for that pass to decode there is none.
 * It is then NULL rather than 1, and the report prints a dash — because "we did not
 * measure this" and "all of it is drawn on" are different answers, and only one of them is
 * true of a 24,746px page.
 */
import {leaves} from './blocks.mjs';

/**
 * BIGGEST FIRST, because the first row is the answer.
 *
 * This was top-of-page to bottom-of-page, so the table read like the page it describes.
 * That is the better order for reading 27 of them side by side — the rows line up and a
 * column can be scanned — and the wrong one for the person the report is FOR, who is
 * reading one page, theirs, and wants to know what it spends the most space on. On
 * natwest.com that is promotion at 36.3%, and it sat fourth.
 *
 * `unclassified` is pinned last whatever its size. It is the tool declining to answer, not
 * a finding, and a refusal at the top of the table reads as the page's largest feature —
 * which on lloydsbank.com, 84% unclassified because it served an error page, would be a
 * confident wrong headline of exactly the kind this tool exists to avoid.
 *
 * The sweep and the leaderboard sort their own rows; this is the per-page order only.
 */
const CATEGORY_ORDER = [
    'navigation', 'hero', 'brand', 'promotion', 'trust', 'routing', 'editorial', 'footer',
    'unclassified',
];

/** Ties break on the fixed order above, so the same page always prints the same table. */
const bySize = (a, b) => (b.share - a.share)
    || (CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

const biggestFirst = (rows) => [
    ...rows.filter((r) => r.category !== 'unclassified').sort(bySize),
    ...rows.filter((r) => r.category === 'unclassified'),
];

/**
 * NULL WHERE IT WAS NOT MEASURED, NEVER 1. A leaf with no coverage recorded is one the ink
 * pass never reached — visionarygrid.studio is 24,746px and past the budget that decodes a
 * PNG in one go. Defaulting it to "fully covered" printed `100.0% ink` for every category
 * of that page, which is a confident wrong number sitting directly beneath a note saying
 * the figure was not available.
 */
const inkOf = (l) => (typeof l.coverage === 'number' ? l.area * l.coverage : null);

const tally = (ls, total) => {
    const byCategory = new Map();
    for (const l of ls) {
        if (l.area <= 0) continue;
        const key = l.label?.category ?? 'unclassified';
        const held = byCategory.get(key) ?? {area: 0, inked: 0, measured: 0};
        held.area += l.area;
        const ink = inkOf(l);
        if (ink !== null) {
            held.inked += ink;
            held.measured += l.area;
        }
        byCategory.set(key, held);
    }

    const rows = CATEGORY_ORDER
        .filter((c) => byCategory.has(c))
        .map((category) => {
            const {area, inked, measured} = byCategory.get(category);

            return {
                category,
                area,
                share: total > 0 ? area / total : 0,
                // Over the area actually measured, and null when none of it was.
                coverage: measured > 0 ? inked / measured : null,
            };
        });

    return biggestFirst(rows);
};

export function surfaceArea(root, viewportHeight) {
    const ls = leaves(root).filter((l) => l.w > 0 && l.h > 0);

    const whole = ls.map((l) => ({...l, area: l.w * l.h}));
    const total = whole.reduce((a, l) => a + l.area, 0);

    // A block straddling the fold contributes only the part above it, which is the only
    // reading that makes the first-viewport figure mean what it says. A hero that runs
    // 400px past the fold is not 100% of what a visitor first sees.
    const above = ls
        .map((l) => {
            const h = Math.max(0, Math.min(l.y + l.h, viewportHeight) - l.y);

            return {...l, area: l.w * h};
        })
        .filter((l) => l.area > 0);
    const aboveTotal = above.reduce((a, l) => a + l.area, 0);

    const full = tally(whole, total);

    return {
        full,
        firstViewport: tally(above, aboveTotal),
        coverage: (() => {
            const measured = whole.filter((l) => typeof l.coverage === 'number');
            const area = measured.reduce((a, l) => a + l.area, 0);

            return area > 0 ? measured.reduce((a, l) => a + inkOf(l), 0) / area : null;
        })(),
        unmeasured: full.find((s) => s.category === 'unclassified')?.share ?? 0,
    };
}
