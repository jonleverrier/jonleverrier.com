/**
 * PLACEHOLDER CYCLE
 *
 * An ask bar's field steps through its prompts (data-placeholder-cycle) in place of
 * its placeholder, each one as `Ask "…"`. The line slides up and out as the next one
 * hops in behind it.
 *
 * WHY AN OVERLAY. A native placeholder can't animate — swapping the attribute is a
 * hard cut. So the real placeholder stays (it's the first prompt in the same shape,
 * rendered by the template, and what :placeholder-shown keys on), its text is made
 * transparent, and the lines are drawn by a span laid over the field
 * (.c-field__cycle).
 *
 * THE HOP. Each prompt is built a character to a span, and an arriving one hops in
 * left to right — each character's animation delayed by its index (--i), the CSS owns
 * the rest. Only on arrival: once landed the line sits still until the next swap.
 *
 * WHEN IT RUNS. Only while the field is empty and not focused — the same moments a
 * placeholder is visible at all (field-input clears it on focus). Focus or text pauses
 * it; coming back to an empty, blurred field resumes with a full hold, so a line never
 * changes the instant you look at it. Reduced motion: no cycle, the first prompt
 * stays put.
 *
 * LONG PROMPTS SCROLL. A prompt wider than the field would only ever be read up to
 * the bar's edge, so once it has landed it waits a beat, slides left at a steady
 * reading pace until its end is in view, and holds there before the next one comes.
 * A bar with ONE prompt (a VIP's own, say) has no next one: a long one slides back to
 * its start instead and goes round again; one that fits simply stays put.
 * It moves on the `translate` property, not `transform`, so it composes with the
 * line's own vertical centring and its exit, which are both on transform.
 *
 * NEVER A QUESTION ALREADY ASKED (Jon, 3 Oct 2026). A prompt the visitor has asked in
 * this conversation — any question in the thread, restored ones included — is skipped,
 * matched on its words alone (case and punctuation aside). Asking the prompt on screen
 * moves the line on at once (jonson-ask.js sends jonson:asked). With every prompt asked,
 * the cycle retires and the field takes its plain placeholder
 * (data-placeholder-fallback, the CMS's ask line).
 *
 * WHAT IT SHARES. The prompt on screen is written to the input as data-cycle-current,
 * which jonson-ask.js reads so an empty submit asks the question the visitor is
 * looking at. Written even under reduced motion, where it simply never changes.
 *
**/

// How long a prompt that fits holds, once landed, before the next one rises in.
const HOLD_MS = 2600;

// A prompt too long for the field: the beat before it starts to move, its speed, and
// how long its end holds once it's in view.
const SCROLL_LEAD_MS = 900;
const SCROLL_PX_PER_S = 60;
const SCROLL_END_HOLD_MS = 1600;

// The slide itself — keep in step with .c-field__cycle-line's transition.
const SWAP_MS = 520;

// One character's hop, and the gap between one starting and the next — keep in step
// with .c-field__cycle-line.is-hopping.
const HOP_MS = 460;
const HOP_STAGGER_MS = 22;

/**
 * @param {HTMLInputElement|null} input  a field carrying data-placeholder-cycle
 * @returns {() => void} teardown
 */
