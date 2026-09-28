/**
 * CHECKS
 *
 * Speed, Technical and Consistency as traffic lights: one row per check, the same rows on
 * every report, in the shape Proposition's checklist already prints —
 * `{id, check, status, found, fix}`.
 *
 *   node --test tools/audit/test/checks.test.mjs
 *
 * THREE LIGHTS: `good`, `work` (needs work) and `poor`. Proposition still says
 * working/fix; the template maps both.
 *
 * READS report.json's OWN FIELDS AND NOTHING ELSE, so a report already on disk can be given
 * its checks without re-running the capture or losing what purpose, proposition and summary
 * patched into it.
 *
 * WHOSE LINE IT IS travels in `found`. Speed's thresholds are Google's published Core Web
 * Vitals bands, so a reader who disputes one is disputing Google; Technical's are ours,
 * drawn against the median page, and the median is named every time so the reader sees
 * the line being drawn rather than taking the word for it.
 *
 * A ROW THAT JUDGES NOTHING IS NOT A CHECK. The palette size, the heaviest file type and
 * the fonts stay in the evidence table under each checklist: eleven colours is a choice,
 * and so is two typefaces.
 */
// A cycle with pdf.mjs, which is safe: both are read at call time, never at import.
import {MEDIAN_PAGE_MB, DEFERRAL_TARGET} from './pdf.mjs';

