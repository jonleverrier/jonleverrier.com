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
 * pixels by lib/painted.mjs. A leaf without it counts as fully covered, which flatters a
 * sparse block — analyse.mjs sets it on every leaf, so that is only reachable by a caller
 * building a tree by hand.
 */
import {leaves} from './blocks.mjs';

/** The order a report prints them in: the four that are being asked about, then the rest. */
const CATEGORY_ORDER = ['brand', 'navigation', 'routing', 'promotion', 'other', 'unclassified'];

const inkOf = (l) => l.area * (typeof l.coverage === 'number' ? l.coverage : 1);

const tally = (ls, total) => {
    const byCategory = new Map();
    for (const l of ls) {
        if (l.area <= 0) continue;
        const key = l.label?.category ?? 'unclassified';
        const held = byCategory.get(key) ?? {area: 0, inked: 0};
        held.area += l.area;
        held.inked += inkOf(l);
        byCategory.set(key, held);
    }

    return CATEGORY_ORDER
        .filter((c) => byCategory.has(c))
        .map((category) => {
            const {area, inked} = byCategory.get(category);

            return {
                category,
                area,
                share: total > 0 ? area / total : 0,
                coverage: area > 0 ? inked / area : 0,
            };
        });
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
        coverage: total > 0 ? whole.reduce((a, l) => a + inkOf(l), 0) / total : 0,
        unmeasured: full.find((s) => s.category === 'unclassified')?.share ?? 0,
    };
}
