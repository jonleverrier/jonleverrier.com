/**
 * PROPOSITION
 *
 * Does the first screen tell a stranger what this company does, and what does the page
 * ask them to do about it? COLLECTION ONLY: the facts and one narrow model answer. Which
 * of them become findings, and how a finding is worded, is decided later and elsewhere.
 *
 *   node --test tools/audit/test/proposition.test.mjs
 *
 * THE CASE IT WAS BUILT ON is boondmanager.com, audited by hand on 25 Sep 2026. Its H1 —
 * "Logiciel ERP ESN et cabinet de conseil : logiciel CRM et ATS" — is 1x1px and clipped,
 * so only a search engine reads it; the visible headline is "Work Smart, Grow Fast."; the
 * demo ask lives in a header that stays on screen and in the hero, and nothing between
 * the hero and the footer asks for anything. Every field below exists because that page
 * needed it to be said.
 *
 * THREE PARTS, two cheap and one not:
 *
 *   - COLLECT_PROPOSITION runs in the page during the capture. Every visible control with
 *     its label, destination and position, whether it held its place on screen while the
 *     page scrolled, every h1-h3 and whether a visitor can see it, and the first screen's
 *     text in reading order.
 *   - destinationKind / wordsToKnow / buildProposition are pure: same input, same answer.
 *   - askProposition is the one model call: a fixed-choice answer about the first screen
 *     and the head, the line numbers that carry it, and an intent for each ask. It never
 *     writes a sentence. The quotes are the page's own lines, picked out by number.
 */
import {createHash} from 'node:crypto';
import {apiKey, API, MODEL} from './vision.mjs';

/**
 * Runs IN the page, after the capture has scrolled it and come back to the top.
 *
 * WALKED A SCREEN AT A TIME, and that is what makes two of the answers possible. A control
 * that appears at the same place on screen at two scroll positions is pinned — boond's
 * header demo button — and one that only exists after a reveal animation is seen when its
 * part of the page is on screen, not dismissed because it was `opacity: 0` from the top.
 *
 * VISIBLE MEANS A VISITOR COULD SEE IT. A closed dropdown's copy of an ask is not an ask
 * (boond has one, with a size and `visibility: hidden`), and a screen-reader-only heading
 * is not a headline. Hidden headings are still RECORDED, with the reason, because "the
 * page says it to Google and not to people" is a finding and needs the hidden words.
 *
 * The limitation worth knowing: a control inside a closed shadow root, or drawn on a
 * canvas, is not found. Open shadow roots are walked (window.__auditDeep).
 */
