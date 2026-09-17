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
    console.log(`consent      ${meta.consentDismissed ? 'dismissed' : 'not dismissed (counts as surface area)'}`);
    console.log(`scroll cap   ${meta.scrollCapHit ? 'HIT — page may be infinite-scroll' : 'not hit'}`);
    console.log(`artefacts    ${outDir}`);
} catch (e) {
    console.error(`capture failed: ${e.message}`);
    process.exit(1);
}
