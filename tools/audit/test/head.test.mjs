/**
 * HEAD
 *
 *   node --test tools/audit/test/head.test.mjs
 *
 * WHAT THE PAGE SAYS ABOUT ITSELF IN ITS OWN <head>, and why it is worth reading.
 *
 * lib/purpose.mjs classified boondmanager.com from its hero, which said "Work Smart, Grow
 * Fast." — three words carrying nothing about what the company sells. It came back `sell`
 * at 72% where gov.uk and gov.je answer at 96-97%, and its competitor scraped the 0.6
 * confidence floor at exactly 60. A meta description is written for a stranger and usually
 * says the thing the hero is too pleased with itself to say.
 *
 * READ FROM THE PAGE WE ALREADY HAVE OPEN. One evaluate inside the existing capture: no
 * second page load, no model call, nothing to pay for.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {READ_HEAD} from '../lib/capture.mjs';

const page$ = (head, body = '<h1>Hello</h1>') =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

let server;
let base;
let browser;
let page;
let html = '';

test.before(async () => {
    server = createServer((_, res) => {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(html);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
    page = await browser.newPage();
});

test.after(async () => {
    await browser?.close();
    server?.close();
});

const read = async (head, body) => {
    html = page$(head, body);
    await page.goto(base, {waitUntil: 'load'});

    return page.evaluate(READ_HEAD);
};

test('the title and the meta description are read', async () => {
    const got = await read('<title>BoondManager | ERP for consulting firms</title>'
        + '<meta name="description" content="The ERP built for consulting and engineering firms.">');
    assert.equal(got.title, 'BoondManager | ERP for consulting firms');
    assert.equal(got.description, 'The ERP built for consulting and engineering firms.');
});

test('og:description is read separately, because it is often the better-kept one', async () => {
    const got = await read('<meta name="description" content="Short one.">'
        + '<meta property="og:description" content="The longer one somebody actually checked.">');
    assert.equal(got.description, 'Short one.');
    assert.equal(got.ogDescription, 'The longer one somebody actually checked.');
});

test('a JSON-LD organisation description is read', async () => {
    const got = await read(`<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Acme',
        description: 'We make anvils for discerning coyotes.',
    })}</script>`);
    assert.equal(got.schemaDescription, 'We make anvils for discerning coyotes.');
});

test('…including one inside a @graph, which is how most plugins write it', async () => {
    const got = await read(`<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'WebPage', name: 'Home'},
            {'@type': 'Organization', description: 'Buried two levels down.'},
        ],
    })}</script>`);
    assert.equal(got.schemaDescription, 'Buried two levels down.');
});

test('a page with nothing in its head answers with empty strings, not undefined', async () => {
    const got = await read('<title></title>');
    assert.deepEqual(got, {title: '', description: '', ogDescription: '', ogTitle: '', schemaDescription: ''});
});

test('broken JSON-LD is stepped over rather than thrown', async () => {
    const got = await read('<script type="application/ld+json">{ this is not json </script>'
        + '<meta name="description" content="Still read.">');
    assert.equal(got.schemaDescription, '');
    assert.equal(got.description, 'Still read.');
});

test('whitespace is collapsed, because these are written across lines in a template', async () => {
    const got = await read('<meta name="description" content="  Two   lines\n  of it.  ">');
    assert.equal(got.description, 'Two lines of it.');
});

test('a very long description is cut, so one page cannot flood the prompt', async () => {
    const got = await read(`<meta name="description" content="${'word '.repeat(300).trim()}">`);
    assert.ok(got.description.length <= 400, `${got.description.length} > 400`);
});