/** In step with r.bytes() in _views/report/_macros.twig: binary, one place in MB. */
export const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}mb` : `${Math.round(n / 1024)}kb`);
const ms = (n) => `${Math.round(n).toLocaleString('en-GB')}ms`;
const pc = (n) => `${Math.round(n * 100)}%`;

/** Google's bands, as their Core Web Vitals and PageSpeed documentation state them. */
export const GOOGLE = {
    score: {good: 90, work: 50},
    lcpMs: {good: 2500, work: 4000},
    tbtMs: {good: 200, work: 600},
    cls: {good: 0.1, work: 0.25},
};

/** Lower is better for the three metrics; the score is the other way up. */
const band = (value, {good, work}, higherIsBetter = false) => {
    if (higherIsBetter) return value >= good ? 'good' : value >= work ? 'work' : 'poor';

    return value <= good ? 'good' : value <= work ? 'work' : 'poor';
};

const NAMES = {lcpMs: 'Largest Contentful Paint', tbtMs: 'Total Blocking Time', cls: 'Cumulative Layout Shift',
    fcpMs: 'First Contentful Paint', speedIndexMs: 'Speed Index'};

export function speedChecks(speed, weight) {
    const lab = speed?.lab;
    if (!lab || typeof speed.score !== 'number') return null;

    const script = weight?.byType?.find((t) => t.type === 'script');
    const rows = [];

    const metric = (id, value, found, fix) => {
        if (typeof value !== 'number') return;
        const status = band(value, GOOGLE[id]);
        rows.push({id, check: NAMES[id], status, found, fix: status === 'good' ? null : fix});
    };

    metric('lcpMs', lab.lcpMs, `${ms(lab.lcpMs)} (Google: under 2,500ms)`,
        'Get the largest thing on the first screen in sooner: a smaller hero image, loaded first rather than lazily.');
    metric('tbtMs', lab.tbtMs, `${ms(lab.tbtMs)} (Google: under 200ms)`,
        `The page is busy running scripts after it appears, so clicks wait. Remove or defer what the first screen does not need${script ? ` — it loads ${script.requests} scripts, ${bytes(script.bytes)}` : ''}.`);
    metric('cls', lab.cls, `${lab.cls} (Google: under 0.1)`,
        'Parts of the page move as it loads. Reserve the space for images, embeds and banners so nothing pushes the page down.');

    // THE SCORE SAYS WHERE ITS POINTS WENT. PageSpeed marks desktop pages on a stricter
    // curve than Google's pass lines, so a page can pass all three rows below and still
    // miss points; `lost` (lib/psi.mjs) names which metric cost them. Older reports lack it
    // and fall back to the first failing row, Total Blocking Time first since it carries
    // the most weight.
    const status = band(speed.score, GOOGLE.score, true);
    const rowStatus = (id) => rows.find((r) => r.id === id)?.status;
    let fix = null;
    if (status !== 'good' && speed.lost) {
        const [id, points] = Object.entries(speed.lost).sort((a, b) => b[1] - a[1])[0];
        const value = id === 'cls' ? lab.cls : ms(lab[id]);
        fix = `${NAMES[id] ?? id} (${value}) costs the most: ${points} of the ${100 - speed.score} points missing.`
            + (rowStatus(id) && rowStatus(id) !== 'good' ? ' See below.' : '');
    } else if (status !== 'good') {
        const worst = ['poor', 'work'].map((s) => ['tbtMs', 'lcpMs', 'cls'].find((id) => rowStatus(id) === s)).find(Boolean);
        fix = worst ? `Start with ${NAMES[worst]}, below.`
            : "Every check below passes Google's thresholds; PageSpeed marks desktop pages on a stricter curve than those.";
    }

    return [{id: 'pagespeed', check: 'Google PageSpeed', status, found: `${speed.score}/100 on desktop (Google: 90 or above)`, fix}, ...rows];
}

/** What to do about the heaviest kind of file, by kind. Unlisted kinds get no advice. */
const LIGHTER = {
    image: 'Serve images at the size they are shown, as AVIF or WebP.',
    media: 'Stream video, or load it when it is played rather than with the page.',
    script: 'Remove scripts the page does not use, and load the rest after it appears.',
    font: 'Load fewer font files, cut to the characters the site uses.',
    stylesheet: 'Ship only the CSS this page uses.',
};

export function technicalChecks(weight, technical) {
    const total = weight?.afterScroll?.bytes;
    if (!total || !technical) return null;

    const median = MEDIAN_PAGE_MB * 1048576;
    const vs = (total - median) / median;
    const heaviest = weight.byType?.[0];
    const weightStatus = vs <= 0.05 ? 'good' : vs <= 1 ? 'work' : 'poor';
    const against = Math.abs(vs) < 0.05 ? 'about the median page'
        : `${pc(Math.abs(vs))} ${vs > 0 ? 'above' : 'below'} the median page of ${MEDIAN_PAGE_MB}mb`;

    // THE SHORT-PAGE GUARD, as in technicalScore: nothing below the fold to defer is not a
    // fault. Nothing deferred on a long page is the red; some is amber.
    const {deferred, shortPage} = technical;
    // ON THE PRINTED NUMBER: 39.7% prints as 40%, and "40% held back" marked amber beside
    // "aim for 40%" reads as a mistake.
    const held = Math.round(deferred * 100) / 100;
    const deferStatus = shortPage || held >= DEFERRAL_TARGET ? 'good' : held < 0.02 ? 'poor' : 'work';
    const atLoad = weight.atLoad?.bytes ?? total;

    return [
        {
            id: 'weight',
            check: 'Page weight',
            status: weightStatus,
            found: `${bytes(total)}, ${against}`,
            fix: weightStatus === 'good' || !heaviest ? null
                : `${pc(heaviest.bytes / total)} of it is ${heaviest.type} (${bytes(heaviest.bytes)}). ${LIGHTER[heaviest.type] ?? ''}`.trim(),
        },
        {
            id: 'deferred',
            check: 'Loads only what is on screen',
            status: deferStatus,
            found: shortPage ? `${bytes(atLoad)}; little below the first screen to hold back`
                : `${bytes(atLoad)} before scrolling; ${deferred < 0.02 ? 'nothing' : pc(deferred)} held back until scroll`,
            fix: deferStatus === 'good' ? null
                : `Lazy-load images and video below the first screen. A visitor who leaves after the first screen still downloads ${bytes(atLoad)}; aim to hold back ${pc(DEFERRAL_TARGET)} of the page.`,
        },
    ];
}

/** 0 groups is green, one or two amber, three or more red: the brand score's 10, 8-6, 4-0. */
export function consistencyChecks(styles, brand) {
    const colours = styles?.colours;
    if (!brand || !Array.isArray(colours?.sameColour)) return null;

    const groups = colours.sameColour;
    const area = new Map((colours.palette ?? []).map((c) => [c.colour, c.area ?? 0]));
    // KEEP THE ONE THE PAGE ALREADY USES MOST: a suggestion to change the dominant colour
    // to its stray twin is backwards.
    const keep = (group) => [...group].sort((a, b) => (area.get(b) ?? 0) - (area.get(a) ?? 0))[0];

    return [{
        id: 'duplicates',
        check: 'Duplicate colours',
        status: groups.length === 0 ? 'good' : groups.length < 3 ? 'work' : 'poor',
        found: groups.length === 0 ? `None (no two colours within dE ${colours.deltaE} of each other)`
            : `${groups.length} ${groups.length === 1 ? 'set' : 'sets'} of colours a person cannot tell apart`,
        // The template draws these as chips; `found` is the sentence for anything that cannot.
        groups,
        fix: groups.length === 0 ? null
            : groups.map((g) => `Use ${keep(g)} for ${g.filter((c) => c !== keep(g)).join(' and ')}.`).join(' '),
    }];
}

/** Every checklist a report prints, keyed by the section it sits under. */
export function checks(report) {
    return {
        speed: speedChecks(report.speed, report.weight),
        technical: technicalChecks(report.weight, report.technical),
        consistency: consistencyChecks(report.styles, report.brand),
    };
}
