/**
 * CONSENT
 *
 * One attempt at the cookie banner, and one only.
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
 *     submitting a URL could steer the audit anywhere they liked. "Banner-shaped" is a
 *     fixed or sticky ancestor, or a dialog role — the two ways a banner is actually
 *     built. A consent bar laid out in normal document flow is therefore never clicked;
 *     it stays on the page and counts as surface area, which is the right answer anyway.
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
 * Is this control inside something shaped like a banner? Runs IN the page.
 *
 * The two ways a consent banner is actually built: taken out of the flow so it can sit
 * over the page (fixed, or sticky), or announced as a dialog. Either is enough. Nothing
 * here looks at wording — that is isAcceptLabel's job — and nothing here looks at size or
 * position, because banners are top bars, bottom bars, corner cards and full-screen walls.
 *
 * The walk goes up from the control itself, because the accept button is usually several
 * static divs deep inside the positioned element that is the banner.
 */
export const IS_BANNER_SHAPED = (el) => {
    for (let a = el; a; a = a.parentElement) {
        const role = a.getAttribute ? a.getAttribute('role') : null;
        if (role === 'dialog' || role === 'alertdialog') return true;
        if (a.getAttribute && a.getAttribute('aria-modal') === 'true') return true;
        const cs = getComputedStyle(a);
        if (cs.position === 'fixed' || cs.position === 'sticky') return true;
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
    try {
        const owner = await frame.frameElement();

        return owner ? await owner.evaluate(IS_BANNER_SHAPED) : false;
    } catch {
        return false;
    }
}

/**
 * Try every visible control that is inside a banner and whose label reads as an accept.
 *
 * Returns `{outcome, label}`. The banner test runs only on controls whose wording already
 * qualified, which keeps it to a handful of round trips on a page of hundreds of controls.
 */
async function clickByLabel(page, frame, wholeFrameIsBanner) {
    let handles = [];
    try {
        handles = await frame.$$(CLICKABLE);
    } catch {
        return {outcome: 'none', label: null}; // frame went away mid-search
    }
    if (handles.length === 0) {
        return {outcome: 'none', label: null};
    }

    let described = [];
    try {
        described = await frame.evaluate(DESCRIBE_CONTROLS, handles);
    } catch {
        return {outcome: 'none', label: null};
    }

    for (let i = 0; i < handles.length; i++) {
        const d = described[i];
        if (!d || !d.visible || !isAcceptLabel(d.label)) continue;
        try {
            if (!wholeFrameIsBanner && !(await handles[i].evaluate(IS_BANNER_SHAPED))) continue;
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
 * Dismiss the banner if we can recognise it.
 *
 * Searches the main frame and every child frame, because several platforms render the
 * banner inside an iframe where a page-level query cannot see it.
 *
 * Returns `{dismissed, via, navigatedAway}` — `via` being the selector pass, the text that
 * was clicked, or null. That is recorded in meta.json: a capture where the banner was
 * dismissed by a loose text match is a capture worth looking at twice.
 *
 * `navigatedAway` means a click moved the page and was undone. It is NOT a dismissal and
 * never reports as one; the capture goes on with the banner still there, which is a page
 * we can honestly measure, unlike a different page entirely.
 */
export async function dismissConsent(page, timeoutMs = 2000) {
    const requested = page.url();
    const frames = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
    const undo = async () => {
        const restored = await restore(page, requested);

        return {dismissed: false, via: null, navigatedAway: true, restored};
    };

    for (const frame of frames) {
        const outcome = await clickKnownVendor(page, frame, timeoutMs);
        if (outcome === 'navigated') {
            return await undo();
        }
        if (outcome === 'dismissed') {
            return {dismissed: true, via: 'vendor selector', navigatedAway: false};
        }
    }

    for (const frame of frames) {
        const wholeFrameIsBanner = await frameIsBanner(page, frame);
        const {outcome, label} = await clickByLabel(page, frame, wholeFrameIsBanner);
        if (outcome === 'navigated') {
            return await undo();
        }
        if (outcome === 'dismissed') {
            // printable: this label is the page's text, and it ends up on a terminal.
            return {dismissed: true, via: `text "${printable(label, 60)}"`, navigatedAway: false};
        }
    }

    return {dismissed: false, via: null, navigatedAway: false};
}
