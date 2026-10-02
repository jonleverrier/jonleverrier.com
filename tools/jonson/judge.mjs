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
export let catalogue = null;
export const clients = {}; // slug -> client name // slug -> "Title: one-line description", from the site's own /case-studies.md
export async function loadCatalogue() {
    if (catalogue) return catalogue;
    catalogue = {};
    const md = await (await fetch(`${BASE}/case-studies.md`)).text();
    for (const m of md.matchAll(/^- \[([^\]]+)\]\(([^)]+)\): ?(.*)$/gm)) catalogue[slugOf(m[2])] = `${m[1]}: ${m[3]}`;
    // Each study's client, from llms-full.txt ("Source: …/slug" then "Client: …"), so a
    // client's sibling studies aren't counted as extras (the site shows a client's work
    // as a set).
    const full = await (await fetch(`${BASE}/llms-full.txt`)).text();
    for (const m of full.matchAll(/^Source: (\S+)\nClient: (.+)$/gm)) clients[slugOf(m[1])] = m[2].trim();
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
            // A sibling of a described study (same client) is the set, not an extra.
            // Nothing specific described ("have a look at a few of these"): the cards are
            // Jonson's own pick, and there is nothing in the prose to judge them against.
            extra: described.length === 0 ? [] : shown.filter((sl) => !described.includes(sl)
                && !(clients[sl] && described.some((d) => clients[d] === clients[sl]))),
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Shared: one tool-forced Haiku call, and a quote check — a finding only stands when
// at least 80% of its quoted words are really in the answer (see judgeCards).
async function askHaiku(prompt, tool, model = process.env.JONSON_JUDGE_MODEL || 'claude-haiku-4-5', system = null) {
    if (!JUDGE || !API_KEY) return null;
    // Haiku takes a forced tool call; Sonnet refuses one ("tool_choice: type tool is not
    // supported"), so it gets the tool on `auto` and is told to call it.
    const forced = model.includes('haiku');
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
            // The facts go in a CACHED system block: identical on every call in a run, so
            // after the first they cost a tenth (≈ €25 → €3 a full run for the invention judge).
            body: JSON.stringify({model, max_tokens: 1200, ...(system ? {system: [{type: 'text', text: system, cache_control: {type: 'ephemeral'}}]} : {}), tools: [tool], tool_choice: forced ? {type: 'tool', name: tool.name} : {type: 'auto'}, messages: [{role: 'user', content: forced ? prompt : `${prompt}\n\nReply ONLY by calling the ${tool.name} tool.`}]}),
        });
        const json = await res.json();
        if (process.env.JONSON_JUDGE_DEBUG) console.error('[judge usage]', model, JSON.stringify(json.usage || json.error));
        return (json.content || []).find((c) => c.type === 'tool_use')?.input || null;
    } catch {
        return null;
    }
}
const words = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2);
const backedBy = (prose) => {
    const hay = new Set(words(prose));
    return (q) => { const w = words(q || ''); return w.length > 0 && w.filter((x) => hay.has(x)).length / w.length >= 0.8; };
};

/**
 * NEVER INVENT. Claims about who Jon has worked with — clients, employers, kinds of
 * client, how many — that the facts (the CMS client list, case studies, sectors and CV,
 * from facts.php) don't support. "Regulators" from a RegTech sector, "estate agents"
 * from one online estate agent. Returns [{quote, why}] for the unsupported ones.
 */
export async function judgeInvention(prose, facts) {
    // TWO INDEPENDENT READS, and only what both flag stands: one read alone wobbled —
    // it once flagged a true claim and missed the false one. A finding agreed twice,
    // with overlapping quotes, is the signal; a one-off is noise.
    const [a, b] = await Promise.all([inventionOnce(prose, facts), inventionOnce(prose, facts)]);
    const overlap = (x, y) => { const wx = new Set(words(x)); const wy = words(y); return wy.filter((w) => wx.has(w)).length / Math.max(1, Math.min(wx.size, wy.length)) >= 0.5; };
    return a.filter((c) => b.some((d) => overlap(c.quote, d.quote)));
}

