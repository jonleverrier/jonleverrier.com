/**
 * STYLES, IN A BROWSER
 *
 *   node --test tools/audit/test/styles-page.test.mjs
 *
 * jonleverrier.com, 26 Sep 2026: the report said the page used two colours a person cannot
 * tell apart — its navy rgb(12, 36, 60) and rgb(13, 38, 64). The second is the SAME navy:
 * the ask bar's microphone button is rgba(12, 36, 60, 0.08), and reading a colour back off a
 * canvas at 8% opacity loses precision (the pixel is stored premultiplied, 20/255 of each
 * channel, and un-premultiplied on the way out). The census reported a rounding error as
 * a second colour, and every site with a faint tint of its own brand colour can be hit.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {COLLECT_STYLES} from '../lib/styles.mjs';

const PAGE = '<!doctype html><html><head><title>Tints</title></head><body style="margin:0;background:#fff">'
    + '<h1 style="color:#0c243c;font-size:64px">Navy heading</h1>'
    + '<button style="width:44px;height:56px;border:0;background:rgba(12, 36, 60, 0.08)">mic</button>'
    + '<p style="color:color(srgb 1 1 0.835);background:#333">A colour written the modern way</p>'
    + '</body></html>';

let server;
let base;
let browser;

before(async () => {
    server = createServer((_, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(PAGE));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

test('a faint tint of a colour is recorded as that colour, not a rounding error of it', async () => {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    await page.goto(base, {waitUntil: 'load'});
    const {colours} = await page.evaluate(COLLECT_STYLES);
    await page.close();
    const values = colours.map((c) => c.colour);

    assert.ok(values.includes('rgba(12, 36, 60, 0.080)'), values.join(' | '));
    assert.equal(values.some((v) => /\b13, 38, 64\b/.test(v)), false, 'the premultiplied rounding error');
    assert.ok(values.includes('rgb(255, 255, 213)'), 'color(srgb …) still converts, as boondmanager.com needed');
});
