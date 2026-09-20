/**
 * LOST FOR WORDS
 *
 * The nudge tucked behind an ask bar's field — the front door's, and the light bar's
 * on a note or case study. Clicking it opens a drawer of every prompt as a chip: the
 * label slides off to the left, the chips slide in from the right (see
 * .c-jonson__drawer). Picking a chip types that prompt into the input — it fills the
 * field, it does NOT submit. The visitor still chooses to ask, and can edit first.
 *
 * The prompts arrive as a JSON array on data-lost-for-words (a page's own questions
 * first, then the homepage's default set; data-lost-for-words-own says how many lead).
 * The chips are rendered by the template beside the button. The button's own wording
 * arrives separately on data-lost-for-words-labels, from the homepage's `suggestions`
 * field: row 0 is what the template rendered and each pick steps to the next.
 *
 * Without a drawer in the markup the nudge falls back to what it was: each click
 * types the next prompt into the field itself.
 *
**/

// Faster than the old placeholder typewriter's 55ms. That was ambient text nobody was
// waiting on; this is something the visitor just asked for, so it wants to land.
const TYPE_SPEED = 25;

// After this many prompts the nudge has done its job — anyone still picking isn't
// short of an idea, and it stops being a suggestion and starts being a toy.
const MAX_USES = 3;

// sessionStorage, not local: the count should follow the visit, not the browser. Coming
// back tomorrow is a new visit and the nudge is useful again; reloading or navigating
// away and back inside the same visit is not, and the allowance carries.
const USES_KEY = 'jonson-prompt-uses';

// How long the drawer's closing slide runs before it's taken out of the tab order —
// matches the panels' transition in .c-jonson__band. TUCK_MS is the band's own
// clip-path wipe, the exit used when the pointer leaves.
const CLOSE_MS = 340;
const TUCK_MS = 260;

// How long the drawer waits after the pointer leaves before it tucks itself away.
//
// It used to go on the instant of pointerleave, which punished the obvious gesture:
// the chips sit in a band ABOVE the field, so reaching one means travelling up and
// often clipping the edge of the box on the way — and the drawer shut under the
// pointer that was going for it. Half a second is long enough to cross that gap or
// come back after a glance, short enough that a drawer left behind still closes
// itself. (Two was tried and overshot — it read as stuck rather than patient; a
// second was the correction to that and still sat a shade long.)
//
// KEEP IN STEP with the band's own hide delay on .c-jonson__band (_jonson.scss). The
// band and the drawer inside it are one object to a visitor; if these two differ, one
// expires under the other and it reads as a glitch rather than a choice.
//
// Cancelled on re-entry, so coming back inside is not merely forgiven but forgotten.
const LEAVE_GRACE_MS = 500;

// Private mode and blocked storage throw on both read and write, and neither is worth
// losing the button over — a failed read is "no uses yet", a failed write just means
// the count doesn't survive the next load.
function readUses() {
    try {
        return Math.max(0, parseInt(sessionStorage.getItem(USES_KEY), 10) || 0);
    } catch {
        return 0;
    }
}

function writeUses(n) {
    try {
        sessionStorage.setItem(USES_KEY, String(n));
    } catch { /* nothing to do — the in-memory count still caps this page load */ }
}

