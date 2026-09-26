/**
 * PROPOSITION READING
 *
 * What proposition.json means, as findings a report can print.
 *
 *   node --test tools/audit/test/proposition-reading.test.mjs
 *
 * NO MODEL RUNS HERE, for the reason lib/expectations.mjs gives: the model says what each
 * line and each ask IS, and what that MEANS is a judgement a report makes about somebody's
 * business, so it must be identical on every run. Every finding carries `evidence` — the
 * quotes, labels and positions it was made from — so a reader can check it against their
 * own page, and so the report can print the fact beside the verdict.
 *
 * THE ASKS ARE JUDGED UNLESS THE PAGE IS CONFIDENTLY NOT MEANT TO ASK. A portal (gov.je)
 * or a publication is not told it has no sales button — that is advice that is wrong, and
 * one wrong line costs the rest their credibility. Everything else is judged, in neutral
 * words when the purpose is not confident — see readProposition for vaiie.com. What the first screen says is judged on every page: gov.je's tagline
 * tells a visitor what it is, and a portal that did not would deserve to be told.
 *
 * AN ASK WITH NO MAJORITY INTENT (`unknown`) COUNTS FOR NOTHING, in either direction.
 */
import {CONFIDENCE_FLOOR} from './expectations.mjs';

/**
 * Within reach means on the first or second screen — or pinned, which is on every screen.
 *
 * SCREENS AND NOT A SHARE OF THE PAGE. The first version flagged an ask more than 50% down,
 * and halfway down a twenty-screen page is ten screens deep; a share makes the answer
 * depend on how long the page is, which lib/expectations.mjs learned the hard way about
 * gov.uk's header. Jon's rule, 25 Sep 2026: "if it's not in the first screen, is it in the
 * next?"
 */
export const WITHIN_SCREENS = 2;

/** The capture's viewport height, when an older record does not carry its own. */
const SCREEN = 900;

const PURPOSES_THAT_ASK = {sell: 'buy or sign up', enquire: 'get in touch'};

/** Pages that are not meant to ask. Spared only when the purpose is confident. */
const PURPOSES_THAT_DO_NOT_ASK = ['route', 'publish'];

/** When the purpose is not confident, the asks are still judged, without guessing its verb. */
const NEUTRAL_VERB = 'take the next step';

/**
 * WHAT COUNTS AS A CALL TO ACTION (26 Sep 2026). bedellcristin.com's hero carries "Meet our
 * people" and "Explore our services", and a report that counted only contact and purchase
 * asks told it there was "nothing to click". A call to action is any of these three; a way
 * to GET IN TOUCH is the first alone, and has a check of its own, so the Bedell finding —
 * its only contact link is in the footer — is still said.
 */
export const CTA_INTENTS = ['sales', 'signup', 'next'];
const isCta = (c) => CTA_INTENTS.includes(c.intent);

/** The verb for the get-in-touch check, by purpose. */
const touchVerb = (purpose) => (PURPOSES_THAT_ASK[purpose?.kind] ?? 'get in touch');

const quoted = (s) => `"${String(s).replace(/\s+/g, ' ').trim()}"`;

