/**
 * SHADOW, IN A BROWSER
 *
 *   node --test tools/audit/test/shadow.test.mjs
 *
 * The walk itself: does it cross into a component, does it come back out again, and does it
 * say so honestly when it cannot. Everything here runs in a real Chromium over one local
 * file:// page, because a shadow root is not a thing a DOM shim has.
 *
 * WHAT THIS FILE IS FOR, and it is not the census. The consequences — a card in a component
 * being censused, hidden once rather than six times, seen by the consent finder — are
 * measured in test/slices.test.mjs and test/consent-page.test.mjs against real captures.
 * This file is the primitive those rest on.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SHADOW_CENSUS, SHADOW_INIT} from '../lib/shadow.mjs';
import {COLLECT_PINNED} from '../lib/unrendered.mjs';
import {VIEWPORT, capturePage} from '../lib/capture.mjs';

/**
 * Every arrangement at once: an open root, an open root nested inside it, a CLOSED one, and
 * an ordinary light-DOM element to prove the walk has not simply stopped doing its old job.
 *
 * The ids are on the elements themselves so a test can name what it expects to find; the
 * walk never uses them, because an id is not something a page is obliged to have.
 */
const PAGE = `<!doctype html><html><head><title>Components</title></head><body style="margin:0">
 <p id="light">in the document</p>
 <div id="mount"><div id="host"></div></div>
 <div id="sealed"></div>
 <!-- For what meta.fixed makes of a component. The first holds a fixed card inside a fixed
      wrapper in the LIGHT DOM, so the card is not the outermost of anything; the second
      holds one whose host is ordinary, so the card is the only thing there is to record. -->
 <div id="outerfixed" style="position:fixed;top:700px;left:0;width:300px;height:60px">
  <div id="innerhost" style="display:block;width:0;height:0"></div>
 </div>
 <div id="plainmount"><div id="lonehost" style="display:block;width:0;height:0"></div></div>
 <script>
  document.getElementById('host').attachShadow({mode: 'open'}).innerHTML =
    '<div id="outer">outer<span id="nested"></span></div>';
  document.getElementById('host').shadowRoot.getElementById('nested')
    .attachShadow({mode: 'open'}).innerHTML = '<b id="deepest">deepest</b>';
  document.getElementById('sealed').attachShadow({mode: 'closed'}).innerHTML = '<i id="hidden">unreachable</i>';
  document.getElementById('innerhost').attachShadow({mode: 'open'}).innerHTML =
    '<div id="inside" style="position:fixed;top:700px;left:0;width:200px;height:40px"></div>';
  document.getElementById('lonehost').attachShadow({mode: 'open'}).innerHTML =
    '<div id="lone" style="position:fixed;top:800px;left:0;width:220px;height:50px"></div>';
 </script>
</body></html>`;

let browser;
let context;
let url;

before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-shadow-'));
    writeFileSync(join(dir, 'index.html'), PAGE);
    url = `file://${join(dir, 'index.html')}`;
    browser = await chromium.launch();
    context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce'});
});

after(async () => {
    await browser?.close();
});

/** A page with the walk installed, as lib/capture.mjs installs it. */
const load = async ({install = true} = {}) => {
    const page = await context.newPage();
    if (install) await page.addInitScript(SHADOW_INIT);
    await page.goto(url, {waitUntil: 'load'});

    return page;
};

/** The ids the walk reaches from `document.body`, in the order it reaches them. */
const walked = (page) => page.evaluate(() => window.__auditDeep.all(document.body).map((el) => el.id));

test('the walk reaches an element the light-DOM walk cannot', async () => {
    const page = await load();
    const light = await page.evaluate(() => [...document.querySelectorAll('body *')].map((el) => el.id));
    const deep = await walked(page);
    assert.ok(!light.includes('outer'), 'the premise: querySelectorAll stops at the shadow boundary');
    assert.ok(deep.includes('outer'), `the walk crosses it: ${deep.join(',')}`);
    await page.close();
});

test('…and one two components deep', async () => {
    // A component built out of components is the ordinary case, not an exotic one.
    const page = await load();
    assert.ok((await walked(page)).includes('deepest'));
    await page.close();
});

test('…and still reaches everything in the document itself', async () => {
    // The old walk's whole job. A change that finds new elements by losing old ones would
    // move every number in this tool and look like a success.
    const page = await load();
    const light = await page.evaluate(() => [...document.querySelectorAll('body *')].map((el) => el.id));
    const deep = await walked(page);
    for (const id of light) assert.ok(deep.includes(id), `${id} was in the light-DOM walk and is not in this one`);
    await page.close();
});

