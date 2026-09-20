/**
 * CAPTURE CLI
 *
 *   node --test tools/audit/test/capture-cli.test.mjs
 *
 * THE WRAPPER, NOT THE CAPTURE. Everything capturePage does is covered in
 * slices.test.mjs; what is here is the twenty lines that print the result — and those had
 * no test at all until production found out why they needed one.
 *
 * WHAT HAPPENED. `meta.styles.colours.sameColour` moved to report time, because which
 * colours are the same colour is a judgement at a threshold rather than a measurement.
 * Every unit test passed: they exercise the functions, and the functions were right. This
 * file's one reader of that field was a `console.log` in a CLI nobody had a test for, so a
 * capture that had loaded the page, dismissed the banner, stitched seven slices, measured
 * the bytes and fetched PageSpeed then died on the last line before writing anything —
 * "Cannot read properties of undefined (reading 'length')" — and it died on the server,
 * on the first real audit after a deploy.
 *
 * So the assertion that matters is the cheap one: the CLI runs to the end and exits 0. A
 * summary line that reads a field which no longer exists cannot survive that.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtempSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const run = promisify(execFile);

/**
 * A page with something of everything the summary prints about: two colours, a web font
 * that will not load (so `declared` and `loaded` differ), text to measure, and enough
 * height to need more than one slice.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<style>
  @font-face { font-family: Nope; src: url(/nope.woff2) format('woff2'); }
  body { margin: 0; font-family: Nope, serif; background: #fafafc; color: #1e1e28; }
  .band { background: #1e1e28; color: #fff; padding: 40px; }
  .tall { height: 1400px; padding: 20px; }
</style></head><body>
  <div class="band"><h1>A heading</h1><p>Some words on a dark band.</p></div>
  <div class="tall"><p>More words, far enough down to need a second slice.</p>
  ${'<p>A line of prose to give the page some weight of its own.</p>'.repeat(40)}
  </div>
</body></html>`;
// OVER A KILOBYTE ON PURPOSE. The byte census declares itself unmeasured below
// CENSUS_MIN_BYTES, on the grounds that a page which recorded almost nothing was not
// really measured — which is right, and which a two-line fixture trips.

let server;
let base;

before(async () => {
    server = createServer((req, res) => {
        if (req.url === '/nope.woff2') {
            res.writeHead(404).end();

            return;
        }
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server?.close());

/**
 * The whole point of this file. PageSpeed is not asked for on a localhost URL — Google
 * cannot reach one — so this runs with no keys and no network beyond the local server.
 */
test('the CLI captures a page, prints every line and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-cli-'));
    const {stdout} = await run('node', ['tools/audit/capture.mjs', base, dir], {maxBuffer: 1 << 24});

    // Every line the summary promises. A field that stopped existing takes its line with
    // it, so naming them is how a shape change is noticed here rather than in production.
    for (const line of ['url', 'captured', 'http', 'full height', 'image', 'capture',
        'rects', 'consent', 'scroll cap', 'webgl', 'content ends', 'weight', 'colours',
        'fonts', 'artefacts']) {
        assert.match(stdout, new RegExp(`^${line}\\s`, 'm'), `no "${line}" line`);
    }

    for (const f of ['meta.json', 'fullpage.png', 'rects.json', 'viewport.png']) {
        assert.ok(existsSync(join(dir, f)), `${f} missing`);
    }
});

test('the record carries what the summary printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-cli-'));
    await run('node', ['tools/audit/capture.mjs', base, dir], {maxBuffer: 1 << 24});
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));

    assert.equal(meta.styles.measured, true);
    assert.ok(meta.styles.colours.palette.length, 'the palette is the measurement');
    assert.equal('sameColour' in meta.styles.colours, false, 'and the grouping is not, it is derived later');
    assert.equal(meta.bytes.measured, true);
    // PageSpeed cannot reach a localhost URL, so it is not asked — and the record says
    // "we did not ask" rather than going missing.
    assert.match(meta.psi.error, /not requested/);
});
