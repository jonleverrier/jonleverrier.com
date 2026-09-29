/**
 * SHOWBOARD — browser smoke tests for /tools/showboard.
 *
 *   node --test tools/showboard/test/*.test.mjs
 *   SHOWBOARD_URL=https://example.test/tools/showboard node --test tools/showboard/test/*.test.mjs
 *
 * Drives the real page in Chromium (Playwright), one named test per thing the tool
 * promises, so a change that breaks one says which. Needs the site running — the local
 * ddev site by default — and a build (`ddev exec "npm run build"`): the page serves the
 * built bundle, not the source.
 *
 * NO COMMITTED FIXTURES. The screenshots (four shapes, so masonry and pinning have
 * something to do) and the settings files are made fresh in a temp directory each run,
 * so the tests cannot drift from files nobody remembers the reason for.
 *
 * EVERY TEST ALSO FAILS ON A SCRIPT ERROR — anything the page throws or logs as an
 * error while the test runs. Most breakage shows up there first.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import sharp from 'sharp';

const URL = process.env.SHOWBOARD_URL || 'https://jonleverrier2.local/tools/showboard';
const DIR = mkdtempSync(join(tmpdir(), 'showboard-'));

// Four shapes: landscape, near-square, wide and tall.
const SHOTS = [[3200, 1800, '#c0504d'], [1600, 1800, '#4f81bd'], [2220, 1480, '#9bbb59'], [1200, 2400, '#8064a2']]
    .map(([w, h, colour], i) => ({path: join(DIR, `shot-${i}.png`), w, h, colour}));

const settingsFile = (name, data) => {
    const path = join(DIR, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
};

let browser;

before(async () => {
    await Promise.all(SHOTS.map(({path, w, h, colour}) => sharp({create: {width: w, height: h, channels: 3, background: colour}}).png().toFile(path)));
    // GPU flags so WebGL renders for real; without them Chromium falls back to software.
    browser = await chromium.launch({args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']});
});

after(async () => {
    await browser?.close();
});

/** A fresh page on the tool, with its errors collected. */
async function openTool() {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}, ignoreHTTPSErrors: true, acceptDownloads: true});
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
    await page.goto(URL, {waitUntil: 'networkidle'});
    return page;
}

/** Close the page and fail the test if anything went wrong in it. */
async function done(page) {
    const errors = page.errors;
    await page.close();
    assert.deepEqual(errors, [], 'the page logged script errors');
}

const visibleSections = (page) => page.$$eval('.c-tool__sec', (secs) => secs.filter((s) => s.offsetParent !== null).map((s) => s.querySelector('h2').textContent));

async function addShots(page, shots = SHOTS) {
    await page.setInputFiles('#sb-file', shots.map((s) => s.path));
    await page.waitForFunction((n) => document.querySelectorAll('.c-showboard__shot').length >= n, shots.length);
}

async function setSize(page, w, h) {
    await page.fill('#sb-outw', String(w)); await page.press('#sb-outw', 'Enter');
    await page.fill('#sb-outh', String(h)); await page.press('#sb-outh', 'Enter');
}

async function toast(page) {
    await page.waitForSelector('#sb-toast.is-visible');
    return {text: await page.textContent('#sb-toast'), tick: (await page.getAttribute('#sb-toast', 'class')).includes('c-tool__toast--success')};
}

async function download(page, selector) {
    const [file] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
    const path = join(DIR, file.suggestedFilename());
    await file.saveAs(path);
    return {name: file.suggestedFilename(), path};
}

/* ------------------------------------------------------------------ the empty tool */

test('an empty tool shows only Setup, and invites a drop', async () => {
    const page = await openTool();
    assert.deepEqual(await visibleSections(page), ['Setup']);
    assert.match(await page.textContent('.c-showboard__empty-text'), /Drop screenshots or settings/);
    assert.equal(await page.inputValue('#sb-outw'), '3200');
    assert.equal(await page.inputValue('#sb-outh'), '1800');
    await done(page);
});

/* ------------------------------------------------------------------ screenshots */

test('adding screenshots reveals the rest of the controls', async () => {
    const page = await openTool();
    await addShots(page);
    assert.deepEqual(await visibleSections(page), ['Setup', 'Arrangement', 'Camera', 'Screens', 'Surface', 'Export']);
    assert.equal(await page.textContent('#sb-count'), `${SHOTS.length} loaded`);
    assert.equal(await page.isVisible('.c-showboard__empty'), false);
    await done(page);
});

test('starring a screenshot pins it, and says so to a screen reader', async () => {
    const page = await openTool();
    await addShots(page);
    const pin = '.c-showboard__shot:nth-child(2) .c-showboard__shot-btn--pin';
    await page.click(pin);
    assert.match(await page.getAttribute('.c-showboard__shot:nth-child(2)', 'class'), /c-showboard__shot--pinned/);
    assert.equal(await page.getAttribute(pin, 'aria-pressed'), 'true');
    await done(page);
});