test('a host is reached before the content it renders', async () => {
    // Order is not cosmetic: the census writes rects in it, and `unionRects` keeps insertion
    // order so that the same page always produces the same file.
    const page = await load();
    const deep = await walked(page);
    assert.ok(deep.indexOf('host') < deep.indexOf('outer'), deep.join(','));
    assert.ok(deep.indexOf('nested') < deep.indexOf('deepest'), deep.join(','));
    await page.close();
});

test('a CLOSED shadow root is not reached, and nothing pretends otherwise', async () => {
    // There is no way to it from script, by design. It is the same blind spot as a
    // cross-origin iframe, and the only honest thing to do is to say so rather than to
    // report a page as having nothing where a closed component is.
    const page = await load();
    assert.ok(!(await walked(page)).includes('hidden'));
    await page.close();
});

test('the walk out of a component lands on its host, not on nothing', async () => {
    // `parentElement` is null at the top of a shadow tree, so every ancestor walk in this
    // tool — clipping, opacity, "is this control inside a banner", "which pinned element is
    // the outermost" — stopped there and answered about the component instead of the page.
    const page = await load();
    const chain = await page.evaluate(() => {
        const deepest = window.__auditDeep.all(document.body).find((el) => el.id === 'deepest');
        const out = [];
        for (let a = deepest; a; a = window.__auditDeep.parent(a)) out.push(a.id || a.tagName.toLowerCase());

        return out;
    });
    assert.deepEqual(chain, ['deepest', 'nested', 'outer', 'host', 'mount', 'body', 'html']);
    await page.close();
});

test('the census counts what is behind a boundary separately from the whole page', async () => {
    const page = await load();
    const census = await page.evaluate(SHADOW_CENSUS);
    assert.equal(census.installed, true);
    assert.equal(census.hosts, 4, 'every open host; the closed one offers no shadowRoot to find');
    assert.equal(census.inShadow, 5, 'outer, nested, deepest, inside and lone');
    assert.ok(census.elements > census.inShadow, 'and the light DOM is in the same total');
    await page.close();
});

test('a page the walk was never installed on says so, rather than reporting an empty one', async () => {
    // What lib/capture.mjs refuses to continue past. A capture that silently stopped
    // piercing would report smaller numbers on every page with a component and look
    // exactly like a capture that had worked.
    const page = await load({install: false});
    assert.deepEqual(await page.evaluate(SHADOW_CENSUS), {installed: false, hosts: 0, elements: 0, inShadow: 0});
    await page.close();
});

test('the record of what holds the viewport reaches into a component, and still keeps only the outermost', async () => {
    // `meta.fixed` is what `heightGap` reads to NAME the cause of a region nothing accounts
    // for. A reveal footer built as a component was invisible to it, so the warning said a
    // sixth of the page was unexplained and could not say by what. Both halves of the walk
    // are in one answer here: down, or the lone card is missing; up, or the card inside a
    // fixed wrapper is listed beside its own wrapper as if it were a second element.
    const page = await load();
    const pinned = await page.evaluate(COLLECT_PINNED);
    const boxes = pinned.map((f) => `${f.w}x${f.h}`);
    assert.ok(boxes.includes('220x50'), `the card whose host is ordinary is recorded: ${boxes.join(' ')}`);
    assert.ok(boxes.includes('300x60'), `so is the light-DOM wrapper: ${boxes.join(' ')}`);
    assert.ok(!boxes.includes('200x40'), `and not the card inside that wrapper: ${boxes.join(' ')}`);
    await page.close();
});

test('a capture is refused outright on a page where the walk is not there', async () => {
    // NOT DEGRADED — REFUSED. Without the walk every census silently skips whatever the page
    // builds inside a component, and the capture looks exactly like one that worked: fewer
    // rects, no error, no flag. The init script runs before the page's own scripts, so the
    // page below can remove it and does; whatever the reason, a run that cannot count part
    // of a page has to say so rather than quietly report a smaller number.
    const dir = mkdtempSync(join(tmpdir(), 'audit-noshadow-'));
    writeFileSync(join(dir, 'hostile.html'), '<!doctype html><html><head><title>Hostile</title></head>'
        + '<body><script>delete window.__auditDeep;</script><h1>no walk here</h1></body></html>');
    await assert.rejects(
        capturePage(`file://${join(dir, 'hostile.html')}`, join(dir, 'out')),
        /shadow-DOM walk was not installed/,
    );
});
