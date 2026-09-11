<?php

namespace modules\frontend\helpers;

use craft\elements\Entry;

/**
 * Shared reads for the `testimonials` section.
 *
 * Exists so the four places that show a testimonial — the case study index, a
 * study's own page, the Jonson rail and the JSON-LD — resolve its client the
 * same way. They used to read `company` directly, four times over.
 *
 * @author You & Me Digital
 * @since  1.0.0
 */
class Testimonials
{
    /**
     * The client a testimonial belongs to.
     *
     * A testimonial can name its client TWICE: `caseStudyLink` (a relation to
     * the study) and `company` (free text). Two fields for one fact is two
     * chances to be wrong, and they diverged silently — Oliver Atkinson's quote
     * read "Urban.co.uk" in the Company box with no relation set, so it looked
     * attached in the CP and never appeared on the study.
     *
     * So the relation wins wherever there is one, and the string is only read
     * when there isn't. That makes `company` what it should always have been: a
     * fallback for quotes with no case study to point at (a client whose work
     * isn't written up), rather than a second source for the same name.
     *
     * A relation to a DISABLED study falls back to the string too — `one()`
     * won't return a draft or a disabled entry, and a quote naming no one is
     * worse than a quote naming a client whose page isn't live yet.
     *
     * The relation resolves through the study to ITS client rather than stopping
     * at the study's Title. That used to be the same string — a study was titled
     * with its client's name — but a client can now have several studies, so the
     * Title names the work and the client hangs off `clientSelector`. Left as it
     * was, a byline would read "Vaiie Product Branding" where it means "Vaiie".
     *
     * A study with no client of its own falls through to the typed `company`
     * rather than to the study's Title, for the same reason: the Title is no
     * longer a client name, so it isn't a safe thing to print as one.
     *
     * '' when there is neither, which every caller already treats as "no
     * company" — the byline just prints the person and their role.
     */
    public static function company(?Entry $testimonial): string
    {
        if (!$testimonial) {
            return '';
        }

        $client = CaseStudies::clientName(self::caseStudy($testimonial));
        if ($client !== '') {
            return $client;
        }

        return self::has($testimonial, 'company')
            ? trim((string) ($testimonial->company ?? ''))
            : '';
    }

    /**
     * The case study a testimonial is attached to, or null.
     *
     * Also the answer to "is this quote attached at all" — the case study views
     * query the relation from the other side, and this is the same edge read
     * forwards.
     */
    public static function caseStudy(?Entry $testimonial): ?Entry
    {
        if (!$testimonial || !self::has($testimonial, 'caseStudyLink')) {
            return null;
        }

        $study = $testimonial->caseStudyLink->one();

        return $study instanceof Entry ? $study : null;
    }

    /**
     * Is this field on the entry's layout?
     *
     * Reading a field an entry type doesn't have throws, and these run over
     * whatever the section holds — so check rather than assume. (The same guard
     * FindContext::fieldVal makes, for the same reason.)
     */
    private static function has(Entry $entry, string $handle): bool
    {
        return (bool) $entry->getFieldLayout()?->getFieldByHandle($handle);
    }
}
