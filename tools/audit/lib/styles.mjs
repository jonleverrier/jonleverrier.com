/**
 * STYLES
 *
 * The colours and typefaces this homepage actually uses, and the fonts it paid to load.
 *
 *   node --test tools/audit/test/styles.test.mjs
 *
 * THE RENDERED PAGE, NOT THE STYLESHEETS. Parsing CSS answers a different question: a
 * stylesheet covers every page of a site, and it carries whatever third parties injected
 * — kohde.agency loads 74 KB of CookieHub CSS from another origin, which is nothing the
 * client wrote and nothing they can change. Computed styles answer the question actually
 * being asked, which is what THIS page uses, and they cost nothing extra: the capture is
 * already walking the DOM.
 *
 * ALPHA IS NOT A COLOUR. `rgba(60, 16, 83, 0.6)` and `rgb(60, 16, 83)` are one colour used
 * at two opacities, which is an ordinary technique rather than a design-system failure.
 * Measured on natwest.com, four of its eighteen colour VALUES were the same four colours
 * at a second opacity; counting those as separate would have reported a drift where there
 * is a deliberate choice. So the values are recorded raw and the palette is recorded with
 * alpha collapsed, and the inconsistency question is asked of the second.
 *
 * DISTANCE IS MEASURED IN CIELAB, because RGB is not perceptually uniform — twenty points
 * of blue and twenty points of green are not the same size to an eye, and two colours can
 * look far apart while their numbers look close. dE is the standard unit: under 1 is
 * invisible, 2.3 is the just-noticeable difference, and under 5 is two colours a person
 * would call the same one.
 *
 * WHAT THIS SIGNAL IS WORTH, measured rather than assumed. Across kohde.agency,
 * natwest.com, hsbc.co.uk and whitepaper.co.uk: 11, 14, 11 and 11 colours, and once alpha
 * was collapsed, ONE genuine drift between them — hsbc's rgb(64,64,64) beside
 * rgb(68,68,68). Two more on kohde were near-whites layered on purpose. A bank, a small
 * agency and a one-person site all landed in the same band, so neither the count nor the
 * drift separated them on that sample. The clusters are recorded because they are cheap
 * and because four sites is not a corpus; nothing here decides what they mean.
 *
 * FONTS ARE TWO QUESTIONS WEARING ONE WORD. `document.fonts` says which faces the browser
 * loaded — one family at six weights is six downloads and one typeface — and computed
 * styles say which families the page actually rendered with. The gap is the finding, and
 * so is the naming: natwest.com renders with `knile`, `knilebold` and `knileblack`, which
 * is one typeface wearing three family names, while kohde.agency's Visuelt carries 400,
 * 500 and 700 as weights of a single family. A raw family count calls the first three and
 * the second one, and has it exactly backwards.
 *
 * The limitation worth knowing: a face is `loaded` only once something on the page has
 * needed it, so this is what THIS capture triggered. A weight used solely on a page we did
 * not visit reads as declared-and-unused, which is the right answer for a homepage report
 * and the wrong one for an audit of the whole site.
 */

/** Two colours closer than this are the same colour twice. See the header. */
export const SAME_COLOUR_DE = 5;

/** A transparent background is the absence of a colour choice, not a colour. */
const TRANSPARENT = /^rgba\(0,\s*0,\s*0,\s*0\)$/;

