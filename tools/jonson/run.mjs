#!/usr/bin/env node
/**
 * Jonson surfacing suite — runs tools/jonson/suite.json against the live ask
 * endpoint and reports, per scenario and per surface, how often the answer
 * carried what it should and nothing it shouldn't.
 *
 *   node tools/jonson/run.mjs [runs=6] [concurrency=4] [filter]
 *
 * Every run of a scenario is a FRESH conversation: its own cookie jar (so its own
 * PHP session and CSRF token) and its own browser-style cid, so nothing is a
 * cache replay and nothing reads as a repeat. Multi-turn scenarios reuse both
 * across their turns and send continuation=1 from the second turn, exactly as
 * jonson-ask.js does.
 *
 * Reads the SSE stream and records the set of event names — each surface is an
 * event named for its handle (casestudies, clients, sectors, method, testimonial,
 * contact, music), the photo rail is `context`, the chips are `suggestions`.
 * `noRepeatPhotos` on a turn asserts that no <img src> in this turn's rail was in
 * an earlier turn's rail of the same conversation; `noRepeatStudies` is its twin for
 * case-study cards. `tap: n` replaces a turn's `q` with the nth chip the previous
 * turn offered (default 0) and posts it as `fromChip`, so a scenario can follow the
 * route the chips lay down instead of only the one we thought to type. `noWorkChip`
 * asserts that none of a turn's chips is a generic offer to show the work.
 * `linksTool` asserts the answer does (true) or does not (false) link the free
 * homepage analysis.
 *
 * Output: a table per scenario (pass rate, and every failed assertion with its
 * count), a per-surface summary (missed when expected / shown when forbidden),
 * and the full per-run record as JSON under tools/jonson/results/. Exit code 1
 * if any scenario failed at least once, so it can gate a change.
 *
 * Each call is one Claude call. A full run at the defaults is ~22 scenarios × 6
 * runs, plus second turns — budget ten minutes and a few hundred API calls.
 */

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ddev's local certificate

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.JONSON_BASE || 'https://jonleverrier2.local';
const RUNS = Number(process.argv[2] || 6);
const CONCURRENCY = Number(process.argv[3] || 4);
const FILTER = process.argv[4] || '';
const SURFACES = ['context', 'casestudies', 'clients', 'sectors', 'method', 'testimonial', 'contact', 'music', 'suggestions'];

const suite = JSON.parse(readFileSync(join(HERE, 'suite.json'), 'utf8'));
const scenarios = suite.scenarios.filter((s) => !FILTER || s.id.includes(FILTER));

