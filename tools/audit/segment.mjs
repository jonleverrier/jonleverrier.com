#!/usr/bin/env node
/**
 * PHASE 2 — SEGMENT
 *
 *   node tools/audit/segment.mjs <outDir> [--depth=4]
 *
 * Reads fullpage.png from outDir — and rects.json beside it when phase 1 left one —
 * then writes blocks.json and debug.png into the same directory.
 *
 * ARTEFACTS ARE WRITTEN ONLY BY A RUN THAT PASSED. The tree is checked against the
 * partition invariant (lib/blocks.mjs) before anything is written, a failure exits 1,
 * and any previous run's blocks.json and debug.png are removed at the start — so what
 * is in the directory afterwards is always this run's, or nothing.
 *
 * OPEN debug.png. The invariants in the test suite prove the tree is a valid
 * partition; they cannot prove it is a sensible one. That judgement is yours, and it
 * is the gate before phase 3 is written.
 *
 * The limitation worth knowing: this is deterministic given fullpage.png, rects.json
 * and --depth — same inputs and flags always produce byte-identical blocks.json — but
 * it trusts fullpage.png itself to be stable. Recapturing a live page and re-running
 * this will not reproduce a prior run's numbers; only re-segmenting the same PNG will.
 */
import {join} from 'node:path';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {edgeMapFromPng} from './lib/edges.mjs';
import {segmentTall} from './lib/xycut.mjs';
import {renderDebug} from './lib/debug.mjs';
import {assertPartition, leaves, totalArea} from './lib/blocks.mjs';
import {webglWarning} from './lib/webgl.mjs';
import {shotTruncationWarning, unrenderedWarning} from './lib/unrendered.mjs';
import {printable} from './lib/printable.mjs';
import {loadRects} from './lib/rects.mjs';

const outDir = process.argv[2];
const depthArg = process.argv.find((a) => a.startsWith('--depth='));
const depthValue = depthArg ? depthArg.slice('--depth='.length) : null;
if (!outDir) {
    console.error('usage: node tools/audit/segment.mjs <outDir> [--depth=4]');
    process.exit(1);
}
// VALIDATE, do not just parse, and match the digits rather than asking Number() what it
// thinks. An unparseable --depth yields NaN, and `rect.depth >= NaN` is always false, so
// the cap is not merely ignored, it is REMOVED — the run then prints `depth NaN`, cuts
// without limit, and still exits 0. A silently uncapped run that reports success is the
// worst failure this CLI has: the number it produces looks like an answer.
//
// Number() alone cannot gate this, because it is generous in three different directions:
// Number('') and Number(' ') are 0 (a typo becomes a deliberate "do not cut"), and
// Number('0x4') is 4 (hex, silently). A plain decimal test refuses all of them.
if (depthValue !== null && !/^\d+$/.test(depthValue)) {
    console.error(`--depth must be a non-negative whole number, got "${printable(depthValue, 40)}"`);
    process.exit(1);
}
const maxDepth = depthValue === null ? 4 : Number(depthValue);

