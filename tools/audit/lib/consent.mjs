/**
 * CONSENT
 *
 * ONE ATTEMPT PER BANNER, AND ONE ONLY.
 *
 * That used to read "one attempt at the cookie banner, and one only", counted per PAGE,
 * and it was the right rule for the wrong reason. The point was never the number of tries:
 * it was that a banner is clicked once, on evidence, and a click that does anything other
 * than dismiss it is never tried again. A banner that was not on the page when we asked has
 * had no attempt at all, and refusing it one is not caution, it is an unasked question.
 *
 * MEASURED ON boondmanager.com, which is the page this rule cost. Its Axeptio card is
 * loaded by a tag manager and OPENS ABOUT EIGHT SECONDS IN, three viewports down the
 * scroll pass — long after `dismissConsent` has run and gone. It then held its place for
 * the rest of the capture and painted twelve times down the image, 1.6% of the page, while
 * `consentBannerSeen` reported `false`. So:
 *
 *   - `dismissConsent` runs at load, exactly as before.
 *   - `dismissLateConsent` runs ONCE MORE, after the scroll pass, and ONLY when the first
 *     attempt found no banner at all AND there is one now. A banner the first attempt SAW
 *     is not offered a second click — it was already refused once and the only thing a
 *     retry buys is the cost of it.
 *   - THE SECOND ATTEMPT IS STRICTER ABOUT WHAT IT WILL CLICK, because the page underneath
 *     it has changed. By then the pinned census has marked hundreds of elements as holding
 *     the viewport — 647 of them on boondmanager.com — and `IS_BANNER_SHAPED` accepts any
 *     of those, so the wording pass would be loose exactly where the page is least
 *     familiar. Its candidates must sit inside something that is banner-shaped AND SAYS
 *     WHAT IT IS ABOUT: the same consent wording `FIND_BANNER` already demands. The vendor
 *     selectors are left ungated, because a CMP's own accept button is not ambiguous.
 *
 * AND EVERY QUESTION PUT TO A FRAME IS NOW BOUNDED. `page.evaluate` has no timeout of its
 * own, and bakerandpartners.com carries a frame whose URL is the empty string that never
 * answers one: the search for a banner stopped there and spent the WHOLE three-minute
 * capture budget, and the capture died with no artefacts. See FRAME_ANSWER_MS.
 *
 * A banner we fail to dismiss is NOT a failure of the capture. It is a real part of that
 * page's surface area, it will classify as promotion, and that is the correct answer — a
 * site that spends 18% of its first viewport on a consent wall should see that number.
 * So this never throws and never blocks; it records what happened and the report says so.
 *
 *   node --test tools/audit/test/consent.test.mjs
 *
 * Two passes, in order. The known CMP vendors by selector, because that is exact and
 * cheap; then button TEXT in many languages, because the vendor list is a losing race
 * and a bespoke banner matches nothing. pola.co.jp is why the second pass exists: its
 * banner offers 「Cookie設定」 and 「了解」 and matched not one selector here.
 *
 * WHY ACCEPT RATHER THAN REJECT. Reject is the more privacy-preserving click, and in a
 * browser carrying someone's identity it would be the right one. This is a throwaway
 * headless context with no profile, no history and no user data, thrown away seconds
 * later — so nothing of anyone's is being consented to. What is being optimised instead
 * is measurement fidelity: rejecting frequently leaves embeds, maps and video as empty
 * placeholder boxes, which is NOT the page a visitor sees, and this tool exists to
 * measure the page a visitor sees. Flip DISMISS_STRATEGY to 'reject' if that trade ever
 * stops being worth it.
 *
 * TWO RULES THE TEXT PASS EARNED THE HARD WAY, both from the same defect:
 *
 *   - IT ONLY LOOKS INSIDE SOMETHING BANNER-SHAPED. It used to consider every control in
 *     the document, so on a page with no banner at all an ordinary `<a>OK</a>` in the
 *     footer was a candidate. Clicking it navigated, every artefact was then of the other
 *     page, and the run reported `dismissed via text "OK"` and exited 0. A stranger
 *     submitting a URL could steer the audit anywhere they liked. "Banner-shaped" is an
 *     ancestor taken out of the flow so it can sit over the page (see OVERLAY_POSITIONS),
 *     or a dialog role. A consent bar laid out in normal document flow is therefore never
 *     clicked; it stays on the page and counts as surface area, which is the right answer
 *     anyway.
 *   - A NAVIGATION IS A FAILURE, NEVER A SUCCESS. A dismissed banner detaches, and a
 *     detached handle is also exactly what navigating away looks like from here, so the
 *     two were indistinguishable and the wrong one was assumed. Now the URL is compared
 *     across the click: if it moved, this was not a dismissal, the page is put back where
 *     it started, and the capture continues WITHOUT dismissing. One attempt, and a banner
 *     we did not dismiss is measured as part of the page.
 *
 * The limitation worth knowing: the text pass reads the ACCESSIBLE text of a control, so
 * a banner whose accept button is an unlabelled icon, or a canvas, is invisible to it.
 * It also refuses anything matching DENY_TEXT, which costs a few real accept buttons
 * whose label happens to contain a settings word — deliberately, because clicking
 * "Manage preferences" opens a SECOND dialog and leaves the page worse than untouched.
 */

