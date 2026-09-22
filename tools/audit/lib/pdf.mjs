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
import {CATEGORY_ORDER, surfaceArea} from './surface.mjs';
import {titleCase} from './debug.mjs';
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
/**
 * THE TECHNICAL SCORE, AND IT IS OURS RATHER THAN GOOGLE'S.
 *
 * The speed score on this report is PageSpeed divided by ten: a reader who disputes it is
 * disputing Google. This one is not like that, and the report has to be built knowing the
 * difference, because the two sit inches apart and will be read as equals.
 *
 * WEIGHT ON A LOG CURVE, because the linear version makes 4.6MB and 9.2MB both just "bad"
 * and stops discriminating exactly where pages get interesting. On this curve doubling a
 * page's weight always costs the same 2.5 points, wherever it started: at the median it
 * scores 10, at twice the median 5, at four times it 0.
 *
 * DEFERRAL IS THE OTHER FORTY PER CENT, because weight alone cannot tell apart two pages
 * of the same size where one makes a visitor who reads the first screen pay for all of it.
 * Full marks at 40% deferred, which is roughly what a page doing ordinary lazy loading
 * manages; kohde.agency defers 31%, atkinsonsca.co.uk defers nothing.
 *
 * THE SHORT-PAGE GUARD IS NOT OPTIONAL. A page barely taller than the viewport has nothing
 * below the fold to defer, so nought per cent deferred is the correct answer rather than a
 * fault, and it takes full marks. Without it whitepaper.co.uk — 0.2MB, and about as light
 * as a page gets — scored 6.
 *
 * The split and the target are judgement, not measurement. They are constants so that
 * moving them is one edit and a test failure rather than a hunt.
 */
export const MEDIAN_PAGE_MB = 2.3;
export const DEFERRAL_TARGET = 0.4;
export const WEIGHT_SHARE = 0.6;
export const SHORT_PAGE_VIEWPORTS = 2;

const clamp10 = (n) => Math.max(0, Math.min(10, n));

export function technicalScore(weight, pageHeight, viewportHeight = 900) {
    if (!weight?.measured || !weight.afterScroll?.bytes) {
        return null;
    }
    const median = MEDIAN_PAGE_MB * 1048576;
    const total = weight.afterScroll.bytes;
    const deferred = 1 - (weight.atLoad?.bytes ?? total) / total;
    const shortPage = pageHeight < viewportHeight * SHORT_PAGE_VIEWPORTS;

    const weightScore = clamp10(10 * (1 - Math.log2(total / median) / 2));
    const deferScore = shortPage ? 10 : clamp10(10 * (deferred / DEFERRAL_TARGET));

    return {
        score: Number((weightScore * WEIGHT_SHARE + deferScore * (1 - WEIGHT_SHARE)).toFixed(1)),
        weightScore: Number(weightScore.toFixed(1)),
        deferScore: Number(deferScore.toFixed(1)),
        deferred,
        shortPage,
        medianMb: MEDIAN_PAGE_MB,
    };
}

/**
 * THE BRAND SCORE, WHICH IS REALLY A CONSISTENCY SCORE.
 *
 * MOST BRAND SIGNALS ARE TASTE AND CANNOT BE SCORED. Eleven colours is not worse than six,
 * and two typefaces is not worse than one — those are choices, and a number claiming
 * otherwise would assert a judgement the measurement cannot support. That mistake has been
 * made on this report once already, in a column that called a decorative photograph ten
 * times more "content" than an article.
 *
 * A DUPLICATE IS NEVER A CHOICE. Two colours within dE 2.3 in CIELAB are two colours a
 * person cannot tell apart, so a page carrying both is carrying a design token that was
 * entered twice: visionarygrid.studio declares its brand yellow as rgb(255,211,0) and
 * rgb(255,210,2), jersey.com paints three near-blacks a point apart. Nobody decided that,
 * which is exactly why it can be scored.
 *
 * AREA WAS TRIED AND REJECTED. The first version scored "stray" colours — those outside the
 * smallest set covering 99% of the painted colour. whitepaper.co.uk killed it: its brand
 * red covers 0.54% of the page, because a button is small, and the score marked the most
 * deliberate colour on the page as a leftover. Area cannot tell an accent from an accident.
 *
 * The penalty is judgement, not measurement, so it is a constant and has a test.
 */
export const DUPLICATE_PENALTY = 2;

export function brandScore(styles) {
    const colours = styles?.colours;
    if (!colours?.palette?.length || !Array.isArray(colours.sameColour)) {
        return null;
    }
    const groups = colours.sameColour.length;

    return {
        score: Number(Math.max(0, 10 - DUPLICATE_PENALTY * groups).toFixed(1)),
        groups,
        colours: colours.sameColour.reduce((sum, g) => sum + g.length, 0),
        deltaE: colours.deltaE,
    };
}

