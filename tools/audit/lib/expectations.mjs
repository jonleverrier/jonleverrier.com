/**
 * EXPECTATIONS
 *
 * Which segments matter, given what the page is for.
 *
 *   node --test tools/audit/test/expectations.test.mjs
 *
 * NO MODEL RUNS HERE, and that is why the file exists. The model decides what each block
 * IS; what that then MEANS is a judgement, and a judgement a report makes about somebody's
 * business has to be identical on every run and readable by the person who wrote it. The
 * feedback bar on gov.uk came back `unclassified` on one run and `promotion` on the next
 * from the same prompt and the same page. A table cannot do that.
 *
 * THE RULE THAT EARNS IT: an absence is not a gap unless the purpose says it is. Telling a
 * government portal it has no testimonials is worse than saying nothing — it is advice
 * that is wrong rather than advice that is missing, and a prospect who spots one wrong
 * line stops believing the right ones.
 *
 * Four roles, and what each licenses the report to say:
 *
 *   core        the page's whole job. Present and substantial, the page is doing what it
 *               says; thin, that is the finding on the sheet.
 *   expected    ordinarily there. Absent is worth naming, gently.
 *   optional    fine either way. Nothing is ever said about it.
 *   irrelevant  absent is CORRECT, and said out loud so the number in the table above does
 *               not read as a fault. Present in quantity is a surprise worth naming.
 *
 * The limitation worth knowing: a wrong purpose flips every line here. That is why a
 * purpose below CONFIDENCE_FLOOR is treated exactly as `unclear`, why the section prints
 * the page's own claim beside the reading, and why `worth: false` means render nothing
 * rather than hedge.
 */
import {PURPOSES} from './purpose.mjs';

export const ROLES = ['core', 'expected', 'optional', 'irrelevant'];

/**
 * Below this, a purpose is a guess and the whole section is withheld.
 *
 * Measured answers on real pages sit at 95-97%; the gibberish case comes back at 0. There
 * is no middle ground in practice, so this is a floor against a bad day rather than a dial.
 */
export const CONFIDENCE_FLOOR = 0.6;

/**
 * A segment with less than this behind it is a rounding error.
 *
 * ONLY EVER USED ABOUT A `core` SEGMENT, never to decide whether something is THERE.
 * Presence is `isPresent`, which asks whether the model found any such block at all,
 * because a share threshold makes the answer depend on page length: gov.uk's header bar is
 * 64px, which is 1.4% of its 4,598px page and 3% of a short one. The first version of this
 * file told gov.uk it had no navigation while the GOV.UK bar sat at the top of the
 * annotated screenshot two pages later.
 */
export const PRESENT = 0.02;

/** A core segment under this is thin enough to be the finding. */
export const CORE_FLOOR = 0.12;

/** An irrelevant segment over this is a surprise worth naming. */
export const SURPRISE = 0.15;

/**
 * The table.
 *
 * `unclassified` is deliberately absent: it is not a kind of content, it is the model
 * declining to say, and the annotated screenshot is where a reader checks those.
 */
export const EXPECTATIONS = {
    route: {
        routing: 'core',
        navigation: 'expected',
        hero: 'expected',
        footer: 'expected',
        explainer: 'optional',
        editorial: 'optional',
        brand: 'optional',
        promotion: 'irrelevant',
        trust: 'irrelevant',
    },
    sell: {
        promotion: 'core',
        hero: 'core',
        routing: 'expected',
        trust: 'expected',
        explainer: 'expected',
        navigation: 'expected',
        footer: 'expected',
        brand: 'optional',
        editorial: 'optional',
    },
    enquire: {
        hero: 'core',
        explainer: 'core',
        trust: 'core',
        promotion: 'expected',
        navigation: 'expected',
        footer: 'expected',
        routing: 'optional',
        brand: 'optional',
        editorial: 'optional',
    },
    publish: {
        editorial: 'core',
        routing: 'core',
        navigation: 'expected',
        footer: 'expected',
        hero: 'optional',
        explainer: 'optional',
        brand: 'optional',
        promotion: 'optional',
        trust: 'optional',
    },
};

