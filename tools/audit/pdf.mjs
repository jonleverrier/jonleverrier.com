#!/usr/bin/env node
/**
 * PHASE 4 — PDF
 *
 *   node tools/audit/pdf.mjs <outDir> [--out=report.pdf] [--pages=12] [--url=...] [--from=...] [--logo=...]
 *
 * Reads meta.json, blocks.json and debug.png from a finished audit directory and writes a
 * PDF beside them. The queue job calls this; see lib/pdf.mjs for why the template in it is
 * a stub and what replaces it.
 */
import {renderPdf, MAX_IMAGE_PAGES} from './lib/pdf.mjs';
import {printable} from './lib/printable.mjs';

const outDir = process.argv[2];
// EVERYTHING AFTER THE FIRST `=`, not `.split('=')[1]`. A URL carries its own equals signs:
// `--url=http://host/index.php?p=actions/...` split that way yields `http://host/index.php?p`,
// which Craft answers with the SITE HOMEPAGE. The report printed this site's front page
// into a lead's PDF and nothing failed.
const arg = (name) => {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));

    return found ? found.slice(name.length + 3) : undefined;
};
if (!outDir) {
    console.error('usage: node tools/audit/pdf.mjs <outDir> [--out=report.pdf] [--pages=N]');
    process.exit(1);
}

process.stderr.write(`rendering ${printable(outDir)}\n`);
try {
    const got = await renderPdf(outDir, {
        out: arg('out'),
        maxImagePages: Number(arg('pages')) || MAX_IMAGE_PAGES,
        // WITH A URL THIS PRINTS CRAFT'S REPORT, and without one it prints the stub. The
        // queue job passes a signed one; run by hand there is no application to ask.
        url: arg('url'),
        // Who the report is from, for the running footer. Craft passes its own site URL.
        from: arg('from'),
        // An SVG or PNG for the running footer, inlined as a data URI.
        logo: arg('logo'),
    });
    console.log(`url          ${printable(got.data.url)}`);
    console.log(`blocks       ${got.data.blocks}`);
    console.log(`caveats      ${got.data.noteCodes.join(', ') || 'none'}`);
    console.log(`template     ${arg('url') ? 'craft' : 'stub'}`);
    if (got.imagePages !== null) {
        console.log(`image pages  ${got.imagePages} of ${got.imagePagesAvailable}`
            + `${got.truncated ? '   <-- TRUNCATED, the page is taller than the ceiling' : ''}`);
    }
    console.log(`size         ${(got.bytes / 1048576).toFixed(2)} MB`);
    console.log(`written      ${printable(got.path)}`);
} catch (e) {
    console.error(`pdf failed: ${printable(e.message, 300)}`);
    process.exit(1);
}
