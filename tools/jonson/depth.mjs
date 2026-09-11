#!/usr/bin/env node
/**
 * Jonson chip-depth probe — what the "where next?" chips do over a LONG
 * conversation, which the acceptance suite cannot see: every suite scenario is
 * one or two turns, and the chip failures all begin around turn four.
 *
 *   node tools/jonson/depth.mjs [--verbose] [runs-per-thread=1]
 *
 * Runs the threads below as fresh conversations — own cookie jar, own cid,
 * continuation=1 from the second turn, exactly as jonson-ask.js does — and
 * reports per TURN INDEX:
 *
 *   - whether the model wrote its [[next:]] block at all. It used to stop around
 *     turn four, because the block was stripped from the model-facing history and
 *     a history without it taught the model not to write one; the slate then fell
 *     to the canned candidateFallback list, which is the hardcoded menu the whole
 *     design exists to avoid.
 *   - how many chips actually reached the visitor, out of MAX_SUGGESTIONS.
 *   - how many were repeats of a chip already offered earlier in that SAME
 *     conversation. askedKeys() only knows what the visitor typed or tapped, so
 *     before the offered-chip budget an ignored chip simply came back.
 *   - empty slates, and how many were the contact beat — which suppresses chips ON
 *     PURPOSE (the way in IS the next step), so those are healthy, not misses.
 *
 * A healthy run: the block written every turn, no repeats, and every empty slate
 * carrying "(contact)". --verbose prints each turn's raw [[next:]] block beside
 * the chips that survived it, which is what you want when a number looks wrong.
 *
 * Each turn is one Claude call: 4 threads × 6 turns = 24 calls per run.
 */

import {randomUUID} from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ddev's local certificate

const BASE = process.env.JONSON_BASE || 'https://jonleverrier2.local';
const VERBOSE = process.argv.includes('--verbose');
const RUNS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 1);

/**
 * Four visitors on different paths — a hirer, a browser, a sceptic, and one who
 * arrives on the personal side. Each runs long enough to pass the turn-three
 * contact beat and out the other side, which is where the chips used to die.
 */
const THREADS = [
    ['Tell me about yourself?', 'What kind of work do you do?', 'Have you worked in fintech?', 'What was the Vaiie project about?', 'Do you work with agencies?', "What's your rate?"],
    ['What do you do?', 'Show me some of your work', 'Who have you worked with?', 'What do clients say about you?', 'How long have you been doing this?', 'Where are you based?'],
    ['Hello', "What's your background?", 'Do you do branding or product?', 'Tell me about a hard project', 'What went wrong on it?', 'Would you do it again?'],
    ['What are you listening to?', 'Do you take photos?', 'Where have you travelled?', 'Does that feed into your design work?', 'What kind of clients suit you?', 'Are you taking on work?'],
];

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
    return (await res.json()).csrfTokenValue;
}

/** One conversation, start to finish. Returns a row per turn. */
async function runThread(questions) {
    const jar = new Jar();
    const cid = `depth-${randomUUID()}`;
    const token = await csrf(jar);
    const offered = new Map(); // chip text (lowercased) → the turn it first appeared
    const rows = [];

    for (const [i, q] of questions.entries()) {
        const body = new URLSearchParams({CRAFT_CSRF_TOKEN: token, question: q, cid});
        if (i > 0) body.set('continuation', '1');
        const res = await fetch(`${BASE}/jonson/ask`, {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/event-stream', Cookie: jar.header()},
            body,
        });
        jar.absorb(res);
        if (!res.ok) throw new Error(`HTTP ${res.status} for "${q}"`);

        const text = await res.text();
        const events = {};
        for (const m of text.matchAll(/^event: (\w+)\ndata: (.*)$/gm)) {
            let data = m[2];
            try { data = JSON.parse(m[2]); } catch { /* keep raw */ }
            (events[m[1]] ??= []).push(data);
        }

        const chips = (events.suggestions || []).flatMap((d) => d.items || []);
        const answer = events.done?.[0]?.answer || '';
        const block = answer.match(/\[\[next:\s*(.+?)\]\]/is);
        const repeats = chips.filter((c) => offered.has(c.toLowerCase()));
        chips.forEach((c) => offered.has(c.toLowerCase()) || offered.set(c.toLowerCase(), i + 1));

        rows.push({turn: i + 1, wroteBlock: !!block, chips: chips.length, repeats: repeats.length, contact: !!events.contact});

        if (VERBOSE) {
            console.log(`\nT${i + 1}  Q: ${q}`);
            console.log(`  surfaces:    ${Object.keys(events).filter((k) => !['text', 'done'].includes(k)).join(', ') || '—'}`);
            console.log(`  model wrote: ${block ? block[1] : '(no block)'}`);
            for (const c of chips) {
                const was = offered.get(c.toLowerCase());
                console.log(`    - ${c}${was && was < i + 1 ? `   ⟵ REPEAT of T${was}` : ''}`);
            }
            if (!chips.length) console.log(`    (no chips${events.contact ? ' — contact beat, by design' : ''})`);
        }
    }

    return rows;
}

const threads = Array.from({length: RUNS}, () => THREADS).flat();
const results = await Promise.all(threads.map((qs) => runThread(qs)));

// ——— Report ———
const byTurn = new Map();
for (const rows of results) {
    for (const r of rows) {
        const t = byTurn.get(r.turn) ?? byTurn.set(r.turn, {n: 0, block: 0, chips: 0, repeats: 0, empty: 0, contact: 0}).get(r.turn);
        t.n++;
        t.block += r.wroteBlock ? 1 : 0;
        t.chips += r.chips;
        t.repeats += r.repeats;
        if (!r.chips) { t.empty++; if (r.contact) t.contact++; }
    }
}

console.log(`\nJonson chip depth — ${threads.length} conversations × ${THREADS[0].length} turns\n`);
console.log('turn  convos  wrote [[next]]  avg chips  repeats  empty (of which contact)');
for (const [turn, s] of [...byTurn].sort((a, b) => a[0] - b[0])) {
    console.log(
        `  ${String(turn).padEnd(4)}${String(s.n).padStart(4)}${`${s.block}/${s.n}`.padStart(14)}`
        + `${(s.chips / s.n).toFixed(2).padStart(11)}${String(s.repeats).padStart(9)}`
        + `${`${s.empty} (${s.contact})`.padStart(12)}`,
    );
}

const repeats = [...byTurn.values()].reduce((a, s) => a + s.repeats, 0);
const missing = [...byTurn.values()].reduce((a, s) => a + (s.n - s.block), 0);
const stranded = [...byTurn.values()].reduce((a, s) => a + (s.empty - s.contact), 0);
console.log(`\nrepeated chips ${repeats} · turns with no [[next:]] block ${missing} · empty slates that weren't the contact beat ${stranded}`);
process.exit(repeats || missing ? 1 : 0);
