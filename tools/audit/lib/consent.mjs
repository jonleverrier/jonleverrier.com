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
 * The limitation worth knowing: the text pass reads the ACCESSIBLE text of a control, so
 * a banner whose accept button is an unlabelled icon, or a canvas, is invisible to it.
 * It also refuses anything matching DENY_TEXT, which costs a few real accept buttons
 * whose label happens to contain a settings word — deliberately, because clicking
 * "Manage preferences" opens a SECOND dialog and leaves the page worse than untouched.
 */

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
 */
export const ACCEPT_TEXT = new RegExp(
    [
        // English
        '\\b(accept|allow|agree|got it|i understand|ok|okay)\\b',
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

/** Controls a banner might use. Not every accept button is a <button>. */
const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

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
 */
async function clickAndConfirm(handle, timeoutMs) {
    let clicked = false;
    try {
        await handle.click({timeout: timeoutMs});
        clicked = true;
    } catch {
        try {
            await handle.evaluate((el) => el.click());
            clicked = true;
        } catch {
            return false;
        }
    }
    if (!clicked) {
        return false;
    }

    try {
        await handle.waitForElementState('hidden', {timeout: 2000});

        return true;
    } catch {
        // Detached is the commonest way a banner leaves, and asking a detached handle
        // anything throws. Treat a handle we can no longer query as gone.
        try {
            return !(await handle.isVisible());
        } catch {
            return true;
        }
    }
}

/** Try the vendor selectors in one combined query. Returns 'selector', or null. */
async function clickKnownVendor(frame, timeoutMs) {
    const combined = CONSENT_SELECTORS.join(', ');
    try {
        const el = frame.locator(combined).first();
        await el.waitFor({state: 'visible', timeout: timeoutMs});
        const handle = await el.elementHandle({timeout: timeoutMs});

        return handle && (await clickAndConfirm(handle, timeoutMs)) ? 'selector' : null;
    } catch {
        return null;
    }
}

/** Try every visible control whose own label reads as an accept. Returns the label, or null. */
async function clickByLabel(frame) {
    let handles = [];
    try {
        handles = await frame.$$(CLICKABLE);
    } catch {
        return null; // frame went away mid-search
    }

    for (const handle of handles) {
        try {
            if (!(await handle.isVisible())) continue;
            // `value` for <input>, accessible text for everything else.
            const label = await handle.evaluate(
                (el) => (el.value || el.innerText || el.textContent || '').trim(),
            );
            if (!isAcceptLabel(label)) continue;
            if (!(await clickAndConfirm(handle, 1000))) continue;

            return label;
        } catch {
            // Detached, covered, or navigated away. Try the next one.
        }
    }

    return null;
}

/**
 * Dismiss the banner if we can recognise it.
 *
 * Searches the main frame and every child frame, because several platforms render the
 * banner inside an iframe where a page-level query cannot see it.
 *
 * Returns `{dismissed, via}` — `via` being the selector pass, the text that was clicked,
 * or null. That is recorded in meta.json: a capture where the banner was dismissed by a
 * loose text match is a capture worth looking at twice.
 */
export async function dismissConsent(page, timeoutMs = 2000) {
    const frames = [page, ...page.frames().filter((f) => f !== page.mainFrame())];

    for (const frame of frames) {
        const bySelector = await clickKnownVendor(frame, timeoutMs);
        if (bySelector) {
            return {dismissed: true, via: 'vendor selector'};
        }
    }

    for (const frame of frames) {
        const label = await clickByLabel(frame);
        if (label) {
            return {dismissed: true, via: `text "${label}"`};
        }
    }

    return {dismissed: false, via: null};
}