import {printable} from './printable.mjs';

/** The strategy this module clicks for. See the header before changing it. */
export const DISMISS_STRATEGY = 'accept';

/**
 * Known consent platforms, by the selector for their accept control.
 *
 * Joined into ONE query rather than awaited one at a time: at 2s per selector this list
 * would otherwise add a minute to every capture, most of it spent waiting for banners
 * that were never there.
 */
export const CONSENT_SELECTORS = [
    // OneTrust
    '#onetrust-accept-btn-handler',
    '#accept-recommended-btn-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    // Usercentrics
    'button[data-testid="uc-accept-all-button"]',
    '#uc-btn-accept-banner',
    // Insites Cookie Consent
    '.cc-allow',
    '.cc-btn.cc-allow',
    // Quantcast / InMobi
    '.qc-cmp2-summary-buttons button[mode="primary"]',
    // TrustArc
    '#truste-consent-button',
    // Didomi
    '#didomi-notice-agree-button',
    // Klaro
    '.cm-btn-success',
    // Osano
    '.osano-cm-accept-all',
    // Complianz
    '.cmplz-accept',
    // Borlabs
    '._brlbs-btn-accept-all',
    // Iubenda
    '.iubenda-cs-accept-btn',
    // Axeptio
    '#axeptio_btn_acceptAll',
    // CookieYes
    '.cky-btn-accept',
    // Cookie Script
    '#cookiescript_accept',
    // Shopify's built-in banner
    '.shopify-pc__banner__btn-accept',
    // Sourcepoint
    '.sp_choice_type_11',
    // Generic ARIA, last because it is the loosest
    '[aria-label="Accept all"]',
    '[aria-label="Accept all cookies"]',
];

/**
 * Accept wording, across the languages a homepage audit is likely to meet.
 *
 * Latin scripts are anchored on word boundaries so "accept" does not fire inside an
 * unrelated word. CJK, Arabic, Hebrew and Thai have no word boundaries to anchor on and
 * are matched as substrings, which is why DENY_TEXT is checked first and wins.
 *
 * `ok` AND `okay` ARE DELIBERATELY ABSENT. They were here, and a two-letter word that
 * appears on dialogs, forms, toasts and plain links across the whole web is not evidence
 * of a consent banner — it was half of the defect that let a bannerless page's footer
 * link be clicked and reported as a dismissal. A banner whose only accept control says
 * exactly "OK" is now left alone and measured as part of the page. 了解 stays, because
 * it is a real accept on a real banner (pola.co.jp) and does not appear on page
 * furniture the way "OK" does.
 */
export const ACCEPT_TEXT = new RegExp(
    [
        // English
        '\\b(accept|allow|agree|got it|i understand)\\b',
        // German, Dutch, Scandinavian
        '\\b(akzeptieren|zustimmen|einverstanden|verstanden|alles accepteren|akkoord|godta|godkänn|acceptera|accepter alle|tillad)\\b',
        // Romance
        "\\b(tout accepter|j'accepte|accepter|aceptar|acepto|accetta|accetto|aceitar|concordo)\\b",
        // Slavic, Greek, Turkish
        '\\b(akceptuj|zgadzam|prihvati|souhlasím|rozumím|kabul|tamam)\\b',
        'принять|согласен|принимаю|хорошо',
        'αποδοχή|συμφωνώ',
        // CJK — 了解 and 同意 are the common ones; 許可/허용/允许 cover "allow"
        '同意|了解|承諾|許可|接受|允许|确定|동의|허용|확인',
        // Arabic, Hebrew, Thai, Vietnamese, Hindi
        'قبول|موافق|أوافق',
        'אישור|מסכים|קבל',
        'ยอมรับ|ตกลง',
        'chấp nhận|đồng ý',
        'स्वीकार',
    ].join('|'),
    'i',
);

