/**
 * A PAGE THAT TAKES THE MAIN THREAD
 *
 *   node --test tools/audit/test/main-thread.test.mjs
 *
 * pinpointhq.com's Rive animations draw every frame in software with no GPU, ~750ms a
 * frame, so every evaluate and screenshot queued behind them and the capture ran out of
 * budget. See RAF_GATE in lib/capture.mjs.
 *
 * TESTED ON THE MECHANISM with a local page whose animation loop busy-waits — the cost
 * pinpointhq.com pays in drawImage — beside an idle page that must be left alone.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {RAF_GATE, SATURATED_MS, freezeIfSaturated} from '../lib/capture.mjs';

const BUSY = '<!doctype html><title>Busy</title><body><script>'
    + 'const frame = () => { const end = performance.now() + 600; while (performance.now() < end) {} requestAnimationFrame(frame); };'
    + 'requestAnimationFrame(frame);</script></body>';
const IDLE = '<!doctype html><title>Idle</title><body><p>Nothing moves.</p></body>';

let server;
let base;
let browser;

before(async () => {
    server = createServer((req, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(req.url === '/busy' ? BUSY : IDLE));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

const open = async (path) => {
    const page = await browser.newPage();
    await page.addInitScript(RAF_GATE);
    await page.goto(base + path, {waitUntil: 'load'});

    return page;
};

const roundTrip = async (page) => {
    const t = Date.now();
    await page.evaluate(() => 1);

    return Date.now() - t;
};

test('a page whose animation loop holds the main thread is frozen, and is fast afterwards', async () => {
    const page = await open('/busy');
    const result = await freezeIfSaturated(page);
    assert.equal(result.frozen, true);
    assert.ok(result.evaluateMs > SATURATED_MS, `measured ${result.evaluateMs}ms`);
    // The frame in flight when the switch closed still finishes; after that, nothing.
    await page.waitForTimeout(700);
    const after = await roundTrip(page);
    assert.ok(after < 50, `still ${after}ms a round trip once frozen`);
    await page.close();
});

test('an idle page is left running', async () => {
    const page = await open('/idle');
    const result = await freezeIfSaturated(page);
    assert.equal(result.frozen, false);
    assert.equal(await page.evaluate(() => window.__auditRafFrozen), false);
    await page.close();
});

// THE BUDGET RUNNING OUT must fail with the budget's own message, and must not start the
// step it refuses — a step started first was orphaned when the budget threw, and its
// rejection on browser close took the process down before the reason was printed.
test('a spent budget refuses the step before starting it', async () => {
    const {budget, boundedStep} = await import('../lib/capture.mjs');
    const step = boundedStep(budget(0));
    let started = false;
    assert.throws(
        () => step('photographing the whole page in one shot', () => { started = true; return Promise.resolve(); }),
        /capture budget was spent before photographing the whole page in one shot/,
    );
    assert.equal(started, false);
});
