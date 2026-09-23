#!/usr/bin/env node
/**
 * SUMMARY
 *
 *   node tools/audit/summary.mjs <leadDir>
 *
 * Chooses the cover's findings and writes them into the lead's `report.json`.
 *
 * ITS OWN STEP, AFTER BOTH SITES, because it is the only part of the record that cannot be
 * computed from one directory. `data.mjs` runs per site and the lead's runs first — before
 * the competitor has been captured at all — so a comparison written there would be a
 * comparison against nothing. This runs when everything is on disk, reads both records,
 * and patches the answer back.
 *
 * IT PATCHES RATHER THAN REWRITES. `report.json` is what the template reads and what
 * data.mjs owns; this adds one key to it and touches nothing else, so there is still one
 * place the numbers are worked out.
 *
 * The limitation worth knowing: run it twice and it simply chooses again from the same
 * records, which is what a re-run wants. It is not idempotent in the strict sense — a
 * changed lib/summary.mjs gives a different answer from identical inputs — and that is
 * the point of it being a separate step rather than baked into a capture.
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {summarise} from './lib/summary.mjs';
import {compare} from './lib/expectations.mjs';
import {printable} from './lib/printable.mjs';

const outDir = process.argv[2];
if (!outDir) {
    console.error('usage: node tools/audit/summary.mjs <leadDir>');
    process.exit(1);
}

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

try {
    const path = join(outDir, 'report.json');
    const report = read(path);
    if (!report) {
        throw new Error(`no report.json in ${outDir} — has data.mjs run?`);
    }
    // ABSENT IS NORMAL. Most leads name nobody, and the findings then stand on their own.
    const competitor = read(join(outDir, 'competitor', 'report.json'));

    const summary = summarise(report, competitor);
    // THE COMPARISON'S OWN READING, written here for the same reason the findings are:
    // this is the one step that has both records open. Null without a competitor, which is
    // how the template knows there is no sheet to put it on.
    const bare = (url) => {
        try {
            return new URL(url).host.replace(/^www\./i, '');
        } catch {
            return url;
        }
    };
    const comparison = competitor
        ? compare(report, competitor, {mine: bare(report.url), theirs: bare(competitor.url)})
        : null;

    writeFileSync(path, JSON.stringify({...report, summary, comparison}, null, 1));

    console.log(`against      ${competitor ? printable(competitor.url) : 'nobody'}`);
    console.log(`findings     ${summary.length}`);
    for (const f of summary) {
        console.log(`             ${printable(f.text, 200)}`);
    }
    if (comparison?.worth) {
        console.log(`same purpose ${comparison.samePurpose ? 'yes' : 'NO — said out loud before the tables'}`);
        for (const point of comparison.points) {
            console.log(`             ${printable(point, 200)}`);
        }
    }
    console.log(`written      ${path}`);
} catch (e) {
    console.error(`summary failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