async function inventionOnce(prose, facts) {
    const brief = JSON.stringify({
        clients: facts.clients,
        caseStudies: facts.studies.map((s) => ({client: s.client, title: s.title, sectors: s.sectors, summary: s.summary, notes: s.notes})),
        testimonials: facts.testimonials,
        sectors: facts.sectors,
        career: facts.cv.map((c) => ({company: c.company, about: c.companySummary, role: c.title, did: c.summary, from: c.start, to: c.end || 'present', types: c.types})),
        about: facts.about,
        howICanHelp: facts.howICanHelp,
        personality: facts.personality,
        relationships: facts.relationships,
        notes: facts.notes,
    });
    const out = await askHaiku(
        `ANSWER he gave (in the first person):\n${prose}\n\nList every claim in the ANSWER about WHO Jon has worked with or for — named clients or employers, the KINDS of client (e.g. \"banks\"), HOW MANY of a kind, or HOW LONG he has worked with them — that the FACTS do not support. The details of what he did for a client are out of scope; only who, how many and how long. For HOW LONG, the career dates (from/to) and what Jon states about specific relationships in his PERSONALITY are the authority; vaguer wording (\"some clients have been with me for years\") doesn't make \"many\" true. A sector he has experience in is not the same as a kind of client he worked for; one client of a kind is not several. Judge whether the client or kind of client EXISTS in the facts, not adjectives — "big", "well-known" and similar are out of scope. Whether he worked WITH or FOR someone doesn't matter. A client described by what it plainly is counts as supported (a known retailer as a retailer). The kinds of client Jon says he works with in ABOUT and HOW I CAN HELP are supported. Skills, opinions, process, interests, personal life and travel are out of scope — only claims about clients, employers and the work. Quote each claim verbatim. If everything is supported, return an empty list.`,
        {name: 'unsupported', description: 'Claims about who Jon worked with that the facts do not support.', input_schema: {type: 'object', properties: {claims: {type: 'array', items: {type: 'object', properties: {quote: {type: 'string', description: 'the exact words from the answer'}, why: {type: 'string'}}, required: ['quote', 'why']}}}, required: ['claims']}},
        // Sonnet: Haiku flagged true claims (real clients by a shortened name) and missed
        // sector-turned-client inventions ("regulators") two runs in three.
        process.env.JONSON_INVENTION_MODEL || 'claude-sonnet-5-5',
        `FACTS about a designer, Jon — everyone he has worked for, his case studies, the sectors he has experience in, and his career:\n${brief}`,
    );
    const backed = backedBy(prose);
    return (out?.claims || []).filter((c) => backed(c.quote));
}

/**
 * NEVER SCREEN ANYONE OUT. Whether the answer turns the visitor away or decides for
 * them that they aren't a fit (budget, size, stage) instead of leaving that to a
 * conversation. Returns [{quote, why}] for each turning-away.
 */
export async function judgeScreening(question, prose) {
    const out = await askHaiku(
        `A designer's portfolio assistant was asked:\n"${question}"\n\nIt answered:\n${prose}\n\nThe rule: never screen anyone out. Whether a project fits is worked out together in a conversation, never decided for the visitor up front. Being honest about how something might work (e.g. a smaller scope) is fine; refusing, discouraging them from getting in touch, or deciding they aren't a fit is not. List every place the answer turns the visitor away or decides they're not a fit, quoting verbatim. If it doesn't, return an empty list.`,
        {name: 'screening', description: 'Places where the answer turns the visitor away.', input_schema: {type: 'object', properties: {findings: {type: 'array', items: {type: 'object', properties: {quote: {type: 'string'}, why: {type: 'string'}}, required: ['quote', 'why']}}}, required: ['findings']}},
    );
    const backed = backedBy(prose);
    return (out?.findings || []).filter((f) => backed(f.quote));
}