/**
 * Wording that means "this opens more choices" or "this refuses".
 *
 * Checked BEFORE accept and wins outright. 「Cookie設定」 contains no accept word, but
 * "Accept settings" and "Manage and accept" do — and clicking either opens a second
 * dialog, which leaves the page in a worse state than never having touched it.
 */
export const DENY_TEXT = new RegExp(
    [
        '\\b(settings|preferences|manage|customi[sz]e|options|choices|configure|more info|learn more|details)\\b',
        '\\b(reject|decline|deny|refuse|necessary only|essential only|disagree|opt.?out)\\b',
        '\\b(einstellungen|verwalten|ablehnen|instellingen|beheren|weigeren|afvis|neka)\\b',
        '\\b(param[èe]tres|g[ée]rer|refuser|configuraci[óo]n|gestionar|rechazar|impostazioni|gestisci|rifiuta|definições|rejeitar)\\b',
        '\\b(ustawienia|zarządzaj|odrzuć|nastavení|ayarlar|reddet|yönet)\\b',
        'настройки|отклонить|управлять',
        'ρυθμίσεις|απόρριψη',
        '設定|设置|拒否|拒绝|管理|詳細|자세히|설정|거부',
        'إعدادات|رفض',
        'הגדרות|דחה',
        'ตั้งค่า|ปฏิเสธ',
        'cài đặt|từ chối',
    ].join('|'),
    'i',
);

/**
 * Controls a banner might use. Not every accept button is a <button>.
 *
 * A BARE `a` IS NOT ONE OF THEM. It was, and an ordinary link is the one control on a
 * page that can take the capture somewhere else. A link built as a button says so with
 * `role="button"`, which the second selector already catches; a link that does not say so
 * is page furniture. `[role="button"]` is not scoped to `a` on purpose — a div or span
 * carrying the role is a perfectly ordinary way to build a banner button.
 */
export const CLICKABLE = 'button, [role="button"], input[type="button"], input[type="submit"]';

/**
 * The `position` values that take an element out of the flow so it can sit over the page.
 *
 * ONE LIST BECAUSE THERE WERE THREE, and they drifted. IS_BANNER_SHAPED, IS_CONSENT_BANNER
 * and FIND_BANNER each enumerated `fixed` and `sticky` separately, each describing the
 * principle as "taken out of the flow so it can sit over the page" — which `absolute` also
 * satisfies, and which all three then failed to say. visionarygrid.studio is the page that
 * found it: a Finsweet consent bar whose wrapper is `position: absolute`, sized to exactly
 * one viewport at the top of a 24,746px page. Its Accept control is an `<a role="button">`
 * and matched CLICKABLE perfectly; every one of the three gates then rejected it on the
 * position of its container, so the capture recorded `consentBannerSeen: false` about a
 * banner sitting in plain sight in its own screenshot.
 *
 * WIDENING THIS IS SAFE BECAUSE NOTHING HERE DECIDES ANYTHING ALONE. Every caller also
 * requires consent WORDING in the same ancestor, or an accept LABEL on the control itself.
 * `absolute` is common; an absolutely-positioned box that also says it is about cookies,
 * or that contains a visible control labelled "Accept", is not.
 */
export const OVERLAY_POSITIONS = ['fixed', 'sticky', 'absolute'];

/**
 * Is this control inside something shaped like a banner? Runs IN the page.
 *
 * The ways a consent banner is actually built: taken out of the flow so it can sit over
 * the page (see OVERLAY_POSITIONS), announced as a dialog — or simply HELD in the viewport by
 * script while computing `position: relative`, which is what boondmanager.com's consent
 * card does and which no reading of the stylesheet can see. `__auditPinned` is the mark
 * lib/pinned.mjs leaves on an element it MEASURED holding its viewport box while the page
 * scrolled under it; see markEarlyPinned, which is run before this module so that the
 * answer exists while the banner is still up.
 *
 * THE PINNED TEST WIDENS THIS SET, IT DOES NOT REPLACE THE CSS ONE. A banner that locks
 * scrolling — the full-screen wall — cannot be measured as pinned, because nothing
 * scrolls under it; dropping the CSS test would lose exactly the banners that are hardest
 * to get past. Nothing here looks at wording — that is isAcceptLabel's job — and nothing
 * here looks at size or position, because banners are top bars, bottom bars, corner cards
 * and full-screen walls.
 *
 * The walk goes up from the control itself, because the accept button is usually several
 * static divs deep inside the positioned element that is the banner.
 *
 * AND IT CROSSES SHADOW BOUNDARIES, because `parentElement` is null at the top of a shadow
 * tree and the walk simply stopped there. boondmanager.com's accept button sits four
 * elements inside an open shadow root; the `position: fixed` overlay that makes it a banner
 * is in the same shadow tree, and the walk never reached it. See lib/shadow.mjs.
 */