export function mountPlaceholderCycle(input) {
    if (!input) return () => {};

    let prompts;
    try {
        prompts = JSON.parse(input.dataset.placeholderCycle || '[]').filter((p) => typeof p === 'string' && p.trim());
    } catch {
        prompts = [];
    }
    if (!prompts.length) return () => {};

    // What's been asked: every question in the thread, by its words alone.
    const norm = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const asked = () => new Set([...document.querySelectorAll('.c-jonson__question')].map((q) => norm(q.textContent || '')));
    const isFresh = (i, seen = asked()) => !seen.has(norm(prompts[i]));
    // The next prompt not yet asked, after `from` and wrapping round to it; -1 if none.
    const nextFresh = (from) => {
        const seen = asked();
        for (let k = 1; k <= prompts.length; k++) {
            const i = (from + k) % prompts.length;
            if (isFresh(i, seen)) return i;
        }
        return -1;
    };

    let index = isFresh(0) ? 0 : Math.max(0, nextFresh(0));
    const setCurrent = () => {
        input.dataset.cycleCurrent = prompts[index];
    };
    setCurrent();

    // Every prompt asked: no cycle, the plain placeholder, nothing for an empty submit
    // to ask.
    const fallback = input.dataset.placeholderFallback || '';
    let retired = false;

    // Reduced motion: no cycle, no scroll — the template's placeholder shows the first.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const still = () => {
            const i = isFresh(index) ? index : nextFresh(index);
            if (i < 0) {
                delete input.dataset.cycleCurrent;
                if (fallback) input.placeholder = fallback;
                return;
            }
            index = i;
            setCurrent();
            input.placeholder = `Ask "${prompts[index]}"`;
        };
        still();
        document.addEventListener('jonson:asked', still);
        return () => {
            document.removeEventListener('jonson:asked', still);
            delete input.dataset.cycleCurrent;
        };
    }

    const overlay = document.createElement('span');
    overlay.className = 'c-field__cycle';
    overlay.setAttribute('aria-hidden', 'true'); // the aria-label already says what this is
    const slot = document.createElement('span');
    slot.className = 'c-field__cycle-slot';
    overlay.append(slot);

    const line = (text) => {
        const el = document.createElement('span');
        el.className = 'c-field__cycle-line';
        [...`Ask "${text}"`].forEach((ch, i) => {
            const c = document.createElement('span');
            c.className = 'c-field__cycle-char';
            c.style.setProperty('--i', String(i));
            c.textContent = ch;
            el.appendChild(c);
        });
        return el;
    };
    let current = line(prompts[index]);
    slot.appendChild(current);
    input.after(overlay);
    input.classList.add('is-cycling');

    let timer = null;
    let disposed = false;

    // Not while the mic is listening either: the field says "Listening..." then (see
    // jonson-voice.js), and a prompt hopping in behind it would contradict it.
    const idle = () => input.value === '' && document.activeElement !== input && !input.classList.contains('is-listening');

    // How long a lone long prompt takes to slide back to its start.
    const RETURN_MS = 600;

    const retire = () => {
        retired = true;
        clearTimeout(timer);
        timer = null;
        overlay.remove();
        input.classList.remove('is-cycling');
        delete input.dataset.cycleCurrent;
        if (fallback) input.placeholder = fallback;
    };

    const advance = () => {
        timer = null;
        if (retired || !idle()) return;

        const upcoming = nextFresh(index);
        if (upcoming < 0) {
            retire();
            return;
        }

        // Only one prompt left to show: back to its start and round again, rather than
        // swapping it for itself.
        if (upcoming === index) {
            current.style.setProperty('--scroll-ms', `${RETURN_MS}ms`);
            current.style.translate = '';
            timer = setTimeout(present, RETURN_MS);
            return;
        }

        index = upcoming;
        setCurrent();

        const next = line(prompts[index]);
        next.classList.add('is-hopping'); // its characters' own animation, from the CSS
        slot.appendChild(next);
        const prev = current;
        current = next;
        prev.classList.add('is-leaving');
        setTimeout(() => prev.remove(), SWAP_MS + 60);

        // Its hold starts once the last character has landed — not at the swap — so a
        // long prompt isn't asked to start scrolling while it's still arriving.
        clearTimeout(timer);
        timer = setTimeout(present, HOP_MS + (next.childElementCount - 1) * HOP_STAGGER_MS);
    };

    // The current line is at rest: hold it, or — if it's wider than the field —
    // scroll it to its end first. Measured at the END of the lead-in, not when the
    // line lands: as late as possible, so it's the field's width now, in the face that
    // actually rendered. (Measured at mount, the first prompt came out at the fallback
    // font's width — at 1440 it read as fitting and never scrolled.)
    const present = () => {
        clearTimeout(timer);
        // The line on screen has been asked since it arrived (a restored thread, or
        // the visitor sent it): move on now rather than hold it.
        if (!isFresh(index)) {
            advance();
            return;
        }
        timer = setTimeout(() => {
            const overflow = current.scrollWidth - slot.clientWidth;
            if (overflow <= 1) {
                // A lone prompt that fits has nowhere to go: leave it be.
                timer = nextFresh(index) !== index ? setTimeout(advance, HOLD_MS - SCROLL_LEAD_MS) : null;
                return;
            }
            const ms = Math.max(800, Math.round((overflow / SCROLL_PX_PER_S) * 1000));
            current.style.setProperty('--scroll-ms', `${ms}ms`);
            current.style.translate = `${-overflow}px 0`;
            timer = setTimeout(advance, ms + SCROLL_END_HOLD_MS);
        }, SCROLL_LEAD_MS);
    };

    // Back to the line's start, with no transition — for a resume, where the visitor
    // comes back to a prompt that may have been left part-way along.
    const rewind = () => {
        current.style.setProperty('--scroll-ms', '0ms');
        current.style.translate = '';
    };

    const pause = () => {
        clearTimeout(timer);
        timer = null;
    };

    // Resume from the line's start with a full hold. Deferred a tick: on blur,
    // activeElement is still settling, and on the input event that empties the field
    // focus is still inside.
    const resume = () => setTimeout(() => {
        if (idle() && !timer) {
            rewind();
            present();
        }
    }, 0);

    const onInput = () => (input.value === '' ? resume() : pause());
    const onListening = (e) => (e.detail ? pause() : resume());

    input.addEventListener('focus', pause);
    input.addEventListener('blur', resume);
    input.addEventListener('input', onInput);
    input.addEventListener('jonson:listening', onListening);
    // A question just went up: if it's the line on screen (or the last fresh one), move
    // on — at once when the field is idle, else when it next is (resume → present).
    const onAsked = () => {
        if (retired || isFresh(index)) return;
        if (idle()) {
            clearTimeout(timer);
            advance();
        }
    };
    document.addEventListener('jonson:asked', onAsked);
    // After the fonts: the first line is the one on screen from page load, and the
    // lead-in alone doesn't cover a slow font.
    document.fonts.ready.then(() => {
        if (!disposed && idle() && !timer) present();
    });

    return () => {
        disposed = true;
        pause();
        input.removeEventListener('focus', pause);
        input.removeEventListener('blur', resume);
        input.removeEventListener('input', onInput);
        input.removeEventListener('jonson:listening', onListening);
        document.removeEventListener('jonson:asked', onAsked);
        input.classList.remove('is-cycling');
        delete input.dataset.cycleCurrent;
        overlay.remove();
    };
}
