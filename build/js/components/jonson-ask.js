/**
 * JONSON
 *
 * Drives the "ask me anything" experience: the first question transitions the
 * hero into an in-place conversation view, and each question→response pair is
 * appended to a growing centered timeline. Both the hero input and the
 * pinned follow-up input feed the same thread. Responses stream in (SSE).
 *
**/

import {mountGrid} from './jonson-grid.js';
import {setupMarquees} from './clients-marquee.js';
import {methodApply} from './method.js';
// slideTo is shared with the document-level slider mount (components/testimonials.js);
// the touch-swipe handler below still needs it to snap after a drag.
import {slideTo} from './testimonials.js';
import {pauseOffscreenWithin} from './pause-offscreen.js';
import {looksLikeJunk} from './junk-question.js';
import {revealPictures} from './picture.js';

// Strip the invisible markers Claude leaves in its prose: the [[next: …]]
// suggestions block, then the inline [[handle]] markers.
//
// Markers may carry a modifier — [[casestudies:all]] — so the handle pattern has
// to allow one. This mirrors AskController::stripMarkers; the two must stay in
// step, because whichever one lags lets a raw marker through into the prose.
// The trailing pass catches markers the model closed with a single bracket
// ("[[france]") or left open. The strict pattern above misses those, and what the
// reader then sees is a raw marker mid-sentence. It also swallows invented handles,
// which is what we want — an unknown marker should disappear, not render.
function stripMarkers(text) {
    return text
        .replace(/\s*\[\[next:[^\]]*\]{1,2}/gi, '')
        .replace(/\s*\[\[[a-z0-9-]+(?::[a-z0-9-]+)?\]\]/gi, '')
        .replace(/\s*\[\[[a-z0-9-]+(?::[a-z0-9-]+)?\]?/gi, '')
        .trim();
}

// Render the light markdown emphasis Claude naturally emits — **bold** and
// *italic* — as real <strong>/<em>. HTML is escaped first so the only markup
// in the result is the emphasis tags we add ourselves (no injection). Bold is
// matched before italic so `**x**` doesn't get eaten by the single-star rule.
function inlineMarkdown(text) {
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return escaped
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>');
}


// A stable per-visitor conversation id, minted once and persisted, so every request
// keys the SAME server-side caches (history, answer bundle, shown-state, transcript).
// The PHP session id can shift on a brand-new visitor before its cookie round-trips —
// this token can't. localStorage so it also survives across pages (e.g. the contact
// form reads it to attach the chat transcript to the lead).
function conversationId() {
    const KEY = 'jonson.cid';
    try {
        let id = localStorage.getItem(KEY);
        if (!id) {
            id = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(KEY, id);
        }
        return id;
    } catch (e) {
        // localStorage blocked (private mode) — a per-load id still beats a shifting one.
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

// The VISIT id, as distinct from the visitor id above — and the distinction is the
// whole point. `jonson.cid` lives in localStorage, so the same browser sends the same
// one today and next Tuesday; keyed on that, two separate conversations a week apart
// are one row spanning seven days, and "how far did they get" means nothing.
//
// sessionStorage is already the visit boundary everywhere else in this codebase: the
// thread snapshot and the nudge allowance (`jonson-prompt-uses`) both live there and
// both mean "this tab, this visit". This sits beside them and inherits the same
// lifetime for free — it survives navigation within the visit and dies with the tab.
//
// Two tabs get two sids. That is correct rather than a flaw: the thread snapshot is
// per-tab too, so a second tab genuinely IS a second conversation.
//
// Analytics only. Nothing about the answer depends on it, so a browser that refuses
// storage gets a per-load id and its turns simply don't group — no reason to fail.
function visitId() {
    const KEY = 'jonson.sid';
    try {
        let id = sessionStorage.getItem(KEY);
        if (!id) {
            id = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            sessionStorage.setItem(KEY, id);
        }
        return id;
    } catch (e) {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

// How many "lost for words" prompts have been spent this visit — written by
// lost-for-words.js, read here so the server can record whether that drawer is doing
// a job. Read, never written: this is a reporting tap on someone else's counter.
function promptUses() {
    try {
        return Math.max(0, parseInt(sessionStorage.getItem('jonson-prompt-uses'), 10) || 0);
    } catch (e) {
        return 0;
    }
}

// Build the finished answer — prose with the context rail slotted in after the
// first paragraph — wait for its images (capped), then fade the whole thing in
// at once. Nothing renders until the response is complete, so there's no
// pop-in, no reflow, and images arrive already loaded.
function revealAnswer(el, text, railHtml, testimonialHtml, clientsHtml, sectorsHtml, caseStudiesHtml, methodHtml, musicHtml, contactHtml, suggestions, errorText, startedAt) {
    const frag = document.createDocumentFragment();
    const nodeFrom = (html) => {
        if (!html) return null;
        const tpl = document.createElement('template');
        tpl.innerHTML = html.trim();
        return tpl.content.firstElementChild;
    };

    if (errorText) {
        const p = document.createElement('p');
        p.textContent = errorText;
        frag.append(p);
    } else {
        // Split the raw prose (markers intact) so we know which paragraph each
        // marker sits in; strip markers per paragraph for display.
        const rawParts = text.split(/\n{2,}/);
        let rail = nodeFrom(railHtml);
        let quote = nodeFrom(testimonialHtml);
        let clients = nodeFrom(clientsHtml);
        let sectors = nodeFrom(sectorsHtml);
        let caseStudies = nodeFrom(caseStudiesHtml);
        let method = nodeFrom(methodHtml);
        let music = nodeFrom(musicHtml);
        let contact = nodeFrom(contactHtml);
        let quotePlaced = false;
        let clientsPlaced = false;
        let sectorsPlaced = false;
        let caseStudiesPlaced = false;
        let methodPlaced = false;
        let musicPlaced = false;
        let contactPlaced = false;
        // Every surface sits beneath the paragraph that frames it — the one carrying
        // its marker. The server only sends a surface whose marker sat in a paragraph
        // with prose (see the resolver in AskController), so a panel always finds
        // its paragraph here; the end-of-answer appends below are a safety net, not
        // a path. The rail's frame is the first paragraph carrying a PHOTO marker —
        // any marker that isn't a panel's — and failing that the first paragraph
        // with content. Nothing ever renders above the first line of prose.
        const PANEL_MARKER = /\[\[(testimonial|clients|sectors|casestudies|method|music|contact|next)(?::[^\]]*)?\]\]/i;
        const hasPhotoMarker = (raw) => [...raw.matchAll(/\[\[[a-z0-9][a-z0-9-]*(?::[a-z0-9-]+)?\]\]/gi)]
            .some((m) => !PANEL_MARKER.test(m[0]));
        let railAnchor = rawParts.findIndex((raw) => hasPhotoMarker(raw) && stripMarkers(raw));
        if (railAnchor < 0) railAnchor = rawParts.findIndex((raw) => stripMarkers(raw));
        let contentSeen = false;
        rawParts.forEach((raw, i) => {
            const clean = stripMarkers(raw);
            if (clean) {
                const p = document.createElement('p');
                p.innerHTML = inlineMarkdown(clean);
                frag.append(p);
                if (rail && i === railAnchor) { frag.append(rail); rail = null; }
                contentSeen = true;
            }
            if (!contentSeen) return;
            if (quote && !quotePlaced && /\[\[testimonial\]\]/i.test(raw)) {
                frag.append(quote); // testimonial right after the paragraph that earns it
                quotePlaced = true;
            }
            if (clients && !clientsPlaced && /\[\[clients\]\]/i.test(raw)) {
                frag.append(clients); // logo marquee after the paragraph that names them
                clientsPlaced = true;
            }
            if (sectors && !sectorsPlaced && /\[\[sectors\]\]/i.test(raw)) {
                frag.append(sectors); // sector tags after the paragraph that earns them
                sectorsPlaced = true;
            }
            // Optional :modifier — [[casestudies:all]] places the cards exactly like
            // the plain marker; the modifier only changes WHICH studies the server sent.
            if (caseStudies && !caseStudiesPlaced && /\[\[casestudies(?::[a-z0-9-]+)?\]\]/i.test(raw)) {
                frag.append(caseStudies); // case study cards after the paragraph pointing at the work
                caseStudiesPlaced = true;
            }
            if (method && !methodPlaced && /\[\[method\]\]/i.test(raw)) {
                frag.append(method); // "how I can help" timeline after the paragraph that earns it
                methodPlaced = true;
            }
            if (music && !musicPlaced && /\[\[music\]\]/i.test(raw)) {
                frag.append(music); // top-artists strip after the paragraph about his music
                musicPlaced = true;
            }
            if (contact && !contactPlaced && /\[\[contact\]\]/i.test(raw)) {
                frag.append(contact); // CTA beat after the paragraph that invites contact
                contactPlaced = true;
            }
        });
        if (rail) frag.append(rail);
        if (quote && !quotePlaced) frag.append(quote); // fallback: end of answer
        if (clients && !clientsPlaced) frag.append(clients);
        if (sectors && !sectorsPlaced) frag.append(sectors);
        if (caseStudies && !caseStudiesPlaced) frag.append(caseStudies);
        if (method && !methodPlaced) frag.append(method);
        if (music && !musicPlaced) frag.append(music);
        if (contact && !contactPlaced) frag.append(contact);
    }

    // "Where next?" prompt chips — always last: a whisper title + a row of
    // buttons. Each button's text is the question; clicking it asks that
    // question (wired in mountJonson).
    if (Array.isArray(suggestions) && suggestions.length) {
        const nav = document.createElement('nav');
        nav.className = 'c-jonson__suggestions';
        nav.setAttribute('aria-label', 'Suggested questions');

        const title = document.createElement('p');
        title.className = 'c-jonson__suggestions-whisper';
        title.textContent = 'Try asking me…';

        const list = document.createElement('div');
        list.className = 'c-jonson__suggestions-list';
        suggestions.forEach((q) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'c-jonson__suggestion';
            chip.textContent = q;
            list.append(chip);
        });

        nav.append(title, list);
        frag.append(nav);
    }

    // Swap the thinking indicator for the composed answer, then let the rail's
    // photos develop in over their blur-up placeholders.
    let fired = false;
    const commit = () => {
        if (fired) return;
        fired = true;
        el.classList.add('is-pending'); // hidden pre-reveal
        el.textContent = '';            // remove the thinking indicator
        el.append(frag);
        requestAnimationFrame(() => {
            el.classList.remove('is-pending');
            el.classList.add('is-revealed'); // container zoom + paragraph fade
        });

        // Every image in the answer — rail photos, case study cards, anything else
        // a component renders — shows its blur-up placeholder instantly and
        // develops in once decoded. This subtree has just been injected, so the
        // page-load pass in app.js never saw it. CSS staggers the rail's cards
        // right-to-left via each card's --r.
        revealPictures(el);

        // Multi-testimonial slider: the first slide starts active (scaled up).
        el.querySelectorAll('.c-testimonials.has-multiple').forEach((slider) => {
            const slides = slider.querySelectorAll('.c-testimonial');
            slides.forEach((s, i) => s.classList.toggle('is-active', i === 0));
        });

        // Clients marquee: fill one run to span the strip, duplicate it for a
        // seamless loop, then set a constant scroll speed and start it.
        setupMarquees(el);

        // Method timeline: rest on the first phase (positions track + fill), then
        // snap it onto the device-pixel grid so Safari doesn't jitter/blur its
        // composited layers at a fractional page offset (see pixelSnapMethod).
        el.querySelectorAll('.c-method').forEach((slider) => methodApply(slider, 0));

        // Pause the marquee/shimmer while they're scrolled off-screen.
        pauseOffscreenWithin(el);
    };

    // Hold the thinking indicator for the minimum beat, then reveal — we no
    // longer block on image loads: the placeholders show instantly and the
    // photos develop in afterward.
    const MIN_THINKING = 1100;
    const elapsed = startedAt ? performance.now() - startedAt : MIN_THINKING;
    setTimeout(commit, Math.max(0, MIN_THINKING - elapsed));
}

// Pull the `event:` / `data:` lines out of one raw SSE block.
function parseSse(block) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
    }
    return {event, data};
}

export function mountJonson({warpOut} = {}) {
    const heroForm = document.querySelector('[data-jonson-form]');
    const view = document.querySelector('[data-jonson-view]');
    const thread = document.querySelector('[data-jonson-thread]');
    const followForm = document.querySelector('[data-jonson-followup]');
    if (!view || !thread || (!heroForm && !followForm)) return () => {};

    const endpoint = (heroForm || followForm).dataset.endpoint;
    // No tunnel / reduced motion → warp falls straight through to its callback.
    const warp = warpOut || ((cb) => { if (cb) cb(); });
    let busy = false;

    // First question: warp through the hero tunnel, then reveal the thread view.
    const enter = () => {
        if (entered) return;
        entered = true;
        const root = document.documentElement;
        root.classList.add('is-warping');           // hero lifts + fades away
        root.classList.add('is-jonson');            // pins the header for the response view
        document.dispatchEvent(new CustomEvent('jonson:enter')); // stop hero cyclers

        warp(() => {
            const frontDoor = document.querySelector('[data-frontdoor]');
            if (frontDoor) frontDoor.hidden = true;
            root.classList.remove('is-warping');
            root.classList.add('is-conversing');
            view.hidden = false;                     // thread arrives
        });
    };

    // Add a question + answer (seeded with the thinking indicator); the timeline
    // connectors are drawn with pseudo-elements. Return the answer element.
    const appendTurn = (question) => {
        const turn = document.createElement('div');
        turn.className = 'c-jonson__turn';

        // First question in the thread is the page's h1; later ones are h2.
        const q = document.createElement(thread.children.length === 0 ? 'h1' : 'h2');
        q.className = 'c-jonson__question';
        q.textContent = question;

        const a = document.createElement('div');
        a.className = 'c-jonson__response';
        a.innerHTML = '<span class="c-jonson__thinking" role="status" aria-label="Thinking">'
            + '<span></span></span>';

        turn.append(q, a);
        thread.append(turn);
        return a;
    };

    const stream = async (question, csrfInput, answerEl, continuation, fromChip = null) => {
        const startedAt = performance.now(); // anchor for the minimum thinking beat
        const payload = new URLSearchParams();
        payload.set('question', question);
        // Tell the server whether this is a continuation of the live thread (a
        // genuine repeat → nudge) or a fresh opener (a repeat → replay cached).
        payload.set('continuation', continuation ? '1' : '0');
        payload.set('cid', conversationId()); // stable key for the server-side caches
        // Analytics only — none of these change the answer. See the Analytics service.
        payload.set('sid', visitId());              // THIS visit (see visitId)
        payload.set('pageUrl', location.pathname);  // the page the turn happened on
        payload.set('promptUses', String(promptUses()));
        // Which chip this came from, if it came from a chip at all. Without it a chip
        // click is indistinguishable from a typed question and "do the chips work?"
        // has no answer. Position, not text: the text is already in `question`, and
        // the position is what says whether anything past the first is ever read.
        if (fromChip !== null) payload.set('fromChip', String(fromChip));
        // A question handed over from a note or case study carries that page's id
        // (see ask-handoff.js) so the server can put the page in front of the
        // model. Sent once; the server remembers it for the rest of the thread.
        if (heroForm && heroForm.dataset.jonsonFrom) {
            payload.set('from', heroForm.dataset.jonsonFrom);
            delete heroForm.dataset.jonsonFrom;
        }
        if (csrfInput && csrfInput.name) payload.set(csrfInput.name, csrfInput.value);

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'text/event-stream',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: payload.toString(),
            });

            if (!res.ok || !res.body) {
                answerEl.textContent = 'Sorry — something went wrong. Please try again.';
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            // Buffer the whole response; nothing renders until `done`, then the
            // finished answer + rail fade in composed together.
            let answerText = '';       // accumulated prose (still carries [[handle]] markers)
            let railHtml = '';         // resolved rail markup, if any content was referenced
            let testimonialHtml = '';  // resolved testimonial pull-quote, if surfaced
            let clientsHtml = '';      // resolved clients logo marquee, if surfaced
            let sectorsHtml = '';      // resolved sector-experience tags, if surfaced
            let caseStudiesHtml = '';  // resolved case-study discovery cards, if surfaced
            let methodHtml = '';       // resolved "how I can help" timeline, if surfaced
            let musicHtml = '';        // resolved top-artists strip, if surfaced
            let contactHtml = '';      // resolved ways-to-connect CTA beat, if surfaced
            let suggestions = [];      // "where next?" prompt chips
            let errorText = '';

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const {value, done} = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, {stream: true});

                let i;
                while ((i = buffer.indexOf('\n\n')) !== -1) {
                    const {event, data} = parseSse(buffer.slice(0, i));
                    buffer = buffer.slice(i + 2);
                    if (!data) continue;

                    if (event === 'text') {
                        answerText += JSON.parse(data).text;   // buffer only
                    } else if (event === 'context') {
                        railHtml = JSON.parse(data).html;
                    } else if (event === 'testimonial') {
                        testimonialHtml = JSON.parse(data).html;
                    } else if (event === 'clients') {
                        clientsHtml = JSON.parse(data).html;
                    } else if (event === 'sectors') {
                        sectorsHtml = JSON.parse(data).html;
                    } else if (event === 'casestudies') {
                        caseStudiesHtml = JSON.parse(data).html;
                    } else if (event === 'method') {
                        methodHtml = JSON.parse(data).html;
                    } else if (event === 'music') {
                        musicHtml = JSON.parse(data).html;
                    } else if (event === 'contact') {
                        contactHtml = JSON.parse(data).html;
                    } else if (event === 'suggestions') {
                        suggestions = JSON.parse(data).items || [];
                    } else if (event === 'error') {
                        errorText = JSON.parse(data).message;
                    } else if (event === 'done') {
                        // The model couldn't be reached. Take the follow-up INPUT away:
                        // it can only produce the same answer again, and the point of
                        // this reply is to send them to the work instead. The footer
                        // around it stays, so the "start over" circle is still there —
                        // hiding the whole bar took the one API-free way out with it.
                        if (JSON.parse(data).apiError && followForm) {
                            followForm.hidden = true;
                        }
                        if (errorText || stripMarkers(answerText)) {
                            revealAnswer(answerEl, answerText, railHtml, testimonialHtml, clientsHtml, sectorsHtml, caseStudiesHtml, methodHtml, musicHtml, contactHtml, suggestions, errorText, startedAt);
                        } else {
                            answerEl.textContent = ''; // nothing came back
                        }
                    }
                }
            }
        } catch {
            answerEl.textContent = 'Sorry — something went wrong. Please try again.';
        }
    };

    // Questions asked so far; 0 → the next is the opener. Seeded from the thread
    // rather than starting at zero, because thread-memory.js can restore a
    // conversation from the previous page and each restored turn is a question
    // already asked. Left at zero, the next question would go up as an opener
    // (continuation=0), and the server resets the once-only gates on an opener
    // (AskController::resetShownOnce) — so the rail and the music beat would
    // replay, and a near-repeat would be answered afresh instead of nudged.
    let turnCount = thread.children.length;
    // The reveal has already happened for a restored thread, so a follow-up must
    // not warp through a hero that isn't on screen any more.
    let entered = turnCount > 0;
    // `fromChip` is the 0-based position of the suggestion chip this question came
    // from, or null when it was typed. Analytics only — it changes nothing about the
    // request otherwise.
    const ask = async (question, csrfInput, fromChip = null) => {
        if (busy) return;
        busy = true;
        // Suggestions only belong on the latest answer. Fade the earlier chips
        // out one at a time (title, then each chip) AND collapse the container's
        // height to 0 as they go — so the space closes smoothly instead of the
        // layout snapping when the node is removed.
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        thread.querySelectorAll('.c-jonson__suggestions').forEach((nav) => {
            if (reduceMotion) { nav.remove(); return; }
            const items = [
                nav.querySelector('.c-jonson__suggestions-whisper'),
                ...nav.querySelectorAll('.c-jonson__suggestion'),
            ].filter(Boolean);
            // Lock the current height so it can transition to 0 (auto won't).
            nav.style.height = `${nav.offsetHeight}px`;
            nav.style.overflow = 'hidden';
            items.forEach((el, i) => {
                el.style.transition = `opacity 220ms ease ${i * 55}ms, transform 220ms ease ${i * 55}ms`;
            });
            const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
            requestAnimationFrame(() => {
                items.forEach((el) => {
                    el.style.opacity = '0';
                    el.style.transform = 'translateY(6px)';
                });
                nav.style.transition = `height 360ms ${ease}, margin-top 360ms ${ease}`;
                nav.style.height = '0';
                nav.style.marginTop = '0';
            });
            setTimeout(() => nav.remove(), 360 + items.length * 55 + 60);
        });
        const continuation = turnCount > 0; // already mid-conversation on this page
        turnCount += 1;
        enter();
        const answerEl = appendTurn(question);
        await stream(question, csrfInput, answerEl, continuation, fromChip);
        busy = false;
    };

    // `clearOnSubmit` — whether the field empties as the question goes off.
    //
    // The follow-up bar must: it stays on screen and is immediately ready for the next
    // question, so leaving the old one in it would be wrong.
    //
    // The hero must NOT. The front door doesn't disappear on submit — it plays a 700ms
    // warp first, and clearing the field means watching your own question vanish and
    // the placeholder come back while you're still looking at it. Nothing needs the
    // field emptied: the door fades out with the warp and is disposed after it.
    // `guardJunk` is the FRONT DOOR's behaviour, not the thread's. Typed at the hero,
    // something that isn't a question shouldn't be asked at all: ask() calls enter(),
    // which warps the hero away and reveals the thread BEFORE any answer arrives — so
    // "aaa" costs the point cloud, the headline and the ask bar, and lands the visitor
    // on a conversation headed "aaa". The prompts drawer is a better answer and it
    // keeps the door open.
    //
    // The follow-up field inside the thread does NOT do this. There is no hero left to
    // stay on, the question is already in the thread above, and a submit that visibly
    // does nothing reads as broken — so there the server's canned nudge stands, which
    // reads as Jonson answering.
    //
    // The server gate is untouched either way; this can be bypassed by posting the
    // endpoint directly, so it is a courtesy on top, never the check.
    const wire = (form, clearOnSubmit, guardJunk = false) => {
        if (!form) return;
        const input = form.querySelector('input[type="text"]');
        const csrfInput = form.querySelector('input[type="hidden"]'); // {{ csrfInput() }}
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (busy) return;
            const question = input.value.trim();
            if (!question) return;
            if (guardJunk && looksLikeJunk(question)) {
                // Hand over the prompts drawer instead — and CLEAR the field. This is
                // the one path where the front door stays on screen, so what's left in
                // the box is what the visitor goes on looking at: "a" sitting there
                // reads as a question still pending. Emptying it hands back the
                // placeholder, which is the instruction they need.
                //
                // It also lets the band open: the drawer is hidden by a rule keyed on
                // the field NOT being placeholder-shown (see _jonson.scss), so text
                // left in the box would fight the nudge we just asked for.
                input.value = '';
                document.dispatchEvent(new CustomEvent('jonson:nudge'));
                // Deliberately NOT focused. The field is empty and showing its
                // placeholder, and the answer to "what should I ask?" is the row of
                // suggestions that just appeared — a caret blinking in an empty box
                // points back at the thing they've just been told isn't working.
                return;
            }
            if (clearOnSubmit) input.value = '';
            ask(question, csrfInput);
        });
    };

    wire(heroForm, false, true);  // front door: junk opens the drawer, not a conversation
    wire(followForm, true);       // in-thread: junk gets the server's canned reply

    // Suggested-prompt chips (rendered under each answer): clicking one asks it,
    // reusing the normal flow. Delegated since chips are injected per answer.
    thread.addEventListener('click', (e) => {
        const chip = e.target.closest('.c-jonson__suggestion');
        if (!chip || busy) return;
        const csrf = (followForm || heroForm)?.querySelector('input[type="hidden"]');
        // Its position among its siblings, so the server can tell a chip click from a
        // typed question — and tell the first chip from the third. Read off the DOM
        // rather than closed over at render time, so it stays right no matter how the
        // list was built.
        const position = [...chip.parentElement.children].indexOf(chip);
        ask(chip.textContent.trim(), csrf, position);
    });

    // Testimonial sliders are handled by components/testimonials.js, mounted on
    // `document` in app.js — one delegated handler covers answers, restored threads
    // and static pages alike. Do NOT re-add a thread-scoped copy: both would fire and
    // every press would advance two slides.

    // The method timeline is handled the same way by components/method.js, mounted
    // on `document` in app.js — its arrows, nodes, arrow keys and resize sync cover
    // answers, restored threads and static pages (About) alike. Same rule as the
    // testimonials: no thread-scoped copy, or every press advances two phases.

    // Touch: drag the track with a finger, snap to the next/prev quote on
    // release. A horizontal drag owns the gesture (prevents page scroll); a
    // vertical one is left alone so the page still scrolls normally.
    let swipe = null;
    thread.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { swipe = null; return; }
        const slider = e.target.closest('.c-testimonials.has-multiple');
        const track = slider?.querySelector('.c-testimonials__track');
        const slides = track?.querySelectorAll('.c-testimonial');
        if (!slides || slides.length < 2) return;
        const step = slides[1].offsetLeft - slides[0].offsetLeft;
        if (!step) return;
        const index = Number(track.dataset.index || 0);
        swipe = {
            slider, track, step, index, last: slides.length - 1,
            x: e.touches[0].clientX, y: e.touches[0].clientY,
            base: -index * step, axis: null, dx: 0,
        };
    }, {passive: true});

    thread.addEventListener('touchmove', (e) => {
        if (!swipe) return;
        const dx = e.touches[0].clientX - swipe.x;
        const dy = e.touches[0].clientY - swipe.y;
        if (swipe.axis === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // wait for intent
            swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
            if (swipe.axis === 'x') swipe.track.style.transition = 'none'; // follow the finger
        }
        if (swipe.axis !== 'x') return; // vertical → let the page scroll
        e.preventDefault();
        swipe.dx = dx;
        // Rubber-band past the ends so it feels bounded, not stuck.
        const atEnd = (swipe.index === 0 && dx > 0) || (swipe.index === swipe.last && dx < 0);
        swipe.track.style.transform = `translateX(${swipe.base + (atEnd ? dx * 0.35 : dx)}px)`;
    }, {passive: false});

    const endSwipe = () => {
        if (!swipe) return;
        const s = swipe;
        swipe = null;
        if (s.axis !== 'x') return;
        s.track.style.transition = ''; // restore the CSS slide animation
        const threshold = s.step * 0.2;
        let target = s.index;
        if (s.dx <= -threshold) target = Math.min(s.last, s.index + 1);
        else if (s.dx >= threshold) target = Math.max(0, s.index - 1);
        s.track.dataset.dir = String(s.dx < 0 ? 1 : -1);
        slideTo(s.slider, target); // snaps (or springs back if under threshold)
    };
    thread.addEventListener('touchend', endSwipe);
    thread.addEventListener('touchcancel', endSwipe);

    // The track's translateX is a pixel value based on the slide width, which
    // changes with the viewport. On resize, re-apply each cycled slider's offset
    // (without animating) so the active slide stays aligned across breakpoints.
    const syncSliders = () => {
        thread.querySelectorAll('.c-testimonials.has-multiple .c-testimonials__track').forEach((track) => {
            const slides = track.querySelectorAll('.c-testimonial');
            if (slides.length < 2) return;
            const step = slides[1].offsetLeft - slides[0].offsetLeft;
            const index = Math.min(Number(track.dataset.index || 0), slides.length - 1);
            track.style.transition = 'none';
            track.style.transform = `translateX(-${index * step}px)`;
            void track.offsetWidth;      // flush so the jump isn't animated
            track.style.transition = ''; // restore the CSS slide animation
        });

        // Method timelines re-sync themselves on resize — see components/method.js.
    };
    let resizeRaf = null;
    const onResize = () => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => { resizeRaf = null; syncSliders(); });
    };
    window.addEventListener('resize', onResize);

    // Interactive dot grid behind the conversation view (the .c-jonson element).
    const disposeGrid = mountGrid(view);

    return function dispose() {
        // Thread/form listeners live on long-lived nodes; only the window resize
        // listener needs detaching.
        window.removeEventListener('resize', onResize);
        disposeGrid();
    };
}
