/**
 * CONTACT FORM — AJAX submit (progressive enhancement) with an origami paper-plane
 * send animation.
 *
 * The <form> works entirely on its own (full POST + redirect). This ENHANCES it:
 * intercept submit, POST via fetch, render the outcome in place — no reload. The
 * server (CrmController) returns JSON to AJAX and a redirect to everyone else, so
 * every protection (CSRF, honeypot, time-trap, rate-limit, validation) runs
 * identically on both paths. Any fetch/parse failure falls back to a native submit.
 *
 * On a successful send, the thank-you takes the form's place. Error markup mirrors
 * form.twig.
 */

// Matches form.twig's errorIcon() macro exactly.
const ERROR_ICON =
    '<svg class="c-form__input-icon" xmlns="http://www.w3.org/2000/svg" fill="none"'
    + ' viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">'
    + '<path stroke-linecap="round" stroke-linejoin="round"'
    + ' d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>';

// Minimum time the spinner stays up, so it's actually seen even when the request
// is near-instant (localhost). The fetch runs immediately underneath; this only
// holds the OUTCOME (thank-you / errors) until the beat has passed.
const MIN_SEND = 1200;

function clearErrors(form) {
    form.querySelectorAll('.c-form__field--error')
        .forEach((f) => f.classList.remove('c-form__field--error'));
    form.querySelectorAll('.c-form__error').forEach((el) => el.remove());
    form.querySelectorAll('.c-form__input-icon').forEach((el) => el.remove());
    const banner = form.querySelector('.c-form__flash');
    if (banner) banner.remove();
}

function fieldFor(form, name) {
    const input = form.querySelector(`[name="${name}"]`);
    return input ? input.closest('.c-form__field') : null;
}

// Paint per-field errors — the same markup form.twig produces on a server render.
function renderFieldErrors(form, fieldErrors) {
    let firstInput = null;
    Object.keys(fieldErrors).forEach((name) => {
        const field = fieldFor(form, name);
        if (!field) return;
        field.classList.add('c-form__field--error');

        const label = field.querySelector('.c-form__label');
        if (label && !label.querySelector('.c-form__error')) {
            const span = document.createElement('span');
            span.className = 'c-form__error';
            span.setAttribute('role', 'alert');
            span.textContent = fieldErrors[name];
            label.appendChild(span);
        }

        const control = field.querySelector('.c-form__control');
        if (control && !control.querySelector('.c-form__input-icon')) {
            control.insertAdjacentHTML('beforeend', ERROR_ICON);
        }

        if (!firstInput) firstInput = field.querySelector('.c-form__input');
    });
    if (firstInput) firstInput.focus();
}

// Top-of-form banner (time-trap / rate-limit / server error), matching form.twig.
function renderBanner(form, message) {
    const p = document.createElement('p');
    p.className = 'c-form__flash c-form__flash--error';
    p.setAttribute('role', 'alert');
    p.textContent = message;
    const anchor = form.querySelector('.c-form__row') || form.querySelector('.c-form__field');
    if (anchor) form.insertBefore(p, anchor);
    else form.appendChild(p);
}

// Replace the form with the thank-you block (mirrors form.twig's --done state).
// The copy comes from the form's data attributes — the contact single's Message
// Sent fields, rendered by form.twig — so the CMS owns it in both paths.
function showThanks(form) {
    const done = document.createElement('div');
    done.className = 'c-form c-form--done is-entering';
    done.setAttribute('role', 'status');
    const title = document.createElement('p');
    title.className = 'c-form__thanks';
    title.textContent = form.getAttribute('data-sent-title') || 'Message sent';
    const sub = document.createElement('p');
    sub.className = 'c-form__thanks-sub';
    sub.textContent = form.getAttribute('data-sent-text') || 'I’ll be in touch soon within the next day or so';
    done.append(title, sub);
    const inPanel = !!form.closest('dialog'); // the contact side panel's copy of the form
    form.replaceWith(done);
    // Jump straight to the top, like a fresh (redirected) load — no animation. Not
    // from inside the panel: the page behind it is locked and the thanks is right
    // there in the panel already.
    if (!inPanel) window.scrollTo(0, 0);
    // Celebratory beat: let the background dot grid pulse (see app.js / jonson-grid).
    // The block itself rides along, so a listener can tell which form it was.
    document.dispatchEvent(new CustomEvent('contact:success', {detail: {el: done}}));
    requestAnimationFrame(() => requestAnimationFrame(() => done.classList.remove('is-entering')));
}

