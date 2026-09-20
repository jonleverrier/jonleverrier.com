#!/usr/bin/env node
/**
 * PHASE 1 — CAPTURE
 *
 *   node tools/audit/capture.mjs <url> [outDir=/tmp/audit]
 *
 * Writes viewport.png, fullpage.png, meta.json and rects.json into outDir.
 * outDir defaults OUTSIDE the repo: nothing under tools/ is gitignored, and a
 * full-page screenshot of a commercial homepage is several megabytes.
 */
import {capturePage} from './lib/capture.mjs';
import {RENDERER_MAX, webglWarning} from './lib/webgl.mjs';
import {shotTruncationWarning, unrenderedWarning, paintLimitWarning} from './lib/unrendered.mjs';
import {printable} from './lib/printable.mjs';
import {sameUrl} from './lib/sameurl.mjs';

/**
 * The page we ended on is not the page we asked for. Never a footnote.
 *
 * Both URLs are printable(): `capturedUrl` is wherever the page sent us, `url` is
 * whatever a stranger submitted, and this line is read in a terminal. The comparison
 * is made on the RAW values first — a sanitised URL must never be able to match one
 * that differs only in a character this strips.
 *
 * TWO EVENTS, ONE FACE, and `landedUrl` is what tells them apart: the site redirected us
 * at load, or something during the capture moved the page. Both are worth saying, because
 * either way the percentages belong to the URL at the end and not the one submitted. Only
 * one of them means the measurement is of something nobody asked to measure. See
 * lib/notes.mjs, which carries the same distinction in a shape a report can branch on.
 */
const wrongPageWarning = (meta) => {
    if (!meta.capturedUrl || sameUrl(meta.capturedUrl, meta.url)) {
        return null;
    }
    const attribution = `Every artefact in this directory is of that page, so any percentage`
        + ' from it belongs to that page too';
    if (meta.landedUrl && sameUrl(meta.capturedUrl, meta.landedUrl)) {
        return `${printable(meta.url)} redirects to ${printable(meta.capturedUrl)} — which is the homepage a`
            + ` visitor typing the requested address would land on. ${attribution}`;
    }

    return `the capture ended on ${printable(meta.capturedUrl)}, not ${printable(meta.url)}, and the page was`
        + ` still on ${printable(meta.landedUrl ?? 'the requested address')} when it finished loading — so`
        + ` something during the capture moved it. ${attribution}`;
};

const url = process.argv[2];
const outDir = process.argv[3] || '/tmp/audit';
if (!url) {
    console.error('usage: node tools/audit/capture.mjs <url> [outDir]');
    process.exit(1);
}