export const IS_BANNER_SHAPED = (el, positions) => {
    const deep = window.__auditDeep;
    const above = deep ? deep.parent : (node) => node.parentElement;
    for (let a = el; a; a = above(a)) {
        if (a.__auditPinned === true) return true;
        const role = a.getAttribute ? a.getAttribute('role') : null;
        if (role === 'dialog' || role === 'alertdialog') return true;
        if (a.getAttribute && a.getAttribute('aria-modal') === 'true') return true;
        if (positions.includes(getComputedStyle(a).position)) return true;
    }

    return false;
};

/**
 * Is this control inside something that is banner-shaped AND says it is about consent?
 * Runs IN the page.
 *
 * THE GATE FOR THE SECOND ATTEMPT, and the reason it is stricter than IS_BANNER_SHAPED is
 * the state of the page it runs on. By the time the scroll pass has finished, the pinned
 * census has marked every element it measured holding the viewport — 647 of them on
 * boondmanager.com — and `__auditPinned` alone would make most of a page's chrome
 * banner-shaped. Requiring the SAME ancestor to be positioned and to say what it is about
 * is what `FIND_BANNER` already asks of a banner, and a sticky header or a chat bubble
 * never says it.
 *
 * Deliberately about the SUBJECT, not the buttons: a banner always states its subject,
 * whatever its accept control happens to be labelled. The wording of the button is
 * isAcceptLabel's job and has already been applied by the time this runs.
 */
export const IS_CONSENT_BANNER = (el, {subjectSource, positions}) => {
    const subject = new RegExp(subjectSource, 'i');
    const deep = window.__auditDeep;
    const above = deep ? deep.parent : (node) => node.parentElement;
    for (let a = el; a; a = above(a)) {
        const role = a.getAttribute ? a.getAttribute('role') : null;
        const shaped = a.__auditPinned === true
            || role === 'dialog' || role === 'alertdialog'
            || (a.getAttribute && a.getAttribute('aria-modal') === 'true')
            || positions.includes(getComputedStyle(a).position);
        if (shaped && subject.test((a.textContent || '').slice(0, 400))) return true;
    }

    return false;
};

/**
 * Label and visibility for a list of controls, in ONE round trip. Runs IN the page.
 *
 * Handles are passed through rather than queried again here so that the descriptions line
 * up with the handles the caller will click, whatever the banner is doing to the DOM in
 * the meantime.
 */
const DESCRIBE_CONTROLS = (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    return {
        // `value` for <input>, accessible text for everything else. Capped well above the
        // 60 characters isAcceptLabel will entertain, so a [role="button"] wrapping a
        // whole card does not drag its contents across the wire to be refused anyway.
        label: (el.value || el.innerText || el.textContent || '').trim().slice(0, 200),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    };
});

/** Does this label read as an accept, once anything that opens more choices is excluded? */
export function isAcceptLabel(text) {
    if (typeof text !== 'string') {
        return false;
    }
    const t = text.trim();
    if (t === '' || t.length > 60) {
        return false; // a paragraph is the banner's prose, not its button
    }
    if (DENY_TEXT.test(t)) {
        return false;
    }

    return ACCEPT_TEXT.test(t);
}

/**
 * How long to let a navigation commit before believing a dismissal.
 *
 * Paid only on the path that is about to report success, never on the common one where
 * nothing matched. It is a backstop for navigations that make no network request — a
 * file:// link, a history entry — because the request listener below cannot see those.
 */
export const NAV_SETTLE_MS = 400;

/** How long to let a navigation we have SEEN REQUESTED actually land, before undoing it. */
export const NAV_COMMIT_MS = 5000;