export const COLLECT_PROPOSITION = async ({screen = 900, settleMs = 150, maxScreens = 40} = {}) => {
    const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const deep = window.__auditDeep;
    const up = deep ? deep.parent : (el) => el.parentElement;
    const all = (selector) => (deep ? deep.all(document) : [...document.querySelectorAll('*')])
        .filter((el) => el.matches(selector));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const go = (top) => window.scrollTo({top, left: 0, behavior: 'instant'});

    // clip-path: inset() that leaves no area. Tailwind's sr-only is `inset(50%)` — half from
    // every side, which is all of it — and wahio.design's skip link read as page text because
    // this only knew inset(100%). Opposite sides are added, as the browser does.
    const insetHidesAll = (clipPath) => {
        const m = /^inset\(([^)]*)\)/.exec(clipPath || '');
        if (!m) return false;
        // Lengths other than % count as nothing, so they can only ever make this say
        // "visible". 99 not 100: boondmanager.com hides its H1 with inset(0 0 99.9% 99.9%).
        const v = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/)
            .map((x) => (x.endsWith('%') ? parseFloat(x) || 0 : 0));
        const [t, r = t, b = t, l = r] = v;

        return t + b >= 99 || l + r >= 99;
    };

    // Why a visitor cannot see this element, or null when they can.
    //
    // 'sr-only' IS THE ONE THAT MEANS SOMETHING: hidden from people on purpose and left for
    // screen readers and search engines — a 1px box, or clipped by `clip`/`clip-path`.
    // boondmanager.com's H1 is one. 'clipped' is merely out of view — a carousel slide out
    // of its track, a folded menu — and wahio.design had 36 of those, gov.je 28.
    const hiddenWhy = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width <= 2 && r.height <= 2) return 'sr-only';
        if (r.width < 2 || r.height < 2) return 'tiny';
        if (el.checkVisibility && !el.checkVisibility({opacityProperty: true, visibilityProperty: true})) {
            return 'invisible';
        }
        if (r.right <= 0 || r.left >= window.innerWidth) return 'offscreen';
        for (let a = el; a && a !== document.documentElement; a = up(a)) {
            const cs = getComputedStyle(a);
            if (cs.clip && cs.clip !== 'auto' && /absolute|fixed/.test(cs.position)) return 'sr-only';
            if (insetHidesAll(cs.clipPath)) return 'sr-only';
            if (a !== el && a !== document.body && cs.overflow !== 'visible') {
                const ar = a.getBoundingClientRect();
                if (r.right <= ar.left || r.left >= ar.right || r.bottom <= ar.top || r.top >= ar.bottom) return 'clipped';
            }
        }

        return null;
    };

    const region = (el) => {
        if (el.closest('footer, [role="contentinfo"]')) return 'footer';
        if (el.closest('header, nav, [role="banner"], [role="navigation"]')) return 'header';

        return 'content';
    };

    // The words a visitor can SEE inside `root`: screen-reader-only text is skipped.
    const visibleText = (root) => {
        const parts = [];
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const t = tidy(n.nodeValue);
            const p = n.parentElement;
            if (!t || !p || p.closest('script, style, noscript, template')) continue;
            if (p !== root && hiddenWhy(p)) continue;
            parts.push(t);
        }

        return tidy(parts.join(' '));
    };

    // WHAT A VISITOR READS ON IT. Webflow's button is a <div> face with a transparent link
    // laid over it whose only text is screen-reader-only: boondmanager.com's header shows
    // "Essayer" and says "Demander une démo". With no visible words of its own, a control
    // takes them from an ancestor it COVERS — the same box, give or take a few pixels. Not
    // merely one it sits in: boond's App Store badge overlay sits in a wrapper that also
    // holds a rating, and borrowing the wrapper labelled the badge "4.7".
    const covers = (r, ar) => Math.abs(r.left - ar.left) <= 4 && Math.abs(r.top - ar.top) <= 4
        && Math.abs(r.right - ar.right) <= 4 && Math.abs(r.bottom - ar.bottom) <= 4;
    const label = (el) => {
        let seen = visibleText(el);
        if (!seen) {
            const r = el.getBoundingClientRect();
            for (let a = up(el), i = 0; a && a !== document.body && i < 4; a = up(a), i++) {
                if (!covers(r, a.getBoundingClientRect())) break;
                seen = visibleText(a);
                if (seen) break;
            }
        }

        return seen
            || tidy(el.getAttribute('aria-label'))
            || tidy(el.value)
            || tidy(el.getAttribute('title'))
            || tidy([...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' '))
            // Last: the words only a screen reader gets. Better than no name at all.
            || tidy(el.innerText);
    };

    // What a screen reader announces, when that is not what is on screen.
    const spoken = (el, seen) => {
        const said = tidy(el.getAttribute('aria-label')) || tidy(el.innerText);

        return said && said !== seen ? said.slice(0, 120) : null;
    };

    const CONTROLS = 'a[href], button, [role="button"], input[type="submit"], input[type="button"]';
    const seen = new Map(); // element -> record
    const headings = new Map();
    const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);

    let screens = 0;
    for (let top = 0; top < pageHeight() && screens < maxScreens; top += window.innerHeight) {
        go(top);
        await wait(settleMs);
        screens++;
        const at = window.scrollY;

        for (const el of all(CONTROLS)) {
            const r = el.getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
            if (hiddenWhy(el)) continue;
            let rec = seen.get(el);
            if (!rec) {
                const form = el.closest('form');
                const seenLabel = label(el).slice(0, 120);
                const said = spoken(el, seenLabel);
                rec = {
                    label: seenLabel,
                    ...(said ? {spoken: said} : {}),
                    href: el.href ? String(el.href) : '',
                    tag: el.tagName.toLowerCase(),
                    region: region(el),
                    x: Math.round(r.left),
                    y: Math.round(r.top + at),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    tops: [],
                };
                if (form) {
                    rec.form = {
                        fields: form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select').length,
                        email: !!form.querySelector('input[type=email], input[name*="mail" i]'),
                    };
                }
                seen.set(el, rec);
            }
            rec.tops.push(Math.round(r.top));
        }

        for (const el of all('h1, h2, h3')) {
            const why = hiddenWhy(el);
            const r = el.getBoundingClientRect();
            const onScreen = r.bottom > 0 && r.top < window.innerHeight;
            const rec = headings.get(el);
            if (!rec) {
                headings.set(el, {
                    level: Number(el.tagName[1]),
                    text: tidy(el.textContent).slice(0, 200),
                    y: Math.round(r.top + at),
                    visible: !why && onScreen,
                    hiddenWhy: why,
                });
            } else if (!why && onScreen) {
                rec.visible = true;
                rec.hiddenWhy = null;
            }
        }
    }

    go(0);
    await wait(settleMs);

    // THE FIRST SCREEN, AS TEXT, IN THE ORDER IT IS READ. Text nodes rather than
    // elements, because a wrapper's textContent is its children's joined together; grouped
    // by the nearest block, so a headline with a <span> in it is one line and not three.
    const blocks = new Map();
    // The boxes of every visible control on the first screen: a Webflow button's face is a
    // <div> with a transparent link laid over it, so "inside an <a>" misses its label, and
    // boond's header "Essayer" read as page text. Covered by a control is the test.
    const controlBoxes = all(CONTROLS)
        .filter((el) => !hiddenWhy(el))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.top < screen && r.bottom > 0);
    const covered = (rr) => {
        const cx = rr.left + rr.width / 2;
        const cy = rr.top + rr.height / 2;

        return controlBoxes.some((r) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = tidy(node.nodeValue);
        const parent = node.parentElement;
        if (!text || !parent || parent.closest('script, style, noscript, template, svg')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rr = range.getBoundingClientRect();
        if (rr.width < 1 || rr.height < 1 || rr.top >= screen || rr.bottom <= 0) continue;
        if (hiddenWhy(parent)) continue;
        // THE HEADING OR PARAGRAPH IT BELONGS TO, before any box: kohde.agency sets each word
        // of its headline in its own animated block, and grouping by box read "Kohde builds
        // businesses with design" as five lines. A link is a line only when no paragraph
        // holds it, so "read our <a>terms</a>" stays one sentence.
        let block = parent.closest('h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, dt, dd')
            ?? parent.closest('a, button, label');
        if (!block) {
            block = parent;
            while (block !== document.body && getComputedStyle(block).display === 'inline') block = block.parentElement;
        }
        const control = !!parent.closest('a, button, [role="button"]') || covered(rr);
        const line = blocks.get(block) ?? {
            text: '',
            x: Math.round(rr.left),
            y: Math.round(rr.top),
            tag: block.tagName.toLowerCase(),
            fontSize: 0,
            inHeader: region(block) === 'header',
            // A link or button's words are a control's label, not the page talking. In a
            // header that is navigation; outside one it is still read, as a CTA is.
            inControl: control,
            // Navigation that is not a link: abas-erp.com's "Produits" is a menu label <div>.
            inNav: control || !!parent.closest('nav, [role="navigation"], menu, [role="menu"], [role="menubar"], li'),
        };
        // A space between pieces, except before punctuation that is its own element:
        // vaiie.com sets the full stop of "One platform." in a span, and read "One platform .".
        // And none after an apostrophe or an opening bracket: "l'<em>IA</em>" is "l'IA".
        const joined = /^[.,;:!?)\]…%]/.test(text) || /['’(\[«]$/.test(line.text);
        line.text = joined ? `${line.text}${text}` : tidy(`${line.text} ${text}`);
        line.x = Math.min(line.x, Math.round(rr.left));
        line.y = Math.min(line.y, Math.round(rr.top));
        line.fontSize = Math.max(line.fontSize, parseFloat(getComputedStyle(parent).fontSize) || 0);
        blocks.set(block, line);
    }
    // Rows first, then left to right. The tolerance keeps a button beside a line of text on
    // the same row even when their tops differ by a few pixels.
    const firstScreen = [...blocks.values()]
        .sort((a, b) => (Math.abs(a.y - b.y) <= 8 ? a.x - b.x : a.y - b.y))
        .map((l) => ({...l, text: l.text.slice(0, 400)}));

    // The same place on screen at two or more scroll positions. A header that scrolls away
    // with the page is seen once; one that stays is seen everywhere.
    const isPinned = (tops) => tops.length >= 2 && Math.max(...tops) - Math.min(...tops) <= 2;
    const controls = [...seen.values()].map(({tops, ...rec}) => ({
        ...rec,
        firstScreen: rec.y < screen,
        pinned: isPinned(tops),
    }));

    // WHAT A MENU BUTTON HIDES. kohde.agency's only navigation is a dot that stays on screen;
    // Contact, its phone and its email are in the menu it opens. Read through the button's
    // own aria-controls, WITHOUT CLICKING: opening menus on somebody's page to see what is in
    // them is a side effect this census does not take. A menu that does not declare what it
    // controls is not found — declared, not guessed.
    // Text nodes joined with spaces: textContent runs "Découvrez Boond" and "Demander une
    // démo" together when they are separate elements, as boondmanager.com's menu card has them.
    const words = (root) => {
        const parts = [];
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.parentElement?.closest('script, style, noscript, template')) parts.push(n.nodeValue);
        }

        return tidy(parts.join(' '));
    };
    const menus = [];
    const menuKeys = new Set();
    for (const [el, rec] of seen) {
        // A MENU BUTTON SAYS WHETHER IT IS OPEN. boondmanager.com's carousel arrows declare
        // aria-controls too, and read seven "En savoir plus" as a menu.
        if (!el.hasAttribute('aria-expanded')) continue;
        const ids = (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
        const inside = [];
        for (const id of ids) {
            const target = document.getElementById(id);
            if (!target) continue;
            for (const item of target.querySelectorAll('a[href], button')) {
                if (seen.has(item)) continue; // visible already, and counted as such
                const name = words(item) || tidy(item.getAttribute('aria-label'));
                if (name) inside.push({label: name.slice(0, 120), href: item.href ? String(item.href) : ''});
            }
        }
        // The same menu twice is one: boondmanager.com renders its header twice.
        const key = JSON.stringify([rec.label, inside]);
        if (inside.length && !menuKeys.has(key)) {
            menuKeys.add(key);
            menus.push({label: rec.label, y: rec.y, firstScreen: rec.y < screen, pinned: isPinned(rec.tops), controls: inside});
        }
    }

    return {measured: true, screen, screens, controls, menus, headings: [...headings.values()], firstScreen};
};

