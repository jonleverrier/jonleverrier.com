/**
 * ANALYSE CLI
 *
 *   node --test tools/audit/test/analyse-cli.test.mjs
 *
 * EVERY TEST HERE REFUSES BEFORE THE NETWORK IS TOUCHED, which is the behaviour being
 * asserted as much as it is a convenience. Paying a model to describe an error page is
 * worse than not measuring it: it returns a confident, plausible answer about a page the
 * prospect does not have.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const run = promisify(execFile);
const dirWith = (meta) => {
    const dir = mkdtempSync(join(tmpdir(), 'analyse-'));
    if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));

    return dir;
};

test('no outDir prints usage and exits 1', async () => {
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs']),
        (e) => /usage: node tools\/audit\/analyse\.mjs/.test(e.stderr),
    );
});

test('a directory with no meta.json is refused, not guessed at', async () => {
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dirWith(null)]),
        (e) => /needs a phase 1 capture/.test(e.stdout + e.stderr),
    );
});

test('an error page is refused before any API call is made', async () => {
    const dir = dirWith({url: 'https://example.com', httpStatus: 403, image: {width: 1440, height: 900}});
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dir]),
        (e) => /answered 403/.test(e.stdout + e.stderr),
    );
});

test('a 5xx is refused on the same rule as a 403', async () => {
    const dir = dirWith({url: 'https://example.com', httpStatus: 503, image: {width: 1440, height: 900}});
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dir]),
        (e) => /answered 503/.test(e.stdout + e.stderr),
    );
});

test('a block page is named as one, from the title phase 1 recorded', async () => {
    // gov.gg: its firewall answers a headless browser with a 500 and this title.
    const dir = dirWith({
        url: 'https://gov.gg',
        httpStatus: 500,
        head: {title: 'The URL you requested has been blocked'},
        image: {width: 1440, height: 900},
    });
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dir]),
        (e) => /firewall blocked the capture: it answered 500 with a page titled "The URL you requested has been blocked"/
            .test(e.stdout + e.stderr),
    );
});

test('a location block that answered 200 is refused before any API call', async () => {
    // wahio.design from a UK server: 200, full layout, and this head.
    const dir = dirWith({
        url: 'https://wahio.design',
        httpStatus: 200,
        head: {title: 'Service Unavailable',
            description: 'Our service is currently only available in the European Union.'},
        image: {width: 1440, height: 900},
    });
    await assert.rejects(
        run('node', ['tools/audit/analyse.mjs', dir]),
        (e) => /blocked the capture by location: it answered 200 with a page titled "Service Unavailable"/
            .test(e.stdout + e.stderr),
    );
});
