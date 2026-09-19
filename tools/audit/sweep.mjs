#!/usr/bin/env node
/**
 * SWEEP
 *
 *   node tools/audit/sweep.mjs <urlsFile> <outRoot>
 *
 * Capture and analyse every URL in a file, one per line, and print one row each.
 *
 * The corpus this was built against is 27 homepages whose debug images have been reviewed
 * by eye by the person the tool is for. Re-running it after a change is how a regression
 * is found before a prospect finds it.
 *
 * THE TABLE IS NOT THE VERDICT. A block count moving in a plausible direction has
 * coincided with the wrong fix more than once on this project. Crop the region and look.
 *
 * Re-running is cheap: analyse.mjs reuses a stored answer whenever a page's structural
 * signature is unchanged, so a second sweep pays only for the pages that actually moved.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {leaves} from './lib/blocks.mjs';
import {noteCodes} from './lib/notes.mjs';

const run = promisify(execFile);
const [urlsFile, outRoot] = process.argv.slice(2);
if (!urlsFile || !outRoot) {
    console.error('usage: node tools/audit/sweep.mjs <urlsFile> <outRoot>');
    process.exit(1);
}

const urls = readFileSync(urlsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const slug = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/[^a-z0-9.]/gi, '-');
const row = (a, b, c, d) => console.log(`${String(a).padEnd(22)} ${String(b).padStart(7)}  ${String(c).padStart(8)}  ${d}`);

const rows = [];
row('SITE', 'BLOCKS', 'UNCLASS', 'NOTES');
for (const url of urls) {
    const dir = join(outRoot, slug(url));
    const out = {url, dir, blocks: '-', unclassified: '-', notes: '-'};
    try {
        await run('node', ['tools/audit/capture.mjs', url, dir], {timeout: 300000, maxBuffer: 1 << 24});
        await run('node', ['tools/audit/analyse.mjs', dir], {timeout: 300000, maxBuffer: 1 << 24});
        const {notes, tree} = JSON.parse(readFileSync(join(dir, 'blocks.json'), 'utf8'));
        const ls = leaves(tree);
        const unclassified = ls.filter((l) => l.label?.category === 'unclassified')
            .reduce((a, l) => a + l.w * l.h, 0) / (tree.w * tree.h);
        out.blocks = ls.length;
        out.unclassified = `${(unclassified * 100).toFixed(1)}%`;
        out.notes = noteCodes(notes).join(',') || 'none';
    } catch (e) {
        const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        out.notes = (text.match(/(?:analysis|capture) failed: (.*)/) ?? [, 'failed'])[1].slice(0, 58);
        out.blocks = 'REFUSED';
    }
    rows.push(out);
    row(slug(url), out.blocks, out.unclassified, out.notes);
}

writeFileSync(join(outRoot, 'sweep.json'), JSON.stringify(rows, null, 1));
const done = rows.filter((r) => typeof r.blocks === 'number');
console.log(`\n${done.length}/${rows.length} measured. Debug images: ${outRoot}/<slug>/debug.png`);
if (existsSync(join(outRoot, 'sweep.json'))) {
    console.log(`Table: ${join(outRoot, 'sweep.json')}`);
}
