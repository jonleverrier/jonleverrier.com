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
 * WHAT THIS SIGNAL IS WORTH, and the first answer was wrong because the measurement was.
 * An early survey of four sites found one genuine drift between them and concluded the
 * signal was thin. That survey read colours with the naive parser described under
 * `channels` below, which mangles `color(srgb ...)`, so some of what it compared was not
 * the colour the page painted.
 *
 * Measured again with the canvas normalisation, on five sites: jersey.com has three
 * near-blacks at rgb(26,26,26), rgb(27,27,27) and rgb(28,28,28); visionarygrid.studio
 * declares its brand yellow twice, as rgb(255,211,0) and rgb(255,210,2); boondmanager.com
 * carries four drifted pairs including rgb(236,240,252) beside rgb(235,239,251). Those are
 * one-point differences nobody chose and nobody can see — a design token entered twice.
 *
 * Still recorded and not judged: what a drift means is the report's to decide, and a page
 * may layer near-whites deliberately.
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

/**
 * Two colours closer than this are the same colour twice.
 *
 * 2.3 IS THE JUST-NOTICEABLE DIFFERENCE — below it a person cannot tell two colours apart
 * with both in front of them. That is the claim this makes, so that is where the line goes.
 *
 * IT WAS 5, AND 5 WAS INDEFENSIBLE. A reader looked at kohde.agency's group and said
 * rgb(240,240,245) looks different to white, which it does: they are dE 5.69 apart. Every
 * genuine drift found across the corpus is far tighter — visionarygrid.studio's brand
 * yellow declared twice is 0.68, jersey.com's near-blacks 1.00, hsbc.co.uk's greys 1.76 —
 * so the looser threshold bought nothing and cost the only thing that matters here, which
 * is that the claim is true.
 */
export const SAME_COLOUR_DE = 2.3;

/**
 * The three channels out of an `rgb()` or `rgba()` string.
 *
 * SAFE ONLY BECAUSE COLLECT_STYLES NORMALISES FIRST. getComputedStyle does not always
 * answer in `rgb()` — boondmanager.com returns `color(srgb 0.156863 0.172549 0.196078)`
 * and visionarygrid.studio `color(srgb 1 1 0.835)` — and taking the first three numbers out
 * of those gives 0-1 values read as 0-255, which turns white into near-black. It did: white
 * was grouped with a dark grey as the same colour twice. Every value is now painted to a
 * canvas and read back in sRGB before it reaches here, so this only ever sees `rgb()` or
 * `rgba()`.
 *
 * THE GUARD IS ON THE SYNTAX, NOT THE RANGE, and the first attempt at it got that wrong.
 * `color(srgb 1 1 0.835)` yields 1, 1 and 0.835 — every one of them inside 0-255, so a
 * range check waves it through as an almost-black. What actually separates the two is the
 * function name: anything that is not `rgb()` or `rgba()` is a colour space this cannot
 * read, and is refused rather than mangled.
 */