/** Each solid screen in a flat-lay PNG, as {colour index, centre x, centre y}. */
async function screensIn(path) {
    const {data, info} = await sharp(path).resize({width: 800}).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const rgb = SHOTS.map(({colour}) => [1, 3, 5].map((o) => parseInt(colour.slice(o, o + 2), 16)));
    const W = info.width, H = info.height, seen = new Uint8Array(W * H), out = [];
    const which = (p) => rgb.findIndex((c) => Math.abs(c[0] - data[p * 3]) + Math.abs(c[1] - data[p * 3 + 1]) + Math.abs(c[2] - data[p * 3 + 2]) < 40);
    for (let p = 0; p < W * H; p++) {
        if (seen[p]) continue;
        const k = which(p);
        if (k < 0) continue;
        let sx = 0, sy = 0, count = 0;
        const stack = [p];
        seen[p] = 1;
        while (stack.length) {
            const q = stack.pop(), x = q % W, y = (q - x) / W;
            sx += x; sy += y; count++;
            for (const r of [x > 0 && q - 1, x < W - 1 && q + 1, y > 0 && q - W, y < H - 1 && q + W]) {
                if (r !== false && !seen[r] && which(r) === k) { seen[r] = 1; stack.push(r); }
            }
        }
        if (count > 30) out.push({k, x: sx / count - W / 2, y: sy / count - H / 2});
    }
    return out;
}

// With a set repeated, the star pins ONE copy to the middle. The rest are dealt like
// any other screen — before, all ten copies took the middle cells (Jon, 29 Sep 2026).
test('a starred screenshot puts one copy in the middle, not every repeat', async () => {
    const page = await openTool();
    await addShots(page);
    await page.$eval('#sb-repeat', (el) => { el.value = '10'; el.dispatchEvent(new Event('input', {bubbles: true})); });
    await page.check('#sb-shuffle');
    await page.click('.c-showboard__shot:has(.c-showboard__shot-name:text-is("shot-0.png")) .c-showboard__shot-btn--pin');
    const file = await download(page, '#sb-png');
    const screens = await screensIn(file.path);
    const starred = screens.filter((s) => s.k === 0);
    assert.equal(starred.length, 10, 'all ten copies of the starred screenshot are drawn');
    const byCentre = screens.slice().sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    assert.equal(byCentre[0].k, 0, 'the screen nearest the middle is the starred one');
    const middleStarred = byCentre.slice(0, 10).filter((s) => s.k === 0).length;
    assert.ok(middleStarred <= 4, `the ten most central screens hold ${middleStarred} starred copies`);
    await done(page);
});

test('removing the last screenshot hides the controls again', async () => {
    const page = await openTool();
    await addShots(page, SHOTS.slice(0, 1));
    await page.click('.c-showboard__shot-btn--remove');
    assert.deepEqual(await visibleSections(page), ['Setup']);
    await done(page);
});

/* ------------------------------------------------------------------ size */

test('the size is clamped to 320-5000 a side', async () => {
    const page = await openTool();
    await setSize(page, 9000, 10);
    assert.equal(await page.inputValue('#sb-outw'), '5000');
    assert.equal(await page.inputValue('#sb-outh'), '320');
    await done(page);
});

test('a portrait size makes a portrait preview', async () => {
    const page = await openTool();
    await setSize(page, 1080, 1920);
    const box = await page.locator('#sb-frame').boundingBox();
    assert.ok(box.height > box.width, `preview is ${box.width}x${box.height}`);
    assert.ok(Math.abs(box.width / box.height - 1080 / 1920) < 0.01, 'and in the export\'s proportions');
    await done(page);
});

/* ------------------------------------------------------------------ the stage */

test('dragging or scrolling over the stage does not move the camera', async () => {
    const page = await openTool();
    await addShots(page);
    const camera = () => page.evaluate(() => ['yaw', 'pitch', 'zoom'].map((k) => document.querySelector('#sb-' + k).value).join(','));
    const before = await camera();
    const box = await page.locator('#sb-frame').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 100, {steps: 8});
    await page.mouse.up();
    await page.mouse.wheel(0, -400);
    assert.equal(await camera(), before);
    await done(page);
});

/* ------------------------------------------------------------------ export */

test('Save PNG downloads at exactly the chosen size', async () => {
    const page = await openTool();
    await addShots(page);
    await setSize(page, 1600, 1200);
    const file = await download(page, '#sb-png');
    assert.equal(file.name, 'showboard-1600x1200.png');
    const meta = await sharp(file.path).metadata();
    assert.deepEqual([meta.width, meta.height], [1600, 1200]);
    const t = await toast(page);
    assert.match(t.text, /^Saved PNG · 1600 × 1200/);
    assert.equal(t.tick, true);
    await done(page);
});

