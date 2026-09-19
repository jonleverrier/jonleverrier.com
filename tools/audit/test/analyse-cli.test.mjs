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
