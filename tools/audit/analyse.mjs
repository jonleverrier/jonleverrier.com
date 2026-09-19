#!/usr/bin/env node
/**
 * PHASES 2 AND 3 — ANALYSE
 *
 *   node tools/audit/analyse.mjs <outDir>
 *
 * Reads fullpage.png, rects.json and meta.json from a phase 1 capture. Asks a vision model
 * where the blocks are and what each one is, snaps the boundaries onto real element edges,
 * and writes blocks.json, vision.json and debug.png.
 *
 * blocks.json is `{notes, tree}` — the SAME SHAPE segment.mjs wrote, deliberately, so that
 * everything downstream of it is unchanged by the rewrite. What is new is that every leaf
 * carries a `label`: what the block is, which category it falls in, how confident the model
 * was, and how many columns it holds.
 *
 * ARTEFACTS ARE WRITTEN ONLY BY A RUN THAT PASSED, and the previous run's are removed
 * first, so what is in the directory afterwards is always this run's or nothing.
 *
 * THE HONESTY CHECKS RUN BEFORE THE API CALL, and that ordering is the point. Refusing a
 * 403 costs nothing; paying to measure one is worse than not measuring it, because a model
 * shown an error page describes it confidently as a homepage. Run on boondmanager.com's
 * pre-stitching capture, where a section was a 1,000px rectangle of flat colour, it named
 * that rectangle "Dark solutions by profession" and returned 16 blocks instead of 21. It
 * cannot tell it was shown an incomplete page. Everything phase 1 does to make the capture
 * complete, and everything lib/notes.mjs does to declare what is missing, is what makes
 * the answer safe to use.
 *
 * OPEN debug.png. The invariants prove the tree is a valid partition and say nothing about
 * whether a block is really "promotion". That judgement is yours.
 */
import {join} from 'node:path';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {askPage} from './lib/vision.mjs';
import {tilePlan} from './lib/tiles.mjs';
import {snapBoundaries, mergeSeams, buildTree} from './lib/bands.mjs';
import {edgeCandidates} from './lib/candidates.mjs';
import {leaves, totalArea} from './lib/blocks.mjs';
import {anyUnmeasured, noteCodes, runNotes} from './lib/notes.mjs';
import {loadRects} from './lib/rects.mjs';
import {printable} from './lib/printable.mjs';
import {renderDebug} from './lib/debug.mjs';
import {overlaysInPng} from './lib/overlay.mjs';
import {pageSignature, signatureFacts} from './lib/signature.mjs';
import {blankRegions, inkFraction, inkPrefix, pixelsFromPng, transparentBlocks, unpaintedBlocks} from './lib/painted.mjs';

const outDir = process.argv[2];
if (!outDir) {
    console.error('usage: node tools/audit/analyse.mjs <outDir>');
    process.exit(1);
}

const png = join(outDir, 'fullpage.png');
const blocksPath = join(outDir, 'blocks.json');
const visionPath = join(outDir, 'vision.json');
const debugPath = join(outDir, 'debug.png');

