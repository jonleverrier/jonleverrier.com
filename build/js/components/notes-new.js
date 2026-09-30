/**
 * NOTES NEW
 *
 * "New since you were last here" on the Notes links: a count in the footer and the
 * nav panel, and a plain dot on the burger — the nav's count is behind a closed menu,
 * so without the dot nobody would open it to find out.
 *
 * The page carries the post dates of the latest notes (_components/notes-new.twig),
 * the same for everyone. What THIS visitor has seen is one number in localStorage:
 * the newest post date on the last Notes page they were on. Server timestamps on
 * both sides, so for a returning visitor their own clock never enters into it.
 *
 *  · Under Notes (the index, a note, a topic) — mark everything seen, show nothing.
 *  · Never been to Notes — no mark to compare against, so count what's RECENT: the
 *    notes posted in the last FIRST_VISIT_DAYS. Nothing is written until they open
 *    Notes, so the count holds from page to page rather than vanishing on the second.
 *    This one does use the visitor's clock — against a window of weeks, a clock a
 *    few minutes out makes no difference.
 *  · Otherwise — count the notes posted after the mark.
 *
 * localStorage blocked: no badge, and nothing else changes.
 *
**/

const KEY = 'notes.lastSeen';
// Ten dates ship; the tenth only exists to tell 9 from "more than 9".
const CAP = 9;
// A first-timer's window: what counts as "new" to someone with no last visit.
const FIRST_VISIT_DAYS = 30;

function readMark() {
    try { return localStorage.getItem(KEY); } catch (e) { return undefined; }
}

function writeMark(value) {
    try { localStorage.setItem(KEY, String(value)); } catch (e) { /* blocked — no badge */ }
}

export function mountNotesNew(root = document) {
    const source = root.querySelector('[data-notes-new]');
    if (!source) return () => {};

    let data;
    try { data = JSON.parse(source.textContent); } catch (e) { return () => {}; }
    const latest = Array.isArray(data.latest) ? data.latest : [];
    const newest = latest[0] ?? 0;

    const badges = [...root.querySelectorAll('[data-notes-badge]')];
    const burger = root.querySelector('[data-nav-toggle]');
    const burgerLabel = burger?.getAttribute('aria-label') || 'Menu';

    const render = () => {
        const mark = readMark();
        if (mark === undefined) return;

        let count = 0;
        if (data.here) {
            writeMark(newest);
        } else if (mark === null) {
            const since = Date.now() / 1000 - FIRST_VISIT_DAYS * 86400;
            count = latest.filter((t) => t > since).length;
        } else {
            count = latest.filter((t) => t > Number(mark)).length;
        }

        const text = count > CAP ? `${CAP}+` : String(count);
        badges.forEach((badge) => {
            badge.hidden = count === 0;
            const slot = badge.querySelector('[data-notes-badge-count]');
            if (slot) slot.textContent = text;
        });

        if (burger) {
            burger.classList.toggle('has-notes-new', count > 0);
            // The dot is decoration on an icon button; its meaning goes in the name.
            burger.setAttribute('aria-label', count > 0
                ? `${burgerLabel}, ${text} new ${count === 1 ? 'note' : 'notes'}`
                : burgerLabel);
        }
    };

    render();

    // Back from Notes through the bfcache restores this page as it was, badge and
    // all, without running any of this again. Recount against the mark just written.
    const onPageShow = (e) => { if (e.persisted) render(); };
    window.addEventListener('pageshow', onPageShow);

    return () => window.removeEventListener('pageshow', onPageShow);
}