const png = join(outDir, 'fullpage.png');
const blocksPath = join(outDir, 'blocks.json');
const debugPath = join(outDir, 'debug.png');
// NOTHING REACHES THIS TERMINAL RAW. The paths are argv, the URLs below came off the
// page, and a JSON error message quotes the file's own bytes back — printable() strips
// the escapes that would otherwise rewrite the line an operator is reading, and caps the
// length so a label cannot fill the screen. See lib/printable.mjs.
process.stderr.write(`segmenting ${printable(png)} at depth ${maxDepth}\n`);
try {
    // CLEAR BEFORE, WRITE AFTER. A run that fails must not leave the PREVIOUS run's
    // blocks.json sitting in the directory: a caller that shells out and reads the file
    // without checking the exit code then gets last week's answer for this week's page,
    // with nothing on disk saying so. Removing them first also means a failure part way
    // through cannot leave a half-matched pair.
    rmSync(blocksPath, {force: true});
    rmSync(debugPath, {force: true});

    // Rects snap each cut onto a real element edge instead of the middle of the
    // whitespace. They are an IMPROVEMENT, NOT A REQUIREMENT: a caller may legitimately
    // have nothing but a PNG — a screenshot from somewhere else, an older capture — and
    // the pixel-only path still produces a valid partition. Say so rather than failing,
    // but do say so, because the cuts will be visibly less exact in debug.png and that
    // should not look like a bug in the segmenter.
    //
    // THEY ARE ALSO NOT TRUSTED. loadRects validates the file, rounds fractional
    // coordinates onto the whole pixels the partition invariant assumes, drops what it
    // cannot repair and says how many of each — see lib/rects.mjs. It returns null only
    // when the file is genuinely absent, so the "no rects.json" message below can no
    // longer be printed about a file that is sitting right there.
    const rectsPath = join(outDir, 'rects.json');
    const loaded = loadRects(rectsPath);
    const rects = loaded ? loaded.rects : undefined;
    if (loaded) {
        const repairs = [
            loaded.rounded ? `${loaded.rounded} rounded to whole pixels` : null,
            loaded.dropped ? `${loaded.dropped} dropped as unusable` : null,
        ].filter(Boolean);
        process.stderr.write(`snapping cuts to ${loaded.rects.length} DOM rects from ${printable(rectsPath)}`
            + `${repairs.length ? ` (${repairs.join(', ')})` : ''}\n`);
    } else {
        process.stderr.write(`no rects.json in ${printable(outDir)} — cutting on pixels alone, boundaries will be approximate\n`);
    }

    const {edges, width, height} = await edgeMapFromPng(png);
    const root = segmentTall(edges, width, height, {maxDepth, rects});
    const ls = leaves(root);

    // THE INVARIANT IS THE PRODUCT, so it is checked here and not only in the tests.
    // assertPartition is the strong check — containment, pairwise overlap and exact area
    // equality at every node — and it runs because the leaf-area total on its own cannot
    // catch an overlap that a gap elsewhere pays for. A tree that fails either is not a
    // measurement of anything, and printing a percentage from it would be the confident
    // wrong number this tool exists to avoid. Throwing lands in the catch: exit 1, and
    // nothing is written.
    assertPartition(root);
    if (totalArea(ls) !== width * height) {
        throw new Error(`area check BROKEN: leaves total ${totalArea(ls)} against an image of ${width * height}`);
    }

    // Only now, with a tree that passed. debug.png first: if rendering throws there is
    // then no blocks.json beside it claiming the run succeeded.
    await renderDebug(png, root, debugPath);
    writeFileSync(blocksPath, JSON.stringify(root, null, 1));

    const mean = Math.round(totalArea(ls) / ls.length);
    console.log(`image        ${width}x${height}`);
    console.log(`depth        ${maxDepth}`);
    console.log(`blocks       ${ls.length}`);
    console.log(`mean area    ${mean}px²`);
    // A statement of what the gate above established, not a recomputation of it: this
    // line is only ever reached by a tree that passed both checks.
    console.log('area check   conserved');
    console.log(`debug image  ${printable(debugPath)}`);

    // Carried through from phase 1 rather than re-probed: by the time anyone reads a
    // percentage, the browser that failed to draw the page is long gone. A blank region
    // segments perfectly and conserves area, so nothing downstream would otherwise
    // notice that part of the page never rendered.
    const metaPath = join(outDir, 'meta.json');
    if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        // WHICH PAGE THIS IS A MEASUREMENT OF comes first: a percentage attributed to the
        // wrong domain is wrong in a way no other warning here can make up for.
        const wrongPage = meta.capturedUrl && meta.url && meta.capturedUrl !== meta.url
            ? `these blocks are of ${printable(meta.capturedUrl)}, not the ${printable(meta.url)} that was requested`
            : null;
        const warnings = [
            wrongPage,
            shotTruncationWarning(meta),
            webglWarning(meta.webgl),
            unrenderedWarning(meta),
        ].filter(Boolean);
        if (warnings.length) {
            console.log('unmeasured   YES — see warnings');
            for (const w of warnings) {
                process.stderr.write(`\nWARNING: ${w}\n`);
            }
        }
    }
} catch (e) {
    console.error(`segmentation failed: ${printable(e.message, 500)}`);
    process.exit(1);
}
