/**
 * CONSENT
 *
 * The label classifier: does this button text mean "accept", or does it mean "open more
 * choices"?
 *
 *   node --test tools/audit/test/consent.test.mjs
 *
 * No browser here. The clicking is Playwright's problem; the decision worth testing is
 * the wording, which is pure string work and is where every real failure has been.
 *
 * The Japanese pair below is REAL — 「Cookie設定」 and 「了解」 are the two buttons on
 * pola.co.jp, which matched no vendor selector at all and is why the text pass exists.
 * Getting that pair the wrong way round clicks "settings", opens a second dialog, and
 * leaves the page worse than untouched.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isAcceptLabel, CONSENT_SELECTORS} from '../lib/consent.mjs';

test('the real pola.co.jp banner: 了解 accepts, Cookie設定 does not', () => {
    assert.equal(isAcceptLabel('了解'), true);
    assert.equal(isAcceptLabel('Cookie設定'), false);
});

test('English accept wording', () => {
    for (const label of ['Accept', 'Accept all', 'Accept all cookies', 'Allow all', 'I agree', 'Got it', 'OK']) {
        assert.equal(isAcceptLabel(label), true, label);
    }
});

test('non-Latin accept wording', () => {
    for (const label of ['同意する', 'すべて同意', '接受', '모두 허용', 'Принять', 'قبول', 'ยอมรับ', 'Đồng ý']) {
        assert.equal(isAcceptLabel(label), true, label);
    }
});

test('European accept wording', () => {
    for (const label of ['Alle akzeptieren', 'Tout accepter', 'Aceptar todo', 'Accetta tutto', 'Akkoord', 'Godta alle']) {
        assert.equal(isAcceptLabel(label), true, label);
    }
});

// Clicking one of these opens a second dialog, so the page ends up WORSE than if nothing
// had been touched. This is the half of the classifier that matters most.
test('settings and reject wording is refused', () => {
    for (const label of [
        'Cookie settings', 'Manage preferences', 'Customise', 'More options', 'Learn more',
        'Reject all', 'Decline', 'Necessary only', 'Einstellungen', 'Paramètres',
        'Configuración', 'Ustawienia', 'Настройки', '設定', '拒否', '거부', 'إعدادات',
    ]) {
        assert.equal(isAcceptLabel(label), false, label);
    }
});

// The deny pass runs FIRST and wins, which is what makes these safe.
test('a label containing both an accept and a settings word is refused', () => {
    assert.equal(isAcceptLabel('Accept settings'), false);
    assert.equal(isAcceptLabel('Manage and accept'), false);
    assert.equal(isAcceptLabel('Accept selected preferences'), false);
});

test('an accept word inside a longer word does not fire', () => {
    assert.equal(isAcceptLabel('Unacceptable'), false);
    assert.equal(isAcceptLabel('Acceptance criteria'), false);
});

test('prose is not a button', () => {
    const prose = 'We use cookies to improve your experience and analyse our traffic, and we would '
        + 'very much like you to accept them all right now';
    assert.equal(isAcceptLabel(prose), false);
});

test('empty and non-string labels are refused rather than thrown at', () => {
    for (const label of ['', '   ', null, undefined, 42, {}]) {
        assert.equal(isAcceptLabel(label), false);
    }
});

test('the vendor selector list is unique and non-empty', () => {
    assert.ok(CONSENT_SELECTORS.length > 15);
    assert.equal(new Set(CONSENT_SELECTORS).size, CONSENT_SELECTORS.length, 'duplicate selector');
});

// They are joined into one combined query, so a stray comma would silently widen it.
test('no selector contains a comma', () => {
    for (const s of CONSENT_SELECTORS) {
        assert.doesNotMatch(s, /,/, s);
    }
});
