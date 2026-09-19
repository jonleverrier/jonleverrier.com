/**
 * TILES
 *
 * A captured page, cut into pieces a vision model can actually read.
 *
 *   node --test tools/audit/test/tiles.test.mjs
 *
 * A 24,746px screenshot scaled to fit a model's input is about 90px wide and unreadable,
 * so the page goes up as a sequence of viewport-ish tiles instead. 1400px at 0.75 scale
 * puts each one at 1080x1050, which is the shape the 26-site sweep was measured at.
 *
 * THE TILES DO NOT OVERLAP, and that is deliberate. An overlapping tile would show the
 * model the same section twice and invite it to report the region twice, which the
 * partition would then have to reconcile. A section straddling a seam is handled instead
 * by lib/bands.mjs, which merges a block ending at a seam with one starting there when
 * the model gave them the same label.
 *
 * The limitation worth knowing: a section taller than one tile is seen in pieces, and the
 * model can only say "this is all one thing" about the part in front of it. That is why
 * the seam merge exists and why it keys on the label rather than on the geometry.
 */
import sharp from 'sharp';

/** Page pixels per tile. */
export const TILE_HEIGHT = 1400;

/** …sent at this scale, so a tile arrives about 1080px on its long edge. */
export const TILE_SCALE = 0.75;

/** Where each tile starts and how tall it is. Exactly tiles the page. */
export function tilePlan(height, tileHeight = TILE_HEIGHT) {
    const out = [];
    for (let top = 0; top < height; top += tileHeight) {
        out.push({index: out.length, top, height: Math.min(tileHeight, height - top)});
    }

    return out;
}

/** The same plan, with each tile rendered and base64-encoded for the API. */
export async function tileImages(pngPath, plan, width, scale = TILE_SCALE) {
    const out = [];
    for (const t of plan) {
        const buf = await sharp(pngPath)
            .extract({left: 0, top: t.top, width, height: t.height})
            .resize(Math.round(width * scale))
            .png()
            .toBuffer();
        out.push({...t, scale, b64: buf.toString('base64')});
    }

    return out;
}