export function mountLostForWords(button) {
    if (!button) return () => {};

    let prompts;
    try {
        prompts = JSON.parse(button.getAttribute('data-lost-for-words') || '[]');
    } catch {
        prompts = [];
    }
    prompts = (Array.isArray(prompts) ? prompts : []).filter(Boolean);
    if (!prompts.length) return () => {};

    let labels;
    try {
        labels = JSON.parse(button.getAttribute('data-lost-for-words-labels') || '[]');
    } catch {
        labels = [];
    }
    labels = (Array.isArray(labels) ? labels : []).filter(Boolean);

    // The input this nudge belongs to: the front door's, or the light bar's (which
    // marks its scope with data-prompt-scope, as the front door does with
    // data-frontdoor).
    const input = button.closest('[data-frontdoor], [data-prompt-scope]')?.querySelector('[data-jonson-input]');
    if (!input) return () => {};

    // The drawer of chips beside the button (see the templates): when it's there the
    // nudge is a toggle that opens it, and a chip is what puts words in the field.
    const field = button.closest('[data-lost-for-words-field]');
    const drawer = field ? field.querySelector('[data-lost-for-words-drawer]') : null;
    const chips = drawer ? [...drawer.querySelectorAll('[data-prompt]')] : [];

    // Spent on an earlier page this visit — leave the button hidden, but DON'T bail.
    // The nudge can still be asked for by name: a visitor who typed "a" into the field
    // is short of an idea whatever their allowance says, and that is exactly who this
    // drawer is for (see the jonson:nudge listener at the foot of this file).
    const spent = readUses() >= MAX_USES;
    button.hidden = spent;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Random FIRST prompt, then step through in order (the no-drawer fallback). Pure
    // random repeats itself — with two prompts a second click would show the same
    // one half the time, which reads as the button being broken. Unless the page
    // has questions of its own: then start at the top, so the first click asks
    // about THIS page.
    const own = parseInt(button.getAttribute('data-lost-for-words-own') || '0', 10) || 0;
    let i = own > 0 ? 0 : Math.floor(Math.random() * prompts.length);
    let used = false;
    let timer = 0;
    let uses = readUses();
    // Handed the drawer by the junk nudge rather than having gone looking for it. Set
    // for the REST OF THE PAGE LOAD, not just while that first drawer is on screen:
    // the pointer leaving tucks the drawer away, and the visitor who hovers back and
    // presses the nudge they can still see has to get it. Scoping this to the open
    // drawer left a visible button that did nothing.
    let nudged = false;

    // The allowance, with that exemption folded in. Every cap test goes through here,
    // so the button, the drawer and the chips can never disagree about it.
    const capped = () => uses >= MAX_USES && !nudged;

    // Carrying uses from an earlier page: the label steps on from where it got to.
    if (uses > 0 && labels.length) {
        button.textContent = labels[uses % labels.length];
    }

    const retireIfSpent = () => {
        if (capped()) {
            button.hidden = true;
            if (drawer) drawer.hidden = true;
        }
    };

    const put = (text) => {
        input.value = text;
        input.setSelectionRange(text.length, text.length);
        input.dispatchEvent(new Event('input', {bubbles: true}));
    };

    const stop = () => {
        clearTimeout(timer);
        timer = 0;
        button.classList.remove('is-typing');
        button.removeAttribute('aria-disabled');
    };

    // ---- the drawer ----------------------------------------------------------
    let open = false;
    let closeTimer = 0;
    // Separate from closeTimer, which is the teardown closeDrawer() schedules for the
    // slide. This one is the grace period BEFORE any of that starts, and the two
    // overlap whenever a leave actually results in a close.
    let leaveTimer = 0;

    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDrawer(true);
        }
    };
    // A click anywhere outside the field (the drawer is inside it) closes the drawer.
    const onOutside = (e) => {
        if (field && !field.contains(e.target)) closeDrawer(false);
    };
    // So does the pointer leaving — the band and the field together, since the
    // band is inside the field's box. The label's band already tucks away on
    // mouse-out; the open drawer should go the same way rather than sit there.
    const onLeave = (e) => {
        if (e.pointerType && e.pointerType !== 'mouse') return; // touch has no hover to leave
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => closeDrawer(false, true), LEAVE_GRACE_MS);
    };
    // Back inside before the clock runs out: the drawer stays, and the next leave
    // starts a fresh two seconds rather than resuming a spent one.
    const onEnterAgain = () => clearTimeout(leaveTimer);

    // No `force` argument: `nudged` is what lifts the allowance and it is already set
    // by the time this runs (see onNudge). The lift has to reach the CHIPS as well — a
    // drawer that opens with dead chips is worse than one that doesn't open — and the
    // allowance is nearly always spent by this point (onEnter burns it outright the
    // moment a conversation starts).
    const openDrawer = () => {
        if (!drawer || open || capped()) return;
        open = true;
        clearTimeout(closeTimer);
        clearTimeout(leaveTimer);
        field.classList.remove('is-tucking', 'is-resetting');
        drawer.hidden = false;
        // Two frames: the first paints it (display), the second starts the slide.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!open) return;
            drawer.classList.add('is-open');
            field.classList.add('is-open');
        }));
        button.setAttribute('aria-expanded', 'true');
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onOutside, true);
        field.addEventListener('pointerleave', onLeave);
        field.addEventListener('pointerenter', onEnterAgain);
        // preventScroll, and it is the whole reason the bar stopped moving. Focusing
        // an element makes the browser scroll it into view, and the chips sit in a
        // band ABOVE the field — so on a phone, where that band is near the top of a
        // full-height section, opening the drawer scrolled the page and carried the
        // input with it. Only the band's contents should move.
        //
        // The focus itself stays: it is what puts a keyboard user on the first chip
        // and what the Escape handler and the outside-click close depend on. Only
        // the browser's scrolling is declined.
        if (chips[0]) chips[0].focus({preventScroll: true});
    };

    // Two ways to close. The visitor is still here (picked a chip, pressed Escape):
    // the panels slide back and the band closes up to its strip in view. The
    // pointer has left: the whole open band tucks away into the field in one wipe
    // — the question band's own exit — and the panels reset unseen behind it, so
    // the next hover finds the label back on its strip.
    const closeDrawer = (refocus, tuck = false) => {
        if (!drawer || !open) return;
        open = false;
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onOutside, true);
        field.removeEventListener('pointerleave', onLeave);
        field.removeEventListener('pointerenter', onEnterAgain);
        // A close that came from somewhere else — Escape, a click outside, a chip
        // picked — must not leave a leave-clock ticking behind it.
        clearTimeout(leaveTimer);
        const reset = () => {
            drawer.classList.remove('is-open');
            field.classList.remove('is-open', 'is-tucking');
        };
        if (tuck && !reduced) {
            field.classList.add('is-tucking');
            closeTimer = setTimeout(() => {
                if (open) return;
                field.classList.add('is-resetting'); // no transitions for the unseen reset
                reset();
                drawer.hidden = true;
                requestAnimationFrame(() => requestAnimationFrame(() => field.classList.remove('is-resetting')));
            }, TUCK_MS);
        } else {
            reset();
            // Out of the tab order once the slide is done — not before, or it vanishes.
            closeTimer = setTimeout(() => { if (!open) drawer.hidden = true; }, reduced ? 0 : CLOSE_MS);
        }
        if (refocus) input.focus({preventScroll: true});
    };

    // Type a phrase into the field, letter by letter (or at once under reduced
    // motion), counting it as a use. `spinner` puts the nudge into its typing
    // state — the label swapped for a spinner — for the no-drawer fallback,
    // where the nudge itself is what's typing; a chip pick types the same way
    // but leaves the nudge alone (the band has tucked away by then anyway).
    const typeIn = (phrase, spinner = true) => {
        used = true;
        uses += 1;
        writeUses(uses);
        if (labels.length) button.textContent = labels[uses % labels.length];

        input.focus();

        if (reduced) {
            put(phrase);
            retireIfSpent();
            return;
        }

        if (spinner) {
            button.classList.add('is-typing');
            button.setAttribute('aria-disabled', 'true');
        }
        put('');
        let n = 0;
        const tick = () => {
            n += 1;
            put(phrase.slice(0, n));
            if (n < phrase.length) {
                timer = setTimeout(tick, TYPE_SPEED);
            } else {
                stop();
                retireIfSpent();
            }
        };
        timer = setTimeout(tick, TYPE_SPEED);
    };

    // Typing or pasting takes over from the nudge: stop the typewriter where it is,
    // close the drawer, and if the allowance is spent, retire the button.
    const onInterrupt = () => {
        stop();
        closeDrawer(false);
        retireIfSpent();
    };

    const onClick = () => {
        if (timer) return;
        if (capped()) return;
        if (drawer) {
            if (open) closeDrawer(true);
            else openDrawer();
            return;
        }
        // No drawer: cycle the prompts into the field, one per click.
        if (used) i = (i + 1) % prompts.length;
        typeIn(prompts[i]);
    };

    // A pick: the words type into the field, and the band tucks away whole — it's
    // hidden by the field having text (see the :placeholder-shown rules), so the
    // drawer can't come back until the field is cleared. The close is the
    // tuck-away kind, so the panels don't visibly swap back under a band that's
    // already leaving; and no spinner on the nudge, which is out of sight.
    const onChip = (e) => {
        const chip = e.currentTarget;
        if (timer || capped()) return;
        closeDrawer(false, true);
        typeIn(chip.getAttribute('data-prompt') || chip.textContent.trim(), false);
    };

    // The conversation has started (jonson-ask.js): the nudge is done for this visit.
    const onEnter = () => {
        stop();
        closeDrawer(false);
        uses = MAX_USES;
        writeUses(uses);
        // The exemption goes with it: a question is being asked, so nobody is short
        // of one any more.
        nudged = false;
        button.hidden = true;
        if (drawer) drawer.hidden = true;
    };

    // Asked for by name. jonson-ask.js and ask-handoff.js fire this instead of
    // submitting when what was typed isn't a question — so the field answers with a
    // drawer of things to ask rather than the front door folding into a conversation
    // headed "aaa". Spends no allowance and ignores the cap: this visitor didn't go
    // looking for the nudge, they were handed it.
    const onNudge = () => {
        nudged = true;
        button.hidden = false;
        openDrawer();
    };

    document.addEventListener('jonson:nudge', onNudge);
    document.addEventListener('jonson:enter', onEnter, {once: true});
    button.addEventListener('click', onClick);
    chips.forEach((c) => c.addEventListener('click', onChip));
    input.addEventListener('keydown', onInterrupt);
    input.addEventListener('paste', onInterrupt);

    return () => {
        stop();
        closeDrawer(false);
        document.removeEventListener('jonson:nudge', onNudge);
        document.removeEventListener('jonson:enter', onEnter);
        button.removeEventListener('click', onClick);
        chips.forEach((c) => c.removeEventListener('click', onChip));
        input.removeEventListener('keydown', onInterrupt);
        input.removeEventListener('paste', onInterrupt);
    };
}