/**
 * Click, and confirm the thing actually went away.
 *
 * A REAL CLICK FIRST, because it is a trusted event and some banners only listen for
 * those. But a real click can be refused forever: Playwright waits for the element to be
 * "stable", and a banner that animates continuously never is, so the click times out —
 * even with `force: true`, which still needs a scroll and a hit test. pola.co.jp does
 * exactly this and cannot be dismissed any other way.
 *
 * So fall back to the element's own click() method, which fires the handler directly
 * with no actionability checks at all.
 *
 * THEN VERIFY, because el.click() on something with no handler succeeds silently and
 * would otherwise let this report a dismissal that never happened. A dismissed banner
 * either detaches (isVisible throws — that is success) or hides.
 *
 * AND A DETACHED HANDLE IS ALSO WHAT NAVIGATION LOOKS LIKE, which is why the URL is
 * compared before and after. Returns one of:
 *
 *   'dismissed'   the control went away and we are still on the same page
 *   'still-there' clicked, nothing happened — try the next candidate
 *   'no-click'    could not be clicked at all
 *   'navigated'   the click took the page somewhere else; the caller must undo it
 */
async function clickAndConfirm(page, handle, timeoutMs) {
    const before = page.url();

    // A NAVIGATION THAT HAS ONLY BEEN REQUESTED IS ALREADY A NAVIGATION, and `page.url()`
    // does not know about it: the URL changes at COMMIT, which waits on the server.
    // Measured against a local endpoint that sleeps 1.5s before responding, with the
    // banner removing itself and navigating 50ms later: the banner was gone, the URL was
    // still the old one, and this returned "dismissed" — after which the capture ran on
    // the other page. The request is visible the instant it is made, whatever the server
    // then does, so listen for it. Two signals covering each other's blind spot: this one
    // misses navigations that make no request, the URL comparison misses slow ones.
    let navigationRequested = false;
    const onRequest = (request) => {
        if (navigationRequested || !request.isNavigationRequest()) return;
        try {
            if (request.frame() === page.mainFrame()) navigationRequested = true;
        } catch {
            // A service worker's request has no frame. It is not a page navigation.
        }
    };
    page.on('request', onRequest);

    try {
        let clicked = false;
        try {
            await handle.click({timeout: timeoutMs});
            clicked = true;
        } catch {
            try {
                await handle.evaluate((el) => el.click());
                clicked = true;
            } catch {
                return 'no-click';
            }
        }
        if (!clicked) {
            return 'no-click';
        }

        let gone = false;
        try {
            await handle.waitForElementState('hidden', {timeout: 2000});
            gone = true;
        } catch {
            // Detached is the commonest way a banner leaves, and asking a detached handle
            // anything throws. Treat a handle we can no longer query as gone — then find
            // out WHY it went.
            try {
                gone = !(await handle.isVisible());
            } catch {
                gone = true;
            }
        }
        if (!gone && !navigationRequested) {
            return 'still-there';
        }

        // Only on the path that is about to claim a dismissal, never on the common one.
        await page.waitForTimeout(NAV_SETTLE_MS);

        if (navigationRequested || page.url() !== before) {
            return 'navigated';
        }

        return gone ? 'dismissed' : 'still-there';
    } finally {
        page.off('request', onRequest);
    }
}

/** Try the vendor selectors in one combined query. Returns an outcome from clickAndConfirm. */
async function clickKnownVendor(page, frame, timeoutMs) {
    const combined = CONSENT_SELECTORS.join(', ');
    try {
        const el = frame.locator(combined).first();
        await el.waitFor({state: 'visible', timeout: timeoutMs});
        const handle = await el.elementHandle({timeout: timeoutMs});

        return handle ? await clickAndConfirm(page, handle, timeoutMs) : 'no-click';
    } catch {
        return 'no-click';
    }
}

/**
 * Is this whole frame a banner? Only asked of child frames.
 *
 * A CMP rendered in an iframe puts its buttons in a document of its own, where the
 * ancestors are ordinary static divs — the positioning that makes it a banner is on the
 * <iframe> element in the parent document. So ask there instead.
 */
async function frameIsBanner(page, frame) {
    if (frame === page) {
        return false;
    }

    return ask(async () => {
        const owner = await frame.frameElement();

        return owner ? await owner.evaluate(IS_BANNER_SHAPED, OVERLAY_POSITIONS) : false;
    }, false);
}

/**
 * How long ONE question to ONE frame may take before it is given up on.
 *
 * NOT A GUESS, AND NOT A TIDINESS MEASURE. `page.evaluate` has no timeout of its own, and a
 * frame that never answers hangs the caller for ever. bakerandpartners.com carries a frame
 * whose URL is the EMPTY STRING; `frame.evaluate` on it returns never, measured at 60s and
 * given up on rather than waited out. That one frame spent the WHOLE three-minute capture
 * budget inside this module — "dismissing a consent banner did not finish within 175945ms" —
 * and the capture died with no artefacts at all.
 *
 * Two seconds is the same order as the vendor pass already spends per frame, and three
 * orders of magnitude above anything measured: `FIND_BANNER` answers in 1–11ms on every
 * real frame in the corpus and the control query in 4–26ms. A frame given up on is SKIPPED,
 * which is exactly what the catch around each of these already did for a frame that threw.
 */
