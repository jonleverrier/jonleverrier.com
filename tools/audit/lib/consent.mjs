/**
 * CONSENT
 *
 * One attempt at the cookie banner, and one only.
 *
 * A banner we fail to dismiss is NOT a failure of the capture. It is a real part of
 * that page's surface area, it will classify as promotion, and that is the correct
 * answer — a site that spends 18% of its first viewport on a consent wall should see
 * that number. So this never throws and never blocks; it records what happened and
 * the report says so.
 */
export const CONSENT_SELECTORS = [
    '#onetrust-accept-btn-handler',
    'button#onetrust-accept-btn-handler',
    '[aria-label="Accept all"]',
    'button[data-testid="uc-accept-all-button"]',
    '.cc-allow',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
];

/** Click the first selector that is visible. Returns whether anything was clicked. */
export async function dismissConsent(page, timeoutMs = 2000) {
    for (const selector of CONSENT_SELECTORS) {
        try {
            const el = page.locator(selector).first();
            await el.waitFor({state: 'visible', timeout: timeoutMs});
            await el.click({timeout: timeoutMs});

            return true;
        } catch {
            // Not on this page, or not clickable. Try the next one.
        }
    }

    return false;
}
