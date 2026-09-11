<?php

namespace modules\frontend\helpers;

use craft\elements\Asset;
use craft\elements\Entry;

/**
 * Shared reads for the `caseStudies` section.
 *
 * Exists for the same reason as Testimonials: the client shows up on the study's
 * own page, the cards, the Jonson panel and the JSON-LD, and four copies of the
 * rule are four chances to disagree.
 *
 * It used to be simpler and wrong. A study's Title WAS its client, so every
 * surface read `entry.title` and got a client name out of it. That only held
 * while a client had exactly one study — the moment one has two, the Title has to
 * become the study's own name and the client has to live somewhere else. That
 * somewhere is `clientSelector`, a relation to the Client List, and this class is
 * the only thing that should know how to follow it.
 *
 * @author You & Me Digital
 * @since  1.0.0
 */
class CaseStudies
{
    /**
     * The Client List entry a case study was for, or null.
     *
     * Null is a real answer, not a failure: personal work (StreetPal, the logo
     * collection) has no client, and a study whose relation hasn't been filled in
     * yet is indistinguishable from it here. Callers drop the client rather than
     * substituting something — see clientName() for why the old fallback is worse
     * than nothing now.
     */
    public static function client(?Entry $study): ?Entry
    {
        if (!$study || !self::has($study, 'clientSelector')) {
            return null;
        }

        $client = $study->clientSelector->one();

        return $client instanceof Entry ? $client : null;
    }

    /**
     * What to call the client, or '' when there isn't one.
     *
     * Two forms, because the two uses want different lengths. The short form is
     * the Client List entry's Title ("White Paper") and belongs anywhere it sits
     * beside something else — the card eyebrow, a byline. The long form is its
     * Client Long Title ("The White Paper Conference Company") and belongs where
     * the client is the subject: the Client row on a study, the Organization in
     * the structured data. Long falls back to short, since most clients don't set
     * one.
     *
     * Deliberately NOT falling back to the study's Title when there's no client.
     * That was the old behaviour and it's now actively wrong: Title is the study's
     * own name, so the fallback would print "Vaiie Product Branding" in a field
     * labelled Client. An empty string drops the row, which is honest — and it
     * makes an unset relation visible instead of papering over it with something
     * that looks plausible.
     */
    public static function clientName(?Entry $study, bool $long = false): string
    {
        $client = self::client($study);
        if (!$client) {
            return '';
        }

        $short = trim((string) $client->title);

        if (!$long) {
            return $short;
        }

        $longName = self::has($client, 'clientLongTitle')
            ? trim((string) ($client->clientLongTitle ?? ''))
            : '';

        return $longName !== '' ? $longName : $short;
    }

    /**
     * The logo to show for a case study.
     *
     * The client's own logo first: it's the client's mark, one client can now own
     * several studies, and holding it once is the whole point of the relation.
     *
     * The study's own Logo field is still read as a fallback, and deliberately so
     * — it's still on the entry type, and the studies with no client attached
     * (StreetPal, Urban) have one set. Dropping it to be strict about where logos
     * come from would take working logos off the page in exchange for nothing.
     */
    public static function clientLogo(?Entry $study): ?Asset
    {
        $client = self::client($study);

        if ($client && self::has($client, 'logo')) {
            $logo = $client->logo->one();
            if ($logo instanceof Asset) {
                return $logo;
            }
        }

        if ($study && self::has($study, 'logo')) {
            $logo = $study->logo->one();
            if ($logo instanceof Asset) {
                return $logo;
            }
        }

        return null;
    }

    /**
     * A list of studies with the ones sharing `$study`'s client first, the rest
     * after, each group keeping the order it arrived in.
     *
     * For the "More case studies" strip: with a client that has several studies,
     * the most useful thing to offer someone at the foot of one of them is the
     * others for the same client. A stable partition rather than a sort, so
     * whatever ordering the caller already applied (featured first) survives
     * inside each group.
     *
     * With no client — or a client with only this one study — every study lands in
     * the second group and the caller's order is returned untouched.
     */
    public static function orderBySharedClient(array $studies, ?Entry $study): array
    {
        $client = self::client($study);
        if (!$client) {
            return $studies;
        }

        $same = [];
        $rest = [];

        foreach ($studies as $candidate) {
            if (self::client($candidate)?->id === $client->id) {
                $same[] = $candidate;
            } else {
                $rest[] = $candidate;
            }
        }

        return array_merge($same, $rest);
    }

    /**
     * Is this field on the entry's layout?
     *
     * Reading a field an entry type doesn't have throws, and `clientSelector` is
     * new — anything that ran against a study before it existed, or against an
     * entry type that never gets one, has to survive the question. (The same guard
     * Testimonials and FindContext::fieldVal make.)
     */
    private static function has(Entry $entry, string $handle): bool
    {
        return (bool) $entry->getFieldLayout()?->getFieldByHandle($handle);
    }
}