/** Booking tools: an ask that ends in a slot in somebody's calendar. */
const BOOKING = /(^|\.)(calendly\.com|cal\.com|savvycal\.com|tidycal\.com|zcal\.co|youcanbook\.me|meetings\.hubspot\.com|acuityscheduling\.com|koalendar\.com|doodle\.com)$/i;

/** Where an existing customer goes: a login, not an ask of a stranger. */
const ACCOUNT_HOST = /^(app|ui|my|portal|account|login|dashboard|client|clients|secure)\./i;
const ACCOUNT_PATH = /(^|\/)(log-?in|sign-?in|signin|connexion|se-connecter|account|compte|espace-client|my-account)(\/|$|\?)/i;

/** Two-label public suffixes, so example.co.uk is one site and not all of co.uk. */
const SECOND_LEVEL = /^(co|com|org|net|ac|gov|ltd|plc)\.[a-z]{2}$/i;

const site = (host) => {
    const labels = host.replace(/^www\./i, '').split('.');
    const two = labels.slice(-2).join('.');

    return SECOND_LEVEL.test(two) ? labels.slice(-3).join('.') : two;
};

/**
 * What a destination asks of a visitor, from the address alone. No model: `mailto:` is an
 * email in every language, which is the point of reading destinations rather than labels.
 */
