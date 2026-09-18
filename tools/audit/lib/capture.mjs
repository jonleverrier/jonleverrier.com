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
        // Before the page's own scripts, so a hero that asks for a context on first
        // evaluation is still recorded.
        await page.addInitScript(WEBGL_PROBE_INIT);
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
        const webgl = await probeWebgl(page);

        const meta = {
            url,
            capturedAt: new Date().toISOString(),
            viewport: VIEWPORT,
            fullHeight,
            consentDismissed,
            scrollCapHit,
            webgl,
        };
        writeFileSync(join(outDir, 'rects.json'), JSON.stringify(rects, null, 1));
        writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));

        return meta;
    } finally {
        await browser.close();
    }
}
