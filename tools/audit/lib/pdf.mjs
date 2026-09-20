/**
 * PDF
 *
 * The audit, as a file a prospect can open and forward.
 *
 *   node tools/audit/pdf.mjs <outDir> [--out=report.pdf]
 *
 * THE TEMPLATE IS A STUB AND IS MEANT TO BE REPLACED. What is built here is the pipeline —
 * numbers in, paginated file out — so the queue job has something real to call while the
 * report is still being designed. Everything about how it LOOKS belongs to whoever designs
 * it; everything about what it CONTAINS is in `reportData`, and that is the seam.
 *
 * CHROMIUM PRINTS IT, because the capture already depends on Playwright and the browser is
 * already installed. No LaTeX, no wkhtmltopdf, no second rendering engine to keep alive.
 *
 * THE ANNOTATED PAGE IS SLICED, and this is the part that is not obvious. A homepage
 * screenshot is thousands of pixels tall — jersey.com is 16,368 and visionarygrid.studio
 * 24,746 — and CSS cannot break an image across pages: it either overflows and is cut, or
 * shrinks to illegibility. So the image is scaled to the page width and cut into
 * page-height slices, one per printed page, which is the only way the blocks stay readable.
 *
 * AND IT IS COMPRESSED FIRST. Those debug images run to 14.7MB as PNG, 101MB across the
 * 27-site corpus. At the printed width, as JPEG, jersey.com is 889KB and hsbc.co.uk 213KB —
 * small enough that the finished PDF attaches to an email rather than needing a download.
 *
 * The limitation worth knowing: a very tall page makes a long PDF. visionarygrid.studio is
 * twelve pages of screenshot. Whether that is a feature (here is your whole homepage) or a
 * fault (nobody reads twelve pages) is a judgement about the report, so `maxImagePages`
 * exists and nothing here decides what it should be.
 */
import {chromium} from 'playwright';
import sharp from 'sharp';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {leaves} from './blocks.mjs';
import {surfaceArea} from './surface.mjs';
import {noteCodes} from './notes.mjs';
import {bytesSummary} from './bytes.mjs';
import {clusterColours, SAME_COLOUR_DE} from './styles.mjs';

/** A4 at 96dpi, less a 12mm margin: the box an image has to fit inside. */
export const PAGE = {width: 794, height: 1123, margin: 45};

/** Quality that keeps a block label readable at printed width without the file bloating. */
export const IMAGE_QUALITY = 78;

/** Past this the report is mostly screenshot. Not a judgement — a ceiling. */
export const MAX_IMAGE_PAGES = 12;

/**
 * Everything the template is allowed to know, read from an audit directory.
 *
 * THE SEAM BETWEEN MEASUREMENT AND PRESENTATION. A template gets this and nothing else, so
 * a redesign cannot change what was measured and a new measurement cannot be forgotten by
 * a template — it either appears here or it does not exist to the report.
 */
export function reportData(outDir, viewportHeight = 900) {
    const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
    const {notes, tree} = JSON.parse(readFileSync(join(outDir, 'blocks.json'), 'utf8'));
    const {full, firstViewport, coverage} = surfaceArea(tree, meta.viewport?.height ?? viewportHeight);
    const fold = (category) => firstViewport.find((f) => f.category === category)?.share ?? null;

    return {
        url: meta.url,
        capturedUrl: meta.capturedUrl,
        capturedAt: meta.capturedAt,
        width: meta.image.width,
        height: meta.image.height,
        blocks: leaves(tree).length,
        coverage,
        categories: full.map((s) => ({...s, firstViewport: fold(s.category)})),
        // NULL AND NOT UNDEFINED, because this record is serialised: `undefined` drops out
        // of JSON entirely, so a consumer cannot tell "we did not measure it" from "the
        // field was never there". An absence has to survive the wire to be an absence.
        speed: meta.psi && !meta.psi.error ? meta.psi : null,
        weight: meta.bytes?.measured ? meta.bytes : null,
        weightSummary: bytesSummary(meta.bytes),
        // The styles as measured, plus the one thing that is a judgement rather than a
        // measurement: which of those colours a person would call the same colour. Derived
        // HERE and not at capture time, so the threshold can move without re-photographing
        // a page whose colours have not.
        styles: meta.styles?.measured ? withColourGroups(meta.styles) : null,
        // The honesty layer, verbatim. A report that drops these is not this tool's report.
        caveats: Object.values(notes?.conditions ?? {}).map((c) => ({effect: c.effect, message: c.message})),
        noteCodes: noteCodes(notes),
    };
}

/**
 * The measured styles with the colour grouping added.
 *
 * A group asserts that a person could not tell its members apart, so it is complete-link:
 * every pair inside it is within the threshold, not merely some path through it. See
 * clusterColours, and the kohde.agency case that proves why the difference matters.
 */
export function withColourGroups(styles, limit = SAME_COLOUR_DE) {
    const palette = styles.colours?.palette ?? [];

    return {
        ...styles,
        colours: {
            ...styles.colours,
            sameColour: clusterColours(palette, limit)
                .filter((g) => g.length > 1)
                .map((g) => g.map((c) => c.colour)),
            deltaE: limit,
        },
    };
}

/**
 * The annotated page, scaled to the printed width and cut into page-height slices.
 *
 * Returns data URIs, one per printed page, because a data URI has no path to get wrong and
 * no second file for the PDF to fail to find.
 */
