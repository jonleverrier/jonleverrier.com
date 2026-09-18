#!/usr/bin/env node
/**
 * PHASE 2 — SEGMENT
 *
 *   node tools/audit/segment.mjs <outDir> [--depth=4]
 *
 * Reads fullpage.png from outDir, writes blocks.json and debug.png beside it.
 *
 * OPEN debug.png. The invariants in the test suite prove the tree is a valid
 * partition; they cannot prove it is a sensible one. That judgement is yours, and it
 * is the gate before phase 3 is written.
 *
 * The limitation worth knowing: this is deterministic given fullpage.png and
 * --depth — same input and flags always produce byte-identical blocks.json — but it
 * trusts fullpage.png itself to be stable. Recapturing a live page and re-running
 * this will not reproduce a prior run's numbers; only re-segmenting the same PNG will.
 */
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {edgeMapFromPng} from './lib/edges.mjs';
import {segmentTall} from './lib/xycut.mjs';
import {renderDebug} from './lib/debug.mjs';
import {leaves, totalArea} from './lib/blocks.mjs';

const outDir = process.argv[2];
const depthArg = process.argv.find((a) => a.startsWith('--depth='));
const maxDepth = depthArg ? Number(depthArg.split('=')[1]) : 4;
if (!outDir) {
    console.error('usage: node tools/audit/segment.mjs <outDir> [--depth=4]');
    process.exit(1);
}

const png = join(outDir, 'fullpage.png');
process.stderr.write(`segmenting ${png} at depth ${maxDepth}\n`);
try {
    const {edges, width, height} = await edgeMapFromPng(png);
    const root = segmentTall(edges, width, height, {maxDepth});
    const ls = leaves(root);
    writeFileSync(join(outDir, 'blocks.json'), JSON.stringify(root, null, 1));
    await renderDebug(png, root, join(outDir, 'debug.png'));

    const mean = Math.round(totalArea(ls) / ls.length);
    console.log(`image        ${width}x${height}`);
    console.log(`depth        ${maxDepth}`);
    console.log(`blocks       ${ls.length}`);
    console.log(`mean area    ${mean}px²`);
    console.log(`area check   ${totalArea(ls) === width * height ? 'conserved' : 'BROKEN'}`);
    console.log(`debug image  ${join(outDir, 'debug.png')}`);
} catch (e) {
    console.error(`segmentation failed: ${e.message}`);
    process.exit(1);
}
