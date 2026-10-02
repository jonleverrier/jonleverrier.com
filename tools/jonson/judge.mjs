/**
 * The card judge for the Jonson suite (run.mjs): do the case-study cards under an answer
 * match the work its prose describes? One Haiku call per answer, against the site's own
 * live catalogue (/case-studies.md), so it needs nothing per study and scales as studies
 * are published. Its own module so it can be checked on known cases without a suite run.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.JONSON_BASE || 'https://jonleverrier2.local';
// THE CARD JUDGE (see the header). Key from craft/.env, as the site itself reads it.
export const JUDGE = process.env.JONSON_JUDGE !== '0';
const ENV = (() => {
    try { return readFileSync(join(HERE, '../../craft/.env'), 'utf8'); } catch { return ''; }
})();
const API_KEY = (ENV.match(/^KEY_ANTHROPIC_API=["']?([^"'\n]+)/m) || [])[1] || '';
export const slugOf = (url) => url.replace(/\/+$/, '').split('/').pop();
export let catalogue = null; // slug -> "Title: one-line description", from the site's own /case-studies.md
export async function loadCatalogue() {
    if (catalogue) return catalogue;
    catalogue = {};
    const md = await (await fetch(`${BASE}/case-studies.md`)).text();
    for (const m of md.matchAll(/^- \[([^\]]+)\]\(([^)]+)\): ?(.*)$/gm)) catalogue[slugOf(m[2])] = `${m[1]}: ${m[3]}`;
    return catalogue;
}
export async function judgeCards(prose, shown, earlier) {
    if (!JUDGE || !API_KEY) return null;
    const cat = await loadCatalogue();
    const list = Object.entries(cat).map(([s, d]) => `- ${s} — ${d}`).join('\n');
    // EVIDENCE OR IT DIDN'T HAPPEN. For every study it says the answer describes, the
    // judge quotes the words that describe it; a quote that isn't actually in the answer
    // is thrown away. A bare yes/no judge invented work ("fintech" answers it said
    // described White Paper, which they never mentioned) and the noise drowned the signal.
    const body = {
        model: process.env.JONSON_JUDGE_MODEL || 'claude-haiku-4-5', max_tokens: 600,
        tools: [{name: 'described', description: 'The case studies the answer describes, each with the exact words that describe it.', input_schema: {type: 'object', properties: {
            studies: {type: 'array', items: {type: 'object', properties: {
                slug: {type: 'string', description: 'a slug from the catalogue'},
                quote: {type: 'string', description: 'the EXACT words from the answer (copied verbatim, 3–15 words) that name or describe this piece of work'},
            }, required: ['slug', 'quote']}},
        }, required: ['studies']}}],
        tool_choice: {type: 'tool', name: 'described'},
        messages: [{role: 'user', content: `A portfolio assistant answered a visitor. Which pieces of work from the catalogue does the answer name or clearly describe? A paraphrase counts ("a street photography app" describes the street photography app). Talking generally about "my work" or a sector describes nothing in particular. Only include a study you can back with words copied verbatim from the answer.\n\nCATALOGUE (slug — title: description):\n${list}\n\nANSWER:\n${prose}`}],
    };
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {method: 'POST', headers: {'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}, body: JSON.stringify(body)});
        const json = await res.json();
        const items = (json.content || []).find((c) => c.type === 'tool_use')?.input?.studies || [];
        // A quote counts when at least 80% of its words are in the answer — exact
        // substrings threw out real claims over a dropped "the"; an invented one has
        // nearly none of its words there.
        const words = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2);
        const hay = new Set(words(prose));
        const backed = (q) => { const w = words(q || ''); return w.length > 0 && w.filter((x) => hay.has(x)).length / w.length >= 0.8; };
        const described = [...new Set(items
            .filter((it) => cat[it.slug] && backed(it.quote))
            .map((it) => it.slug))];
        return {
            described,
            missing: described.filter((sl) => !shown.includes(sl) && !earlier.includes(sl)),
            extra: shown.filter((sl) => !described.includes(sl)),
        };
    } catch {
        return null;
    }
}
