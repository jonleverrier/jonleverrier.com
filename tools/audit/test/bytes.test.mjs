/**
 * BYTES
 *
 *   node --test tools/audit/test/bytes.test.mjs
 *
 * No browser. A CDP session is an event emitter with a `send`, so a fake one exercises the
 * census exactly as Chromium drives it — which is the point, because the events arrive in
 * an order a real page controls and not one a test would choose.
 *
 * The whole-capture behaviour is in test/slices.test.mjs, against the local page.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {byType, bytesSummary, countBytes, CENSUS_MIN_BYTES} from '../lib/bytes.mjs';

/** Chromium's side of the conversation, as far as this module can tell. */
const fakeCdp = ({failEnable = false} = {}) => {
    const handlers = new Map();

    return {
        sent: [],
        async send(method) {
            if (failEnable && method === 'Network.enable') throw new Error('target closed');
            this.sent.push(method);
        },
        on(event, fn) {
            handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
        emit(event, payload) {
            for (const fn of handlers.get(event) ?? []) fn(payload);
        },
    };
};

/** One request, start to finish, as Chromium reports it. */
const resource = (cdp, id, type, bytes) => {
    cdp.emit('Network.responseReceived', {requestId: id, type});
    cdp.emit('Network.loadingFinished', {requestId: id, encodedDataLength: bytes});
};

test('bytes and requests are counted per type', async () => {
    const cdp = fakeCdp();
    const census = await countBytes(cdp);
    resource(cdp, '1', 'Document', 50000);
    resource(cdp, '2', 'Image', 400000);
    resource(cdp, '3', 'Image', 300000);
    resource(cdp, '4', 'Script', 120000);

    const got = census.result();
    assert.equal(got.measured, true);
    assert.equal(got.afterScroll.bytes, 870000);
    assert.equal(got.afterScroll.requests, 4);
    assert.deepEqual(got.byType[0], {type: 'image', bytes: 700000, requests: 2});
});

/**
 * THE GAP BETWEEN THE TWO MARKS IS THE FINDING, and it is why Lighthouse's number could
 * not be used. kohde.agency measured 1,229 KiB at load and 2,710 KiB after the scroll
 * pass: everything lazy-loaded arrives only when somebody goes down the page, and
 * Lighthouse never does.
 */
test('what arrived before the scroll is kept apart from what arrived during it', async () => {
    const cdp = fakeCdp();
    const census = await countBytes(cdp);
    resource(cdp, '1', 'Document', 1258496);
    census.mark('atLoad');
    resource(cdp, '2', 'Image', 1516544);
    census.mark('afterScroll');

    const got = census.result();
    assert.equal(got.atLoad.bytes, 1258496);
    assert.equal(got.afterScroll.bytes, 2775040);
    assert.ok(got.afterScroll.bytes > got.atLoad.bytes * 2, 'the page more than doubled on scroll');
});

test('an unnamed resource type is collapsed into other rather than dropped', async () => {
    const cdp = fakeCdp();
    const census = await countBytes(cdp);
    resource(cdp, '1', 'Manifest', 900);
    resource(cdp, '2', 'WebSocket', 1200);
    resource(cdp, '3', 'Script', 50000);

    const got = census.result();
    const other = got.byType.find((t) => t.type === 'other');
    assert.deepEqual(other, {type: 'other', bytes: 2100, requests: 2});
    assert.equal(got.afterScroll.bytes, 52100, 'and nothing is lost from the total');
});

test('a response with no matching type still counts', async () => {
    const cdp = fakeCdp();
    const census = await countBytes(cdp);
    // loadingFinished without a preceding responseReceived: a redirect, a cached hit.
    cdp.emit('Network.loadingFinished', {requestId: 'x', encodedDataLength: 4096});
    assert.equal(census.result().afterScroll.bytes, 4096);
});

test('a missing encodedDataLength is nought, never NaN', async () => {
    const cdp = fakeCdp();
    const census = await countBytes(cdp);
    cdp.emit('Network.responseReceived', {requestId: '1', type: 'Script'});
    cdp.emit('Network.loadingFinished', {requestId: '1'});
    const got = census.result();
    assert.equal(got.afterScroll.bytes, 0);
    assert.equal(got.afterScroll.requests, 1);
});

/**
 * A byte count is the least important thing this tool produces and a capture is the most
 * expensive, so nothing here may throw into one. An absence is DECLARED rather than
 * reported as a page that shipped nothing.
 */
test('a census that could not attach says so instead of reporting zero', async () => {
    const cdp = fakeCdp({failEnable: true});
    const census = await countBytes(cdp);
    const got = census.result();
    assert.equal(got.measured, false);
    assert.match(got.why, /target closed/);
});

test('a census that recorded almost nothing is not a measurement', async () => {
    const cdp = fakeCdp();
    const census = await countBytes(cdp);
    resource(cdp, '1', 'Document', CENSUS_MIN_BYTES - 1);
    const got = census.result();
    assert.equal(got.measured, false);
    assert.match(got.why, /almost nothing/);
});

/* ------------------------------------------------------------------- the ordering */

test('the largest type comes first, and a tie breaks on the name', () => {
    const types = new Map([
        ['Script', {bytes: 100, requests: 1}],
        ['Image', {bytes: 100, requests: 1}],
        ['Font', {bytes: 900, requests: 1}],
    ]);
    assert.deepEqual(byType(types).map((t) => t.type), ['font', 'image', 'script']);
});

/* -------------------------------------------------------------------- the sentence */

test('the summary names the weight, the requests and what led it', () => {
    const said = bytesSummary({
        measured: true,
        atLoad: {bytes: 1258496, requests: 71},
        afterScroll: {bytes: 2775040, requests: 78},
        byType: [{type: 'media', bytes: 1536000, requests: 3}],
    });
    assert.match(said, /2\.6 MB over 78 requests/);
    assert.match(said, /1\.2 MB of it before any scrolling/);
    assert.match(said, /55% of it media/);
});

/**
 * DELIBERATELY NOT A VERDICT. Whether 14.7 MB is too much depends on what the page is for,
 * and this file cannot know. It says what was shipped; the report makes the argument by
 * putting that beside how much of the page is drawn on.
 */
test('the summary states and never judges', () => {
    const said = bytesSummary({
        measured: true, atLoad: {bytes: 1000, requests: 1},
        afterScroll: {bytes: 15029594, requests: 166},
        byType: [{type: 'image', bytes: 13431808, requests: 46}],
    });
    assert.doesNotMatch(said, /too much|heavy|bloat|should|slow/i);
    assert.match(said, /14\.3 MB/);
});

test('an unmeasured census has nothing to say', () => {
    assert.equal(bytesSummary({measured: false, why: 'target closed'}), null);
    assert.equal(bytesSummary(null), null);
});