/**
 * BELOW THIS, SAY SO. The model returns a confidence per block and it was measured and
 * thrown away. kohde.agency block 4 is a case study card on a large graphic; the model read
 * the tagline as the company's own voice, called it `explainer`, and scored itself 0.6 —
 * the lowest on that page, against 0.72 for a more obvious case study card higher up. It
 * knew. Nothing in the report said so, and it took cropping the screenshot to find.
 *
 * HIGHER THAN notes.mjs's LOW_CONFIDENCE OF 0.5, deliberately, because these are different
 * questions. That one asks whether a block should be reported as `unclassified` at all;
 * this one asks whether a reader should look at the picture before believing the label.
 * At 0.7 the only block flagged on kohde is the one that was wrong.
 */
export const UNSURE = 0.7;

/** The measured rows, plus a nought row for every category this page spends nothing on. */
export function withEmptyCategories(rows) {
    const present = new Set(rows.map((r) => r.category));
    const empty = CATEGORY_ORDER
        .filter((c) => c !== 'unclassified' && !present.has(c))
        .map((category) => ({category, area: 0, share: 0, coverage: null, firstViewport: null, blocks: []}));

    // Nought rows sit above `unclassified`, which stays last: a refusal to label is not a
    // category and must never read as the page's smallest feature.
    return [
        ...rows.filter((r) => r.category !== 'unclassified'),
        ...empty,
        ...rows.filter((r) => r.category === 'unclassified'),
    ];
}

