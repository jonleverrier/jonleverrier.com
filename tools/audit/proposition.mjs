#!/usr/bin/env node
/**
 * PROPOSITION
 *
 *   node tools/audit/proposition.mjs <outDir> [--force]
 *
 * Does the first screen say what the company does, does the <head>, and what does every
 * ask on the page want from a visitor. Writes `proposition.json` beside `meta.json`.
 *
 * COLLECTION ONLY. Nothing here reaches report.json or the PDF: which of these facts
 * become findings, and how they are worded, is decided once they have been looked at
 * across real audits. See lib/proposition.mjs.
 *
 * CACHED ON WHAT THE MODEL IS SHOWN. The same words, headings and controls shown to the
 * same model are not asked again; `--force` asks anyway. A capture from before the
 * collector existed has no `meta.proposition` and gets a record that says so.
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {askProposition, buildProposition, inputHash} from './lib/proposition.mjs';
import {askMap, askRows, firstCallToAction, propositionChecks, propositionScore, propositionVerdict, readProposition} from './lib/proposition-reading.mjs';
import {MODEL} from './lib/vision.mjs';
import {printable} from './lib/printable.mjs';

const outDir = process.argv[2];
if (!outDir) {
    console.error('usage: node tools/audit/proposition.mjs <outDir> [--force]');
    process.exit(1);
}

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

try {
    const meta = read(join(outDir, 'meta.json'));
    if (!meta) {
        throw new Error(`no meta.json in ${outDir} — has capture.mjs run?`);
    }
    const path = join(outDir, 'proposition.json');

    let record;
    if (!meta.proposition || meta.proposition.measured === false) {
        record = buildProposition(meta, null);
    } else {
        const hash = inputHash(meta);
        const stored = read(path);
        let reply;
        let votes = null;
        let why = null;
        let cached = false;
        if (!process.argv.includes('--force') && stored?.inputHash === hash && stored.reply) {
            ({reply, votes} = stored);
            cached = true;
        } else {
            ({reply, votes, why} = await askProposition(meta));
        }
        record = {
            ...buildProposition(meta, reply),
            inputHash: hash,
            model: MODEL,
            askedAt: cached ? stored.askedAt : new Date().toISOString(),
            // THE RAW ANSWER IS KEPT, so the cache can replay it and a reader can see
            // exactly what was chosen before the facts were joined to it.
            reply: reply ?? null,
            // Each vote as it came back, so a reader can see where the majority was thin.
            votes: votes ?? null,
            ...(why ? {why} : {}),
        };
        console.log(`asked        ${cached ? 'no — the stored answer still describes the page' : MODEL}`);
    }
    // THE READING, from the facts and the page's purpose — which purpose.mjs has already
    // patched into report.json when this runs inside an audit. No purpose, no judgement
    // about the asks: see lib/proposition-reading.mjs.
    const reportPath = join(outDir, 'report.json');
    const report = read(reportPath);
    const purpose = report?.purpose ?? null;
    record.reading = readProposition(record, purpose);
    writeFileSync(path, JSON.stringify(record, null, 1));

    // INTO report.json, which is what the template reads — patched, not rewritten, as
    // purpose.mjs does, so data.mjs stays the one place the page's numbers are worked out.
    // Only what the report prints: the full record stays in proposition.json.
    if (report) {
        report.proposition = record.measured
            ? {
                score: propositionScore(record, purpose),
                verdict: propositionVerdict(record, purpose),
                checks: propositionChecks(record, purpose),
                // The one fact the Competitor Benchmark sets side by side under the checks.
                firstCall: firstCallToAction(record, purpose),
                firstScreen: {
                    answer: record.firstScreen.answer,
                    quotes: record.firstScreen.quotes,
                    wordsToKnow: record.firstScreen.wordsToKnow,
                },
                head: {answer: record.head.answer, hiddenHeadings: record.head.hiddenHeadings, title: record.head.title},
                asks: askRows(record),
                map: askMap(record),
                findings: record.reading.findings,
            }
            : null;
        writeFileSync(reportPath, JSON.stringify(report, null, 1));
    }

    if (!record.measured) {
        console.log(`not measured ${printable(record.why, 200)}`);
    } else {
        const fs = record.firstScreen;
        console.log(`first screen ${fs.answer}${fs.wordsToKnow !== null ? ` — ${fs.wordsToKnow} words to know, of ${fs.wordsOnScreen}` : ''}`);
        for (const q of fs.quotes) console.log(`             "${printable(q, 160)}"`);
        console.log(`head         ${record.head.answer}${record.head.sources.length ? ` (${record.head.sources.join(', ')})` : ''}`);
        for (const h of record.head.hiddenHeadings) console.log(`hidden       "${printable(h, 160)}"`);
        const sales = record.ctas.filter((c) => c.intent === 'sales');
        console.log(`asks         ${record.ctas.length} controls, ${sales.length} sales, ${record.destinations.length} destinations`);
        for (const d of record.destinations.filter((g) => g.intents.includes('sales'))) {
            console.log(`             ${d.pinned ? 'pinned ' : ''}${d.firstScreen ? 'first-screen ' : ''}${printable(d.href, 90)} ← ${d.labels.map((l) => `"${printable(l, 40)}"`).join(', ')}`);
        }
        if (record.why) console.log(`why          ${printable(record.why, 200)}`);
        console.log(`purpose      ${purpose ? `${purpose.kind} (${Math.round((purpose.confidence ?? 0) * 100)}%)` : 'none — the asks are not judged'}`);
        for (const f of record.reading.findings) console.log(`${f.kind === 'gap' ? 'GAP' : 'ok '}          ${printable(f.text, 240)}`);
    }
    console.log(`written      ${path}`);
} catch (e) {
    console.error(`proposition failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