process.stderr.write(`capturing ${printable(url)}\n`);
try {
    const meta = await capturePage(url, outDir);
    // Everything below that is not a number came from the page or from the URL a
    // stranger submitted, so all of it goes through printable() on the way out. See
    // lib/printable.mjs: an ESC here is an ANSI sequence and a newline forges a line.
    console.log(`url          ${printable(meta.url)}`);
    // A redirect the SITE performed is not the alarm; a page that moved after it loaded is.
    // See lib/notes.mjs for why the two used to read the same.
    const landedHere = meta.landedUrl && sameUrl(meta.capturedUrl, meta.landedUrl);
    const moved = sameUrl(meta.capturedUrl, meta.url)
        ? ''
        : landedHere ? '   <-- redirected here by the site' : '   <-- NOT THE URL REQUESTED';
    console.log(`captured     ${printable(meta.capturedUrl)}${moved}`);
    const ok = meta.httpStatus === null || (meta.httpStatus >= 200 && meta.httpStatus < 300);
    console.log(`http         ${meta.httpStatus ?? 'no response (same-document)'}${ok ? '' : '   <-- NOT A PAGE'}`);
    console.log(`full height  ${meta.fullHeight}px`);
    console.log(`image        ${meta.image.width}x${meta.image.height}`);
    // WHICH CAPTURE PATH RAN, because the two produce visibly different images of the
    // same page and a silent fallback would look like the page having changed.
    const c = meta.capture ?? {};
    console.log(`capture      ${c.mode === 'stitched'
        ? `${c.slices} stitched slices of ${c.viewportHeight}px`
        : `ONE FULL-PAGE SHOT — slicing failed: ${printable(c.fallbackReason ?? 'no reason recorded', 200)}`}`);
    console.log(`rects        ${c.rects ?? 0}${c.mode === 'stitched' ? ` (${c.rectsAtTop ?? 0} from the top alone)` : ''}`);
    // A page wider than the locked viewport loses the overflow, because every slice is a
    // viewport shot. Said out loud rather than left to whoever compares two numbers.
    if (c.pageWidth > meta.image.width) {
        console.log(`page width   ${c.pageWidth}px — ${c.pageWidth - meta.image.width}px WIDER than the image`);
    }
    if (c.stoppedEarly) {
        console.log(`slicing      STOPPED EARLY — ${printable(c.stoppedEarly, 200)}`);
    }
    // WHAT HELD THE VIEWPORT AND WHAT WAS DONE ABOUT IT, because "this page has no
    // repeating chrome" and "this pass failed to find any" look identical in the image.
    const pin = c.pinned;
    if (pin) {
        console.log(`pinned       ${pin.pinned} elements, ${pin.maximal} outermost — `
            + `${pin.chrome} hidden as repeating, ${pin.maximal - pin.chrome - pin.undecided} kept as content`
            + `${pin.undecided ? `, ${pin.undecided} undecided` : ''}`
            + `${pin.lateArrivals ? `   <-- ${pin.lateArrivals} MORE ARRIVED AFTER THE DECISION AND MAY REPEAT` : ''}`);
    }
    // "no banner found" and "a banner we could not dismiss" are different outcomes, and
    // saying the same thing for both is what made this line noise on most of the web.
    const consentState = meta.consentDismissed
        ? `dismissed via ${printable(meta.consentVia)}`
        : (meta.consentBannerSeen ? 'BANNER FOUND, not dismissed (counts as surface area)' : 'no banner found');
    // A banner that was not on the page at load changes what every measurement taken
    // before the scroll pass was a measurement OF, so it is never left implicit.
    const lateNote = meta.consentArrivedLate ? ' — it was not there at load; it arrived during the scroll' : '';
    console.log(`consent      ${consentState}${lateNote}${meta.consentNavigatedAway ? ' — a consent click navigated away and was undone' : ''}`);
    // "This page has no web components" and "the walk that finds them stopped working"
    // would otherwise be the same silence. Only printed when there is something to say.
    const shadow = c.shadow;
    if (shadow && shadow.hosts > 0) {
        console.log(`components   ${shadow.hosts} shadow roots holding ${shadow.inShadow} of ${shadow.elements} elements`);
    }
    console.log(`scroll cap   ${meta.scrollCapHit ? 'HIT — page may be infinite-scroll' : 'not hit'}`);
    console.log(`webgl        ${printable(meta.webgl.renderer || 'none', RENDERER_MAX)}${meta.webgl.software === true ? ' (software)' : ''}`);
    console.log(`webgl asked  ${meta.webgl.requested.length ? printable(meta.webgl.requested.join(", "), RENDERER_MAX) : "no"}`);
    console.log(`webgl draws  ${meta.webgl.draws}`);
    console.log(`content ends ${meta.heightGap.contentBottom}px of ${meta.fullHeight}px`);
    console.log(`artefacts    ${printable(outDir)}`);

    // Loud, and on stderr, because the capture SUCCEEDED — the page is simply missing a
    // region, and nothing else about this run looks wrong.
    for (const warning of [
        wrongPageWarning(meta),
        shotTruncationWarning(meta),
        paintLimitWarning(meta),
        webglWarning(meta.webgl),
        unrenderedWarning(meta),
    ]) {
        if (warning) {
            process.stderr.write(`\nWARNING: ${warning}\n`);
        }
    }
} catch (e) {
    // Sanitised too: a JSON or protocol error message can quote the page's own bytes
    // back at us, so the failure path is no safer than the success path.
    console.error(`capture failed: ${printable(e.message, 500)}`);
    process.exit(1);
}
