#!/usr/bin/env node
/**
 * REFRESH
 *
 *   node tools/audit/refresh.mjs craft/storage/audits
 *
 * Rewrites the checklists on every report.json under a directory — each lead's and each
 * competitor's — from what that record already holds. No capture, no model, no network:
 * it is lib/checks.mjs and lib/expectations.mjs run again, so a changed threshold or a
 * reworded suggestion reaches reports that were written before it.
 *
 * IT TOUCHES TWO KEYS AND NOTHING ELSE: `checks`, and `reading.checks` where a reading
 * exists. Re-running data.mjs instead would rewrite report.json from scratch and drop
 * everything purpose, proposition and summary patched into it.
 *
 * What it cannot give an old report is PageSpeed's points-lost line: that was never
 * collected for it, so the report keeps the plainer sentence until it is audited again.
 */
import {readdirSync, readFileSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {checks} from './lib/checks.mjs';
import {read} from './lib/expectations.mjs';
import {printable} from './lib/printable.mjs';

/** Every report.json under root, one level of competitor below each lead. */
export function reportsUnder(root) {
    const found = [];
    for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (!statSync(dir).isDirectory()) continue;
        for (const path of [join(dir, 'report.json'), join(dir, 'competitor', 'report.json')]) {
            if (existsSync(path)) found.push(path);
        }
    }

    return found;
}

/** The record with its checklists rewritten. Everything else is returned as it came. */
export function refreshed(report) {
    const out = {...report, checks: checks(report)};
    if (report.reading) {
        out.reading = {...report.reading, checks: read(report).checks};
    }

    return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const root = process.argv[2];
    if (!root || !existsSync(root)) {
        console.error('usage: node tools/audit/refresh.mjs <auditsDir>');
        process.exit(1);
    }
    let ok = 0;
    let failed = 0;
    for (const path of reportsUnder(root)) {
        try {
            const report = JSON.parse(readFileSync(path, 'utf8'));
            // Written in place, so the file keeps its owner and its 0600.
            writeFileSync(path, JSON.stringify(refreshed(report), null, 1));
            ok++;
            console.log(`refreshed    ${printable(path)}  ${printable(report.url ?? '')}`);
        } catch (e) {
            failed++;
            console.error(`failed       ${printable(path)}: ${printable(e.message, 200)}`);
        }
    }
    console.log(`${ok} refreshed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}
