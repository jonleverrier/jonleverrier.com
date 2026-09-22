/**
 * DEBUG LABELS
 *
 *   node --test tools/audit/test/debug.test.mjs
 *
 * The casing of the text on the annotated image and in the report's Segments table. Both
 * print the same strings, from one function, because two rules would drift apart the first
 * time either was tuned.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {titleCase} from '../lib/debug.mjs';

test('each word opens in capitals', () => {
    assert.equal(titleCase('footer link columns'), 'Footer Link Columns');
    assert.equal(titleCase('social icons, payment marks, copyright'), 'Social Icons, Payment Marks, Copyright');
});

/**
 * NOT Twig's `title` FILTER, which is ucwords(strtolower(...)) and would print "Closing Cta
 * With Buttons". A word already in capitals is a word somebody meant.
 */
test('a word already in capitals is left alone', () => {
    assert.equal(titleCase('closing CTA with buttons'), 'Closing CTA with Buttons');
    assert.equal(titleCase('B2B design partner'), 'B2B Design Partner');
    assert.equal(titleCase('Xero cloud accounting section'), 'Xero Cloud Accounting Section');
});

test('small words stay small unless they open the phrase', () => {
    assert.equal(titleCase('about firm and team'), 'About Firm and Team');
    assert.equal(titleCase('the case for a new site'), 'The Case for a New Site');
});

test('nothing in, nothing out', () => {
    assert.equal(titleCase(null), null);
    assert.equal(titleCase(''), '');
});