/**
 * What to call a page of each kind, as the tail of "the things ___ needs".
 *
 * A NOUN, because the closing sentence counts against it: "two of the three things an
 * enquiry page needs are there". `enquire` and the rest are keys, not words anybody reads.
 */
const NOUN = {
    route: 'a directory',
    sell: 'a page that sells',
    enquire: 'an enquiry page',
    publish: 'a page that is read',
};

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * What each job is, as the tail of "That is a page whose job is ___".
 *
 * The clause carries no subject of its own. It read "its job is to send people somewhere",
 * which is a whole sentence, and the template's own lead-in then produced "a page whose
 * its job is to send people somewhere".
 */
const JOBS = {
    route: 'to send people somewhere',
    sell: 'to get a sale or a signup',
    enquire: 'to start a conversation',
    publish: 'to be read',
};

/**
 * Each segment in the two shapes it is needed in: as the subject of a sentence, and as an
 * absence.
 *
 * TWO FORMS BECAUSE ONE DOES NOT BEND. A single plain word produced "The page has no an
 * opening statement", and the obvious fix — dropping the article — produces "Routing is
 * what this page is for" beside "The page has no hero", one of which is right.
 *
 * THE WORDS ARE THE TABLE'S OWN, not friendlier synonyms. The reader has just come off the
 * Segments table, where these rows are called Hero, Routing and Trust; prose that renames
 * them to "an opening statement" makes them look like different things. `trust` is the one
 * exception, because "the page has no trust" is not a sentence in English.
 */
const PLAIN = {
    routing: {subject: 'Routing', absence: 'no routing', bare: 'routing'},
    promotion: {subject: 'Promotion', absence: 'no promotion', bare: 'promotion'},
    trust: {
        subject: 'Trust',
        absence: 'nothing from outside the company vouching for it',
        bare: 'anything vouching for it from outside the company',
    },
    hero: {subject: 'The hero', absence: 'no hero', bare: 'a hero'},
    explainer: {subject: 'The explainer', absence: 'no explainer', bare: 'an explainer'},
    editorial: {subject: 'Editorial', absence: 'no editorial', bare: 'editorial'},
    navigation: {subject: 'Navigation', absence: 'no navigation', bare: 'navigation'},
    footer: {subject: 'The footer', absence: 'no footer', bare: 'a footer'},
    brand: {subject: 'Brand imagery', absence: 'no brand imagery', bare: 'brand imagery'},
};

/**
 * The clause that stops an excused number reading as a fault.
 *
 * A reader who has just seen promotion at 1.7% in the table above will wonder whether the
 * report noticed. Saying so costs a sentence; leaving it out costs the reader's trust in
 * every other line, because they cannot tell an omission from an oversight.
 */
function sentenceForNotGaps(list) {
    if (!list.length) {
        return '';
    }
    const names = list.map((c) => PLAIN[c]?.subject.replace(/^The /, '').toLowerCase() ?? c);
    const joined = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

    const one = names.length === 1;
    const subject = joined.charAt(0).toUpperCase() + joined.slice(1);

    return `${subject} ${one ? 'is' : 'are'} not what a page like this is for, `
        + `so having little or none of ${one ? 'it' : 'them'} is not a gap.`;
}

/**
 * The one sentence that judges the core segments, after they have each stated a number.
 *
 * SAID ONCE, however many cores a purpose has. It used to be a clause on the end of every
 * core finding, which reads as a stuck record on any purpose with more than one — and
 * every purpose except `route` has more than one.
 */
