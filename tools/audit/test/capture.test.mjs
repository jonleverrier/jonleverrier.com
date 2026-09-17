import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {capturePage, VIEWPORT} from '../lib/capture.mjs';

// Network-gated: this one hits a real site, so it is opt-in and never runs in a
// plain `node --test`. AUDIT_LIVE=1 node --test tools/audit/test/capture.test.mjs
const live = process.env.AUDIT_LIVE === '1';

test('viewport is locked to 1440x900', () => {
    assert.deepEqual(VIEWPORT, {width: 1440, height: 900});
});

test('capturePage writes all four artefacts', {skip: !live}, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const meta = await capturePage('https://example.com', dir);
    for (const f of ['viewport.png', 'fullpage.png', 'meta.json', 'rects.json']) {
        assert.ok(existsSync(join(dir, f)), `${f} missing`);
    }
    assert.ok(meta.fullHeight > 0);
});
