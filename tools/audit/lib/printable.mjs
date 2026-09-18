/**
 * PRINTABLE
 *
 * One line of defence between a stranger's page and an operator's terminal.
 *
 *   node --test tools/audit/test/printable.test.mjs
 *
 * WHY: almost every string this tool prints about a capture was written by the page it
 * captured. A cookie button's label becomes `consent  dismissed via text "..."`, the
 * WebGL renderer string is whatever `getParameter` returned — and a page can replace
 * `getParameter` — a tag name arrives in a warning, and a redirect chooses
 * `capturedUrl`. None of that is our text. An ESC in any of it opens an ANSI escape
 * sequence: ESC [ 2K, a carriage return, and a sentence of the attacker's choosing
 * rewrites the line the operator is reading. A newline alone is enough to forge a whole
 * line — `area check   conserved` is 24 characters somebody else could type.
 *
 * So: anything page-derived goes through here before it is printed, and the rule is
 * simply that every string printed about the page is printable. THE JSON PATH IS
 * SEPARATE AND STAYS RAW — `JSON.stringify` escapes control characters itself, and
 * `meta.json` has to keep `url` and `capturedUrl` byte-exact or comparing them means
 * nothing. Sanitising is for the terminal, not for the record.
 *
 * Each removed character becomes `?` rather than vanishing, because a label that was
 * tampered with should look tampered with. Silently cleaning it would hide the one
 * thing worth noticing.
 *
 * The limitation worth knowing: this makes a string SAFE TO PRINT, not safe to embed in
 * anything else. HTML, SQL, a shell command and a CSV cell each need their own escape,
 * and none of them is this.
 */

/**
 * Characters that steer a terminal rather than appear in it.
 *
 *   \u0000-\u001F  C0, which is ESC (ANSI), CR, LF, BEL and the rest
 *   \u007F         DEL
 *   \u0080-\u009F  C1, including \u009B — the 8-bit CSI, an ANSI introducer by itself
 *   \u2028 \u2029  line and paragraph separators, newlines by another name
 *   \u202A-\u202E  bidi overrides: reorder what is displayed without changing the text
 *   \u2066-\u2069  bidi isolates, the same trick with a later spelling
 */
const UNPRINTABLE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/** Above this, a "label" is someone filling the terminal rather than naming a button. */
export const PRINTABLE_MAX = 200;

/**
 * A version of `value` that can only ever appear in a terminal, never act on it.
 *
 * Non-strings are stringified rather than rejected: a caller is interpolating this into
 * a message, and throwing there would turn a cosmetic problem into a failed run.
 */
export function printable(value, max = PRINTABLE_MAX) {
    const s = typeof value === 'string' ? value : String(value);
    const clean = s.replace(UNPRINTABLE, '?');

    return clean.length > max ? `${clean.slice(0, max)}\u2026` : clean;
}
