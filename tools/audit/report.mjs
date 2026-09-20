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

    // Everything the prospect is being told about. `unclassified` is in the table but not
    // in the headline, because it is a refusal rather than a finding.
    const named = full.filter((s) => s.category !== 'unclassified');
    const headline = named.length
        ? named.map((s) => `${s.category} ${pct(s.share)}`).join(', ')
        : 'nothing on this page could be classified';

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
        // TWO NUMBERS ANSWERING TWO QUESTIONS, and the header has to say which is which.
        // It read `45.5% at 12.5% ink`, and the first person shown it asked what the second
        // number was. `ink` is this tool's word for "pixels differing from their row's own
        // background" and it is a fine name inside lib/painted.mjs; on a page somebody reads
        // about their own site it names nothing. The first column is the section against the
        // PAGE, the second is its content against ITS OWN SPACE — so a section that takes a
        // lot of room and a section that has a lot in it stop looking identical.
        // The header is built from the SAME widths as the rows, so the two cannot drift apart.
        const COL = {label: 16, share: 12, content: 14, fold: 11};
        const head = (a, b, c) => ' '.repeat(COL.label)
            + a.padStart(COL.share) + b.padStart(COL.content) + c.padStart(COL.fold);
        console.log(head('share', 'content to', 'first'));
        console.log(head('of page', 'space', 'viewport'));
        for (const s of r.full) {
            const fv = r.firstViewport.find((f) => f.category === s.category);
            console.log(`  ${s.category.padEnd(COL.label - 2)}${pct(s.share).padStart(COL.share)}`
                + `${pct(s.coverage).padStart(COL.content)}${(fv ? pct(fv.share) : '-').padStart(COL.fold)}`);
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
