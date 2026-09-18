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
 */
const wrongPageWarning = (meta) => (meta.capturedUrl && !sameUrl(meta.capturedUrl, meta.url)
    ? `the capture ended on ${printable(meta.capturedUrl)}, not ${printable(meta.url)}. Every artefact in this`
        + ' directory is of that page, so any percentage from it belongs to that page too'
    : null);

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
    console.log(`captured     ${printable(meta.capturedUrl)}${sameUrl(meta.capturedUrl, meta.url) ? '' : '   <-- NOT THE URL REQUESTED'}`);
    console.log(`full height  ${meta.fullHeight}px`);
    console.log(`image        ${meta.image.width}x${meta.image.height}`);
    // "no banner found" and "a banner we could not dismiss" are different outcomes, and
    // saying the same thing for both is what made this line noise on most of the web.
    const consentState = meta.consentDismissed
        ? `dismissed via ${printable(meta.consentVia)}`
        : (meta.consentBannerSeen ? 'BANNER FOUND, not dismissed (counts as surface area)' : 'no banner found');
    console.log(`consent      ${consentState}${meta.consentNavigatedAway ? ' — a consent click navigated away and was undone' : ''}`);
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