export async function sliceAnnotated(png, maxPages = MAX_IMAGE_PAGES) {
    const box = {width: PAGE.width - PAGE.margin * 2, height: PAGE.height - PAGE.margin * 2};
    const meta = await sharp(png).metadata();
    const scaled = await sharp(png).resize({width: box.width}).jpeg({quality: IMAGE_QUALITY}).toBuffer();
    const size = await sharp(scaled).metadata();

    const slices = [];
    for (let top = 0; top < size.height && slices.length < maxPages; top += box.height) {
        const height = Math.min(box.height, size.height - top);
        // eslint-disable-next-line no-await-in-loop
        const part = await sharp(scaled)
            .extract({left: 0, top, width: size.width, height})
            .jpeg({quality: IMAGE_QUALITY})
            .toBuffer();
        slices.push({uri: `data:image/jpeg;base64,${part.toString('base64')}`, height});
    }

    return {
        slices,
        pages: Math.ceil(size.height / box.height),
        truncated: Math.ceil(size.height / box.height) > maxPages,
        source: {width: meta.width, height: meta.height},
    };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const pct = (n) => (typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : '—');

/**
 * The stub template. DELIBERATELY PLAIN — see the header.
 *
 * It exists to prove the pipeline and to be thrown away. The one thing worth keeping
 * whatever replaces it: the caveats are printed, and they are printed whole.
 */
export function stubTemplate(data, image) {
    const rows = data.categories.map((c) => `<tr>
        <td>${esc(c.category)}</td>
        <td class="n">${pct(c.share)}</td>
        <td class="n">${pct(c.coverage)}</td>
        <td class="n">${c.firstViewport === null ? '—' : pct(c.firstViewport)}</td>
    </tr>`).join('');

    const caveats = data.caveats.length
        ? `<section class="caveats"><h2>What this does not cover</h2><ul>${
            data.caveats.map((c) => `<li><b>${esc(c.effect)}</b> ${esc(c.message)}</li>`).join('')
        }</ul></section>`
        : '';

    const pages = image.slices.map((s) => `<section class="shot"><img src="${s.uri}" alt=""></section>`).join('');

    return `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { size: A4; margin: ${PAGE.margin}px; }
        * { box-sizing: border-box; }
        body { font: 11px/1.5 -apple-system, system-ui, sans-serif; color: #111; margin: 0; }
        h1 { font-size: 20px; margin: 0 0 2px; }
        h2 { font-size: 13px; margin: 24px 0 8px; }
        .meta { color: #666; margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; }
        th { text-align: left; font-weight: 600; border-bottom: 1px solid #111; padding: 4px 0; }
        td { padding: 4px 0; border-bottom: 1px solid #eee; }
        .n { text-align: right; font-variant-numeric: tabular-nums; }
        .facts { margin: 20px 0; color: #333; }
        .facts div { padding: 2px 0; }
        .caveats { margin-top: 24px; padding: 12px; background: #f6f6f6; }
        .caveats li { margin-bottom: 6px; }
        .shot { break-before: page; }
        .shot img { display: block; width: 100%; }
    </style></head><body>
        <h1>${esc(data.url)}</h1>
        <div class="meta">${data.width}&times;${data.height}px &middot; ${data.blocks} blocks &middot;
            ${pct(data.coverage)} of it drawn on &middot; captured ${esc(String(data.capturedAt).slice(0, 10))}</div>
        <table>
            <thead><tr><th>&nbsp;</th><th class="n">share of page</th>
                <th class="n">content to space</th><th class="n">first viewport</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <div class="facts">
            ${data.weightSummary ? `<div>${esc(data.weightSummary)}</div>` : ''}
            ${data.speed ? `<div>PageSpeed ${data.speed.score}/100 desktop &middot;
                LCP ${data.speed.lab.lcpMs}ms &middot; TBT ${data.speed.lab.tbtMs}ms</div>` : ''}
            ${data.styles ? `<div>${data.styles.colours.total} colours &middot;
                ${data.styles.fonts.loaded} font faces loaded of ${data.styles.fonts.declared} declared &middot;
                ${data.styles.fonts.rendered.length} rendered</div>` : ''}
        </div>
        ${caveats}
        ${pages}
    </body></html>`;
}

/**
 * Render an audit directory to a PDF. Returns what was written and how big it is.
 *
 * `template` is swapped for the real one when it exists; the signature is
 * `(data, image) => html` and nothing else, so a designer needs no part of this file.
 */
export async function renderPdf(outDir, opts = {}) {
    const out = opts.out ?? join(outDir, 'report.pdf');
    const png = opts.annotated ?? join(outDir, 'debug.png');
    if (!existsSync(png)) {
        throw new Error(`no annotated image at ${png} — has analyse.mjs run?`);
    }
    const data = reportData(outDir);
    const image = await sliceAnnotated(png, opts.maxImagePages ?? MAX_IMAGE_PAGES);
    const html = (opts.template ?? stubTemplate)(data, image);

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        // `domcontentloaded` and not `networkidle`: every image is a data URI, so there is
        // no network to go idle and waiting for it is waiting for a timeout.
        await page.setContent(html, {waitUntil: 'domcontentloaded'});
        await page.pdf({path: out, format: 'A4', printBackground: true, preferCSSPageSize: true});
    } finally {
        await browser.close();
    }

    return {
        path: out,
        bytes: readFileSync(out).length,
        imagePages: image.slices.length,
        imagePagesAvailable: image.pages,
        truncated: image.truncated,
        data,
    };
}