export const channels = (value) => {
    const text = String(value).trim();
    if (!/^rgba?\(/i.test(text)) {
        return [];
    }
    const found = (text.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

    return found.length === 3 && found.every((c) => c >= 0 && c <= 255) ? found : [];
};

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
 * Colours grouped so that EVERY pair in a group is within `limit` of one another.
 *
 * COMPLETE-LINK, AND THE FIRST ATTEMPT WAS SINGLE-LINK, WHICH WAS WRONG. Joining a group
 * on closeness to ANY member lets a chain form: on kohde.agency, white joined
 * rgb(250,250,252) at dE 1.96, then rgb(240,240,245) joined THAT at 3.73 — and the report
 * announced white and rgb(240,240,245) as the same colour when they are 5.69 apart and
 * visibly different. A reader spotted it immediately, which is what a claim like this
 * deserves.
 *
 * The header comment called that cost "the right answer for this question". It was not.
 * A group here asserts that a person could not tell these apart, so every pair in it has
 * to pass, not merely some path through it.
 *
 * Input is `{colour, area}` sorted by area, and the order is kept: the first member of a
 * group is the one covering the most of the page, which is the one a reader would call the
 * real colour and the others the drift from it.
 */
export function clusterColours(colours, limit = SAME_COLOUR_DE) {
    const groups = [];
    for (const c of colours) {
        const lab = toLab(channels(c.colour));
        const home = groups.find((g) => g.every((m) => deltaE(toLab(channels(m.colour)), lab) <= limit));
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

    // EVERY COLOUR IS PAINTED AND READ BACK, because getComputedStyle does not always
    // answer in `rgb()`. Modern syntax survives into the computed value — boondmanager.com
    // returns `color(srgb 0.156863 0.172549 0.196078)` and visionarygrid.studio
    // `color(srgb 1 1 0.835)` — and anything that pulls the first three numbers out of
    // those and calls them channels reads white as near-black. Which it did: white was
    // grouped with a dark grey as "the same colour twice".
    //
    // A 1x1 canvas settles it for every syntax there is, current and future: the browser
    // does the conversion it would do to paint the pixel, and the pixel is read back in
    // sRGB. Cached, because a page has tens of distinct colours and thousands of elements.
    const paint = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    const known = new Map();
    const srgb = (value) => {
        if (known.has(value)) return known.get(value);
        let answer = null;
        try {
            paint.fillStyle = '#000';
            paint.fillStyle = value;
            // THE CANVAS'S OWN DESCRIPTION FIRST, because it is exact. jonleverrier.com's
            // microphone button is rgba(12, 36, 60, 0.08) and the painted pixel read back as
            // rgba(13, 38, 64, 0.078) — a pixel at 8% opacity is stored premultiplied, so its
            // channels lose precision — and the report called the page's own navy and that
            // rounding error two colours nobody can tell apart. For an sRGB colour the
            // canvas serialises `#rrggbb` or `rgba(r, g, b, a)` with the channels intact;
            // only a syntax it cannot state that way (color(), oklch()) is painted.
            const said = String(paint.fillStyle);
            const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(said);
            const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i.exec(said);
            if (hex || rgba) {
                const [r, g, b] = (hex ? hex.slice(1, 4).map((h) => parseInt(h, 16)) : rgba.slice(1, 4).map(Number));
                const alpha = rgba?.[4] === undefined ? 1 : Number(rgba[4]);
                answer = alpha === 0 ? null
                    : (alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
                known.set(value, answer);

                return answer;
            }
            paint.clearRect(0, 0, 1, 1);
            paint.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
            // ALPHA IS PRESERVED RATHER THAN BAKED OUT. getImageData is unpremultiplied,
            // so the channels are the colour and `a` is its opacity, and keeping them
            // apart is what lets the record say how many colour VALUES a page used against
            // how many colours — natwest.com's eighteen against fourteen. Collapsing them
            // here would answer one question and lose the other. Fully transparent is the
            // absence of a colour choice, not a colour.
            answer = a === 0
                ? null
                : (a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`);
        } catch {
            answer = null;
        }
        known.set(value, answer);

        return answer;
    };

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

        const bg = srgb(cs.backgroundColor);
        if (bg) add(area, bg, px);
        const writes = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
        if (writes) {
            const ink = srgb(cs.color);
            if (ink) add(area, ink, px);
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
export function styleRecord(collected) {
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
            // THE PALETTE AND NOT THE GROUPING. Which colours are the same colour is a
            // DERIVATION from this, at a threshold that is a judgement — and a judgement
            // baked in here is frozen into meta.json at capture time, so changing it would
            // mean re-photographing a page whose colours have not moved. The measurement
            // belongs to the capture; the grouping belongs to the report. See reportData
            // in lib/pdf.mjs, which clusters this.
            palette,
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