export const FRAME_ANSWER_MS = 2000;

/**
 * `work()`, or `fallback` once the frame has had FRAME_ANSWER_MS to answer. Never throws.
 *
 * The loser of the race gets its own handler: a `frame.evaluate` that is still stuck when
 * the browser closes underneath it rejects LATER, and an unhandled rejection would take the
 * process down long after this had returned the right answer.
 */
async function ask(work, fallback) {
    let timer = null;
    const bell = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), FRAME_ANSWER_MS);
        if (typeof timer.unref === 'function') timer.unref();
    });
    try {
        return await Promise.race([Promise.resolve().then(work).catch(() => fallback), bell]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Try every visible control that is inside a banner and whose label reads as an accept.
 *
 * Returns `{outcome, label}`. The banner test runs only on controls whose wording already
 * qualified, which keeps it to a handful of round trips on a page of hundreds of controls.
 *
 * `gate` is the in-page test a candidate has to pass — IS_BANNER_SHAPED at load, and the
 * stricter IS_CONSENT_BANNER once the page has been scrolled. See the header.
 */
async function clickByLabel(page, frame, wholeFrameIsBanner, gate) {
    // EVERY QUESTION PUT TO THE FRAME IS BOUNDED — see FRAME_ANSWER_MS. A frame that never
    // answers used to hang here as surely as in lookForBanner; the empty fallback is what
    // the catch around each of these already meant, arrived at on a clock as well as on an
    // exception. "frame went away mid-search" and "frame never answered" are the same
    // outcome to this pass: try the next frame.
    const handles = await ask(() => frame.$$(CLICKABLE), []);
    if (handles.length === 0) {
        return {outcome: 'none', label: null};
    }

    const described = await ask(() => frame.evaluate(DESCRIBE_CONTROLS, handles), []);

    for (let i = 0; i < handles.length; i++) {
        const d = described[i];
        if (!d || !d.visible || !isAcceptLabel(d.label)) continue;
        try {
            if (!wholeFrameIsBanner && !(await ask(() => handles[i].evaluate(gate.test, gate.arg), false))) continue;
            const outcome = await clickAndConfirm(page, handles[i], 1000);
            if (outcome === 'dismissed' || outcome === 'navigated') {
                return {outcome, label: d.label};
            }
        } catch {
            // Detached or covered. Try the next one.
        }
    }

    return {outcome: 'none', label: null};
}

/**
 * Undo a navigation our own click caused, so the capture measures the page it was asked
 * for. Back first, because it restores the page as the site served it; an explicit goto
 * only if that did not land where we started.
 */
async function restore(page, url) {
    // The navigation may have been caught at request time and not have landed yet. Undo
    // it before it commits and the site simply arrives on the new page afterwards, with
    // this function having reported success.
    if (page.url() === url) {
        await page.waitForURL((u) => u.toString() !== url, {timeout: NAV_COMMIT_MS}).catch(() => {});
    }
    if (page.url() === url) {
        return true; // it never committed — aborted, or it was never really a navigation
    }

    try {
        await page.goBack({waitUntil: 'load', timeout: 30000});
    } catch {
        // No history entry, or it timed out. The goto below is the fallback.
    }
    if (page.url() !== url) {
        try {
            await page.goto(url, {waitUntil: 'load', timeout: 45000});
        } catch {
            return false;
        }
    }
    await page.waitForLoadState('networkidle', {timeout: 20000}).catch(() => {});

    return page.url() === url;
}

/**
 * Consent wording, for telling a banner apart from any other positioned element.
 *
 * Deliberately about the SUBJECT, not the buttons: a banner always says what it is about,
 * whatever its accept control happens to be labelled, and a sticky header or a chat
 * widget never does. Matching on accept wording instead would fire on every "I agree"
 * checkbox on the page.
 */
export const CONSENT_SUBJECT = new RegExp(
    [
        'cookie', 'consent', 'gdpr', 'privacy', 'tracking',
        'datenschutz', 'zustimmung', // German
        'confidentialit', 'témoins', // French
        'privacidad', 'consentimiento', // Spanish
        'privacy', 'informativa', // Italian
        'クッキー', '同意', 'プライバシー', // Japanese
        '쿠키', '개인정보', // Korean
        'cookies', 'integritet', // Scandinavian
    ].join('|'),
    'i',
);

/** How much text to read from a candidate before deciding. A banner says it early. */
const SUBJECT_SAMPLE = 400;

/**
 * Is there a consent banner on this page at all? Runs IN the page.
 *
 * Banner-shaped AND about consent. Shape alone is far too common — sticky headers, chat
 * bubbles, back-to-top chips are all fixed — and wording alone matches any page with a
 * privacy link in its footer.
 *
 * `__auditPinned` is here for the same reason it is in IS_BANNER_SHAPED: a card held in
 * the viewport by script computes `position: relative`, and `consentBannerSeen` was
 * therefore FALSE on a page with a consent card in plain sight.
 *
 * THE WALK CROSSES SHADOW BOUNDARIES for the other half of the same answer: the card itself
 * is inside an open shadow root on boondmanager.com, so a light-DOM query found only its
 * 1440x0 wrappers, dropped them for being too small, and said `false` again for a different
 * reason. See lib/shadow.mjs.
 */
export const FIND_BANNER = ({subjectSource, positions}) => {
    const subject = new RegExp(subjectSource, 'i');
    const deep = window.__auditDeep;
    const candidates = deep
        ? deep.all(document.body).filter((el) => ['DIV', 'SECTION', 'ASIDE', 'DIALOG', 'FORM'].includes(el.tagName))
        : document.querySelectorAll('div, section, aside, dialog, form');
    for (const el of candidates) {
        const cs = getComputedStyle(el);
        const positioned = positions.includes(cs.position) || el.__auditPinned === true;
        const role = el.getAttribute('role');
        if (!positioned && role !== 'dialog' && role !== 'alertdialog' && el.ariaModal !== 'true') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 30) continue;
        if (subject.test((el.textContent || '').slice(0, 400))) return true;
    }

    return false;
};

/**
 * Dismiss the banner if we can recognise it.
 *
 * Searches the main frame and every child frame, because several platforms render the
 * banner inside an iframe where a page-level query cannot see it.
 *
 * THE FIRST OF TWO ATTEMPTS. See `dismissLateConsent` for the second, which runs after the
 * scroll pass and only for a banner that was not on the page when this one ran.
 *
 * Returns `{dismissed, via, navigatedAway, bannerSeen, arrivedLate}` — `via` being the
 * selector pass, the text that was clicked, or null. That is recorded in meta.json: a
 * capture where the banner was dismissed by a loose text match is one worth looking at twice.
 *
 * `navigatedAway` means a click moved the page and was undone. It is NOT a dismissal and
 * never reports as one; the capture goes on with the banner still there, which is a page
 * we can honestly measure, unlike a different page entirely.
 *
 * `bannerSeen` EXISTS BECAUSE `dismissed: false` MEANT TWO DIFFERENT THINGS. "There was a
 * wall and we could not get past it" and "this page has no cookie banner" were recorded
 * identically, so the report warned that the measurement was "largely a measurement of
 * the wall" on liquidlight.co.uk and vaiie.com, neither of which has a banner at all — on
 * most of the web, in other words. A warning that fires on the ordinary case teaches its
 * reader to skip the one that matters.
 */
export async function dismissConsent(page, timeoutMs = 2000) {
    const requested = page.url();
    const frames = everyFrame(page);

    // ASKED FIRST, while the banner is still up. Afterwards a dismissed banner is gone
    // and the question cannot be answered at all.
    const bannerSeen = await lookForBanner(frames);
    const outcome = await attempt(page, frames, timeoutMs, AT_LOAD);
    if (outcome.navigated) {
        return {dismissed: false, via: null, navigatedAway: true, restored: await restore(page, requested), bannerSeen};
    }

    return {
        dismissed: outcome.dismissed,
        via: outcome.via,
        navigatedAway: false,
        // A control that dismissed IS a banner, whatever the shape-and-wording test made of it.
        bannerSeen: outcome.dismissed ? true : bannerSeen,
        arrivedLate: false,
    };
}

/**
 * One more attempt, for a banner that was not on the page when the first one ran.
 *
 * `first` is what `dismissConsent` returned. This RETURNS THE SAME SHAPE, so the caller
 * keeps one consent record rather than two to reconcile — with `arrivedLate` saying which
 * attempt answered it.
 *
 * IT RUNS ONLY WHEN THE FIRST ATTEMPT FOUND NOTHING AT ALL. A banner the first attempt saw
 * and failed to dismiss has already been refused once; trying the same controls again buys
 * nothing but the time it costs, and that time is charged to the capture's budget on a page
 * that has already proved to be slow. A first attempt that NAVIGATED is likewise not
 * repeated — the one control we know about takes the page somewhere else.
 *
 * WHERE IT BELONGS IN THE CAPTURE: after the scroll pass, before anything is photographed.
 * That is the first moment a late banner is certainly there — boondmanager.com's opens
 * about eight seconds in — and the last moment before the slice pass would start painting
 * it into the image.
 *
 * THE COST WHEN THERE IS NOTHING TO DO is one `FIND_BANNER` per frame, and nothing else.
 */
export async function dismissLateConsent(page, first, timeoutMs = 2000) {
    if (first.dismissed || first.navigatedAway || first.bannerSeen) {
        return {...first, arrivedLate: false};
    }
    const requested = page.url();
    const frames = everyFrame(page);
    if (!(await lookForBanner(frames))) {
        return {...first, arrivedLate: false};
    }

    const outcome = await attempt(page, frames, timeoutMs, AFTER_SCROLLING);
    if (outcome.navigated) {
        return {
            dismissed: false,
            via: null,
            navigatedAway: true,
            restored: await restore(page, requested),
            bannerSeen: true,
            arrivedLate: true,
        };
    }

    return {
        dismissed: outcome.dismissed,
        // Said out loud in meta.json: a banner dismissed here was on screen for part of the
        // capture, and the page measured before this point still had it.
        via: outcome.via === null ? null : `${outcome.via}, after the scroll pass`,
        navigatedAway: false,
        bannerSeen: true,
        arrivedLate: true,
    };
}

/** The main frame and every child frame, which is where a CMP's own document lives. */
const everyFrame = (page) => [page, ...page.frames().filter((f) => f !== page.mainFrame())];

/**
 * What a candidate has to be, for each of the two attempts. See the header for why they
 * differ: `wholeFrame` is the shortcut that lets a CMP's iframe vouch for its own controls,
 * and it is only sound while the parent document is the one the page loaded with.
 */
const AT_LOAD = {test: IS_BANNER_SHAPED, arg: OVERLAY_POSITIONS, wholeFrame: true};
const AFTER_SCROLLING = {
    test: IS_CONSENT_BANNER,
    arg: {subjectSource: CONSENT_SUBJECT.source, positions: OVERLAY_POSITIONS},
    wholeFrame: false,
};

/**
 * The two passes, in order, over every frame. Shared by both attempts.
 *
 * Returns `{dismissed, via, navigated}`. `navigated` is not a dismissal and never reports
 * as one — the caller undoes it and the capture goes on with the banner still standing,
 * which is a page we can honestly measure, unlike a different page entirely.
 */
async function attempt(page, frames, timeoutMs, gate) {
    for (const frame of frames) {
        const outcome = await clickKnownVendor(page, frame, timeoutMs);
        if (outcome === 'navigated') {
            return {dismissed: false, via: null, navigated: true};
        }
        if (outcome === 'dismissed') {
            return {dismissed: true, via: 'vendor selector', navigated: false};
        }
    }

    for (const frame of frames) {
        const wholeFrameIsBanner = gate.wholeFrame ? await frameIsBanner(page, frame) : false;
        const {outcome, label} = await clickByLabel(page, frame, wholeFrameIsBanner, gate);
        if (outcome === 'navigated') {
            return {dismissed: false, via: null, navigated: true};
        }
        if (outcome === 'dismissed') {
            // printable: this label is the page's text, and it ends up on a terminal.
            return {dismissed: true, via: `text "${printable(label, 60)}"`, navigated: false};
        }
    }

    return {dismissed: false, via: null, navigated: false};
}

/**
 * Any frame showing something banner-shaped and about consent. Never throws, and never
 * waits on a frame for longer than FRAME_ANSWER_MS.
 *
 * THIS IS WHERE THE THREE-MINUTE HANG WAS. bakerandpartners.com has seven frames and one of
 * them has an EMPTY URL; `frame.evaluate` on it returns never, so a page whose banner was
 * not found on an earlier frame stopped here for the whole capture budget. Measured: HEAD
 * gives up at 3:00 in `dismissConsent` on three runs out of three, and the same page
 * captures in 29s once this loop can stop asking. A frame that does not answer is skipped,
 * which is what the catch here already did for a frame that threw.
 */
async function lookForBanner(frames) {
    for (const frame of frames) {
        if (await ask(() => frame.evaluate(FIND_BANNER, {subjectSource: CONSENT_SUBJECT.source, positions: OVERLAY_POSITIONS}), false)) {
            return true;
        }
    }

    return false;
}
