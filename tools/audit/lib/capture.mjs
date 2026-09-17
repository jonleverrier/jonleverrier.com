/**
 * CAPTURE (phase 1)
 *
 * Load a URL at a fixed 1440×900, make lazy content load, and write the two
 * screenshots plus the DOM rects that phase 2 is checked against.
 *
 *   node tools/audit/capture.mjs <url> [outDir]
 *
 * The limitation worth knowing: prefers-reduced-motion is forced, because a carousel
 * or an entrance animation makes the capture non-deterministic and phase 2 is
 * required to be deterministic. A site whose hero only exists mid-animation will
 * therefore capture as its resting state, which is the state most visitors see.
 */
import {chromium} from 'playwright';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {dismissConsent} from './consent.mjs';

export const VIEWPORT = {width: 1440, height: 900};

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
        await page.goto(url, {waitUntil: 'load', timeout: 45000});
        await page.waitForLoadState('networkidle', {timeout: 20000}).catch(() => {});

        const consentDismissed = await dismissConsent(page);

        // Step down a viewport at a time so lazy images and in-view animations fire.
        let scrolls = 0;
        let previousHeight = -1;
        for (; scrolls < maxScrolls; scrolls++) {
            const height = await page.evaluate(() => document.body.scrollHeight);
            const atBottom = await page.evaluate(
                () => window.scrollY + window.innerHeight >= document.body.scrollHeight - 2,
            );
            if (atBottom && height === previousHeight) break;
            previousHeight = height;
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await page.waitForTimeout(400);
        }
        const scrollCapHit = scrolls >= maxScrolls;

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(400);

        await page.screenshot({path: join(outDir, 'viewport.png')});
        await page.screenshot({path: join(outDir, 'fullpage.png'), fullPage: true});

        const rects = await page.evaluate(COLLECT_RECTS);
        const fullHeight = await page.evaluate(() => document.body.scrollHeight);

        const meta = {
            url,
            capturedAt: new Date().toISOString(),
            viewport: VIEWPORT,
            fullHeight,
            consentDismissed,
            scrollCapHit,
        };
        writeFileSync(join(outDir, 'rects.json'), JSON.stringify(rects, null, 1));
        writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));

        return meta;
    } finally {
        await browser.close();
    }
}
