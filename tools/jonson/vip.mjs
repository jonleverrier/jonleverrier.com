#!/usr/bin/env node
/**
 * VIP door checks — no Claude calls, free to run, takes seconds:
 *
 *   node tools/jonson/vip.mjs
 *
 * 1. CONTACT ROUTES FIT THE DOOR'S PURPOSE. For a door of each purpose (and a door
 *    with none, and no door at all), open it in a fresh cookie jar, load /contact, and
 *    compare the ways in on the page with the CTAs whose purposes include that one
 *    ("general" for an ordinary visitor). Expected sets come from the CMS via
 *    facts.php, so a CTA added or re-tagged next month is checked without editing this.
 * 2. ONLY PEOPLE COUNT AS VISITS. A link preview (no fetch metadata), a browser
 *    prefetch, and a real navigation hit one door; only the navigation may add to its
 *    URL Hits, and the preview must get the door's own card (og:url = the door).
 *
 * Every counter it touches is put back afterwards. Exit 1 on any failure.
 * (Not covered: a logged-in visit not counting — that needs a CP session.)
 */
import {execSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // ddev's local certificate
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.JONSON_BASE || 'https://jonleverrier2.local';
const BROWSER = {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'User-Agent': 'Mozilla/5.0 (Macintosh) jonson-vip-test'};

const facts = () => JSON.parse(execSync('ddev exec "php tools/jonson/facts.php"', {cwd: ROOT, encoding: 'utf8'}));
const setHits = (slug, n) => execSync(`ddev exec "php tools/jonson/facts.php set-hits ${slug} ${n}"`, {cwd: ROOT, encoding: 'utf8'});
const hitsOf = (slug) => facts().vips.find((v) => v.slug === slug)?.hits;

// The counted requests go through curl: Node's fetch sends Sec-Fetch-* headers of its
// own (mode: cors), so a "browser navigation" from it reads as a script — correctly.
const curl = (path, headers) => {
    const h = Object.entries(headers).map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`).join(' ');
    const out = execSync(`curl -sk -o /dev/null -w '%{http_code}' ${h} ${JSON.stringify(BASE + path)}`, {encoding: 'utf8'});
    return Number(out);
};

const fails = [];
const check = (ok, label, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) fails.push(label);
};

// A request with a cookie jar of its own.
function jar() {
    const cookies = new Map();
    return async (path, headers = {}) => {
        const res = await fetch(BASE + path, {
            headers: {...headers, Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')},
            redirect: 'manual',
        });
        for (const line of res.headers.getSetCookie?.() || []) {
            const [pair] = line.split(';');
            const i = pair.indexOf('=');
            cookies.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return res;
    };
}

// The ways in on a page, compared by their letters alone: the page carries the list
// twice (its own and the contact panel's copy) and "free" is split into one span per
// letter for its sparkle, so spacing means nothing here.
const compact = (t) => t.toLowerCase().replace(/\(opens in a new tab\)/g, '').replace(/[^a-z0-9]/g, '').replace(/freefree/g, 'free');
const routesOn = (html) => [...new Set([...html.matchAll(/<a class="c-ctas__item"[\s\S]*?<\/a>/g)]
    .map((m) => compact(m[0].replace(/<[^>]+>/g, ' '))))];

const start = facts();
const original = Object.fromEntries(start.vips.map((v) => [v.slug, v.hits]));
const expectedFor = (purpose) => start.ctas
    .filter((c) => c.purposes.includes(purpose || 'general'))
    .map((c) => c.title).sort();

try {
    // 1. Purpose → contact routes.
    const cases = [{label: 'no door (ordinary visitor)', slug: null, purpose: ''}];
    const purposes = [...new Set(start.vips.map((v) => v.purpose))];
    for (const p of purposes) {
        const door = start.vips.find((v) => v.purpose === p);
        cases.push({label: p ? `door with purpose ${p}` : 'door with no purpose', slug: door.slug, purpose: p});
    }
    for (const c of cases) {
        const get = jar();
        if (c.slug) await get(`/vip/${c.slug}`, BROWSER);
        const html = await (await get('/contact', BROWSER)).text();
        const shown = routesOn(html).sort();
        const want = expectedFor(c.purpose);
        const ok = JSON.stringify(shown) === JSON.stringify(want.map(compact).sort());
        check(ok, `contact routes — ${c.label}`, ok ? want.join(', ') : `want [${want.join(', ')}] got [${shown.join(', ')}]`);
    }

    // 2. Only people count. A door with a known counter.
    const door = start.vips[0].slug;
    setHits(door, 0);
    const preview = await jar()(`/vip/${door}`, {'User-Agent': 'LinkedInBot/1.0 (compatible; Mozilla/5.0)'});
    const card = preview.status === 200 ? await preview.text() : '';
    check(preview.status === 200 && card.includes(`og:url" content="${BASE}/vip/${door}"`),
        'link preview gets the door\'s own card', `status ${preview.status}`);
    check(hitsOf(door) === 0, 'link preview does not count', `hits ${hitsOf(door)}`);

    curl(`/vip/${door}`, {...BROWSER, 'Sec-Purpose': 'prefetch'});
    check(hitsOf(door) === 0, 'browser prefetch does not count', `hits ${hitsOf(door)}`);

    const real = curl(`/vip/${door}`, BROWSER);
    check(real === 302, 'a real visit is let in (302 home)', `status ${real}`);
    check(hitsOf(door) === 1, 'a real visit counts once', `hits ${hitsOf(door)}`);
} finally {
    // Put every counter back as it was — the purpose checks walked through doors too.
    const now = facts();
    for (const v of now.vips) if (v.hits !== original[v.slug]) setHits(v.slug, original[v.slug]);
}

console.log(fails.length ? `\n${fails.length} failed` : '\nall passed');
process.exit(fails.length ? 1 : 0);