test('the PNG is opaque white by default, and transparent when asked', async () => {
    const page = await openTool();
    await addShots(page, SHOTS.slice(0, 1));
    const corner = async (path) => [...(await sharp(path).extract({left: 2, top: 2, width: 1, height: 1}).ensureAlpha().raw().toBuffer())];
    const opaque = await download(page, '#sb-png');
    assert.deepEqual(await corner(opaque.path), [255, 255, 255, 255]);
    await page.check('#sb-alpha');
    const clear = await download(page, '#sb-png');
    assert.equal((await corner(clear.path))[3], 0, 'corner alpha');
    await done(page);
});

/* ------------------------------------------------------------------ settings */

test('Export writes the settings only, and they load back onto new screenshots', async () => {
    let page = await openTool();
    await addShots(page);
    await page.click('[data-preset="iso"]');
    await setSize(page, 1500, 1500);
    const file = await download(page, '#sb-settings');
    assert.equal(file.name, 'showboard-settings-1500x1500.json');
    const data = JSON.parse(readFileSync(file.path, 'utf8'));
    assert.equal(data.tool, 'showboard');
    assert.equal(data.format, 2);
    assert.equal('screenshots' in data, false, 'no screenshot references');
    assert.equal(data.settings.outW, 1500);
    await done(page);

    page = await openTool();
    await page.setInputFiles('#sb-file', [file.path]);
    const t = await toast(page);
    assert.equal(t.text, 'Settings loaded');
    assert.equal(t.tick, true);
    assert.equal(await page.inputValue('#sb-outw'), '1500');
    assert.equal(await page.inputValue('#sb-yaw'), String(data.settings.yaw));
    assert.match(await page.textContent('.c-showboard__empty-text'), /^Drop screenshots from a previous session here/);
    await addShots(page, SHOTS.slice(2));
    assert.equal(await page.inputValue('#sb-outw'), '1500', 'adding screenshots keeps the loaded look');
    await done(page);
});

test('settings saved under the old name (Surface) still load', async () => {
    const page = await openTool();
    const legacy = settingsFile('legacy.json', {tool: 'surface', format: 1, settings: {outW: 1234, outH: 900}, screenshots: [{name: 'a.png'}]});
    await page.setInputFiles('#sb-file', [legacy]);
    assert.equal((await toast(page)).text, 'Settings loaded');
    assert.equal(await page.inputValue('#sb-outw'), '1234');
    await done(page);
});

test('a JSON file that is not Showboard settings is refused, and changes nothing', async () => {
    const page = await openTool();
    await page.setInputFiles('#sb-file', [settingsFile('foreign.json', {hello: 'world'})]);
    const t = await toast(page);
    assert.equal(t.text, 'That file is not Showboard settings');
    assert.equal(t.tick, false);
    assert.equal(await page.inputValue('#sb-outw'), '3200');
    await done(page);
});

test('bad values in a settings file are ignored, good ones taken', async () => {
    const page = await openTool();
    await page.setInputFiles('#sb-file', [settingsFile('mixed.json', {tool: 'showboard', format: 2, settings: {bg: 'red', yaw: 'left', outW: 2000, gap: 0.5}})]);
    await toast(page);
    assert.equal(await page.inputValue('#sb-bg-hex'), '#FFFFFF', 'a colour that is not hex is ignored');
    assert.equal(await page.inputValue('#sb-yaw'), '0', 'a string where a number belongs is ignored');
    assert.equal(await page.inputValue('#sb-outw'), '2000');
    assert.equal(await page.inputValue('#sb-gap'), '0.5');
    await done(page);
});

/* ------------------------------------------------------------------ reset */

test('Reset asks first, and Cancel or Escape keep the work', async () => {
    const page = await openTool();
    await addShots(page);
    await page.click('#sb-reset');
    assert.equal(await page.$eval('#sb-confirm', (d) => d.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel', 'Cancel has focus');
    await page.keyboard.press('Escape');
    await page.click('#sb-reset');
    await page.click('#sb-confirm button[value="cancel"]');
    assert.equal(await page.$$eval('.c-showboard__shot', (s) => s.length), SHOTS.length);
    await done(page);
});

test('confirming Reset clears every screenshot and setting', async () => {
    const page = await openTool();
    await addShots(page);
    await page.click('[data-preset="stand"]');
    await setSize(page, 1000, 1000);
    await page.click('#sb-reset');
    await page.click('#sb-confirm button[value="reset"]');
    const t = await toast(page);
    assert.equal(t.text, 'Everything reset');
    assert.equal(t.tick, true);
    assert.equal(await page.$$eval('.c-showboard__shot', (s) => s.length), 0);
    assert.equal(await page.inputValue('#sb-outw'), '3200');
    assert.equal(await page.inputValue('#sb-yaw'), '0');
    assert.deepEqual(await visibleSections(page), ['Setup']);
    await done(page);
});
