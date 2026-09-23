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
    const answer = await askPurpose(context);
    // THE WORDS TRAVEL WITH THE KIND. The report quotes the claim and never prints the
    // kind on its own: a reader can disagree with a sentence from their own page in a way
    // they cannot disagree with the word "route".
    const purpose = {kind: answer.kind, confidence: answer.confidence, claim, from};

    writeFileSync(path, JSON.stringify({...report, purpose}, null, 1));

    console.log(`read from    ${from ?? 'nothing readable'}`);
    console.log(`claim        ${claim ? printable(claim, 200) : '(none)'}`);
    console.log(`purpose      ${purpose.kind} (${Math.round(purpose.confidence * 100)}%)`);
    if (answer.why) {
        console.log(`why          ${printable(answer.why, 200)}`);
    }
    console.log(`written      ${path}`);
} catch (e) {
    console.error(`purpose failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
