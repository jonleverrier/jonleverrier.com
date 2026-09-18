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
 * THE ORDINARY CANONICAL REDIRECT IS FORGIVEN, AND IT IS TWO THINGS AT ONCE.
 * `http://boondmanager.com` lands on `https://www.boondmanager.com/`: an http→https
 * upgrade and a `www.` prefix, which between them is what most of the web does to a bare
 * hostname. Warning about it was the third false alarm in this family — after the
 * trailing slash above and the consent note that fired on every page without a banner —
 * and each one teaches the reader to skip the warning that matters.
 *
 * THE UPGRADE IS FORGIVEN IN ONE DIRECTION ONLY, which is why this file no longer
 * compares two canonical strings. Asking for http and being answered over https is the
 * web working as intended; asking for https and ending on http is a downgrade, and being
 * quietly moved off TLS is exactly the kind of thing a report should say. So the
 * arguments are NOT interchangeable: `sameUrl(captured, requested)`, in that order, which
 * is the order both call sites already used.
 *
 * WHAT IS DELIBERATELY STILL A DIFFERENCE: a different host, a different port, and any
 * change to the path beyond a trailing slash, the query or the fragment — a query string
 * or a fragment can select entirely different content on one URL. A consent click that
 * carries the capture to another page is the case this exists for and it still fires.
 *
 * The limitation worth knowing: an unparseable URL compares raw, which is the safe
 * direction — it can only produce a warning that should be read, never suppress one.
 */

/**
 * A URL split into the scheme and everything else, or null if it will not parse.
 *
 * Split rather than joined because the scheme is the one part with a direction: see the
 * header. `www.` comes off the host here so that both `www.a.com` and `a.com` reduce to
 * the same thing whichever side of the comparison each turns up on.
 */
export function canonicalParts(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const u = new URL(raw);
        // `new URL('https://x.com')` already yields a pathname of '/', which is the whole
        // fix; the rest is making a deliberate choice visible rather than inheriting it.
        const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
        const host = u.host.toLowerCase();
        // Only when something is left that still looks like a host: `www.com` is a
        // registrable domain in its own right, and stripping it to `com` would make it
        // match a different site.
        const bare = host.replace(/^www\./, '');
        const stripped = bare.includes('.') ? bare : host;

        return {scheme: u.protocol, rest: `${stripped}${path}${u.search}${u.hash}`};
    } catch {
        return null;
    }
}

/** A URL reduced to the parts a difference in which means a different page. */
export function canonicalUrl(raw) {
    const parts = canonicalParts(raw);

    return parts === null ? null : `${parts.scheme}//${parts.rest}`;
}

/**
 * Is `captured` the page `requested` asked for? Unparseable input compares exactly.
 *
 * ORDER MATTERS — see the header. Only `captured` may be the https of an http
 * `requested`, never the other way round.
 */
export function sameUrl(captured, requested) {
    if (!captured || !requested) {
        return false;
    }
    const c = canonicalParts(captured);
    const r = canonicalParts(requested);
    if (c === null || r === null) {
        return captured === requested;
    }
    if (c.rest !== r.rest) {
        return false;
    }

    return c.scheme === r.scheme || (c.scheme === 'https:' && r.scheme === 'http:');
}