export function destinationKind(href, pageUrl) {
    const raw = String(href ?? '').trim();
    if (!raw || /^javascript:/i.test(raw)) return 'none';
    if (raw.startsWith('#')) return 'same-page';
    if (/^mailto:/i.test(raw)) return 'email';
    if (/^tel:/i.test(raw)) return 'phone';

    let url;
    let at;
    try {
        at = new URL(pageUrl);
        url = new URL(raw, at);
    } catch {
        return 'none';
    }
    if (!/^https?:$/.test(url.protocol)) return 'none';
    if (BOOKING.test(url.hostname)) return 'booking';
    if (url.hostname === at.hostname && url.pathname === at.pathname && url.hash) return 'same-page';
    if (ACCOUNT_HOST.test(url.hostname) || ACCOUNT_PATH.test(url.pathname)) return 'account';

    return site(url.hostname) === site(at.hostname) ? 'internal' : 'external';
}

const countWords = (text) => String(text ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * How many words a visitor reads, top to bottom, before the page has told them what it
 * does: every line up to and including the last one that says it. `null` when nothing
 * says it — "never" is not zero words.
 */
export function wordsToKnow(lines, says) {
    if (!says?.length) return null;
    const last = Math.max(...says);

    return lines.filter((l) => l.n <= last).reduce((sum, l) => sum + countWords(l.text), 0);
}

export const ANSWERS = ['yes', 'partly', 'no'];
export const LINE_LABELS = ['offer', 'context', 'other'];
export const INTENTS = ['sales', 'signup', 'next', 'service', 'explore', 'account'];
export const HEAD_SOURCES = ['title', 'description', 'social', 'structured', 'hidden heading'];

/**
 * The lines the model is shown and the word count runs over: the first screen, less the
 * header's navigation. NOT less the whole header — gov.je's tagline beside its logo is the
 * one line on its first screen that says what it is.
 */
const contentLines = (p) => (p.firstScreen ?? [])
    .filter((l) => !(l.inHeader && (l.inNav ?? l.inControl)))
    .map((l, i) => ({n: i + 1, text: l.text, y: l.y}));

/**
 * The items behind menu buttons, as controls: region `menu`, placed where their button is,
 * pinned when it is. They are asked about like any other control, and the reading keeps
 * them apart from what a visitor can see.
 */
const menuControls = (p) => (p.menus ?? []).flatMap((m) => m.controls.map((c) => ({
    ...c, region: 'menu', menu: m.label, x: 0, y: m.y, w: 0, h: 0, firstScreen: m.firstScreen, pinned: m.pinned,
})));

/** Each distinct ask once: the same label to the same place is one question, not three. */
const askKey = (c) => `${c.label}\u0000${c.href}`;
const distinctAsks = (p) => {
    const out = new Map();
    for (const c of [...(p.controls ?? []), ...menuControls(p)]) {
        if (c.label && !out.has(askKey(c))) out.set(askKey(c), c);
    }

    return [...out.values()];
};

/**
 * The question. Fixed choices and line numbers only, so it cannot put words in a page's
 * mouth: whatever it picks, the report quotes the page.
 */
export const PROPOSITION_PROMPT = `You are shown what a stranger sees when they land on a company's homepage.

1. THE FIRST SCREEN. Label EVERY numbered line, each on its own:
   - "offer": it names the kind of thing the company sells or is - a product or service
     category you could look up ("accounting software", "branding agency", "ERP", "garden
     rooms", "design studio", "printed t-shirts"). A generic noun ("platform", "software",
     "app", "solutions") counts when the line ties it to a concrete SUBJECT it works on - "a
     platform to run your projects, teams and profitability" is project software. A verb
     phrase alone is not enough ("we build businesses with design").
   - "context": it says who the company serves, or an outcome, without naming the thing - and
     a generic noun tied only to an outcome stays here ("solutions to accelerate your
     performance", "for dental practices", "grow faster").
   - "other": anything else - slogans, navigation, button labels, legal or cookie text, and
     selling points that are not the offer itself (free shipping, discounts, guarantees,
     ratings, delivery times).

2. THE HEAD. Does what the page says about itself where a search engine reads it - its title,
   descriptions, and any headings hidden from visitors - name what the company offers?
   "yes" (it names the thing), "partly" (only who or a benefit), or "no". Say which sources name
   it: "title", "description", "social", "structured", "hidden heading".

3. THE ASKS. For each numbered control, what it asks of a stranger:
   - "sales": start a commercial conversation or a purchase with this company about what it
     offers - contact, demo, quote, call, book, buy, start a trial, create an account for the
     product.
   - "signup": a low-commitment step - newsletter, download, guide, webinar, free resource.
   - "next": a button inviting a stranger deeper into what the company offers - "Explore our
     services", "Meet our people", "View our work", "See how it works", "Learn more" under a
     hero or a section about the offer.
   - "service": use a service the organisation runs for people it already serves - pay a bill
     or tax, report a problem, apply, give feedback, answer a survey, make a complaint.
   - "explore": everything else that only links somewhere - navigation menu items, cards for
     people, articles, news, events or case studies (and their "Read more"), social links,
     legal links, language switchers.
   - "account": for existing customers - log in, client area, support portal.

Judge only by the words and destinations given. Any language.

Return ONLY a JSON object, no prose and no code fence:
{"lines": {"<number>": "offer|context|other"}, "head": "yes|partly|no",
 "headSources": [sources], "ctas": {"<number>": "sales|signup|next|service|explore|account"}}`;

/** Everything the model is told, as one string: also what the cache is keyed on. */
export function propositionInput(meta) {
    const p = meta.proposition ?? {};
    const head = meta.head ?? {};
    const hidden = (p.headings ?? []).filter((h) => !h.visible && h.hiddenWhy === 'sr-only');
    const lines = contentLines(p);
    const asks = distinctAsks(p);
    const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

    return [
        'FIRST SCREEN (in reading order):',
        ...(lines.length ? lines.map((l) => `${l.n}. ${l.text}`) : ['(no text)']),
        '',
        'HEAD:',
        `Title: ${tidy(head.title) || '(none)'}`,
        `Description: ${tidy(head.description) || '(none)'}`,
        head.ogDescription ? `Social: ${tidy(head.ogDescription)}` : '',
        head.schemaDescription ? `Structured: ${tidy(head.schemaDescription)}` : '',
        ...hidden.map((h) => `Hidden heading (h${h.level}): ${h.text}`),
        '',
        'CONTROLS:',
        ...(asks.length
            ? asks.map((c, i) => `${i + 1}. "${c.label}" -> ${destinationKind(c.href, meta.capturedUrl)}${c.href ? `: ${c.href}` : ''}`)
            : ['(none)']),
    ].filter((line) => line !== '').join('\n');
}

/**
 * A reply, made safe. An answer outside the fixed choices is `unknown`, a line number that
 * does not exist is dropped, and a control with no valid intent is `unknown` — never a
 * guess on the model's behalf.
 */
export function parsePropositionReply(text, sizes) {
    const none = {lines: {}, head: 'unknown', headSources: [], ctas: {}};
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return none;
    let body;
    try {
        body = JSON.parse(match[0]);
    } catch {
        return none;
    }

    // Every line and every control gets a value, `unknown` where the reply gave none: a
    // missing label must not read as "other" any more than a missing intent as "explore".
    const labelled = (field, size, allowed) => {
        const out = {};
        for (let n = 1; n <= size; n++) {
            const v = body?.[field]?.[n] ?? body?.[field]?.[String(n)];
            out[n] = allowed.includes(v) ? v : 'unknown';
        }

        return out;
    };

    const ctas = {};
    for (let n = 1; n <= sizes.ctas; n++) {
        const intent = body?.ctas?.[n] ?? body?.ctas?.[String(n)];
        ctas[n] = INTENTS.includes(intent) ? intent : 'unknown';
    }

    return {
        lines: labelled('lines', sizes.lines, LINE_LABELS),
        head: ANSWERS.includes(body?.head) ? body.head : 'unknown',
        headSources: (Array.isArray(body?.headSources) ? body.headSources : []).filter((s) => HEAD_SOURCES.includes(s)),
        ctas,
    };
}

/**
 * The reply's ceiling. 3000 ran out on gov.je (163 controls plus every first-screen line,
 * each labelled), which came back "unknown" for the lot. Output is billed as written, not
 * as allowed, so the headroom costs nothing on a small page.
 */
export const MAX_TOKENS = 8000;

/**
 * How many times the question is asked. MEASURED, not chosen: the same page asked three
 * times gave gov.je "partly/yes/yes" and gov.gg's words-to-know as 37/30/8 (25 Sep 2026,
 * craft/storage/cta/stability.mjs). A single answer is a sample; three give a majority.
 *
 * Voting alone was not enough while the model chose WHICH lines said it: words-to-know
 * depends on the last line chosen, and wahio.design still came back 53/27/53. So the model
 * now labels each line on its own and the code derives the rest — see buildProposition.
 */
export const VOTES = 5;

/** The value more than half of `values` agree on, or null. */
const majority = (values) => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, n] of counts) if (n * 2 > values.length) return v;

    return null;
};

