/**
 * CAPTURE (phase 1)
 *
 * Load a URL at a fixed 1440×900, make lazy content load, and write the two
 * screenshots plus the DOM rects that phase 2 is checked against.
 *
 *   node tools/audit/capture.mjs <url> [outDir]
 *
 * The limitation worth knowing: THIS BROWSER CANNOT DRAW EVERYTHING A VISITOR SEES, and
 * it does not always fail loudly.
 *
 * Two separate causes, both of which produce a page that loads perfectly and is missing
 * a region:
 *
 *   - prefers-reduced-motion is forced, because a carousel or an entrance animation
 *     makes the capture non-deterministic and phase 2 has to be deterministic. Content
 *     gated behind that query is therefore absent — and it is NOT true, as this comment
 *     used to claim, that the resting state is "what most visitors see": most visitors
 *     do not have reduced motion set, so they get the thing we skipped.
 *   - There is no GPU, so WebGL falls back to SwiftShader, and sites that check for
 *     that decline to render rather than push a heavy scene through a software
 *     rasteriser. See lib/webgl.mjs — `meta.webgl` records it so the report can decline
 *     to answer for that region instead of measuring a hole as empty space.
 *
 * Neither is a bug to fix here. Both are conditions to declare.
 */
import {chromium} from 'playwright';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {dismissConsent} from './consent.mjs';
import {WEBGL_PROBE_INIT, probeWebgl} from './webgl.mjs';
import {COLLECT_FIXED, heightGap} from './unrendered.mjs';

export const VIEWPORT = {width: 1440, height: 900};

/**
 * How tall the page is, measured the way the screenshot measures it. Runs IN the page.
 *
 * `document.body.scrollHeight` is NOT the page height and was used here for all three of
 * "how far is there left to scroll", "how tall is the page" and the denominator of the
 * unmeasured-region check. On example.com it says 96 while the full-page screenshot is
 * 900 tall; on the standard app-shell homepage — `html, body { height: 100% }` with an
 * inner scrolling div — it says one viewport whatever the content, so the scroll loop
 * concluded it was already at the bottom on its first pass and no lazy content ever
 * loaded. No warning, exit 0: the silent kind of wrong.
 *
 * The larger of the two is what Chromium's fullPage screenshot uses, so this is the
 * number the image phase 2 divides by actually has.
 */
export const PAGE_HEIGHT = () => Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0,
);

/**
 * A PNG's own pixel dimensions, straight out of its IHDR header.
 *
 * Read so that meta can carry the image's height beside the page's. They should agree;
 * when they do not, the screenshot was truncated (Chromium has a limit, and a page can
 * grow between the measure and the shot) and every percentage phase 2 produces is of a
 * prefix of the page. That was previously undetectable after the browser had closed.
 */
export function pngSize(buffer) {
    // 8-byte signature, then the IHDR chunk: 4-byte length, the type, width, height.
    if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
        throw new Error('not a PNG: no IHDR where one must be');
    }

    return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

/** Collect rects for every visible element. Runs IN the page. */
const COLLECT_RECTS = () => {
    const out = [];

    // Fully clipped by an ancestor's overflow — an off-screen carousel slide, a
    // collapsed accordion panel with height:0 on the wrapper. The element itself
    // reports a perfectly normal rect, so only walking up catches it.
    const clipped = (el) => {
        const r = el.getBoundingClientRect();
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
            const ar = a.getBoundingClientRect();
            if (r.right <= ar.left || r.left >= ar.right || r.bottom <= ar.top || r.top >= ar.bottom) return true;
        }

        return false;
    };

    // Does this element draw its own box? A card is a box; the section it sits in is
    // not, even though the section also has a background — what makes the card a module
    // is that its background DIFFERS from its parent's, or that it has a border or a
    // radius of its own. Comparing against the parent is the whole trick: without it,
    // every sectioned page reads as one enormous container.
    const boxed = (el, cs) => {
        const own = cs.backgroundColor;
        const parent = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : '';
        const transparent = (c) => !c || c === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(c);
        if (!transparent(own) && own !== parent) return true;
        if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) return true;

        return parseFloat(cs.borderTopLeftRadius) > 0;
    };

    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (clipped(el)) continue;
        out.push({
            x: Math.round(r.x + window.scrollX),
            y: Math.round(r.y + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
            tag: el.tagName.toLowerCase(),
            // Only the raw signal. Deciding WHICH boxes are modules means comparing them
            // against each other, which belongs in segmentation where it is testable.
            // Deciding it here meant guessing a pixel floor for "contains another box",
            // and a 48px avatar inside a testimonial card was enough to disqualify the
            // card — the exact module the cut was supposed to protect.
            boxed: boxed(el, cs),
            text: (el.textContent || '').trim().slice(0, 200),
        });
    }

    return out;
};

export async function capturePage(url, outDir, opts = {}) {
    const maxScrolls = opts.maxScrolls ?? 40;
    mkdirSync(outDir, {recursive: true});

    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
            reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        // Before the page's own scripts, so a hero that asks for a context on first
        // evaluation is still recorded.
        await page.addInitScript(WEBGL_PROBE_INIT);
        await page.goto(url, {waitUntil: 'load', timeout: 45000});
        await page.waitForLoadState('networkidle', {timeout: 20000}).catch(() => {});

        const consent = await dismissConsent(page);

        // Step down a viewport at a time so lazy images and in-view animations fire.
        let scrolls = 0;
        let previousHeight = -1;
        for (; scrolls < maxScrolls; scrolls++) {
            const height = await page.evaluate(PAGE_HEIGHT);
            const atBottom = await page.evaluate(
                (h) => window.scrollY + window.innerHeight >= h - 2,
                height,
            );
            if (atBottom && height === previousHeight) break;
            previousHeight = height;
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await page.waitForTimeout(400);
        }
        const scrollCapHit = scrolls >= maxScrolls;

        // AT THE BOTTOM, before scrolling back: a reveal footer is only in its resting
        // place once the content has travelled over it.
        const fixed = await page.evaluate(COLLECT_FIXED);

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(400);

        await page.screenshot({path: join(outDir, 'viewport.png')});
        const shot = await page.screenshot({path: join(outDir, 'fullpage.png'), fullPage: true});

        const rects = await page.evaluate(COLLECT_RECTS);
        const fullHeight = await page.evaluate(PAGE_HEIGHT);
        const image = pngSize(shot);
        const webgl = await probeWebgl(page);

        const meta = {
            url,
            // THE PAGE WE ACTUALLY MEASURED, which is not always the one we asked for: a
            // site can redirect, and a click during consent dismissal used to be able to
            // walk the capture onto another page entirely with nothing recording it.
            // Kept separate from `url` so the two can be compared rather than conflated.
            capturedUrl: page.url(),
            capturedAt: new Date().toISOString(),
            viewport: VIEWPORT,
            fullHeight,
            image,
            consentDismissed: consent.dismissed,
            consentBannerSeen: consent.bannerSeen === true,
            consentVia: consent.via,
            consentNavigatedAway: consent.navigatedAway === true,
            scrollCapHit,
            webgl,
            fixed,
            heightGap: heightGap(fullHeight, rects, fixed),
        };
        writeFileSync(join(outDir, 'rects.json'), JSON.stringify(rects, null, 1));
        writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));

        return meta;
    } finally {
        await browser.close();
    }
}
