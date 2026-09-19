#!/usr/bin/env node
/**
 * PHASE 4 — REPORT
 *
 *   node tools/audit/report.mjs <outDir>
 *
 * Turns a blocks.json into the thing a prospect reads: what share of their homepage goes
 * to brand, navigation, routing and promotion, above the fold and over the whole page.
 *
 * EVERY CAVEAT TRAVELS WITH THE NUMBER. The notes are not debug output; they are the
 * difference between a measurement and a claim. A page with a canvas the capture could not
 * read, or a region the model would not name, gets a figure AND the sentence saying what
 * the figure does not cover — because the person reading it owns the site and will know.
 *
 * COVERAGE IS PRINTED BESIDE EVERY SHARE, which is the user's ruling that whitespace is a
 * measure across blocks rather than a kind of block. "routing 22% at 31% coverage" says
 * something "routing 22%" does not: that two thirds of that region is deliberate space.
 *
 * The limitation worth knowing: this reports ONE capture at ONE width. A homepage that
 * reorganises itself on a phone is a different page, and nothing here measures it.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {surfaceArea} from './lib/surface.mjs';
import {printable} from './lib/printable.mjs';

// A measurement we did not take prints as a dash, never as a number. See lib/surface.mjs.
const pct = (n) => (typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : '—');

export function reportFor(doc, viewportHeight) {
    const {notes, tree} = doc;
    const {full, firstViewport, coverage, unmeasured} = surfaceArea(tree, viewportHeight);

    const caveats = [];
    // First, because if this one is true none of the others can be trusted either.
    if (!notes?.metaRead) {
        caveats.push('how this page was captured could not be checked, so nothing here is guaranteed to '
            + 'describe the page that was asked for');
    }
    for (const c of Object.values(notes?.conditions ?? {})) {
        caveats.push(c.message);
    }

    // The four the prospect is being told about. `other` and `unclassified` are in the
    // table but not in the headline, because neither is a finding.
    const named = full.filter((s) => s.category !== 'other' && s.category !== 'unclassified');
    const headline = named.length
        ? named.map((s) => `${s.category} ${pct(s.share)}`).join(', ')
        : 'nothing on this page classified as brand, navigation, routing or promotion';

    return {url: doc.url ?? null, full, firstViewport, coverage, unmeasured, caveats, headline};
}

// ONLY WHEN RUN AS A COMMAND, never on import. `reportFor` is the tested surface, and a
// test importing it must not also execute a CLI whose argv belongs to the test runner.
const isCommand = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
const outDir = process.argv[2];
if (isCommand && outDir) {
    try {
        const doc = JSON.parse(readFileSync(join(outDir, 'blocks.json'), 'utf8'));
        const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
        const r = reportFor({...doc, url: meta.url}, meta.viewport?.height ?? 900);

        console.log(`\n${printable(meta.url)}`);
        console.log(`captured ${meta.capturedAt}`);
        console.log(`${meta.image.width}x${meta.image.height}, `
            + `${r.coverage === null ? 'coverage not measured' : `${pct(r.coverage)} of it drawn on`}\n`);
        console.log('                    whole page             first viewport');
        for (const s of r.full) {
            const fv = r.firstViewport.find((f) => f.category === s.category);
            console.log(`  ${s.category.padEnd(14)}${pct(s.share).padStart(7)} at ${pct(s.coverage).padStart(6)} ink`
                + `   ${fv ? pct(fv.share).padStart(7) : '      -'}`);
        }
        console.log(`\n  ${r.headline}`);
        if (r.caveats.length) {
            console.log('\nwhat this does not cover:');
            for (const c of r.caveats) {
                console.log(`  - ${printable(c, 300)}`);
            }
        }
        console.log('');
    } catch (e) {
        console.error(`report failed: ${printable(e.message, 300)}`);
        process.exit(1);
    }
}
