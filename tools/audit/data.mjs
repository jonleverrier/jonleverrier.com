#!/usr/bin/env node
/**
 * REPORT DATA
 *
 *   node tools/audit/data.mjs <outDir>
 *
 * Writes `report.json` into a finished audit directory: everything a report is allowed to
 * know, and nothing about how it looks.
 *
 * IT EXISTS SO THAT NOTHING RECOMPUTES THE NUMBERS. The report is designed in Twig, and a
 * Twig template cannot call lib/surface.mjs — so the alternative was a PHP class adding
 * areas up a second way. Two implementations of one percentage is how a report and a
 * terminal come to disagree about the same page, and the first anyone would know is a
 * prospect asking which is right. The arithmetic stays in one place and this hands over
 * its answer.
 */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {reportData} from './lib/pdf.mjs';
import {printable} from './lib/printable.mjs';

const outDir = process.argv[2];
if (!outDir) {
    console.error('usage: node tools/audit/data.mjs <outDir>');
    process.exit(1);
}

try {
    const data = reportData(outDir);
    const path = join(outDir, 'report.json');
    writeFileSync(path, JSON.stringify(data, null, 1));
    console.log(`url          ${printable(data.url)}`);
    console.log(`categories   ${data.categories.length}`);
    console.log(`caveats      ${data.noteCodes.join(', ') || 'none'}`);
    console.log(`written      ${path}`);
} catch (e) {
    console.error(`data failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