function verdictFor(kind, cores, otherGaps) {
    if (!cores.length) {
        return '';
    }

    const thin = cores.filter((c) => !c.healthy);
    if (!thin.length) {
        // NOTHING TO SAY WHEN SOMETHING ELSE IS MISSING. This counts core segments only,
        // and gov.je put it straight after "The page has no hero." — a bullet naming a gap,
        // answered by a sentence saying the page spends its space correctly. Both true,
        // and together they read as the report waving its own finding away. The bullets
        // already say what is absent; a summary that cannot see it should keep quiet.
        return otherGaps ? '' : 'That is the page spending its space on what it says it is for.';
    }

    const noun = NOUN[kind] ?? 'a page like this';
    const total = COUNT[cores.length] ?? cores.length;
    if (thin.length === cores.length) {
        return `None of the ${total} things ${noun} needs takes much of the page.`;
    }

    // Lower-cased and rejoined rather than printed as the table's own labels: "The hero
    // and Trust" is two sentences fighting over one capital letter.
    const names = thin.map((c) => PLAIN[c.category].subject.toLowerCase());
    const joined = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const healthy = cores.length - thin.length;

    return `${COUNT[healthy] ?? healthy} of the ${total} things ${noun} needs `
        + `${healthy === 1 ? 'is' : 'are'} there in quantity. `
        + `${joined.charAt(0).toUpperCase() + joined.slice(1)} ${names.length === 1 ? 'is' : 'are'} not.`;
}

export function roleOf(purpose, category) {
    return EXPECTATIONS[purpose]?.[category] ?? null;
}

export function describe(purpose) {
    return JOBS[purpose] ?? '';
}

const pc = (v) => `${(v * 100).toFixed(1)}%`;
const sections = (n) => `${n} section${n === 1 ? '' : 's'}`;

/**
 * Read a report against its own purpose.
 *
 * Returns `{worth, kind, claim, job, findings, notGaps}`. `worth: false` means print
 * nothing at all: an unknown purpose, a shaky one, or a report from before this existed.
 *
 * `notGaps` is the list of segments the purpose excuses. It is returned separately from
 * the findings because it is not one — it is the clause that stops a 1.7% in the table
 * above reading as a fault the report forgot to mention.
 *
 * NOTHING HERE MENTIONS ANOTHER SITE. This section runs per site, including inside a
 * comparison, and setting the two against each other is the Executive Comparison's job.
 */
export function read(report) {
    const purpose = report?.purpose ?? null;
    const kind = purpose?.kind ?? 'unclear';
    const confident = (purpose?.confidence ?? 0) >= CONFIDENCE_FLOOR;
    const table = EXPECTATIONS[kind];

    if (!table || !confident) {
        return {worth: false, kind: 'unclear', claim: null, job: '', findings: [], notGaps: []};
    }

    const share = (category) => (report.categories ?? [])
        .find((c) => c.category === category)?.share ?? 0;
    const at = (category) => (report.categories ?? [])
        .find((c) => c.category === category) ?? null;
    // THERE AT ALL, which is a different question from how much room it takes. A segment
    // the model found a block for exists, however small the block.
    const isPresent = (category) => {
        const seg = at(category);

        return (seg?.share ?? 0) > 0 || (seg?.blocks?.length ?? 0) > 0;
    };

    const findings = [];
    const notGaps = [];
    // Which core segments cleared the floor, for the one sentence that judges them.
    const cores = [];

    for (const [category, role] of Object.entries(table)) {
        const seg = at(category);
        const has = share(category);

        if (role === 'core') {
            // THE MEASUREMENT ONLY. The conclusion used to ride on the end of every core
            // finding — "so the page is spending its space on what it says it is for" —
            // which was written when the only purpose being tested had ONE core segment.
            // `enquire` has three, so a real report carried that clause twice in three
            // bullets and each of the three announced itself as "what this page is for".
            // `route` was the lucky case, not the normal one: every other purpose has two
            // cores or more. The conclusion belongs to the reading, not to each line of
            // it — see verdictFor.
            const first = seg?.firstViewport ?? 0;
            const measured = `${PLAIN[category].subject} takes ${pc(has)} of the page across `
                + `${sections(seg?.blocks?.length ?? 0)}`
                + (first > 0 ? `, and ${pc(first)} of the first screen` : '') + '.';

            const healthy = has >= CORE_FLOOR;
            cores.push({category, healthy});
            findings.push({
                id: `core-${category}`,
                category,
                role,
                kind: healthy ? 'doing-its-job' : 'gap',
                weight: healthy ? has : 1 - has,
                text: healthy || isPresent(category)
                    ? measured
                    : `The page has ${PLAIN[category].absence}.`,
            });
            continue;
        }

        if (role === 'expected' && !isPresent(category)) {
            findings.push({
                id: `missing-${category}`,
                category,
                role,
                kind: 'gap',
                weight: 0.5,
                text: `The page has ${PLAIN[category].absence}.`,
            });
            continue;
        }

        if (role === 'irrelevant') {
            if (has >= SURPRISE) {
                findings.push({
                    id: `surprise-${category}`,
                    category,
                    role,
                    kind: 'surprise',
                    weight: has,
                    text: `${pc(has)} of the page is ${category}, which is not what a page like `
                        + 'this usually spends its space on.',
                });
            } else {
                // Named whether it is there or not: a 1.7% in the table is as much in need
                // of excusing as a nought.
                notGaps.push(category);
            }
        }
    }

    findings.sort((a, b) => b.weight - a.weight);

    return {
        worth: findings.length > 0,
        kind,
        claim: purpose.claim ?? null,
        job: describe(kind),
        findings,
        notGaps,
        // WRITTEN HERE, NOT IN THE TEMPLATE, for the reason the findings are: a Twig file
        // that assembled this sentence would be a second place the judgement lives.
        notGapsText: sentenceForNotGaps(notGaps),
        verdict: verdictFor(kind, cores, findings.some((f) => f.kind === 'gap' && f.role !== 'core')),
    };
}

