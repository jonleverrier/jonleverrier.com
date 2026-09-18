/**
 * SEGMENT CLI
 *
 * The argument gate on tools/audit/segment.mjs, tested by actually running the CLI.
 *
 *   node --test tools/audit/test/segment-cli.test.mjs
 *
 * These run the real binary rather than importing a parser, because the bug this guards
 * against was invisible at the unit level: --depth=abc parsed to NaN, `rect.depth >= NaN`
 * is always false, so the depth cap was REMOVED rather than ignored and the process still
 * exited 0. Only the exit code and the printed depth showed it.
 *
 * The limitation worth knowing: every accepted-case run segments a real fixture, so add
 * them sparingly — one costs about a second. The rejection cases exit before any work.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const run = promisify(execFile);
const CLI = 'tools/audit/segment.mjs';

/** A directory shaped the way the CLI expects: one fullpage.png. */
const fixtureDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'));
    copyFileSync('tools/audit/fixtures/jonleverrier.png', join(dir, 'fullpage.png'));

    return dir;
};

/** The exit code, treating a thrown non-zero exit as the result rather than a failure. */
const exitCode = async (...args) => {
    try {
        await run('node', [CLI, ...args]);

        return 0;
    } catch (e) {
        return e.code;
    }
};

// Number() is generous in three separate directions and none of them are what a person
// typing --depth meant: Number('') and Number(' ') are 0, Number('0x4') is 4, and
// Number('abc') is NaN, which disables the cap entirely.
for (const bad of ['abc', '1.5', '-1', '', ' ', '0x4', 'Infinity', '+4']) {
    test(`--depth=${JSON.stringify(bad)} is rejected with exit 1`, async () => {
        assert.equal(await exitCode(fixtureDir(), `--depth=${bad}`), 1);
    });
}

test('a missing input png exits 1', async () => {
    assert.equal(await exitCode(join(tmpdir(), 'audit-cli-definitely-not-here')), 1);
});

test('no outDir exits 1', async () => {
    assert.equal(await exitCode(), 1);
});

test('a valid depth runs, conserves area, and reports the depth it was given', async () => {
    const {stdout} = await run('node', [CLI, fixtureDir(), '--depth=2']);
    assert.match(stdout, /^depth\s+2$/m, 'should report the depth it was actually given');
    assert.match(stdout, /^area check\s+conserved$/m);
});
