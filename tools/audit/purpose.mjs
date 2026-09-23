#!/usr/bin/env node
/**
 * PURPOSE
 *
 *   node tools/audit/purpose.mjs <outDir>
 *
 * Reads what the page says at the top of it, asks which of five jobs that makes it, and
 * patches the answer into that site's `report.json`.
 *
 * PER SITE, so a comparison asks it of both — a lead whose purpose differs from their
 * competitor's is exactly the case where comparing segment shares misleads, and the report
 * can only say so if it knows both.
 *
 * AFTER `data.mjs`, which owns report.json, and patching rather than rewriting for the
 * same reason `summary.mjs` does: one place works the numbers out.
 *
 * The limitation worth knowing: this asks the model one more question per site. It is a
 * text-only request answered in a dozen tokens, which is why it can run on every audit
 * rather than on demand — but it is not free, and a re-run pays it again because there is
 * nothing here keyed on the page's signature the way lib/vision.mjs is.
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {heroText, askPurpose} from './lib/purpose.mjs';
import {read as readAgainstPurpose} from './lib/expectations.mjs';
import {printable} from './lib/printable.mjs';

const outDir = process.argv[2];
if (!outDir) {
    console.error('usage: node tools/audit/purpose.mjs <outDir>');
    process.exit(1);
}

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

try {
    const path = join(outDir, 'report.json');
    const report = read(path);
    const blocks = read(join(outDir, 'blocks.json'));
    const rects = read(join(outDir, 'rects.json'));
    if (!report) {
        throw new Error(`no report.json in ${outDir} — has data.mjs run?`);
    }

    const {claim, context, from} = heroText(blocks, rects);
    // THE <head> GOES TO THE CLASSIFIER AND NEVER TO THE QUOTE. A meta description is
    // written for a stranger who has never heard of the company, which is the same question
    // being asked here — but it is not words a visitor reads, and the report prints the
    // claim under "In its own words". See lib/capture.mjs READ_HEAD.
    const meta = read(join(outDir, 'meta.json'));
    const answer = await askPurpose(context, {head: meta?.head ?? {}});
    // THE WORDS TRAVEL WITH THE KIND. The report quotes the claim and never prints the
    // kind on its own: a reader can disagree with a sentence from their own page in a way
    // they cannot disagree with the word "route".
    const purpose = {kind: answer.kind, confidence: answer.confidence, claim, from};

    // THE READING IS WRITTEN HERE TOO, rather than in a step of its own, because it is a
    // pure function of the record this step has just completed — see lib/expectations.mjs,
    // where no model runs and the same input gives the same answer every time. Splitting
    // it out would buy a fourth CLI and a second read of the same file.
    const withPurpose = {...report, purpose};
    const reading = readAgainstPurpose(withPurpose);

    writeFileSync(path, JSON.stringify({...withPurpose, reading}, null, 1));

    const head = meta?.head ?? {};
    console.log(`read from    ${from ?? 'nothing readable'}`);
    console.log(`head         ${[
        head.title ? 'title' : '',
        head.description ? 'description' : '',
        head.ogDescription ? 'og' : '',
        head.schemaDescription ? 'schema' : '',
    ].filter(Boolean).join(', ') || 'nothing in <head>'}`);
    console.log(`claim        ${claim ? printable(claim, 200) : '(none)'}`);
    console.log(`purpose      ${purpose.kind} (${Math.round(purpose.confidence * 100)}%)`);
    console.log(`findings     ${reading.worth ? reading.findings.length : 'none — nothing will be printed'}`);
    for (const f of reading.findings) {
        console.log(`             ${printable(f.text, 200)}`);
    }
    if (reading.notGaps.length) {
        console.log(`not gaps     ${reading.notGaps.join(', ')}`);
    }
    if (answer.why) {
        console.log(`why          ${printable(answer.why, 200)}`);
    }
    console.log(`written      ${path}`);
} catch (e) {
    console.error(`purpose failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