/**
 * Several replies to the same question, reduced to what a majority agrees on: each line's
 * label, the head's answer and sources, and each ask's intent. Anything without a majority
 * is `unknown`, never the first reply's guess. Fewer than two usable replies is no answer.
 */
export function combineReplies(replies) {
    const ok = replies.filter(Boolean);
    if (ok.length < 2) return null;

    const each = (field) => {
        const out = {};
        for (const n of Object.keys(ok[0][field] ?? {})) out[n] = majority(ok.map((r) => r[field]?.[n])) ?? 'unknown';

        return out;
    };

    const lines = each('lines');
    const head = majority(ok.map((r) => r.head)) ?? 'unknown';
    const sourceVotes = new Map();
    for (const r of ok) for (const src of r.headSources) sourceVotes.set(src, (sourceVotes.get(src) ?? 0) + 1);
    const headSources = HEAD_SOURCES.filter((src) => (sourceVotes.get(src) ?? 0) * 2 > ok.length);

    return {lines, head, headSources, ctas: each('ctas')};
}

/**
 * The question, asked VOTES times in parallel and reduced to the majority. A failure is
 * `{reply: null, why}`, not a throw: the record is still written with the facts, and says
 * the judgement is missing. `votes` are the individual replies, kept for the record.
 */
export async function askProposition(meta, opts = {}) {
    const runs = await Promise.all(Array.from({length: opts.votes ?? VOTES}, () => askOnce(meta, opts)));
    const votes = runs.map((r) => r.reply);
    const reply = combineReplies(votes);
    const why = reply ? null : runs.map((r) => r.why).filter(Boolean)[0] ?? 'no two answers were usable';

    return {reply, votes, ...(why ? {why} : {})};
}

