// Ask bar on a static page → the homepage conversation.
//
// Jonson only exists on the homepage: the streaming endpoint renders into the thread
// there, and nothing on a content page can display an answer. So the bar doesn't post
// — it stashes the question and navigates, and the homepage asks it on arrival.
//
// sessionStorage rather than a query string: the question is whatever the visitor
// typed, which can be personal, and a URL would put it in history, the address bar,
// and any referrer sent to a third party. Per-tab storage keeps it to this journey.

import {looksLikeJunk} from './junk-question.js';

const PENDING = 'jonson.pending';
const PENDING_FROM = 'jonson.pending-from'; // the entry id of the page the question was asked from, if any

/** The ask bar on a content page. Intercepts submit and hands off to the homepage. */
export function mountAskHandoff() {
    const form = document.querySelector('[data-jonson-handoff]');
    if (!form) return () => {};

    const onSubmit = (e) => {
        const input = form.querySelector('input[name="question"]');
        const question = (input?.value || '').trim();
        e.preventDefault(); // never a plain submit: the form's action is the homepage, and a bare GET there is a pointless redirect
        if (!question) {
            // Nothing to hand over — stay here and put the cursor back in the box.
            input?.focus();
            return;
        }

        // Not a question either — same answer as the front door gives: the prompts
        // drawer, right here, rather than a trip to the homepage to be refused there.
        // (This bar has its own lost-for-words nudge; see _components/ask.twig.)
        if (looksLikeJunk(question)) {
            document.dispatchEvent(new CustomEvent('jonson:nudge'));
            input?.focus();
            return;
        }

        const from = (form.querySelector('input[name="from"]')?.value || '').trim();
        try {
            sessionStorage.setItem(PENDING, question);
            if (from) sessionStorage.setItem(PENDING_FROM, from);
            else sessionStorage.removeItem(PENDING_FROM);
        } catch (err) {
            // Private mode — fall through to a normal GET so the visitor still
            // reaches the homepage, just without the question carried over.
            return;
        }
        window.location.href = form.getAttribute('action') || '/';
    };

    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
}

/**
 * Is a handed-over question waiting? A PEEK — doesn't clear, so the real consume
 * below still gets it.
 *
 * Needed before the hero is mounted, not after: someone who typed a question on
 * another page has already started the conversation, and playing them the front-door
 * intro first is a detour through a door they walked past. The homepage skips the
 * tunnel when this is true and opens straight into the thread, the same as a restored
 * conversation does.
 */
export function hasPendingQuestion() {
    try {
        return !!sessionStorage.getItem(PENDING);
    } catch (err) {
        return false; // private mode — no handoff to honour
    }
}

/**
 * On the homepage: if a question was handed over, ask it. Returns true if one was
 * consumed, so the caller knows an answer is on its way.
 *
 * Read-and-clear: a refresh must not re-ask, and neither should a later visit.
 */
export function consumePendingQuestion() {
    let question = null;
    let from = null;
    try {
        question = sessionStorage.getItem(PENDING);
        from = sessionStorage.getItem(PENDING_FROM);
        if (question) sessionStorage.removeItem(PENDING);
        sessionStorage.removeItem(PENDING_FROM);
    } catch (err) {
        return false;
    }
    if (!question) return false;

    const form = document.querySelector('[data-jonson-form]');
    const input = form && form.querySelector('[data-jonson-input]');
    if (!form || !input) return false;

    // The page it came from rides on the form for the one request that follows
    // (jonson-ask.js reads and clears it when it posts).
    if (from) form.dataset.jonsonFrom = from;
    else delete form.dataset.jonsonFrom;
    input.value = question;
    // After a frame, so the tunnel and Jonson have mounted and the submit handler
    // exists — otherwise the question is typed into an input nothing is listening to.
    requestAnimationFrame(() => form.requestSubmit());
    return true;
}
