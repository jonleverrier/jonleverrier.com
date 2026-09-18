/**
 * DEBUG RENDER
 *
 * The screenshot with every leaf outlined. This image is the review gate for the
 * whole tool: if the cuts are wrong here, nothing downstream is worth building, and
 * no invariant can tell you they are wrong — only an eye can.
 *
 *   node tools/audit/segment.mjs <outDir> [--depth=4]   (calls this internally)
 *
 * SVG over the PNG rather than pixel-pushing, because sharp composites SVG directly
 * and it keeps the outlines crisp at any size. The limitation worth knowing: labels
 * are drawn at (x+6, y+18) with no collision avoidance, so a leaf shorter than ~18px
 * gets a clipped or overlapping index number. That is a labelling nuisance, not a
 * segmentation bug — the rect itself is still drawn correctly.
 */
import sharp from 'sharp';
import {leaves} from './blocks.mjs';

export async function renderDebug(pngPath, root, outPath) {
    const {width, height} = await sharp(pngPath).metadata();
    const rects = leaves(root)
        .map((b, i) =>
            `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" `
            + `fill="none" stroke="#e02e1a" stroke-width="2"/>`
            + `<text x="${b.x + 6}" y="${b.y + 18}" font-family="monospace" font-size="13" `
            + `fill="#e02e1a">${i}</text>`,
        )
        .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`;

    await sharp(pngPath)
        .composite([{input: Buffer.from(svg), top: 0, left: 0}])
        .toFile(outPath);
}
