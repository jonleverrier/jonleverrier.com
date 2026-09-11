/**
 * JONSON VOICE — dictate a question instead of typing it.
 *
 * Adds a microphone button inside each ask field (the front door's and the
 * conversation's) and writes what you say into the input as you say it.
 *
 * BUILT IN JS, NOT IN THE MARKUP, and deliberately: unlike Read more or the
 * "+N more" toggle, there is no no-JS equivalent of a microphone — a button in
 * the served HTML would be a dead control for anyone whose browser can't do
 * this. So the field ships exactly as it is and the button appears only where it
 * will work. Firefox has never shipped speech recognition, so Firefox simply
 * never sees it.
 *
 * WHAT IT USES, and what that means for privacy: the browser's own
 * SpeechRecognition. Neither engine does this on the device — Chrome streams the
 * audio to Google, Safari to Apple — so this hands a recording of the visitor's
 * voice to a third party the moment they press it. NOTHING ON THE PAGE SAYS SO —
 * the button is a bare icon by choice — so the AI Policy page is the only place
 * that claim can live. It isn't there yet.
 *
 * The permission prompt is the browser's, raised by recognition.start(); we
 * never touch getUserMedia, so there is no second prompt and no stream to hold
 * open or tear down.
 */

// Every ask field on the site, by the attribute its own script keys off:
//   data-jonson-form      the front door (posts to the endpoint)
//   data-jonson-followup  the conversation's own bar, once a thread is open
//   data-jonson-handoff   the bar on a content page, which carries the question
//                         to the homepage rather than answering in place
const FIELD = '[data-jonson-form], [data-jonson-followup], [data-jonson-handoff]';
// The question field, however this particular bar labels it. Only the front door
// and the content-page bar carry `data-jonson-input`; the conversation's own bar
// identifies its field by name alone, which is why keying on the attribute alone
// silently skipped it. `name="question"` is what every one of them posts, so it
// is the reliable handle; the attribute stays first for the two that have it.
const INPUT = '[data-jonson-input], input[name="question"]';
const CLASS = 'c-voice';

/** Chrome and Safari both prefix it; Firefox has neither. */
const Recognition = typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;

// Two glyphs, both in the button, swapped by CSS on the listening state — a mic
// to start, a pause to stop, so the control says what pressing it will do rather
// than what it is. Rendered once rather than rewritten on each toggle: no
// re-parsing, and nothing to go wrong if a state change is missed.
//
// Larger than the submit's 20px: the mic and the pause are both quieter shapes
// than the spark beside them and read smaller at a matched size. 24 in a 44px
// button still leaves the icon comfortably inside its tap target.
const ICON = `<svg class="c-voice__icon c-voice__icon--mic" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"/>
    <path d="M18.5 11a.75.75 0 0 0-1.5 0 5 5 0 0 1-10 0 .75.75 0 0 0-1.5 0 6.5 6.5 0 0 0 5.75 6.455V20H9.5a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5h-1.75v-2.545A6.5 6.5 0 0 0 18.5 11Z"/>
</svg>
<svg class="c-voice__icon c-voice__icon--stop" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false">
    <rect x="7.6" y="6" width="3.4" height="12" rx="1.3"/>
    <rect x="13" y="6" width="3.4" height="12" rx="1.3"/>
</svg>`;

/**
 * The language to listen in. The document's own, since that's what the visitor
 * is reading — but only when it names a REGION ("en-GB"): Craft's site language
 * here is "en-JE", a valid locale for Craft and not one any speech engine knows,
 * and an unknown tag makes Chrome fall back to the browser's UI language rather
 * than erroring. Jersey speaks English, so en-GB is the honest substitute.
 */
function language(doc) {
    const tag = (doc.documentElement.getAttribute('lang') || '').trim();
    if (/^en-(GB|US|AU|CA|NZ|IE|IN|ZA)$/i.test(tag)) return tag;
    if (/^en\b/i.test(tag) || tag === '') return 'en-GB';
    return tag;
}

function setup(form) {
    const input = form.querySelector(INPUT);
    if (!input || form._voice) return;

    const button = document.createElement('button');
    button.type = 'button'; // inside a form, a bare button submits it
    button.className = CLASS;
    button.innerHTML = ICON;
    button.setAttribute('aria-label', 'Dictate your question');
    // A live region so a screen reader hears the state change, not just sighted
    // users seeing the button turn red.
    button.setAttribute('aria-pressed', 'false');

    // Before the submit, so the reading and tab order run: field, dictate, send.
    const submit = form.querySelector('button[type="submit"]');
    if (submit) form.insertBefore(button, submit);
    else form.appendChild(button);

    const recognition = new Recognition();
    recognition.lang = language(document);
    recognition.interimResults = true; // words land in the field as they're said
    recognition.continuous = false;    // one question, then stop on the pause
    recognition.maxAlternatives = 1;

    let listening = false;
    // What was in the field when dictation started. Interim results replace only
    // what has been dictated, so typing a few words and then dictating the rest
    // appends rather than wipes.
    let base = '';

    const paint = (on) => {
        listening = on;
        button.classList.toggle('is-listening', on);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.setAttribute('aria-label', on ? 'Stop dictating' : 'Dictate your question');
    };

    const start = () => {
        base = input.value.trim();
        try {
            recognition.start();
        } catch (e) {
            // start() throws if it's already running — the state is already what
            // we want, so there is nothing to do but keep the button honest.
            paint(true);
        }
    };

    const stop = () => {
        try { recognition.stop(); } catch (e) { /* already stopped */ }
    };

    button.addEventListener('click', () => (listening ? stop() : start()));

    recognition.addEventListener('start', () => paint(true));

    // Fires on a pause, on stop(), and on an error — the one place the button is
    // returned to rest, so it can never be left looking live.
    recognition.addEventListener('end', () => paint(false));

    recognition.addEventListener('error', (e) => {
        paint(false);
        // 'no-speech' and 'aborted' are ordinary: the visitor said nothing, or
        // pressed again. Only a refusal is worth a word, and the browser has
        // already shown its own prompt, so this is only for the console.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            console.warn('[voice] microphone permission was refused');
        }
    });

    recognition.addEventListener('result', (event) => {
        let said = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            said += event.results[i][0].transcript;
        }
        said = said.trim();
        if (!said) return;
        input.value = base ? `${base} ${said}` : said;
        // So anything watching the field (the prompt strip, a character count)
        // sees a change it would have seen from typing.
        input.dispatchEvent(new Event('input', {bubbles: true}));
    });

    // Escape gives up without submitting, the same key that closes everything
    // else on the site.
    const onKey = (e) => {
        if (e.key === 'Escape' && listening) {
            stop();
            input.value = base;
        }
    };
    document.addEventListener('keydown', onKey);

    // Sending the question ends dictation — otherwise the recogniser keeps
    // listening into the answer.
    form.addEventListener('submit', stop);

    form._voice = () => {
        stop();
        document.removeEventListener('keydown', onKey);
        form.removeEventListener('submit', stop);
        button.remove();
        form._voice = null;
    };
}

/** Add the mic to every ask field inside `root`. Idempotent; no-op without support. */
export function mountVoice(root = document) {
    if (!Recognition || !root || !root.querySelectorAll) return () => {};

    const forms = Array.from(root.querySelectorAll(FIELD));
    forms.forEach(setup);

    return function dispose() {
        forms.forEach((form) => { if (form._voice) form._voice(); });
    };
}