/** Every purpose the table knows, for the guards in the tests. */
export const KNOWN = PURPOSES.filter((p) => p !== 'unclear');

/**
 * The two readings set against each other. The Executive Comparison's own summary.
 *
 * THE FIRST QUESTION IS WHETHER THEY ARE THE SAME KIND OF PAGE, and it is not a formality.
 * Every row on that sheet puts two shares side by side, and if one page is a directory and
 * the other is a shop then 69% against 18% is not one page beating another — it is two
 * different decisions, and a reader left to assume otherwise draws the wrong conclusion
 * from a table the report handed them. So a mismatch is said out loud, before the numbers.
 *
 * WHAT IT ADDS IS ABSENCES. Everything else on the page is already two columns and a
 * change; what those columns cannot show is that one page has a thing the other simply
 * does not, judged against what both are FOR. gov.je having no hero is the finding of that
 * whole comparison, and no row on the sheet says it.
 *
 * `names` is `{mine, theirs}`, already reduced to bare hosts by the caller — this file has
 * no business parsing URLs.
 */
export function compare(a, b, names) {
    const mine = read(a);
    const theirs = read(b);
    if (!mine.worth || !theirs.worth) {
        return {worth: false, samePurpose: null, lead: '', points: []};
    }

    const same = mine.kind === theirs.kind;
    const lead = same
        ? `Both pages are trying to do the same thing: ${mine.job.replace(/^to /, '')}. `
            + 'So the shares above are two answers to one question.'
        : `These two pages are not trying to do the same thing. ${names.mine} is a page whose job is `
            + `${mine.job}; ${names.theirs} is one whose job is ${theirs.job}. The shares above are `
            + 'two different decisions rather than two answers to one question.';

    const gapsIn = (reading) => new Set(reading.findings.filter((f) => f.kind === 'gap').map((f) => f.category));
    const ours = gapsIn(mine);
    const yours = gapsIn(theirs);

    const points = [];
    // ONLY WHEN THEY ARE THE SAME KIND OF PAGE. "Only the magazine has no promotion" is
    // not a finding about the magazine, it is a finding about the comparison.
    if (same) {
        for (const category of [...new Set([...ours, ...yours])]) {
            const word = PLAIN[category];
            if (!word) continue;
            if (ours.has(category) && yours.has(category)) {
                points.push(`Neither page has ${word.bare}.`);
            } else {
                points.push(`Only ${ours.has(category) ? names.mine : names.theirs} is without ${word.bare}.`);
            }
        }
    }

    return {worth: true, samePurpose: same, lead, points};
}