/** One ask. */
async function askOnce(meta, opts) {
    const p = meta.proposition ?? {};
    const input = propositionInput(meta);
    const sizes = {lines: contentLines(p).length, ctas: distinctAsks(p).length};
    try {
        const res = await fetch(API, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': opts.key ?? apiKey(opts.envPath),
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: opts.model ?? MODEL,
                max_tokens: MAX_TOKENS,
                // NO temperature: this model rejects it ("deprecated for this model", 400).
                // The same answer every time comes from the cache instead — see inputHash.
                messages: [{role: 'user', content: `${PROPOSITION_PROMPT}\n\n${input}`}],
            }),
        });
        if (!res.ok) {
            const said = await res.json().then((j) => j?.error?.message ?? '').catch(() => '');
            return {reply: null, why: `the model answered ${res.status}${said ? `: ${said}` : ''}`};
        }
        const json = await res.json();
        if (json.stop_reason === 'max_tokens') return {reply: null, why: 'the answer ran out of room'};
        const said = (json?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');

        return {reply: parsePropositionReply(said, sizes)};
    } catch (e) {
        return {reply: null, why: e.message};
    }
}

/** The cache key: the same words shown to the same model get the stored answer. */
export const inputHash = (meta, model = MODEL) =>
    createHash('sha256').update(`${model}\n${VOTES}\n${PROPOSITION_PROMPT}\n${propositionInput(meta)}`).digest('hex');

