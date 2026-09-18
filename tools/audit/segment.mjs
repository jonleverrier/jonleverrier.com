#!/usr/bin/env node
/**
 * PHASE 2 — SEGMENT
 *
 *   node tools/audit/segment.mjs <outDir> [--depth=4]
 *
 * Reads fullpage.png from outDir — and rects.json and meta.json beside it when phase 1
 * left them — then writes blocks.json and debug.png into the same directory.
 *
 * blocks.json is `{notes, tree}`. The tree is the partition; the notes are every
 * condition that applies to this run, in a form something downstream can branch on —
 * including the case where meta.json was absent, so "nothing was wrong" and "we could
 * not tell" are never the same answer. See lib/notes.mjs.
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
import {anyUnmeasured, noteCodes, runNotes} from './lib/notes.mjs';
import {printable} from './lib/printable.mjs';
import {loadRects} from './lib/rects.mjs';
import {blankRegions, inkPrefix, pixelsFromPng, transparentBlocks, unpaintedBlocks} from './lib/painted.mjs';

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

    // Carried through from phase 1 rather than re-probed: by the time anyone reads a
    // percentage, the browser that failed to draw the page is long gone. A blank region
    // segments perfectly and conserves area, so nothing downstream would otherwise
    // notice that part of the page never rendered.
    //
    // READ BEFORE THE TREE IS WRITTEN, because it goes INTO the file. Warnings used to
    // reach stdout and stderr only, and the Craft job imports lib/ rather than this CLI,
    // so the whole honesty layer was invisible to everything downstream of a terminal.
    const metaPath = join(outDir, 'meta.json');
    let meta = null;
    let metaReason = 'missing';
    if (existsSync(metaPath)) {
        try {
            meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        } catch {
            // NOT FATAL. The segmentation is sound; it is the provenance record that is
            // broken, and saying so is more use than refusing to write a valid tree.
            metaReason = 'unreadable';
        }
    }
    // WHAT THE DOM SAYS IS HERE AGAINST WHAT WAS PAINTED, per block. Needs the tree, so
    // it cannot be done before the segmentation, and needs the rects, so it does not
    // happen at all without them. It is the one condition phase 1 could never have
    // recorded: the pixels and the DOM have to be compared against each other, and only
    // phase 2 holds both. See lib/painted.mjs.
    let unpainted = null;
    let blank = null;
    let transparent = null;
    if (rects) {
        const raw = await pixelsFromPng(png);
        const measured = inkPrefix(raw.pixels, raw.width, raw.height);
        unpainted = unpaintedBlocks(measured, ls, rects);
        // The same missing pixels with a cause attached: content that was still behind an
        // `opacity: 0` ancestor when phase 1 censused it. Split out of the contradiction
        // above because "we arrived before the reveal" and "this never rendered" are
        // different answers and only one of them is the page's fault.
        transparent = transparentBlocks(measured, ls, rects);
        // The other half of the same measurement: a region with nothing painted AND
        // nothing in the DOM is not a contradiction, so the checks above cannot see it —
        // and alchemy.je gives half its page to one.
        blank = blankRegions(measured, ls);
    }
    // The rects go in too: some conditions are about what the page CONTAINS rather than
    // how it was captured — an error page served as a success, and DOM content that
    // never made it into the pixels. Both are in lib/, because the Craft job imports
    // lib/ and not this CLI.
    const notes = runNotes(meta, metaReason, rects ?? null, unpainted, blank, transparent);

    // AN ERROR PAGE IS NOT A WEAKER MEASUREMENT, IT IS A MEASUREMENT OF SOMETHING ELSE.
    // Every other condition here describes a page we can still honestly report on, with
    // a region declared unmeasured. This one says the bytes belong to a CDN's block page,
    // so there is no percentage worth writing and no debug image worth opening. Refusing
    // is the only honest answer, and it happens before anything is written.
    if ('httpError' in notes.conditions) {
        throw new Error(notes.conditions.httpError.message);
    }

    // Only now, with a tree that passed. debug.png first: if rendering throws there is
    // then no blocks.json beside it claiming the run succeeded.
    //
    // NOTES FIRST IN THE FILE, ahead of the tree: what is unmeasured about this page
    // should be the first thing anyone opening it reads, and a consumer destructuring
    // `{notes, tree}` cannot take the numbers without being handed the caveats.
    await renderDebug(png, root, debugPath);
    writeFileSync(blocksPath, JSON.stringify({notes, tree: root}, null, 1));

    const mean = Math.round(totalArea(ls) / ls.length);
    console.log(`image        ${width}x${height}`);
    console.log(`depth        ${maxDepth}`);
    console.log(`blocks       ${ls.length}`);
    console.log(`mean area    ${mean}px²`);
    // A statement of what the gate above established, not a recomputation of it: this
    // line is only ever reached by a tree that passed both checks.
    console.log('area check   conserved');
    console.log(`debug image  ${printable(debugPath)}`);

    const codes = noteCodes(notes);
    console.log(`notes        ${notes.metaRead
        ? (codes.length ? `${codes.length} — ${codes.join(', ')}` : 'none')
        : `NOT CHECKED — ${metaReason === 'unreadable' ? 'meta.json is unreadable' : 'no meta.json here'}`}`);
    if (anyUnmeasured(notes)) {
        console.log('unmeasured   YES — see warnings');
    }

    // The same sentences as before, from the same place the file now carries. Deriving
    // both from `notes` is the point: a condition that reaches blocks.json and not the
    // terminal, or the other way round, is how the two drift apart.
    for (const code of codes) {
        process.stderr.write(`\nWARNING: ${notes.conditions[code].message}\n`);
    }
} catch (e) {
    console.error(`segmentation failed: ${printable(e.message, 500)}`);
    process.exit(1);
}