/** A minimal cookie jar: enough for CraftSessionId + the CSRF cookie. */
class Jar {
    constructor() { this.cookies = new Map(); }
    absorb(res) {
        const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const line of set) {
            const [pair] = line.split(';');
            const i = pair.indexOf('=');
            if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }
    header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function csrf(jar) {
    const res = await fetch(`${BASE}/actions/users/session-info`, {headers: {Accept: 'application/json', Cookie: jar.header()}});
    jar.absorb(res);
    const json = await res.json();
    return json.csrfTokenValue;
}

/** POST one question; resolve to {events: {name: [data…]}, answer, imgs, chips, studies}. */
async function ask(jar, cid, token, question, continuation, fromChip = null) {
    const body = new URLSearchParams({CRAFT_CSRF_TOKEN: token, question, cid});
    if (continuation) body.set('continuation', '1');
    // The 0-based position of the chip this question came from, as jonson-ask.js
    // sends it — the server logs it, and a tapped question is not a typed one.
    if (fromChip !== null) body.set('fromChip', String(fromChip));
    const res = await fetch(`${BASE}/jonson/ask`, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/event-stream', Cookie: jar.header()},
        body,
    });
    jar.absorb(res);
    if (!res.ok) throw new Error(`HTTP ${res.status} for "${question}"`);
    const text = await res.text();
    const events = {};
    for (const m of text.matchAll(/^event: (\w+)\ndata: (.*)$/gm)) {
        let data = m[2];
        try { data = JSON.parse(m[2]); } catch { /* keep raw */ }
        (events[m[1]] ??= []).push(data);
    }
    const done = events.done?.[0] || {};
    const railHtml = (events.context || []).map((d) => d.html || '').join('');
    const imgs = [...railHtml.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    // THE CHIP TEXT, NOT A COUNT. This line used to end in `.length`, and that one
    // word was the suite's blind spot: a chip re-offering work already on screen is
    // invisible to a number, and the saved record kept nothing to read back either.
    const chips = (events.suggestions || []).flatMap((d) => d.items || []);
    // Which studies are on screen, keyed by the href on the card's own anchor —
    // matched off `class="c-case-study"` (the component, in _components/case-study.twig)
    // rather than off the URL, which is `/case-study/{slug}` today and is the section's
    // to change. A first pass keyed on the path missed every card and left the repeat
    // assertion below testing an empty list: green, and checking nothing.
    const studyHtml = (events.casestudies || []).map((d) => d.html || '').join('');
    const studies = [...new Set([...studyHtml.matchAll(/class="c-case-study"\s+href="([^"]+)"/g)].map((m) => m[1]))];
    return {events, answer: done.answer || '', imgs, chips, studies, error: events.error?.[0]?.message};
}

/** Run one scenario once: every turn in one fresh conversation. */
async function runScenario(s) {
    const jar = new Jar();
    const cid = `suite-${randomUUID()}`;
    const token = await csrf(jar);
    const record = {id: s.id, turns: [], failures: []};
    const seenImgs = new Set();
    const seenStudies = new Set();
    let offered = [];
    for (const [i, turn] of s.turns.entries()) {
        // TAPPING A CHIP, rather than typing another question of our own. Every
        // scenario here used to supply all its own questions, so the suite never
        // travelled the route a real visitor takes — and the chips, which CHOOSE
        // that route, were never under test at all. `tap` takes the nth chip the
        // previous turn offered (the first, unless a number says otherwise), which
        // also means a scenario cannot assume what the chip says: the assertion is
        // about where tapping LEADS, and that holds whatever the model wrote.
        let question = turn.q;
        let fromChip = null;
        if (turn.tap !== undefined) {
            const n = typeof turn.tap === 'number' ? turn.tap : 0;
            // NOTHING TO TAP IS NOT A FAILURE. A turn that offers no chips is a
            // legitimate end — a sign-off, or the contact panel taking over — and a
            // tapping scenario cannot assert about a turn the visitor could never
            // have reached. Recorded and stopped, so the run still says what happened.
            if (!offered[n]) {
                record.turns.push({q: null, tapped: n, note: `no chip at position ${n} to tap`, shown: [], marked: [], imgs: 0, chips: [], studies: [], answer: ''});
                break;
            }
            question = offered[n];
            fromChip = n;
        }
        const r = await ask(jar, cid, token, question, i > 0, fromChip);
        const shown = SURFACES.filter((name) => (r.events[name] || []).length > 0);
        const fails = [];
        for (const e of turn.expect || []) if (!shown.includes(e)) fails.push(`T${i + 1} missing ${e}`);
        for (const f of turn.forbid || []) if (shown.includes(f)) fails.push(`T${i + 1} showed ${f}`);
        if (turn.noRepeatPhotos && r.imgs.some((src) => seenImgs.has(src))) fails.push(`T${i + 1} repeated a photo`);
        if (r.error) fails.push(`T${i + 1} error: ${r.error}`);
        // A named client gets their own quote alone — a panel of several here means
        // the selection fell to the generic featured set (see FindContext::testimonials).
        // A question that names one study by title should get that study alone,
        // not everything its client made (see FindContext::caseStudies).
        if (turn.maxStudies) {
            const html = (r.events.casestudies || []).map((d) => d.html || '').join('');
            const cards = (html.match(/class="c-case-study"/g) || []).length;
            if (cards > turn.maxStudies) fails.push(`T${i + 1} casestudies showed ${cards} cards (max ${turn.maxStudies})`);
        }
        if (turn.maxWords) {
            const prose = r.answer.replace(/\[\[[^\]]*\]{1,2}/g, ' ').trim();
            const words = prose.split(/\s+/).filter(Boolean).length;
            if (words > turn.maxWords) fails.push(`T${i + 1} answer ran to ${words} words (max ${turn.maxWords})`);
        }
        // A PANEL THAT SAYS NOTHING NEW. The directive already promises this — "a
        // study's card appears ONCE per conversation" — but only the photo rail had
        // an assertion for it (noRepeatPhotos, above). Case studies never grew the
        // twin, which is how a second marquee carrying the first one's cards went
        // unnoticed: every card was allowed, because each turn was judged alone.
        if (turn.noRepeatStudies) {
            const again = r.studies.filter((u) => seenStudies.has(u));
            if (again.length) fails.push(`T${i + 1} repeated ${again.length} study card(s) already on screen`);
        }
        // A CHIP THAT LEADS NOWHERE. Once every study is on screen, "can I see some
        // of your work?" is an offer of nothing — and it came from two places: the
        // model's own [[next:]] and the canned fallback candidate. Asserted on the
        // chip text rather than on the code's predicate, so the test still means
        // something if that predicate is rewritten.
        if (turn.noWorkChip) {
            const offers = r.chips.filter((c) => /\b(see|show|view|browse)\b[^?.]{0,40}\b(work|projects?|case stud(y|ies)|portfolio)\b/i.test(c));
            if (offers.length) fails.push(`T${i + 1} offered the work again: ${JSON.stringify(offers)}`);
        }
        // THE FREE REPORT, OFFERED OR NOT. It is the one thing on the site a stranger
        // can be given, so the assistant should reach for it when someone asks about
        // THEIR OWN homepage — and must not work it into answers about the work, the
        // clients or the process, where it is an advert rather than an answer.
        if (turn.linksTool !== undefined) {
            const links = /\/tools\/homepage-analysis/.test(r.answer);
            if (turn.linksTool && !links) fails.push(`T${i + 1} did not offer the homepage analysis`);
            if (!turn.linksTool && links) fails.push(`T${i + 1} pushed the homepage analysis`);
        }
        if (s.singleTestimonial) {
            const html = (r.events.testimonial || []).map((d) => d.html || '').join('');
            if (html && /has-multiple/.test(html)) fails.push(`T${i + 1} testimonial panel had several quotes`);
        }
        r.imgs.forEach((src) => seenImgs.add(src));
        r.studies.forEach((u) => seenStudies.add(u));
        offered = r.chips;
        // Which markers the model actually wrote, so a report can say whether a
        // missing surface was the model's judgement (unmarked) or the server's
        // (marked, then dropped) — the two need different fixes.
        const marked = [...new Set([...r.answer.matchAll(/\[\[([a-z0-9][a-z0-9-]*)(?::[a-z0-9-]+)?\]\]/gi)].map((m) => m[1].toLowerCase()).filter((h) => h !== 'next'))];
        const PHOTO_MARKED = marked.some((h) => !SURFACES.includes(h));
        const annotated = fails.map((f) => {
            const m = f.match(/^T\d+ missing (\w+)$/);
            if (!m) return f;
            const wasMarked = m[1] === 'context' ? PHOTO_MARKED : marked.includes(m[1]);
            return `${f} (${wasMarked ? 'marked, dropped by server' : 'unmarked by model'})`;
        });
        record.turns.push({q: question, tapped: fromChip, shown, marked, imgs: r.imgs.length, chips: r.chips, studies: r.studies, answer: r.answer});
        record.failures.push(...annotated);
    }
    return record;
}

async function pool(items, worker, n) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({length: n}, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await worker(items[idx]);
        }
    }));
    return out;
}