/**
 * Where the destination alone settles the intent, it does, and the model is not asked to
 * agree: a booking tool is an ask for a conversation in any language, and a login is for
 * people who are already customers.
 */
const SETTLED = {booking: 'sales', account: 'account'};

const stripSlash = (href) => href.replace(/\/(?=$|[?#])/, '');

/**
 * THE VERDICT IS THE CODE'S, from the agreed line labels, so the same labels always give the
 * same answer and the same count:
 *
 *   yes     some line names the offer; words-to-know runs to the FIRST such line.
 *   partly  lines give context (who, or a benefit) and none names the offer.
 *   no      neither.
 *
 * `says` is what a visitor has read that told them anything — context and offer lines, up to
 * the first offer line — and `quotes` is those lines as the page wrote them.
 */
function firstScreenVerdict(lines, labels) {
    if (!labels) return {answer: 'unknown', labels: null, says: [], quotes: [], wordsToKnow: null};
    const firstOffer = lines.find((l) => labels[l.n] === 'offer');
    const says = lines
        .filter((l) => ['offer', 'context'].includes(labels[l.n]) && (!firstOffer || l.n <= firstOffer.n))
        .map((l) => l.n);
    const answer = firstOffer ? 'yes' : says.length ? 'partly' : 'no';

    return {
        answer,
        labels,
        says,
        quotes: says.map((n) => lines[n - 1].text),
        wordsToKnow: firstOffer ? wordsToKnow(lines, [firstOffer.n]) : null,
    };
}

/**
 * The record `proposition.json` holds: facts from the capture, joined to the reply.
 *
 * `reply` may be null — the model failed — and every judgement then reads `unknown`
 * while the facts stand.
 */
export function buildProposition(meta, reply) {
    const p = meta?.proposition;
    if (!p || p.measured === false) {
        return {measured: false, why: p?.why ?? 'the capture did not collect proposition data'};
    }
    const r = reply ?? {lines: null, head: 'unknown', headSources: [], ctas: {}};
    const lines = contentLines(p);
    const asks = distinctAsks(p);
    const intentOf = new Map(asks.map((c, i) => [askKey(c), r.ctas[i + 1] ?? 'unknown']));
    const height = meta.fullHeight || null;
    const head = meta.head ?? {};

    // TWO COPIES IN ONE PLACE ARE ONE ASK. boondmanager.com renders its header twice,
    // stacked, so every header button was counted twice.
    const once = new Map();
    for (const c of [...(p.controls ?? []), ...menuControls(p)]) {
        const key = `${c.label}\u0000${c.href}\u0000${c.region}\u0000${c.x}\u0000${c.y}\u0000${c.w}\u0000${c.h}`;
        if (c.label && !once.has(key)) once.set(key, c);
    }

    const ctas = [...once.values()].map((c) => {
        const kind = destinationKind(c.href, meta.capturedUrl);

        return {
            label: c.label,
            ...(c.spoken ? {spoken: c.spoken} : {}),
            ...(c.menu ? {menu: c.menu} : {}),
            href: c.href,
            kind,
            intent: SETTLED[kind] ?? intentOf.get(askKey(c)) ?? 'unknown',
            region: c.region,
            y: c.y,
            pct: height ? Math.round((c.y / height) * 100) : null,
            firstScreen: c.firstScreen,
            pinned: c.pinned,
            ...(c.form ? {form: c.form} : {}),
        };
    });

    const groups = new Map();
    for (const c of ctas) {
        if (!c.href) continue;
        const key = stripSlash(c.href);
        const g = groups.get(key) ?? {href: c.href, kind: c.kind, labels: [], intents: [], count: 0,
            firstY: c.y, firstScreen: false, pinned: false, regions: []};
        if (!g.labels.includes(c.label)) g.labels.push(c.label);
        if (!g.intents.includes(c.intent)) g.intents.push(c.intent);
        if (!g.regions.includes(c.region)) g.regions.push(c.region);
        g.count++;
        g.firstY = Math.min(g.firstY, c.y);
        g.firstScreen ||= c.firstScreen;
        g.pinned ||= c.pinned;
        groups.set(key, g);
    }

    return {
        measured: true,
        // The viewport height the capture used, so "which screen" can be said in screens.
        screen: p.screen ?? null,
        // The page's height, so the ask map can draw it a screen at a time.
        pageHeight: meta.fullHeight ?? null,
        firstScreen: {
            ...firstScreenVerdict(lines, r.lines),
            wordsOnScreen: lines.reduce((sum, l) => sum + countWords(l.text), 0),
            lines,
        },
        head: {
            answer: r.head,
            sources: r.headSources,
            title: head.title ?? '',
            description: head.description ?? '',
            hiddenHeadings: [...new Set((p.headings ?? [])
                .filter((h) => !h.visible && h.hiddenWhy === 'sr-only')
                .map((h) => h.text))],
        },
        ctas,
        destinations: [...groups.values()].sort((a, b) => a.firstY - b.firstY),
    };
}
