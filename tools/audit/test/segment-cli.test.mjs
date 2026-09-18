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
import {register} from 'node:module';
import {mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {edgeMapFromPng} from '../lib/edges.mjs';
import {segmentTall} from '../lib/xycut.mjs';
import {leaves, totalArea} from '../lib/blocks.mjs';

const run = promisify(execFile);
const CLI = 'tools/audit/segment.mjs';
const MUTANT = './tools/audit/test/mutants/register-not-a-partition.mjs';

/** A directory shaped the way the CLI expects: one fullpage.png. */
const fixtureDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'));
    copyFileSync('tools/audit/fixtures/jonleverrier.png', join(dir, 'fullpage.png'));

    return dir;
};

/** Exit code, stdout and stderr, treating a non-zero exit as a result and not a throw. */
const attempt = async (args, nodeArgs = []) => {
    try {
        const {stdout, stderr} = await run('node', [...nodeArgs, CLI, ...args]);

        return {code: 0, stdout, stderr};
    } catch (e) {
        return {code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? ''};
    }
};

const exitCode = async (...args) => (await attempt(args)).code;

/** Every coordinate in a block tree, root and descendants. */
const coordinates = (b) => [b.x, b.y, b.w, b.h, ...(b.children ?? []).flatMap(coordinates)];

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
 * A directory the segmenter can work on, plus rects whose height is a thirds fraction —
 * which is what getBoundingClientRect returns for a three-column grid, a fractional
 * line-height, or anything under a transform: scale.
 *
 * 240x500, one quiet band at rows 190..260. Handed to segmentTall RAW, the cut snaps
 * onto that fractional edge and the two children's areas no longer sum to the image's.
 * That is the door this input came in through, and the door the rects loader now shuts.
 *
 * Nothing is mutated to arrange it: it is ordinary input, arriving the way the README
 * invites ("a screenshot from somewhere else, an older capture").
 */
const fractionalDir = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-fractional-'));
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

// FINDING 3. This input used to exit 1 — correctly, in that the tree really was not a
// partition, but with a message blaming the segmenter for what the rects did. A
// fractional rect is an ordinary out-of-house file rather than an attack, and rounding
// it keeps the file usable while restoring the premise the invariant assumes.
test('a fractional rect is rounded, and the run that used to fail now succeeds', async () => {
    const {dir, rects} = await fractionalDir();
    writeFileSync(join(dir, 'rects.json'), JSON.stringify(rects, null, 1));

    // The premise, in-process and unrepaired: if this construction ever stops violating
    // the partition, the run below proves nothing. Say which of the two has changed.
    const {edges, width, height} = await edgeMapFromPng(join(dir, 'fullpage.png'));
    const ls = leaves(segmentTall(edges, width, height, {maxDepth: 4, rects}));
    assert.notEqual(
        totalArea(ls),
        width * height,
        'the raw fractional rect no longer breaks the partition — find another one, do not delete the test',
    );

    const {code, stdout, stderr} = await attempt([dir]);
    assert.equal(code, 0, `the repaired run must succeed, stderr was: ${stderr}`);
    assert.match(stdout, /^area check\s+conserved$/m);
    assert.match(stderr, /rounded to whole pixels/, 'and must say that it repaired something');

    const written = JSON.parse(readFileSync(join(dir, 'blocks.json'), 'utf8'));
    for (const n of coordinates(written)) {
        assert.ok(Number.isInteger(n), `every coordinate must be whole pixels, got ${n}`);
    }
});

// The other three faces of the same missing validation, all measured by the reviewer:
// `[1,2,3]` was accepted with stderr announcing "snapping cuts to 3 DOM rects" while
// snapping to nothing, `null` was reported as "no rects.json in <dir>" with the file
// sitting right there, and `{"y": null}` silently moved a cut by 50px.
for (const [name, body] of [
    ['null', 'null'],
    ['an array of numbers', '[1, 2, 3]'],
    ['a bare object', '{"x": 0, "y": 0, "w": 10, "h": 10, "tag": "div"}'],
    ['only a rect with a null coordinate', '[{"x": 0, "y": null, "w": 240, "h": 100, "tag": "section"}]'],
    ['nonsense', 'not json at all'],
]) {
    test(`rects.json containing ${name} fails clearly, and is never called absent`, async () => {
        const {dir} = await fractionalDir();
        writeFileSync(join(dir, 'rects.json'), body);
        const {code, stderr} = await attempt([dir]);
        assert.equal(code, 1, `should have failed, stderr was: ${stderr}`);
        assert.match(stderr, /rects\.json/, 'the message must name the file it is about');
        assert.doesNotMatch(stderr, /no rects\.json/, 'the file is right there');
    });
}

test('one unusable rect among good ones is dropped and counted, not fatal', async () => {
    const {dir} = await fractionalDir();
    writeFileSync(join(dir, 'rects.json'), JSON.stringify([
        {x: 0, y: 100, w: 240, h: 100, tag: 'section', boxed: false, text: ''},
        {x: 0, y: null, w: 240, h: 100, tag: 'section', boxed: false, text: ''},
    ]));
    const {code, stderr} = await attempt([dir]);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /1 dropped as unusable/);
    assert.match(stderr, /snapping cuts to 1 DOM rect/, 'and must count what it actually kept');
});

// FINDING 8, which needs a run that fails for SOME reason; an unusable rects file is one.
test('a failed run does not leave the previous run\'s blocks.json behind', async () => {
    const {dir} = await fractionalDir();
    await run('node', [CLI, dir]);
    assert.ok(existsSync(join(dir, 'blocks.json')), 'the pixel-only run should succeed');

    writeFileSync(join(dir, 'rects.json'), '[1, 2, 3]');
    assert.notEqual(await exitCode(dir), 0);
    assert.equal(
        existsSync(join(dir, 'blocks.json')),
        false,
        'the previous run\'s tree must not survive a failed run',
    );
});

// FINDING 2, with the real segmenter replaced by one returning overlapping children. The
// CLI used to print `area check BROKEN` and exit 0 with blocks.json already on disk. See
// test/mutants/not-a-partition.mjs for why this is a mutant and no longer an input.
test('a tree that is not a partition exits non-zero and writes nothing', async (t) => {
    if (typeof register !== 'function') {
        t.skip('module.register (Node 20.6+) is needed to install the mutant segmenter');

        return;
    }
    const {dir} = await fractionalDir();
    const {code, stderr} = await attempt([dir], ['--import', MUTANT]);
    assert.equal(code, 1, 'a broken partition must not exit 0');
    assert.match(stderr, /overlap|area/, 'and must say what was wrong with the tree');
    assert.equal(existsSync(join(dir, 'blocks.json')), false, 'nothing may be written');
    assert.equal(existsSync(join(dir, 'debug.png')), false, 'not even the debug image');
});