/** The numbers out of an `rgb()` or `rgba()` string, which is all getComputedStyle returns. */
export const channels = (value) => (String(value).match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

/**
 * sRGB to CIELAB, through linear RGB and XYZ at D65.
 *
 * The gamma step is the one that matters: sRGB is stored non-linearly, and skipping the
 * transfer function makes every dark colour look further from its neighbours than it is.
 */
export function toLab(rgb) {
    const linear = (c) => {
        const v = c / 255;

        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgb.map(linear);
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76. Plain Euclidean distance in Lab, which is what that space is for. */
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Colours grouped so that any two in a group are within `limit` of one another.
 *
 * SINGLE-LINK, DELIBERATELY: a colour joins a group if it is close to ANY member, so a run
 * of near-whites collects into one group rather than into overlapping pairs. The cost is
 * that a long chain can span more than `limit` end to end, which on a page's palette means
 * a ramp of greys reported as one family of grey — the right answer for this question.
 *
 * Input is `{colour, area}` sorted by area, and the order is kept: the first member of a
 * group is the one covering the most of the page, which is the one a reader would call the
 * real colour and the others the drift from it.
 */
export function clusterColours(colours, limit = SAME_COLOUR_DE) {
    const groups = [];
    for (const c of colours) {
        const lab = toLab(channels(c.colour));
        const home = groups.find((g) => g.some((m) => deltaE(toLab(channels(m.colour)), lab) <= limit));
        if (home) {
            home.push(c);
        } else {
            groups.push([c]);
        }
    }

    return groups;
}

/**
 * Every colour, typeface and size this page renders with. Runs IN the page.
 *
 * AREA IS CARRIED BESIDE EACH COLOUR because a count cannot tell a palette from an
 * accident. Seven colours where three cover ninety per cent of the page is a system with
 * accents; seven spread evenly is an accretion. What that means is the report's to decide
 * — this records the area so the question can be asked at all.
 *
 * A TEXT COLOUR ONLY COUNTS WHERE THERE IS TEXT. `color` is inherited, so every wrapper on
 * the page reports one whether or not it draws a character, and counting those makes a
 * single heading's colour look like the dominant colour of the page. Only elements with a
 * non-empty text node of their own are asked.
 *
 * The walk crosses open shadow roots where lib/shadow.mjs has installed its helper, for
 * the reason that file gives: a page that builds its components leaves a light-DOM walk
 * looking at empty wrappers.
 */
export const COLLECT_STYLES = () => {
    const deep = window.__auditDeep;
    const all = deep ? deep.all(document.body) : document.querySelectorAll('body *');

    const area = new Map();
    const sizes = new Map();
    const rendered = new Map();
    const add = (map, key, by) => map.set(key, (map.get(key) ?? 0) + by);

    for (const el of all) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const px = r.width * r.height;

        if (cs.backgroundColor && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(cs.backgroundColor)) {
            add(area, cs.backgroundColor, px);
        }
        const writes = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
        if (writes) {
            if (cs.color) add(area, cs.color, px);
            add(sizes, cs.fontSize, 1);
            add(rendered, cs.fontFamily.split(',')[0].trim().replace(/['"]/g, ''), px);
        }
    }

    // THE FACES THE BROWSER LOADED, which is not the families the page rendered with: a
    // face is only `loaded` once something needed it, so `declared` minus `loaded` is what
    // this page paid for in CSS and never used.
    const faces = [];
    try {
        for (const f of document.fonts) {
            faces.push({
                family: String(f.family).replace(/['"]/g, ''),
                weight: f.weight,
                style: f.style,
                status: f.status,
            });
        }
    } catch {
        // No FontFaceSet. Recorded as an empty list, which `declared: 0` already says.
    }

    const rows = (m) => [...m].sort((a, b) => b[1] - a[1]);

    return {
        colours: rows(area).map(([colour, px]) => ({colour, area: Math.round(px)})),
        fontSizes: rows(sizes).map(([size, count]) => ({size, count})),
        renderedFamilies: rows(rendered).map(([family, px]) => ({family, area: Math.round(px)})),
        faces,
    };
};

/**
 * The page's own styling, reduced to a record. Never throws.
 *
 * `collected` is COLLECT_STYLES' return. The palette is the colours with alpha collapsed —
 * see the header — and `sameColour` holds only the groups with more than one member, since
 * a group of one is a colour, not an inconsistency.
 */
export function styleRecord(collected, limit = SAME_COLOUR_DE) {
    if (!collected || !Array.isArray(collected.colours)) {
        return {measured: false, why: 'the style census returned nothing'};
    }

    // Two values differing only in alpha are one colour. Areas add, because both opacities
    // of it are that colour being used.
    const byChannels = new Map();
    for (const {colour, area} of collected.colours) {
        const key = channels(colour).join(',');
        byChannels.set(key, (byChannels.get(key) ?? 0) + area);
    }
    const palette = [...byChannels]
        .map(([key, area]) => ({colour: `rgb(${key.split(',').join(', ')})`, area}))
        .sort((a, b) => b.area - a.area);

    const faces = collected.faces ?? [];
    const loaded = faces.filter((f) => f.status === 'loaded');

    return {
        measured: true,
        why: null,
        colours: {
            values: collected.colours.length,
            total: palette.length,
            palette,
            // Groups of two or more: colours a person would call the same one.
            sameColour: clusterColours(palette, limit).filter((g) => g.length > 1)
                .map((g) => g.map((c) => c.colour)),
            deltaE: limit,
        },
        fonts: {
            declared: faces.length,
            loaded: loaded.length,
            // Distinct family NAMES among the loaded faces. Not the same as typefaces:
            // knile, knilebold and knileblack are three names and one typeface.
            families: [...new Set(loaded.map((f) => f.family))],
            rendered: collected.renderedFamilies ?? [],
            faces,
        },
        fontSizes: collected.fontSizes ?? [],
    };
}
