/**
 * SUBMIT ARM
 *
 * The ask bars ship without a send button. It arrives — opening out of the field's
 * right edge, the mic sliding over to make room — the moment what has been typed is
 * actually a question, and collapses again if it stops being one.
 *
 * WHY IT ISN'T JUST SITTING THERE. The button was red from page load, which is a
 * promise it can't keep: with an empty field, or "aaa" in it, pressing it sends
 * nothing — the front door answers a non-question by opening the prompts drawer
 * instead (see jonson-ask.js). The obvious fix, greying it out until it works, is
 * worse HERE than it would be elsewhere, because the mic sits immediately beside it
 * wearing that same grey and working perfectly. Two identical grey buttons, one
 * meaning "ready" and one meaning "refuses", is a worse lie than the red one was.
 *
 * ONE RULE, SHARED. The test is looksLikeJunk() — the same function the front door and
 * the handoff bar gate on, itself the twin of AskController::looksLikeJunk(). A button
 * that appeared on a different rule from the one deciding what pressing it does would
 * be worse than no button at all: it would be confidently wrong.
 *
 * ONE CLASS, and the CSS owns the motion (field-submit in _field.scss). `.is-armed`
 * holds the button open for as long as the question lasts, and the opening itself is
 * the only motion — the submit's whoosh stays a reply to a pointer, not something
 * that fires at the same time as the button arriving.
 *
 * It flips only on the CROSSING — the keystroke where the answer actually changes —
 * so the transition is never restarted mid-flight by the rest of the sentence being
 * typed.
 *
**/

import {looksLikeJunk} from './junk-question.js';

/**
 * @param {HTMLFormElement|null} form  any ask form: question field + submit button
 * @returns {() => void} teardown
 */
export function armSubmit(form) {
    if (!form) return () => {};

    // BY ROLE, not by component class. The three ask bars are three components —
    // .c-frontdoor__input at the front door, .c-jonson__input in the thread and on a
    // content page — and they share the same field name and the same submit mixin.
    // Matching the classes would have quietly skipped the front door, which is both
    // the most-used bar and the only one that refuses junk.
    const input = form.querySelector('input[name="question"]');
    const button = form.querySelector('button[type="submit"]');
    if (!input || !button) return () => {};

    // null, not false, so the first run always writes the class whichever way it
    // lands — a field that arrives pre-filled has to open the button on mount.
    let armed = null;

    const sync = () => {
        const value = input.value.trim();
        const ok = value !== '' && !looksLikeJunk(value);
        if (ok === armed) return; // nothing crossed; leave the transition alone
        armed = ok;
        button.classList.toggle('is-armed', ok);
    };

    input.addEventListener('input', sync);
    // A field can arrive already filled — a restored thread, a back-navigation, or the
    // browser refilling it — so settle the state now rather than waiting for a
    // keystroke that may never come.
    sync();

    return () => {
        input.removeEventListener('input', sync);
        button.classList.remove('is-armed');
    };
}
