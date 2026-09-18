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
import {webglWarning} from './lib/webgl.mjs';
import {shotTruncationWarning, unrenderedWarning} from './lib/unrendered.mjs';

/** The page we ended on is not the page we asked for. Never a footnote. */
const wrongPageWarning = (meta) => (meta.capturedUrl && meta.capturedUrl !== meta.url
    ? `the capture ended on ${meta.capturedUrl}, not ${meta.url}. Every artefact in this`
        + ' directory is of that page, so any percentage from it belongs to that page too'
    : null);

const url = process.argv[2];
const outDir = process.argv[3] || '/tmp/audit';
if (!url) {
    console.error('usage: node tools/audit/capture.mjs <url> [outDir]');
    process.exit(1);
}

process.stderr.write(`capturing ${url}\n`);
try {
    const meta = await capturePage(url, outDir);
    console.log(`url          ${meta.url}`);
    console.log(`captured     ${meta.capturedUrl}${meta.capturedUrl === meta.url ? '' : '   <-- NOT THE URL REQUESTED'}`);
    console.log(`full height  ${meta.fullHeight}px`);
    console.log(`image        ${meta.image.width}x${meta.image.height}`);
    console.log(`consent      ${meta.consentDismissed ? `dismissed via ${meta.consentVia}` : 'not dismissed (counts as surface area)'}${meta.consentNavigatedAway ? ' — a consent click navigated away and was undone' : ''}`);
    console.log(`scroll cap   ${meta.scrollCapHit ? 'HIT — page may be infinite-scroll' : 'not hit'}`);
    console.log(`webgl        ${meta.webgl.renderer || 'none'}${meta.webgl.software === true ? ' (software)' : ''}`);
    console.log(`webgl asked  ${meta.webgl.requested.length ? meta.webgl.requested.join(", ") : "no"}`);
    console.log(`webgl draws  ${meta.webgl.draws}`);
    console.log(`content ends ${meta.heightGap.contentBottom}px of ${meta.fullHeight}px`);
    console.log(`artefacts    ${outDir}`);

    // Loud, and on stderr, because the capture SUCCEEDED — the page is simply missing a
    // region, and nothing else about this run looks wrong.
    for (const warning of [
        wrongPageWarning(meta),
        shotTruncationWarning(meta),
        webglWarning(meta.webgl),
        unrenderedWarning(meta),
    ]) {
        if (warning) {
            process.stderr.write(`\nWARNING: ${warning}\n`);
        }
    }
} catch (e) {
    console.error(`capture failed: ${e.message}`);
    process.exit(1);
}
