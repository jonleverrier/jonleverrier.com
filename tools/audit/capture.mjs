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
    console.log(`full height  ${meta.fullHeight}px`);
    console.log(`consent      ${meta.consentDismissed ? `dismissed via ${meta.consentVia}` : 'not dismissed (counts as surface area)'}`);
    console.log(`scroll cap   ${meta.scrollCapHit ? 'HIT — page may be infinite-scroll' : 'not hit'}`);
    console.log(`webgl        ${meta.webgl.renderer || 'none'}${meta.webgl.software === true ? ' (software)' : ''}`);
    console.log(`webgl asked  ${meta.webgl.requested.length ? meta.webgl.requested.join(", ") : "no"}`);
    console.log(`webgl draws  ${meta.webgl.draws}`);
    console.log(`artefacts    ${outDir}`);

    // Loud, and on stderr, because the capture SUCCEEDED — the page is simply missing a
    // region, and nothing else about this run looks wrong.
    const warning = webglWarning(meta.webgl);
    if (warning) {
        process.stderr.write(`\nWARNING: ${warning}\n`);
    }
} catch (e) {
    console.error(`capture failed: ${e.message}`);
    process.exit(1);
}