// Replace the form with a "not sent" notice (rate limit / too-fast). Same format as
// the thank-you but no celebratory pulse; mirrors form.twig's crmBlocked state.
function showBlocked(form) {
    const done = document.createElement('div');
    done.className = 'c-form c-form--done is-entering';
    done.setAttribute('role', 'status');
    done.innerHTML =
        '<p class="c-form__thanks">Message not sent</p>'
        + '<p class="c-form__thanks-sub">Please use another way of contacting me</p>';
    form.replaceWith(done);
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => done.classList.remove('is-entering')));
}

// POST the form as JSON; resolve {res, data} (data null if the body isn't JSON).
function postForm(form) {
    const body = new FormData(form);
    // Attach the Jonson conversation id (set by the chat) so the lead can carry the
    // visitor's transcript. Absent if they never chatted — the server falls back.
    try {
        const cid = localStorage.getItem('jonson.cid');
        if (cid) body.append('cid', cid);
    } catch (e) { /* localStorage blocked — no transcript link, that's fine */ }

    return fetch(form.action || window.location.href, {
        method: 'POST',
        headers: {Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
        body,
    }).then((res) => res.json().then((data) => ({res, data}), () => ({res, data: null})));
}

// Pull a fresh CSRF token from Craft and write it into the form — so a stale token
// (page left open, session rotated) doesn't hard-fail the submit.
function refreshCsrf(form) {
    return fetch('/index.php?p=actions/users/session-info', {
        headers: {Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
    })
        .then((r) => r.json())
        .then((info) => {
            if (info && info.csrfTokenName && info.csrfTokenValue) {
                const input = form.querySelector(`input[name="${info.csrfTokenName}"]`);
                if (input) input.value = info.csrfTokenValue;
            }
        })
        .catch(() => {});
}

export function mountContactForm(form) {
    if (!form) return () => {};
    const btn = form.querySelector('[type="submit"]');
    let busy = false;

    const onSubmit = (e) => {
        // Native constraint validation first — the browser handles empty required
        // fields with its own messages, no fetch.
        if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
            form.reportValidity();
            return;
        }
        e.preventDefault();
        if (busy) return;
        busy = true;
        clearErrors(form);
        // Sending: lock the button's width so it can animate, then collapse it to
        // a circle around the spinner (width → its own height); fade the label out
        // and disable it.
        if (btn) {
            const w = btn.offsetWidth;
            const h = btn.offsetHeight;
            btn._naturalWidth = w;
            btn.style.width = `${w}px`; // lock the start
            void btn.offsetWidth;        // reflow so the transition has somewhere to go
            btn.disabled = true;
            form.classList.add('is-sending');
            btn.style.width = `${h}px`;  // collapse to a circle
        } else {
            form.classList.add('is-sending');
        }
        const startedAt = (window.performance && performance.now()) || Date.now();

        const finish = (data) => {
            // Keep the spinner up for at least MIN_SEND so it's felt.
            const now = (window.performance && performance.now()) || Date.now();
            window.setTimeout(() => {
                if (data && data.success) {
                    showThanks(form);
                    return;
                }
                // Rate-limit / too-fast → replace the form with the "not sent" notice.
                if (data && data.blocked) {
                    showBlocked(form);
                    return;
                }
                busy = false;
                form.classList.remove('is-sending');
                if (btn) {
                    btn.disabled = false;
                    // Expand the circle back out to the button, then release the width.
                    btn.style.width = btn._naturalWidth ? `${btn._naturalWidth}px` : '';
                    window.setTimeout(() => { btn.style.width = ''; }, 400);
                }
                const fieldErrors = (data && data.fieldErrors) || {};
                if (Object.keys(fieldErrors).length) {
                    renderFieldErrors(form, fieldErrors);
                } else {
                    renderBanner(form, (data && (data.error || data.message))
                        || 'Sorry — something went wrong. Please try again.');
                }
            }, Math.max(0, MIN_SEND - (now - startedAt)));
        };

        postForm(form)
            .then(({res, data}) => {
                // Stale CSRF → Craft answers 400 "Unable to verify your data
                // submission." Refresh the token and retry once.
                const csrfFail = res.status === 400
                    && data && /verify your data/i.test(data.message || '');
                if (csrfFail) {
                    return refreshCsrf(form)
                        .then(() => postForm(form))
                        .then(({data: retryData}) => finish(retryData));
                }
                return finish(data);
            })
            .catch(() => {
                // Network failure — submit for real via the normal (redirect) path.
                form.removeEventListener('submit', onSubmit);
                if (typeof form.requestSubmit === 'function') form.requestSubmit();
                else form.submit();
            });
    };

    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
}
