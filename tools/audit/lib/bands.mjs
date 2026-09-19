/**
 * BANDS
 *
 * The model's boundaries, turned into the true partition the measurement rests on.
 *
 *   node --test tools/audit/test/bands.test.mjs
 *
 * THE MODEL'S ANSWER IS ADVISORY; THE PARTITION IS NOT. Blocks arrive as a list of y
 * ranges that MOSTLY tile the page — across a 26-site sweep there were no gaps at all, but
 * "mostly" is not a foundation for a percentage somebody will argue with. Everything here
 * exists to turn that list into a partition where total leaf area equals image area
 * exactly, so the arithmetic is ours and not the model's.
 *
 * Snapping comes first, because it is what makes the number reproducible: the model places
 * a boundary to within ten or twenty pixels, and rects.json knows where elements actually
 * stop. On andybudd.com two runs that differed raw reached 8 of 8 identical boundaries and
 * 0.0px of drift once snapped. See lib/candidates.mjs.
 *
 * The limitation worth knowing: where two runs genuinely disagree about whether a region
 * is one section or two, snapping cannot reconcile them — kohde.agency returns 10 blocks
 * on one run and 11 on another. That is why a page is audited once and the answer stored;
 * see lib/signature.mjs.
 */
import {assertPartition} from './blocks.mjs';

/** How far a boundary may move to reach a real element edge. */
export const SNAP_REACH = 40;

/**
 * Each boundary moved to the nearest element edge within reach, de-duplicated and sorted.
 *
 * Out of reach means the model saw a boundary the DOM does not have — a background change
 * inside one element, most often — and its own coordinate stands rather than being dragged
 * to the nearest thing that happens to exist.
 */
export function snapBoundaries(edges, candidates, reach = SNAP_REACH) {
    const snapped = edges.map((y) => {
        let best = y;
        let gap = reach + 1;
        for (const c of candidates) {
            const d = Math.abs(c - y);
            if (d < gap) {
                gap = d;
                best = c;
            }
        }

        return gap <= reach ? best : y;
    });

    return [...new Set(snapped)].sort((a, b) => a - b);
}

/**
 * Blocks split by a tile seam, put back together.
 *
 * A section taller than one tile is shown to the model in pieces and comes back as two
 * blocks meeting exactly at the seam. The test is that they meet, that they meet AT A
 * SEAM, and that they carry the same CATEGORY.
 *
 * NOT THE SAME WORDING, and that was the first attempt. The model sees two halves and
 * describes them as two halves: natwest.com's prize draw came back as "prize draw promo
 * section" for 1233-1400 and "ISA prize draw offer" for 1400-1720, both `promotion`, both
 * the same panel, and requiring the text to match left them as two blocks — which a reader
 * reported as the defect it is. The description is the model's prose; the category is its
 * judgement, and the judgement is what should decide.
 *
 * The cost of the looser rule is bounded. Two genuinely different sections have to meet at
 * exactly the seam — an arbitrary 1400px grid, unrelated to the page — AND share a
 * category. When that happens they merge into one block carrying the label they both
 * already had, so no percentage moves; only the granularity does, and by the depth ruling
 * a cut that changes no label was not worth making.
 */
/**
 * Below this, a block at a seam is a fragment the model could not identify, and it takes
 * the category of the confident section it abuts.
 *
 * A slice boundary falls at an arbitrary 1400px grid, so a section can start a hundred
 * pixels before one. The slice above then sees a sliver and says so — masonbreese.com
 * produced `unclassified` at confidence 0.4 for the last 133px of a section, described as
 * "grey section begins", while the slice below named the whole thing confidently. Leaving
 * that sliver unclassified reports as unmeasured something we did in fact measure.
 *
 * ONLY AT A SEAM, and only when the two ends disagree in confidence. Two confident blocks
 * that differ are two sections, and neither gives way.
 */
export const FRAGMENT_MAX_CONFIDENCE = 0.5;

export function mergeSeams(blocks, seams) {
    const at = new Set(seams);
    const out = [];
    for (const b of blocks) {
        const last = out[out.length - 1];
        const meets = last && last.y1 === b.y0 && at.has(b.y0);
        // A fragment the slice above could not identify, abutting a section the slice
        // below could: adopt the confident answer rather than keep the guess.
        if (meets && last.category !== b.category
            && (last.confidence ?? 0) <= FRAGMENT_MAX_CONFIDENCE
            && (b.confidence ?? 0) > FRAGMENT_MAX_CONFIDENCE) {
            last.category = b.category;
            last.what = b.what;
        }
        const joins = meets && last.category === b.category;
        if (joins) {
            last.y1 = b.y1;
            // The widest column count, because one half of a grid may show fewer columns
            // than the other; the lowest confidence, because a run is only as sure as its
            // least sure part; and the fuller description, because the half that named the
            // thing is more use than the half that named its bottom edge.
            last.cols = Math.max(last.cols, b.cols);
            last.confidence = Math.min(last.confidence, b.confidence);
            if (String(b.what).length > String(last.what).length) last.what = b.what;
            continue;
        }
        out.push({...b});
    }

    return out;
}

/**
 * A root whose children exactly tile the image, each carrying its block's label.
 *
 * BUILT FROM THE BOUNDARIES RATHER THAN FROM THE BLOCKS, which is what makes gaps and
 * overlaps impossible rather than merely unlikely. The distinct y values become one
 * contiguous run of bands, and each band takes the label of the block covering its
 * midpoint. A block that overlapped another simply loses the part it did not own; a gap
 * becomes a band nobody labelled, reported as `unclassified` and never silently absorbed
 * into whichever neighbour happens to be nearer.
 *
 * Coordinates outside the page are dropped rather than trusted: a block reaching past the
 * bottom is clipped by the page's own height being the last cut.
 */
export function buildTree(blocks, width, height) {
    const cuts = new Set([0, height]);
    for (const b of blocks) {
        if (b.y0 > 0 && b.y0 < height) cuts.add(b.y0);
        if (b.y1 > 0 && b.y1 < height) cuts.add(b.y1);
    }
    const ys = [...cuts].sort((a, b) => a - b);

    const children = [];
    for (let i = 0; i < ys.length - 1; i++) {
        const y = ys[i];
        const h = ys[i + 1] - y;
        if (h <= 0) continue;
        const mid = y + h / 2;
        const owner = blocks.find((b) => b.y0 <= mid && mid < b.y1);
        children.push({
            x: 0,
            y,
            w: width,
            h,
            depth: 1,
            children: [],
            label: owner
                ? {what: owner.what, category: owner.category, confidence: owner.confidence, cols: owner.cols}
                : {what: 'unlabelled region', category: 'unclassified', confidence: 0, cols: 1},
        });
    }

    const root = {x: 0, y: 0, w: width, h: height, depth: 0, children};
    // Thrown here rather than left to the caller: a tree that is not a partition is not a
    // measurement of anything, and every path into this function either produces one or
    // fails loudly.
    assertPartition(root);

    return root;
}