export function reportData(outDir, viewportHeight = 900) {
    const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
    const {notes, tree} = JSON.parse(readFileSync(join(outDir, 'blocks.json'), 'utf8'));
    const {full, firstViewport, coverage} = surfaceArea(tree, meta.viewport?.height ?? viewportHeight);
    const fold = (category) => firstViewport.find((f) => f.category === category)?.share ?? null;
    // Grouped once: the brand score is a judgement ABOUT the grouping, so it must see the
    // same one the template prints rather than deriving its own.
    const grouped = meta.styles?.measured ? withColourGroups(meta.styles) : null;

    // THE NUMBER IS THE ONE DRAWN ON THE SCREENSHOT. lib/debug.mjs labels each block with
    // its index in leaves() order, so a reader can read "4" in the table and find 4 on the
    // image. If either stops using leaves() order the table starts pointing at the wrong
    // section, which is worse than not pointing at all.
    const blocksByCategory = new Map();
    leaves(tree).forEach((l, n) => {
        const key = l.label?.category ?? 'unclassified';
        const held = blocksByCategory.get(key) ?? [];
        const confidence = l.label?.confidence ?? null;
        held.push({n, what: titleCase(l.label?.what ?? null), y: l.y, h: l.h, confidence,
            unsure: confidence !== null && confidence < UNSURE});
        blocksByCategory.set(key, held);
    });

    return {
        url: meta.url,
        capturedUrl: meta.capturedUrl,
        capturedAt: meta.capturedAt,
        width: meta.image.width,
        height: meta.image.height,
        blocks: leaves(tree).length,
        coverage,
        // EVERY CATEGORY, INCLUDING THE ONES WORTH NOTHING. An absent row reads as a
        // category we did not check; a row at 0.0% reads as a page that spends nothing on
        // it, and that is frequently the finding — atkinsonsca.co.uk gives no space at all
        // to `trust`, which for an accountancy firm is worth saying out loud.
        //
        // `unclassified` is the exception and is only ever shown when it happened. It is
        // not a category, it is the model declining to guess, and "unclassified 0.0%" tells
        // a reader nothing about their homepage.
        categories: withEmptyCategories(full.map((s) => ({
            ...s,
            firstViewport: fold(s.category),
            blocks: blocksByCategory.get(s.category) ?? [],
        }))),
        // NULL AND NOT UNDEFINED, because this record is serialised: `undefined` drops out
        // of JSON entirely, so a consumer cannot tell "we did not measure it" from "the
        // field was never there". An absence has to survive the wire to be an absence.
        speed: meta.psi && !meta.psi.error ? meta.psi : null,
        weight: meta.bytes?.measured ? meta.bytes : null,
        weightSummary: bytesSummary(meta.bytes),
        // A judgement at a threshold, derived here for the same reason the colour grouping
        // is: moving the bands must not mean re-photographing a page that has not changed.
        technical: technicalScore(meta.bytes, meta.image.height, meta.viewport?.height ?? viewportHeight),
        // The styles as measured, plus the one thing that is a judgement rather than a
        // measurement: which of those colours a person would call the same colour. Derived
        // HERE and not at capture time, so the threshold can move without re-photographing
        // a page whose colours have not.
        styles: grouped,
        brand: brandScore(grouped),
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
    if (!opts.url && !existsSync(png)) {
        throw new Error(`no annotated image at ${png} — has analyse.mjs run?`);
    }
    const data = reportData(outDir);
    // WITH A URL, THE DOCUMENT IS CRAFT'S. The Twig template at _views/report/audit does its
    // own pagination and fetches the annotated image through a signed controller action, so
    // there is nothing to slice here and nothing to hand it. Without one this falls back to
    // the stub, which is what the tool prints when it is run outside Craft.
    const image = opts.url ? null : await sliceAnnotated(png, opts.maxImagePages ?? MAX_IMAGE_PAGES);
    const html = opts.url ? null : (opts.template ?? stubTemplate)(data, image);

    const browser = await chromium.launch();
    try {
        // `ignoreHTTPSErrors` FOR OUR OWN SITE, because in local development the certificate
        // is self-signed and the printer refuses it: the fonts came back
        // ERR_CERT_AUTHORITY_INVALID and the PDF printed in a fallback face, looking close
        // enough that nobody noticed. The only thing being fetched is this application.
        const context = await browser.newContext({ignoreHTTPSErrors: true});
        const page = await context.newPage();
        if (opts.url) {
            // `networkidle` HERE, because Craft's version fetches the annotated screenshot
            // over HTTP and printing before it lands gives a report with a blank page in it.
            const res = await page.goto(opts.url, {waitUntil: 'networkidle', timeout: 60000});
            if (!res || !res.ok()) {
                throw new Error(`the report page answered ${res ? res.status() : 'nothing'}`);
            }
        } else {
            // `domcontentloaded` and not `networkidle`: every image in the stub is a data
            // URI, so there is no network to go idle and waiting for it is waiting for a
            // timeout.
            await page.setContent(html, {waitUntil: 'domcontentloaded'});
        }
        // A RUNNING HEAD ON EVERY PAGE, through Chromium's own header/footer rather than
        // CSS: `@page { @top-center }` is in the spec and Chromium does not implement it,
        // so this is the only way to get one into the PDF.
        //
        // THE TEMPLATE IS ITS OWN LITTLE DOCUMENT. It does not inherit the report's
        // stylesheet, its fonts or its colours, so everything it needs is inline and it
        // falls back to a system mono rather than silently printing in Times. The classes
        // `pageNumber` and `totalPages` are Chromium's and are substituted by the printer.
        //
        // WHOSE REPORT THIS IS, not whose site it is about. The audited URL is already the
        // title at the top of page one; a reader who has printed this and put it down needs
        // to know where it came from. Craft passes its own site URL, so this is right on any
        // install rather than a name written into a general-purpose tool.
        //
        // It draws inside the @page top margin, which PAGE.margin has to stay in step with;
        // 45px is enough room for one 8px line and the space below it.
        // A DATA URI AND NOT A PATH. The footer template is its own document and is not
        // resolved against the page's origin, so `<img src="/…">` fetches nothing and fails
        // silently — the same way the screenshot did. Inlined, there is nothing to fetch.
        const mark = opts.logo && existsSync(opts.logo)
            ? `<img src="data:image/svg+xml;base64,${readFileSync(opts.logo).toString('base64')}"`
                + ` style="height:11px;width:11px;margin-right:6px;display:block;`
                + `position:relative;top:-1px;">`
            : '';
        const bar = `<div style="width:100%;margin:0 45px;font-size:8px;color:#8a8a8a;`
            + `font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;`
            + `display:flex;align-items:center;justify-content:space-between;">`
            // `line-height:1` IS WHAT CENTRES IT. `align-items:center` centres the mark on
            // the LINE BOX, and a line box is taller than its glyphs — it carries room for
            // ascenders and descenders the address never uses — so the mark sat visibly
            // above the text. Collapsed to the text's own height, the two agree.
            //
            // The last pixel is the `top:-1px` on the mark, and it was measured rather than
            // eyeballed: rendered at 3x and read off the dark-pixel extents, the mark's
            // centre sat 3px below the text's, which is one pixel on the page.
            + `<span style="display:flex;align-items:center;line-height:1;">${mark}`
            + `${esc(opts.from || data.url)}</span>`
            + `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>`
            + `</div>`;
        await page.pdf({
            path: out,
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: bar,
            // An empty span, not nothing: left out entirely, Chromium prints its own
            // default footer — the source URL and the date — along the bottom of each page.
            footerTemplate: '<span></span>',
        });
    } finally {
        await browser.close();
    }

    return {
        path: out,
        bytes: readFileSync(out).length,
        // Null and not nought when Craft printed it: the template paginated the screenshot
        // itself and this function never counted the sheets, which is not the same as there
        // being none of them.
        imagePages: image ? image.slices.length : null,
        imagePagesAvailable: image ? image.pages : null,
        truncated: image ? image.truncated : null,
        data,
    };
}