/** A sentence that ends on a quote ends once: `…there."` rather than `…there.".` */
const ending = (quote) => (/[.!?…]"$/.test(quote) ? quote : `${quote}.`);
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const unique = (items) => [...new Set(items)];

/** Case and spacing folded: "Contact" and "CONTACT" (abas-erp.com, CSS capitals) are one word. */
const fold = (s) => String(s ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const uniqueFolded = (items) => {
    const seen = new Map();
    for (const item of items) if (!seen.has(fold(item))) seen.set(fold(item), item);

    return [...seen.values()];
};

/** A destination as a reader recognises it: the path on the site's own domain, else the address. */
const where = (c) => {
    // Never a raw scheme in a report: "Phone +44…" and "Email info@…", not tel: and mailto:.
    if (c.kind === 'phone') return `Phone ${c.href.replace(/^tel:/i, '')}`;
    if (c.kind === 'email') return `Email ${c.href.replace(/^mailto:/i, '').split('?')[0]}`;
    if (c.kind === 'internal' || c.kind === 'same-page') {
        try {
            return new URL(c.href).pathname.replace(/\/$/, '') || '/';
        } catch {
            return c.href;
        }
    }

    return c.href;
};

function firstScreenFinding(record) {
    const fs = record.firstScreen;
    if (!fs || !['yes', 'partly', 'no'].includes(fs.answer)) return null;

    const evidence = {answer: fs.answer, quotes: fs.quotes, wordsToKnow: fs.wordsToKnow, wordsOnScreen: fs.wordsOnScreen};
    if (fs.answer === 'yes') {
        return {
            id: 'first-screen',
            kind: 'doing-its-job',
            weight: 0.2,
            // A COUNT, NOT A VERDICT. The first threshold tried (20 words, "five seconds")
            // failed every site in the corpus, including the ones that are plainly clear.
            text: `The first screen says what you do in ${fs.wordsToKnow} words: ${ending(quoted(fs.quotes[fs.quotes.length - 1]))}`,
            evidence,
        };
    }

    // WHERE IT IS SAID INSTEAD, when the page says it somewhere a visitor does not look.
    const head = record.head ?? {};
    const hidden = head.hiddenHeadings ?? [];
    let instead = '';
    // THE FIX, from the same evidence: the page's own words, where it already wrote them.
    let fix = 'Add a line to the first screen that names what you sell.';
    if (head.answer === 'yes' && head.sources.includes('hidden heading') && hidden.length) {
        instead = ` Your page does say it — in a heading hidden from visitors: ${ending(quoted(hidden[0]))}`;
        fix = `Put ${quoted(hidden[0])} on the first screen, where visitors can read it.`;
    } else if (head.answer === 'yes' && head.sources.includes('title') && head.title) {
        instead = ` Your page title does: ${ending(quoted(head.title))}`;
        fix = `Say on the first screen what your page title says: ${ending(quoted(head.title))}`;
    } else if (head.answer === 'yes' && head.sources.includes('description') && head.description) {
        instead = ` Your description for search engines does: ${ending(quoted(head.description))}`;
        fix = `Say on the first screen what your description for search engines says: ${ending(quoted(head.description))}`;
    }

    return {
        id: 'first-screen',
        kind: 'gap',
        weight: 1,
        text: (fs.answer === 'partly'
            ? 'The first screen says who it is for, not what you sell.'
            : 'Nothing on the first screen says what you sell.') + instead,
        fix,
        evidence: {...evidence, head: head.answer, headSources: head.sources ?? [], hiddenHeadings: hidden, title: head.title ?? ''},
    };
}

/** Where a set of calls to action sits: first screen, pinned, the next one down, menu, footer. */
function placeOf(record, list_) {
    const screen = record.screen || SCREEN;
    const onPage = list_.filter((c) => c.region !== 'footer' && c.region !== 'menu');
    const next = onPage.filter((c) => !c.firstScreen && !c.pinned).sort((a, b) => a.y - b.y)[0] ?? null;

    return {
        onPage,
        first: onPage.filter((c) => c.firstScreen),
        pinned: onPage.find((c) => c.pinned) ?? null,
        next,
        nextScreen: next ? Math.floor(next.y / screen) + 1 : null,
        behindMenu: list_.find((c) => c.region === 'menu' && c.pinned) ?? null,
        footer: list_.find((c) => c.region === 'footer') ?? null,
        screens: record.pageHeight ? Math.max(1, Math.ceil(record.pageHeight / screen)) : null,
    };
}

/** Within reach: pinned, on the first screen, or on the second. */
const withinReach = (at) => Boolean(at.pinned || at.first.length || (at.nextScreen && at.nextScreen <= WITHIN_SCREENS));

function askFindings(record, touch) {
    const ctas = (record.ctas ?? []).filter(isCta);
    const at = placeOf(record, ctas);
    const out = [];

    out.push(at.first.length
        ? {
            id: 'ask-first-screen',
            kind: 'doing-its-job',
            weight: 0.1,
            text: `Visitors can act from the first screen: ${list(unique(at.first.map((c) => quoted(c.label))))}.`,
            evidence: {asks: at.first.map(({label, href, region}) => ({label, href, region}))},
        }
        : {
            id: 'ask-first-screen',
            kind: 'gap',
            weight: 0.9,
            text: 'Nothing on the first screen asks visitors to act.',
            fix: at.next ? `Move ${quoted(at.next.label)} up onto the first screen.` : 'Add a call to action to the first screen.',
            evidence: {asks: []},
        });

    if (at.pinned) {
        out.push({
            id: 'ask-reachable',
            kind: 'doing-its-job',
            weight: 0.1,
            text: `${quoted(at.pinned.label)} stays on screen as visitors scroll.`,
            evidence: {pinned: at.pinned.label, nextScreen: at.nextScreen},
        });
    } else if (withinReach(at)) {
        out.push({
            id: 'ask-reachable',
            kind: 'doing-its-job',
            weight: 0.1,
            text: at.first.length
                ? 'The first screen has a call to action, though nothing stays on screen as visitors scroll.'
                : `The second screen has a call to action: ${ending(quoted(at.next.label))}`,
            evidence: {pinned: null, nextScreen: at.nextScreen},
        });
    } else {
        out.push({
            id: 'ask-reachable',
            kind: 'gap',
            weight: 0.8,
            // NEVER BOTH "nothing stays on screen" AND "the menu button stays": kohde.agency's
            // dot does stay, and the first wording said the opposite in consecutive sentences.
            text: (at.behindMenu
                ? `Nothing visible on the first ${WITHIN_SCREENS === 2 ? 'two' : WITHIN_SCREENS} screens asks visitors to act. `
                    + `${quoted(at.behindMenu.label)} is behind the menu button, which stays on screen, but a visitor has to open it to find it. `
                : `Nothing on the first ${WITHIN_SCREENS === 2 ? 'two' : WITHIN_SCREENS} screens asks visitors to act, `
                    + 'and nothing stays on screen as they scroll. ')
                + (at.next
                    ? `The first ${at.behindMenu ? 'visible ' : ''}call to action is on screen ${at.nextScreen}: ${ending(quoted(at.next.label))}`
                    : `There is no call to action at all${at.footer ? ' until the footer' : ''}.`),
            fix: at.behindMenu
                ? `Put ${quoted(at.next?.label ?? at.behindMenu.label)} on the first screen, not only in the menu: in the hero, or in a header that stays on screen.`
                : `Add ${at.next ? quoted(at.next.label) : 'a call to action'} to the first screen, or keep one on screen as visitors scroll.`,
            evidence: {pinned: null, nextScreen: at.nextScreen, behindMenu: at.behindMenu?.label ?? null},
        });
    }

    // SAID ONCE. "Nothing on the first screen" is contained in "nothing on the first two
    // screens", and kohde.agency got both, one after the other.
    if (!at.first.length && out.some((f) => f.id === 'ask-reachable' && f.kind === 'gap')) {
        out.splice(out.findIndex((f) => f.id === 'ask-first-screen'), 1);
    }

    // A WAY TO GET IN TOUCH (or buy), within reach: the contact and purchase asks alone.
    // bedellcristin.com passes the two checks above on "Meet our people" and "Explore our
    // services", and its only "Contact Us" is in the footer — which is this finding.
    const sales = placeOf(record, (record.ctas ?? []).filter((c) => c.intent === 'sales'));
    if (withinReach(sales)) {
        const shown = sales.pinned ?? sales.first[0] ?? sales.next;
        out.push({
            id: 'get-in-touch',
            kind: 'doing-its-job',
            weight: 0.1,
            text: `Visitors can ${touch} without hunting: ${ending(quoted(shown.label))}`,
            evidence: {label: shown.label, pinned: Boolean(sales.pinned)},
        });
    } else {
        const label = sales.next?.label ?? sales.behindMenu?.label ?? sales.footer?.label ?? null;
        out.push({
            id: 'get-in-touch',
            kind: 'gap',
            weight: 0.85,
            text: sales.behindMenu && sales.next
                ? `Before screen ${sales.nextScreen}, the only way to ${touch} is behind the menu button.`
                : sales.behindMenu
                    ? `The only way to ${touch} is behind the menu button${sales.footer ? ' and in the footer' : ''}.`
                    : sales.next
                        ? `The first way to ${touch} is on screen ${sales.nextScreen}: ${ending(quoted(sales.next.label))}`
                        : sales.footer
                            ? `The only way to ${touch} is in the footer: ${ending(quoted(sales.footer.label))}`
                            : `Nothing on the page asks visitors to ${touch}.`,
            fix: label
                ? `Put ${quoted(label)} on the first screen, or in a header that stays on screen.`
                : `Add a way to ${touch} to the first screen.`,
            evidence: {nextScreen: sales.nextScreen, behindMenu: sales.behindMenu?.label ?? null,
                footer: sales.footer?.label ?? null},
        });
    }

    // ONE DESTINATION, SEVERAL NAMES. Checked across the whole page, footer included (menu
    // items are not: a hidden "Contact" is not a second name anybody has read). Only real
    // destinations: wahio.design's twelve href-less <button>s were read as one place "".
    // CONVERSION ASKS ONLY (26 Sep 2026): once routing calls to action counted,
    // bedellcristin.com's /services was "Explore our services", "Our services", "View our
    // services" and a team card — links to a page, not one ask worded several ways.
    const byPlace = new Map();
    for (const c of ctas.filter((x) => x.href && x.region !== 'menu' && x.intent !== 'next')) {
        const key = where(c);
        byPlace.set(key, uniqueFolded([...(byPlace.get(key) ?? []), c.label]));
    }
    for (const [place, labels] of byPlace) {
        if (labels.length < 2) continue;
        out.push({
            id: `labels-${place}`,
            kind: 'gap',
            weight: 0.4,
            text: `${place} is asked for in ${labels.length} different words: ${list(labels.map(quoted))}.`,
            fix: `Use one label for ${place}: whichever of ${list(labels.map(quoted))} says best what happens next.`,
            evidence: {destination: place, labels},
        });
    }

    // WHAT A SCREEN READER HEARS, when it does not contain what the button says — WCAG
    // 2.5.3, "label in name". boondmanager.com's header "Essayer" is announced "Demander une
    // démo"; wahio.design's "Cart" is announced "Open cart", which contains it and is fine.
    const mismatched = ctas.filter((x) => x.spoken && !fold(x.spoken).includes(fold(x.label)));
    for (const c of unique(mismatched.map((x) => JSON.stringify([x.label, x.spoken])))) {
        const [label, spoken] = JSON.parse(c);
        out.push({
            id: `spoken-${label}`,
            kind: 'gap',
            weight: 0.5,
            text: `Your ${quoted(label)} button tells screen-reader users ${ending(quoted(spoken))}`,
            fix: `Make the button's screen-reader name include ${quoted(label)}, or change what it shows to match.`,
            evidence: {label, spoken},
        });
    }

    return out;
}

/**
 * The findings for one site. `purpose` is report.json's `{kind, confidence}`; without a
 * confident purpose that asks, only the first screen is judged.
 */
export function readProposition(record, purpose) {
    if (!record?.measured) return {worth: false, findings: []};

    const findings = [];
    const first = firstScreenFinding(record);
    if (first) findings.push(first);

    // SPARE ONLY WHAT WE ARE SURE IS NOT MEANT TO ASK. This used to judge the asks only on
    // a confident sell or enquire, and vaiie.com — "Get Started" and "Contact" on its first
    // screen — came back "unclear" in the audit and "enquire, 58%" on a re-run, under the
    // floor both times, so its asks were never looked at. Sell and enquire are exactly what
    // a B2B SaaS page blurs; a portal or a publication is what a confident answer can rule out.
    const confident = (purpose?.confidence ?? 0) >= CONFIDENCE_FLOOR;
    if (!(confident && PURPOSES_THAT_DO_NOT_ASK.includes(purpose?.kind))) {
        findings.push(...askFindings(record, touchVerb(confident ? purpose : null)));
    }

    findings.sort((a, b) => b.weight - a.weight);

    return {worth: findings.length > 0, findings};
}

/**
 * THE PROPOSITION SCORE, out of 10, from the same findings.
 *
 * HALF FOR SAYING WHAT YOU DO: yes 10, partly 5, no 0. The word count is not scored — the
 * first threshold tried failed every site, clear ones included.
 *
 * HALF FOR THE CALLS TO ACTION, on a page whose job is to ask (26 Sep 2026): 15% for one
 * on the first screen, 15% for one within reach after it, 20% for a way to get in touch
 * within reach — the contact or purchase ask itself. Routing calls to action alone take half
 * marks on the first two; a pinned menu is half marks for either of the last two, as
 * kohde.agency's dot is. Less a point for each screen-reader mismatch
 * and each destination asked for in several words, two at most. A confident portal or
 * publication is scored on what it says alone.
 *
 * JUDGEMENT, NOT MEASUREMENT, the way lib/pdf.mjs's DUPLICATE_PENALTY is: constants, so
 * moving one is one edit and a test failure. Null when the first screen was never judged.
 */
export const CLARITY = {yes: 10, partly: 5, no: 0};
export const WEIGHTS = {clarity: 0.5, firstAsk: 0.15, reach: 0.15, touch: 0.2};
export const MENU_ONLY_REACH = 5;
export const ROUTING_ONLY = 5;
export const PENALTY = 1;
export const MAX_PENALTIES = 2;

export function propositionScore(record, purpose) {
    const clarity = CLARITY[record?.firstScreen?.answer];
    if (!record?.measured || clarity === undefined) return null;

    const {findings} = readProposition(record, purpose);
    const byId = (id) => findings.find((f) => f.id === id);
    const reachFinding = byId('ask-reachable');
    if (!reachFinding) {
        return {score: clarity, clarity, asksJudged: false};
    }

    // THE SALES ASK IS PREFERRED (Jon, 26 Sep 2026): a routing call to action is playing a
    // different game, so where the only ones on the first screen or within reach are
    // routing, those checks take half marks. bedellcristin.com's "Meet our people".
    const at = placeOf(record, (record.ctas ?? []).filter(isCta));
    const sales = placeOf(record, (record.ctas ?? []).filter((c) => c.intent === 'sales'));
    const firstAsk = at.first.length ? (sales.first.length || sales.pinned ? 10 : ROUTING_ONLY) : 0;
    const reach = withinReach(at) ? (withinReach(sales) ? 10 : ROUTING_ONLY) : (at.behindMenu ? MENU_ONLY_REACH : 0);
    const touchFinding = byId('get-in-touch');
    const touch = touchFinding.kind === 'doing-its-job' ? 10 : (touchFinding.evidence.behindMenu ? MENU_ONLY_REACH : 0);
    const penalties = Math.min(MAX_PENALTIES,
        findings.filter((f) => f.id.startsWith('spoken-') || f.id.startsWith('labels-')).length * PENALTY);
    const score = Math.max(0, clarity * WEIGHTS.clarity + firstAsk * WEIGHTS.firstAsk
        + reach * WEIGHTS.reach + touch * WEIGHTS.touch - penalties);

    return {score: Number(score.toFixed(1)), clarity, firstAsk, reach, touch, penalties, asksJudged: true};
}

/**
 * What a call to action is, as the report's Type column says it (Jon, 26 Sep 2026): Routing
 * for a button deeper into the site, Conversion for a contact, purchase or sign-up ask.
 * "Conversion" and not "Sale": a law firm's "Contact Us" is not a sale.
 */
const TYPE = {sales: 'Conversion', signup: 'Conversion', next: 'Routing'};
const typeOf = (c) => TYPE[c.intent];

/**
 * The calls to action as the report's table (Jon's columns, 26 Sep 2026): the label, its
 * type, how many times it appears, where it goes, and where a visitor first meets it —
 * "Screen 1 (stays on screen)", "Screen N", "Behind the menu", "Footer". One row per label
 * and destination; `unknown` left out. Earliest first. A menu row is kept only when its
 * destination is not visible sooner (boondmanager.com repeated a pinned demo ask there).
 */
export function askRows(record) {
    const screen = record?.screen || SCREEN;
    const rank = (c) => {
        if (c.region === 'menu') return c.pinned ? [1.5, 'Behind the menu'] : [Infinity, null];
        if (c.region === 'footer') return [9998, 'Footer'];
        if (c.pinned) return [0, 'Screen 1 (stays on screen)'];
        const n = c.firstScreen ? 1 : Math.floor(c.y / screen) + 1;

        return [n, `Screen ${n}`];
    };
    const rows = new Map();
    // FORM BUTTONS TOO: kohde.agency's first call to action is a newsletter "Submit" on
    // screen 6 with no href, and the table started at screen 7 while the checklist said 6.
    for (const c of (record?.ctas ?? []).filter(isCta)) {
        const destination = c.href ? where(c) : 'Form on the page';
        const key = `${fold(c.label)}\u0000${destination}`;
        const row = rows.get(key) ?? {label: c.label, type: typeOf(c), count: 0, destination, at: Infinity, where: null};
        const [at, place] = rank(c);
        if (place) row.count++;
        if (place && at < row.at) Object.assign(row, {at, where: place});
        rows.set(key, row);
    }

    const all = [...rows.values()].filter((r) => r.where);
    const soonest = new Map();
    for (const r of all) {
        if (r.where !== 'Behind the menu') soonest.set(r.destination, Math.min(soonest.get(r.destination) ?? Infinity, r.at));
    }

    return all
        .filter((r) => r.where !== 'Behind the menu' || !(soonest.get(r.destination) <= r.at))
        .sort((a, b) => a.at - b.at)
        .map(({at, ...r}) => r);
}

/**
 * THE CALL TO ACTION MAP: the page as a row of screens, each saying how a visitor can act.
 *
 *   ask     a call to action on this screen (the footer's included, on its own screen)
 *   pinned  none of its own, but one stays on screen as the page scrolls
 *   menu    only through a menu button that stays on screen
 *   none    nothing to act on
 *
 * "The first visible call to action is on screen 7" is a sentence a reader has to picture;
 * kohde.agency's six empty screens in a row are not. Empty when the height is unknown.
 */
export function askMap(record) {
    const screen = record?.screen || SCREEN;
    const height = record?.pageHeight;
    if (!height) return [];
    const count = Math.max(1, Math.ceil(height / screen));
    const ctas = (record.ctas ?? []).filter(isCta);
    const pinned = ctas.some((c) => c.pinned && c.region !== 'menu' && c.region !== 'footer');
    const menu = ctas.some((c) => c.region === 'menu' && c.pinned);

    return Array.from({length: count}, (_, i) => {
        const here = ctas.filter((c) => c.region !== 'menu' && !c.pinned
            && Math.min(count, Math.floor(c.y / screen) + 1) === i + 1);
        const asks = unique(here.map((c) => c.label));
        const state = asks.length ? 'ask' : pinned ? 'pinned' : menu ? 'menu' : 'none';

        return {screen: i + 1, state, asks};
    });
}

/** Whether the calls to action are judged at all: everything but a confident portal or publication. */
const asksJudged = (purpose) => !((purpose?.confidence ?? 0) >= CONFIDENCE_FLOOR && PURPOSES_THAT_DO_NOT_ASK.includes(purpose?.kind));

/**
 * THE CHECKLIST: the same six rows on every report, so two reports — or a lead and their
 * competitor — read row by row. `status` is `working` or `fix`; `fix` is null on a row that
 * is working. A confident portal or publication gets the first row only.
 */
export function propositionChecks(record, purpose) {
    if (!record?.measured) return [];
    const {findings} = readProposition(record, purpose);
    const said = findings.find((f) => f.id === 'first-screen');
    if (!said) return [];

    const head = record.head ?? {};
    const hidden = head.hiddenHeadings ?? [];
    const answer = record.firstScreen.answer;
    const saysFound = answer === 'yes'
        ? `Said in the first ${record.firstScreen.wordsToKnow} words a visitor reads`
        : head.answer === 'yes' && head.sources?.includes('hidden heading') && hidden.length ? 'Only in a heading hidden from visitors'
            : head.answer === 'yes' && head.sources?.includes('title') ? 'Only in your page title'
                : head.answer === 'yes' && head.sources?.includes('description') ? 'Only in your description for search engines'
                    : answer === 'partly' ? 'Says who it is for, not what you sell' : 'Nothing on the first screen says it';
    const checks = [{id: 'says', check: 'Says what you do', status: said.kind === 'gap' ? 'fix' : 'working', found: saysFound, fix: said.fix ?? null}];
    if (!asksJudged(purpose)) return checks;

    const confident = (purpose?.confidence ?? 0) >= CONFIDENCE_FLOOR;
    const touch = touchVerb(confident ? purpose : null);
    const at = placeOf(record, (record.ctas ?? []).filter(isCta));
    const labelled = (list_) => list(unique(list_.map((c) => quoted(c.label))));
    const target = at.next?.label ?? at.behindMenu?.label ?? null;
    checks.push(at.first.length
        ? {id: 'ask-first-screen', check: 'Call to action on the first screen', status: 'working', found: labelled(at.first), fix: null}
        : {
            id: 'ask-first-screen',
            check: 'Call to action on the first screen',
            status: 'fix',
            found: at.behindMenu ? 'Only behind the menu button' : at.next ? `First visible call to action on screen ${at.nextScreen}` : 'None',
            fix: target ? `Put ${quoted(target)} on the first screen.` : 'Add a call to action to the first screen.',
        });

    const reachWorking = withinReach(at);
    checks.push({
        id: 'ask-reachable',
        check: 'Call to action within reach',
        status: reachWorking ? 'working' : 'fix',
        found: at.pinned ? `${quoted(at.pinned.label)} stays on screen as visitors scroll`
            : reachWorking ? (at.first.length ? 'Asked on the first screen' : `Asked again on screen 2: ${quoted(at.next.label)}`)
                : at.next ? `First visible call to action on screen ${at.nextScreen}${at.screens ? ` of ${at.screens}` : ''}` : 'No visible call to action on the page',
        fix: reachWorking ? null : 'Keep a call to action on screen as visitors scroll.',
    });

    const touchFinding = findings.find((f) => f.id === 'get-in-touch');
    const sales = placeOf(record, (record.ctas ?? []).filter((c) => c.intent === 'sales'));
    const touchOk = touchFinding.kind !== 'gap';
    checks.push({
        id: 'get-in-touch',
        check: `Way to ${touch}`,
        status: touchOk ? 'working' : 'fix',
        found: touchOk
            ? (sales.pinned ? `${quoted(sales.pinned.label)} stays on screen as visitors scroll`
                : sales.first.length ? labelled(sales.first) : `On screen 2: ${quoted(sales.next.label)}`)
            : sales.behindMenu ? 'Only behind the menu button'
                : sales.next ? `First on screen ${sales.nextScreen}: ${quoted(sales.next.label)}`
                    : sales.footer ? `Only in the footer: ${quoted(sales.footer.label)}` : 'None on the page',
        fix: touchFinding.fix ?? null,
    });

    const names = findings.filter((f) => f.id.startsWith('labels-'));
    checks.push({
        id: 'one-name',
        check: 'Consistent button labels',
        status: names.length ? 'fix' : 'working',
        found: names.length ? names.map((f) => `${f.evidence.destination} is ${list(f.evidence.labels.map(quoted))}`).join('; ') : 'Each destination has one label',
        fix: names[0]?.fix ?? null,
    });

    const spoken = findings.filter((f) => f.id.startsWith('spoken-'));
    checks.push({
        id: 'screen-readers',
        check: 'Screen readers',
        status: spoken.length ? 'fix' : 'working',
        found: spoken.length ? spoken.map((f) => `${quoted(f.evidence.label)} is announced as ${quoted(f.evidence.spoken)}`).join('; ') : 'Every call to action says what it shows',
        fix: spoken[0]?.fix ?? null,
    });

    return checks;
}

/**
 * THE VERDICT: one sentence under the score, built from the checks in fixed words, so it
 * says what the number means without a model writing it. Null when nothing was judged.
 */
export function propositionVerdict(record, purpose) {
    const checks = propositionChecks(record, purpose);
    if (!checks.length) return null;
    const says = {yes: 'Clear about what you do.', partly: 'Says who it is for, not what you sell.', no: 'Does not say what you sell.'}[record.firstScreen.answer];
    if (checks.length === 1) return says;

    const failing = (id) => checks.find((c) => c.id === id)?.status === 'fix';
    const confident = (purpose?.confidence ?? 0) >= CONFIDENCE_FLOOR;
    const touch = touchVerb(confident ? purpose : null);
    if (failing('ask-first-screen') || failing('ask-reachable')) {
        const at = placeOf(record, (record.ctas ?? []).filter(isCta));
        // WHERE THE FIRST ONE IS, never "nothing to click": bedellcristin.com was told
        // "nothing to click at all" with a page full of links and "Contact Us" in its footer.
        const until = at.next ? `no call to action until screen ${at.nextScreen}`
            : at.footer ? 'no call to action until the footer' : 'no call to action anywhere on the page';

        return `${says} Hard to act on: ${until}${at.behindMenu ? ', unless a visitor opens the menu' : ''}.`;
    }
    if (failing('get-in-touch')) {
        const sales = placeOf(record, (record.ctas ?? []).filter((c) => c.intent === 'sales'));
        const how = sales.behindMenu ? `the only way to ${touch} is behind the menu`
            : sales.next ? `no way to ${touch} until screen ${sales.nextScreen}`
                : sales.footer ? `the only way to ${touch} is in the footer` : `no way to ${touch}`;

        return `${says} Easy to explore, but ${how}.`;
    }
    const small = ['one-name', 'screen-readers'].filter(failing).length;

    return `${says} Easy to act on${small ? `, with ${small === 1 ? 'one fix' : `${small} fixes`}` : ''}.`;
}

/**
 * Where a visitor first meets a call to action, as the Competitor Benchmark prints it side
 * by side: "Screen 1 (sticky)", "Screen 1", "Screen N", "Only through the menu", "Footer",
 * "None". Null for a page whose calls to action are not judged.
 */
export function firstCallToAction(record, purpose) {
    if (!record?.measured || !asksJudged(purpose)) return null;
    const at = placeOf(record, (record.ctas ?? []).filter(isCta));
    if (at.pinned) return 'Screen 1 (sticky)';
    if (at.first.length) return 'Screen 1';
    if (at.next) return `Screen ${at.nextScreen}`;

    return at.behindMenu ? 'Only through the menu' : at.footer ? 'Footer' : 'None';
}
