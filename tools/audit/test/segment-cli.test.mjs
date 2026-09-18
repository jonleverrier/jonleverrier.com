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
import {mkdtempSync, copyFileSync, existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {segmentTall} from '../lib/xycut.mjs';
import {leaves, totalArea} from '../lib/blocks.mjs';

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

/**
 * A directory whose inputs make the segmenter produce a tree that is NOT a partition.
 *
 * 240x500, one quiet band at rows 190..260, and one rect whose height is a thirds
 * fraction — which is what getBoundingClientRect returns for a three-column grid, a
 * fractional line-height, or anything under a transform: scale. The cut snaps onto that
 * fractional edge, and the two children's areas then no longer sum to the image's.
 *
 * Nothing is mutated to arrange this: it is ordinary input, arriving through the door
 * the README leaves open ("a screenshot from somewhere else, an older capture").
 */
const violatingDir = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-broken-'));
    const width = 240, height = 500;
    const raw = Buffer.alloc(width * height * 3, 255);
    for (let y = 0; y < height; y++) {
        if (y >= 190 && y < 260) continue;
        for (let x = 0; x < width; x++) {
            const v = (x + y) % 2 === 0 ? 0 : 255;
            const i = (y * width + x) * 3;
            raw[i] = raw[i + 1] = raw[i + 2] = v;
        }
    }
    await sharp(raw, {raw: {width, height, channels: 3}}).png().toFile(join(dir, 'fullpage.png'));

    return {dir, rects: [{x: 0, y: 100, w: 240, h: 100.33333333333334, tag: 'section', boxed: false, text: ''}]};
};

// FINDING 2 AND FINDING 8 TOGETHER: the CLI printed "area check BROKEN" and then exited
// 0 with blocks.json and debug.png already on disk, and a run that failed for any other
// reason left the PREVIOUS run's blocks.json in place. Either way a caller reading the
// file gets a number that is not a measurement of this page.
test('a tree that is not a partition exits non-zero and leaves no blocks.json behind', async () => {
    const {dir, rects} = await violatingDir();

    // A good run first, so there is something on disk for a bad run to leave behind.
    await run('node', [CLI, dir]);
    assert.ok(existsSync(join(dir, 'blocks.json')), 'the pixel-only run should succeed');

    writeFileSync(join(dir, 'rects.json'), JSON.stringify(rects, null, 1));

    // The premise, in-process: if this input ever stops breaking the invariant the test
    // below would be proving nothing, so say which of the two has changed.
    const {edges, width, height} = await edgeMapFromPng(join(dir, 'fullpage.png'));
    const ls = leaves(segmentTall(edges, width, height, {maxDepth: 4, rects}));
    assert.notEqual(
        totalArea(ls),
        width * height,
        'this construction no longer violates the partition — find another one, do not delete the test',
    );

    assert.notEqual(await exitCode(dir), 0, 'a broken partition must not exit 0');
    assert.equal(
        existsSync(join(dir, 'blocks.json')),
        false,
        'the previous run\'s tree must not survive a failed run',
    );
});
