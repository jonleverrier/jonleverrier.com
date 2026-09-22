/**
 * DEBUG RENDER
 *
 * The screenshot with every leaf outlined. This image is the review gate for the
 * whole tool: if the cuts are wrong here, nothing downstream is worth building, and
 * no invariant can tell you they are wrong — only an eye can.
 *
 *   node tools/audit/analyse.mjs <outDir>   (calls this internally)
 *
 * SVG over the PNG rather than pixel-pushing, because sharp composites SVG directly
 * and it keeps the outlines crisp at any size. The limitation worth knowing: labels
 * are drawn at (x+6, y+18) with no collision avoidance, so a leaf shorter than ~18px
 * gets a clipped or overlapping index number. That is a labelling nuisance, not a
 * segmentation bug — the rect itself is still drawn correctly.
 *
 * A LEAF'S LABEL IS DRAWN WITH IT where it has one, because the question this image has
 * to answer is no longer only "is the boundary in the right place" but "is this thing
 * what the report is about to call it". A wrong category on a correct rect is just as
 * bad a number, and only an eye catches it.
 */
import sharp from 'sharp';
import {leaves} from './blocks.mjs';

/** Words title case leaves alone unless they open the phrase. */
const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
    'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * Title case that does not destroy what the model wrote.
 *
 * NOT `ucwords(strtolower(...))`, which is what Twig's own `title` filter does and which
 * turns "closing CTA with buttons" into "Closing Cta With Buttons" and "Xero" into "Xero"
 * only by luck. A word already in capitals is a word somebody meant: CTA, USP, B2B, and
 * every client name the model reads off a page.
 *
 * Shared with the report rather than done twice: lib/pdf.mjs prints these same strings in
 * the Segments table, and two casing rules would drift.
 */
export function titleCase(text) {
    if (!text) {
        return text;
    }

    return String(text).split(' ').map((word, i) => {
        if (word.length > 1 && word === word.toUpperCase()) {
            return word;
        }
        const bare = word.replace(/[^a-z]/gi, '').toLowerCase();

        return i > 0 && MINOR.has(bare) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

/** Everything printable stripped of the two characters that would break the SVG. */
const safe = (s) => String(s).replace(/[<&]/g, '');

export async function renderDebug(pngPath, root, outPath) {
    const {width, height} = await sharp(pngPath).metadata();
    const rects = leaves(root)
        .map((b, i) => {
            // THE NUMBER IS THE ONE THE REPORT PRINTS, and it is leaves() order in both
            // places. A reader matches "Slice 8" in the table to "Slice 8" on the image, so
            // if either side stops using this order the table starts pointing at the wrong
            // section — which is worse than pointing at nothing.
            const tag = b.label
                ? `Slice ${i}: ${titleCase(b.label.category)}: ${titleCase(b.label.what)}: `
                    + `Confidence: ${Math.round((b.label.confidence ?? 0) * 100)}%`
                : `Slice ${i}`;

            return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" `
                + 'fill="none" stroke="#e02e1a" stroke-width="2"/>'
                + `<text x="${b.x + 6}" y="${b.y + 18}" font-family="monospace" font-size="13" `
                + `fill="#e02e1a">${safe(tag)}</text>`;
        })
        .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`;

    await sharp(pngPath)
        .composite([{input: Buffer.from(svg), top: 0, left: 0}])
        .toFile(outPath);
}