process.stderr.write(`analysing ${printable(png)}\n`);
try {
    rmSync(blocksPath, {force: true});
    rmSync(debugPath, {force: true});
    // vision.json is NOT removed here: it is the stored answer, and reading it is the
    // whole point of the cache below.

    const metaPath = join(outDir, 'meta.json');
    if (!existsSync(metaPath)) {
        throw new Error('no meta.json — this phase needs a phase 1 capture, not just a PNG');
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const loaded = loadRects(join(outDir, 'rects.json'));
    const rects = loaded ? loaded.rects : [];

    // THE REFUSAL COMES FIRST, BEFORE ANY MONEY IS SPENT. Every other note describes a
    // page we can still honestly report on; this one says the bytes belong to a CDN's
    // block page, so there is no percentage worth paying for.
    if (typeof meta.httpStatus === 'number' && (meta.httpStatus < 200 || meta.httpStatus >= 300)) {
        throw new Error(`the server answered ${meta.httpStatus}, so this is an error page rather than the site`);
    }

    const {width, height} = meta.image;

    // THE CACHE, AND IT IS THE DETERMINISM PROMISE. A model does not answer the same way
    // twice — three runs of one image gave the largest block as 19.2%, 21.1% and 17.7% —
    // so a page is audited ONCE and every report served from that answer. It is re-audited
    // only when its structural signature moves: the page's height, its element count, what
    // those elements say and where they sit. A carousel showing a different photograph is
    // not a change. `--force` overrides it. See lib/signature.mjs.
    const signature = pageSignature(meta, rects);
    const force = process.argv.includes('--force');
    const cached = !force && existsSync(visionPath)
        ? JSON.parse(readFileSync(visionPath, 'utf8'))
        : null;
    let answer;
    if (cached && cached.signature === signature) {
        process.stderr.write(`page unchanged since ${cached.askedAt} — reusing the stored answer\n`);
        answer = {blocks: cached.blocks, usage: cached.usage ?? {}, secs: 0, tiles: cached.tiles, reused: true};
    } else {
        answer = await askPage(png, meta, {});
    }
    if (answer.error) {
        throw new Error(`the model could not read this capture: ${answer.error}`);
    }

    // A section taller than one tile arrives as two blocks meeting at the seam. See
    // lib/bands.mjs for why nothing else is allowed to merge.
    const seams = tilePlan(height).map((t) => t.top).filter((y) => y > 0);
    const merged = mergeSeams(answer.blocks, seams);

    // Snapped onto real element edges, then each block re-seated on the snapped set, so
    // the tree is built from coordinates the DOM actually has rather than from the
    // model's approximation of them.
    const boundaries = snapBoundaries(
        [...new Set(merged.flatMap((b) => [b.y0, b.y1]))],
        edgeCandidates(rects, true),
    );
    const nearest = (y) => boundaries.reduce((best, c) => (Math.abs(c - y) < Math.abs(best - y) ? c : best), y);
    const seated = merged
        .map((b) => ({...b, y0: nearest(b.y0), y1: nearest(b.y1)}))
        .filter((b) => b.y1 > b.y0);

    const root = buildTree(seated, width, height);
    const ls = leaves(root);
    // buildTree asserts the partition itself; this is the cheap total, kept because the
    // two checks fail on different things and a percentage from either is worthless.
    if (totalArea(ls) !== width * height) {
        throw new Error(`area check BROKEN: leaves total ${totalArea(ls)} against an image of ${width * height}`);
    }

    // What the DOM says is here against what was painted, per block. Needs the tree, so it
    // cannot happen earlier, and needs the rects, so it does not happen at all without
    // them. See lib/painted.mjs.
    let unpainted = null;
    let blank = null;
    let transparent = null;
    if (rects.length) {
        const raw = await pixelsFromPng(png);
        const measured = inkPrefix(raw.pixels, raw.width, raw.height);
        unpainted = unpaintedBlocks(measured, ls, rects);
        transparent = transparentBlocks(measured, ls, rects);
        blank = blankRegions(measured, ls);
        // EACH LEAF'S OWN INK, which is how whitespace is reported. A client logo strip is
        // 4% ink and 96% space; counted by area alone that space silently becomes whatever
        // the strip was labelled. See lib/surface.mjs.
        for (const l of ls) {
            l.coverage = Number(inkFraction(measured, l).toFixed(4));
        }
    }
    // Chrome the DOM census could not reach, found in the stitched image itself. Only
    // meaningful on a stitched capture, where the repeat IS the artefact. See
    // lib/overlay.mjs.
    const overlays = meta.capture?.mode === 'stitched'
        ? await overlaysInPng(png, meta.capture.viewportHeight ?? 900)
        : [];
    const notes = runNotes(meta, 'present', rects, unpainted, blank, transparent, overlays, ls);

    // debug.png first: if rendering throws there is then no blocks.json beside it claiming
    // the run succeeded.
    await renderDebug(png, root, debugPath);
    writeFileSync(visionPath, JSON.stringify({
        signature,
        facts: signatureFacts(meta, rects),
        askedAt: answer.reused ? cached.askedAt : new Date().toISOString(),
        blocks: answer.blocks,
        usage: answer.usage,
        tiles: answer.tiles,
        secs: Number(answer.secs.toFixed(1)),
    }, null, 1));
    writeFileSync(blocksPath, JSON.stringify({notes, tree: root}, null, 1));

    console.log(`image        ${width}x${height}`);
    console.log(`tiles        ${answer.tiles}`);
    console.log(`blocks       ${ls.length}`);
    console.log('area check   conserved');
    console.log(`tokens       ${answer.usage.input_tokens} in, ${answer.usage.output_tokens} out`);
    console.log(`seconds      ${answer.secs.toFixed(1)}`);
    console.log(`answer       ${answer.reused ? 'reused — page unchanged' : 'fresh'}`);
    console.log(`debug image  ${printable(debugPath)}`);

    const codes = noteCodes(notes);
    console.log(`notes        ${codes.length ? `${codes.length} — ${codes.join(', ')}` : 'none'}`);
    if (anyUnmeasured(notes)) {
        console.log('unmeasured   YES — see warnings');
    }
    for (const code of codes) {
        process.stderr.write(`\nWARNING: ${notes.conditions[code].message}\n`);
    }
} catch (e) {
    console.error(`analysis failed: ${printable(e.message, 500)}`);
    process.exit(1);
}
