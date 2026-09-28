/**
 * REFRESH
 *
 *   node --test tools/audit/test/refresh.test.mjs
 *
 * The one promise that matters: the checklists are rewritten and nothing else is.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {refreshed, reportsUnder} from '../refresh.mjs';

const record = {
    url: 'https://a.com',
    speed: {score: 47, lab: {fcpMs: 664, lcpMs: 5635, tbtMs: 43, cls: 1.128, speedIndexMs: 2032}},
    weight: null, technical: null, styles: null, brand: null,
    purpose: {kind: 'sell', confidence: 1},
    categories: [{category: 'hero', share: 0.3, firstViewport: 1, blocks: [{}]}],
    reading: {worth: true, lead: 'kept as written', findings: []},
    proposition: {score: {score: 5}},
    summary: {findings: ['kept']},
    checks: {speed: 'stale'},
};

test('only the two checklists change', () => {
    const out = refreshed(record);
    assert.equal(out.checks.speed[0].status, 'poor');
    assert.equal(out.reading.checks.find((c) => c.id === 'promotion').status, 'poor');
    assert.equal(out.reading.lead, 'kept as written', 'the reading itself is not re-read');
    for (const key of ['url', 'proposition', 'summary', 'purpose', 'categories']) {
        assert.deepEqual(out[key], record[key], key);
    }
});

test('a report with no reading does not gain one', () => {
    const {reading, ...bare} = record;
    assert.equal('reading' in refreshed(bare), false);
});

test('the CLI finds every lead and competitor, and rewrites them', () => {
    const root = mkdtempSync(join(tmpdir(), 'refresh-'));
    mkdirSync(join(root, '1', 'competitor'), {recursive: true});
    mkdirSync(join(root, '2'));
    writeFileSync(join(root, '1', 'report.json'), JSON.stringify(record));
    writeFileSync(join(root, '1', 'competitor', 'report.json'), JSON.stringify(record));
    writeFileSync(join(root, 'stray.txt'), '');
    assert.equal(reportsUnder(root).length, 2, 'a directory with no report is skipped');

    const said = execFileSync('node', ['tools/audit/refresh.mjs', root], {encoding: 'utf8'});
    assert.match(said, /2 refreshed, 0 failed/);
    const back = JSON.parse(readFileSync(join(root, '1', 'competitor', 'report.json'), 'utf8'));
    assert.equal(back.checks.speed[0].status, 'poor');
});