const jobs = scenarios.flatMap((s) => Array.from({length: RUNS}, () => s));
const started = Date.now();
let doneCount = 0;
const records = await pool(jobs, async (s) => {
    try {
        return await runScenario(s);
    } catch (e) {
        return {id: s.id, turns: [], failures: [`run error: ${e.message}`]};
    } finally {
        doneCount++;
        process.stderr.write(`\r${doneCount}/${jobs.length} runs`);
    }
}, CONCURRENCY);
process.stderr.write('\n');

// ——— Report ———
const byId = new Map();
for (const r of records) (byId.get(r.id) ?? byId.set(r.id, []).get(r.id)).push(r);

const surfaceStats = Object.fromEntries(SURFACES.map((n) => [n, {expected: 0, missed: 0, forbidden: 0, leaked: 0}]));
const lines = [];
let anyFail = false;
for (const s of scenarios) {
    const runs = byId.get(s.id) || [];
    const passed = runs.filter((r) => r.failures.length === 0).length;
    if (passed < runs.length) anyFail = true;
    const tally = {};
    for (const r of runs) for (const f of r.failures) tally[f] = (tally[f] || 0) + 1;
    const detail = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ×${n}`).join('; ');
    lines.push(`${(passed === runs.length ? 'PASS' : 'FAIL').padEnd(5)} ${s.id.padEnd(17)} ${String(passed).padStart(2)}/${runs.length}  ${detail}`);
    for (const [i, turn] of s.turns.entries()) {
        for (const e of turn.expect || []) {
            surfaceStats[e].expected += runs.length;
            surfaceStats[e].missed += runs.filter((r) => r.failures.some((f) => f.startsWith(`T${i + 1} missing ${e}`))).length;
        }
        for (const f of turn.forbid || []) {
            surfaceStats[f].forbidden += runs.length;
            surfaceStats[f].leaked += runs.filter((r) => r.failures.includes(`T${i + 1} showed ${f}`)).length;
        }
    }
}

console.log(`\nJonson surfacing suite — ${scenarios.length} scenarios × ${RUNS} runs, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
console.log(lines.join('\n'));
console.log('\nsurface        expected  missed   forbidden  leaked');
for (const [name, st] of Object.entries(surfaceStats)) {
    if (!st.expected && !st.forbidden) continue;
    console.log(`${name.padEnd(14)} ${String(st.expected).padStart(8)} ${String(st.missed).padStart(7)}   ${String(st.forbidden).padStart(9)} ${String(st.leaked).padStart(7)}`);
}

const outDir = join(HERE, 'results');
mkdirSync(outDir, {recursive: true});
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = join(outDir, `${stamp}${FILTER ? '-' + FILTER : ''}.json`);
writeFileSync(outFile, JSON.stringify({base: BASE, runs: RUNS, started: new Date(started).toISOString(), scenarios: records}, null, 2));
console.log(`\nfull record: ${outFile}`);
process.exit(anyFail ? 1 : 0);
