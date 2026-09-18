/**
 * SAME URL
 *
 * Did the capture end on the page that was asked for?
 *
 *   node --test tools/audit/test/sameurl.test.mjs
 *
 * The check exists because a consent click could once navigate away and the run still
 * reported success, so every artefact was of another page. It must not cry wolf, and
 * comparing the two strings raw does: asking for `https://www.visionarygrid.studio`
 * lands on `https://www.visionarygrid.studio/`, and the only difference is the empty
 * path the browser fills in. A warning that fires on ordinary navigation trains the
 * reader to ignore the one that matters.
 *
 * WHAT IS DELIBERATELY STILL A DIFFERENCE: scheme, host and port, and the path beyond a
 * trailing slash. http to https is a redirect worth knowing about, and a query string or
 * a fragment can select entirely different content on one URL. Only the empty-path slash
 * and a case-insensitive host are normalised away.
 *
 * The limitation worth knowing: an unparseable URL compares raw, which is the safe
 * direction — it can only produce a warning that should be read, never suppress one.
 */

/** A URL reduced to the parts a difference in which means a different page. */
export function canonicalUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const u = new URL(raw);
        // `new URL('https://x.com')` already yields a pathname of '/', which is the whole
        // fix; the rest is making a deliberate choice visible rather than inheriting it.
        const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');

        return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}${u.hash}`;
    } catch {
        return null;
    }
}

/** Are these the same page? Unparseable input falls back to an exact comparison. */
export function sameUrl(a, b) {
    if (!a || !b) {
        return false;
    }
    const ca = canonicalUrl(a);
    const cb = canonicalUrl(b);

    return ca === null || cb === null ? a === b : ca === cb;
}
