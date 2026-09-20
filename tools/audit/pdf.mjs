#!/usr/bin/env node
/**
 * PHASE 4 — PDF
 *
 *   node tools/audit/pdf.mjs <outDir> [--out=/path/report.pdf] [--pages=12]
 *
 * Reads meta.json, blocks.json and debug.png from a finished audit directory and writes a
 * PDF beside them. The queue job calls this; see lib/pdf.mjs for why the template in it is
 * a stub and what replaces it.
 */
import {renderPdf, MAX_IMAGE_PAGES} from './lib/pdf.mjs';
import {printable} from './lib/printable.mjs';

const outDir = process.argv[2];
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1];
if (!outDir) {
    console.error('usage: node tools/audit/pdf.mjs <outDir> [--out=report.pdf] [--pages=N]');
    process.exit(1);
}

process.stderr.write(`rendering ${printable(outDir)}\n`);
try {
    const got = await renderPdf(outDir, {
        out: arg('out'),
        maxImagePages: Number(arg('pages')) || MAX_IMAGE_PAGES,
    });
    console.log(`url          ${printable(got.data.url)}`);
    console.log(`blocks       ${got.data.blocks}`);
    console.log(`caveats      ${got.data.noteCodes.join(', ') || 'none'}`);
    console.log(`image pages  ${got.imagePages} of ${got.imagePagesAvailable}`
        + `${got.truncated ? '   <-- TRUNCATED, the page is taller than the ceiling' : ''}`);
    console.log(`size         ${(got.bytes / 1048576).toFixed(2)} MB`);
    console.log(`written      ${printable(got.path)}`);
} catch (e) {
    console.error(`pdf failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
