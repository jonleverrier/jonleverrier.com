<?php

namespace modules\jonson\services;

use Craft;
use craft\elements\Asset;
use craft\elements\Category;
use craft\elements\Entry;
use modules\frontend\helpers\CaseStudies;
use modules\frontend\helpers\Testimonials;
use modules\jonson\Jonson;
use yii\base\Component;

/**
 * Retrieval for the `find_context` tool. Claude passes a free-text `query` (the
 * topics it's talking about) and an optional `kind`; this returns a flat list of
 * normalised items for the context rail.
 *
 * Two match strategies, declared per source in the registry:
 *   - `tags`   — for photos (no text of their own), match the query's terms
 *                against each asset's `tags` field.
 *   - `search` — for text content (projects, testimonials, CV…), use Craft's
 *                search index across the entry's own fields.
 *
 * Sources whose section/field doesn't exist yet are skipped, so the registry
 * can list future kinds safely.
 */
class FindContext extends Component
{
    private const MAX_ITEMS = 4;
    private const MAX_TESTIMONIALS = 3; // ceiling on how many quotes surface at once
    private const TESTIMONIAL_FEATURED_BOOST = 100; // a featured quote outranks any non-featured in generic (non-client) contexts
    private const CASE_STUDY_TARGETED_MAX = 2; // >this many matches = a broad sweep, not a targeted ask → featured only

    /**
     * Content sources, keyed by `kind`. Photos are the only tag-dependent one;
     * everything else self-describes via its text.
     */
    private const SOURCES = [
        'photo' => [
            'strategy' => 'tags',
            'single' => 'personality', // the personality single…
            'field' => 'memories',     // …its Assets field
        ],
        'project' => [
            'strategy' => 'search',
            'section' => 'projects',
        ],
        'casestudy' => [
            'strategy' => 'search',
            'section' => 'caseStudies',
        ],
        'testimonial' => [
            'strategy' => 'search',
            'section' => 'testimonials',
        ],
        'process' => [
            'strategy' => 'search',
            'section' => 'process',
        ],
        'experience' => [
            'strategy' => 'search',
            'section' => 'cv',
        ],
    ];

    /**
     * Find content matching `query`, optionally scoped to one `kind`.
     * Returns normalised item maps: { kind, image?, title?, url?, summary?,
     * quote?, cite? }.
     */
    public function find(string $query, ?string $kind = null): array
    {
        $query = trim($query);
        if ($query === '') {
            return [];
        }

        $sources = ($kind !== null && isset(self::SOURCES[$kind]))
            ? [$kind => self::SOURCES[$kind]]
            : self::SOURCES;

        $items = [];
        foreach ($sources as $k => $source) {
            try {
                $found = $source['strategy'] === 'tags'
                    ? $this->byTags($source, $query)
                    : $this->bySearch($k, $source, $query);
            } catch (\Throwable $e) {
                Craft::error("[jonson] find_context {$k}: " . $e->getMessage(), __METHOD__);
                $found = [];
            }

            $items = array_merge($items, $found);
            if (count($items) >= self::MAX_ITEMS) {
                break;
            }
        }

        $items = array_slice($items, 0, self::MAX_ITEMS);
        Craft::info(
            sprintf('query="%s" kind=%s terms=[%s] → %d item(s)', $query, $kind ?? 'any', implode(',', $this->terms($query)), count($items)),
            'jonson.find_context',
        );

        return $items;
    }

    /**
     * The handles Jonson may reference inline as `[[handle]]` to surface photos.
     * Derived from the memory assets' own tags + location categories (each
     * expanded up the tree), so every handle listed here resolves through
     * find(). Returns [{handle, label}], deduped, label = the human title.
     */
    public function inventory(): array
    {
        $source = self::SOURCES['photo'];
        $entry = Entry::find()->status(Entry::STATUS_LIVE)->section($source['single'])->one();
        $assets = $entry?->{$source['field']}?->all() ?? [];

        $vocab = []; // slug => label
        foreach ($assets as $asset) {
            if ($asset->getFieldLayout()?->getFieldByHandle('tags')) {
                foreach ($asset->tags->all() as $tag) {
                    $vocab[$this->slug((string) $tag->title)] = (string) $tag->title;
                }
            }
            if ($asset->getFieldLayout()?->getFieldByHandle('location')) {
                foreach ($asset->location->all() as $category) {
                    foreach (array_merge([$category], $category->getAncestors()->all()) as $node) {
                        $vocab[$this->slug((string) $node->title)] = (string) $node->title;
                    }
                }
            }
        }

        unset($vocab['']);
        $items = [];
        foreach ($vocab as $handle => $label) {
            $items[] = ['handle' => $handle, 'label' => $label];
        }

        return $items;
    }

    /**
     * Deterministic fallback for the rail: the showable handles whose label is
     * named anywhere in the given text (case-insensitive, whole word/phrase).
     * Lets the rail surface photos from what the answer actually says, even when
     * the model placed no `[[marker]]` — which, for broad answers, it often
     * doesn't. Order follows first appearance in the text.
     */
    public function handlesInText(string $text): array
    {
        $text = mb_strtolower($text);
        if ($text === '') {
            return [];
        }

        $hits = []; // handle => first-match offset, so we can order by appearance
        foreach ($this->inventory() as $item) {
            $label = trim(mb_strtolower((string) $item['label']));
            // Skip very short labels — too noisy to match on their own.
            if (mb_strlen($label) < 3) {
                continue;
            }
            // Whole word/phrase match (unicode-safe boundaries, not \b), letting
            // the LAST word run on into an inflection — "street photo" is named by
            // "street photography", "Jersey" by "Jersey's" (the boundary stops at
            // the apostrophe) — but never starting mid-word.
            $pattern = '/(?<![\p{L}\p{N}])' . preg_quote($label, '/') . '\p{L}{0,6}(?![\p{L}\p{N}])/u';
            if (preg_match($pattern, $text, $m, PREG_OFFSET_CAPTURE)) {
                $handle = $item['handle'];
                $offset = $m[0][1];
                if (!isset($hits[$handle]) || $offset < $hits[$handle]) {
                    $hits[$handle] = $offset;
                }
            }
        }

        asort($hits); // by first appearance in the prose

        return array_keys($hits);
    }

    /**
     * Resolve inline `[[handle]]` references (parsed from the answer) to a
     * deduped list of rail items. Each handle runs through the same matcher
     * find() uses, so photos and (future) text kinds resolve identically.
     */
    public function forHandles(array $handles, array $excludeKeys = []): array
    {
        // Resolve each handle to its own candidate list first. Photos only — the
        // rail is a personal-photography strip; work content (case studies etc.)
        // is surfaced elsewhere and must never mix in here.
        $lists = array_map(fn(string $handle) => $this->find($handle, 'photo'), $handles);

        // Fill round-robin — one photo per handle before any handle's second —
        // so every place/theme the answer named gets a slot before one of them
        // fills the rail (e.g. three Jersey photos crowding out Bordeaux).
        // Dedupe by item; stop at MAX_ITEMS. $excludeKeys pre-seeds the "seen" set
        // with photos already shown earlier this conversation, so a repeat surfaces
        // only new ones (or none) rather than the same set again.
        $items = [];
        $seen = array_fill_keys($excludeKeys, true);
        for ($col = 0, $active = true; $active && count($items) < self::MAX_ITEMS; $col++) {
            $active = false;
            foreach ($lists as $list) {
                if (!isset($list[$col])) {
                    continue;
                }
                $active = true;
                $key = $this->itemKey($list[$col]);
                if ($key === null || isset($seen[$key])) {
                    continue;
                }
                $seen[$key] = true;
                $items[] = $list[$col];
                if (count($items) >= self::MAX_ITEMS) {
                    return $items;
                }
            }
        }

        return $items;
    }

    /**
     * The testimonials to surface for the current answer, most relevant first.
     *
     * The strongest signal is the CLIENT: if the answer names a testimonial's
     * company/person, that quote is what the point is about, so it leads and
     * only other named-client quotes join it — no generic fillers. Absent a
     * named client (a general credibility beat), the quotes Jon has flagged
     * `isFeatured` lead (his strongest, boosted above any non-featured), then
     * topical overlap of each quote's `context` + text with the answer fills the
     * rest (or the single best as a default, since the model asked for a quote via
     * its marker). Capped at MAX_TESTIMONIALS. Returns a list of
     * { quote, name, role, company, image } (empty if none).
     */
    public function testimonials(string $forText = ''): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('testimonials')) {
            return [];
        }

        $entries = Entry::find()->status(Entry::STATUS_LIVE)->section('testimonials')->all();
        if (!$entries) {
            return [];
        }

        $terms = $this->terms($forText);
        // Normalised, space-padded answer for phrase matching (word boundaries).
        $answerNorm = ' ' . trim(preg_replace('/\s+/', ' ',
            preg_replace('/[^\p{L}\p{N}]+/u', ' ', mb_strtolower($forText)) ?? '')) . ' ';

        $scored = [];
        foreach ($entries as $i => $entry) {
            // A subject match is a PHRASE hit on the client's distinctive name —
            // the whole name for a one-word company ("vaiie"), or its leading
            // distinctive bigram for a multi-word one ("white paper"). Adjacency
            // is required, so a lone common word ("company", "jersey") can't
            // trigger it, while a single distinctive word still can.
            $companyKey = $this->nameKey(Testimonials::company($entry));
            $personKey = $this->nameKey((string) ($entry->personName ?? ''));
            $isSubject = ($companyKey !== '' && str_contains($answerNorm, ' ' . $companyKey . ' '))
                || ($personKey !== '' && str_contains($answerNorm, ' ' . $personKey . ' '));

            // Finer relevance: overlap of the quote's own context + text.
            $vocab = $this->terms(((string) ($entry->context ?? '')) . ' ' . strip_tags((string) ($entry->blockquote ?? '')));
            $topical = count(array_intersect($terms, $vocab));

            $isFeatured = $this->isFeatured($entry);
            $scored[] = [
                'entry' => $entry,
                'isSubject' => $isSubject,
                'isFeatured' => $isFeatured,
                'topical' => $topical,
                // A named client dominates; among the rest, a featured quote (Jon's
                // strongest) outranks any non-featured, with topical fit the tiebreak.
                'score' => ($isSubject ? 1000 : 0)
                    + ($isFeatured ? self::TESTIMONIAL_FEATURED_BOOST : 0)
                    + $topical,
                'i' => $i,
            ];
        }

        // Sort by score desc, keeping the CMS order on ties (stable).
        usort($scored, static fn($a, $b) => $b['score'] <=> $a['score'] ?: $a['i'] <=> $b['i']);

        if ($scored[0]['isSubject']) {
            // The answer is about specific client(s) — show only their quote(s);
            // that is the point being made. No unrelated fillers.
            $chosen = array_values(array_filter($scored, static fn($s) => $s['isSubject']));
        } else {
            // Generic beat (no named client) — Jon's featured quotes lead (they carry
            // the boost above, so they sort first), then any genuinely topical ones fill
            // the remaining slots; the single best as a last-resort default (the marker
            // means the model wants a quote here).
            $chosen = array_values(array_filter(
                $scored,
                static fn($s) => $s['isFeatured'] || $s['topical'] >= 2,
            ));
            if (!$chosen) {
                $chosen = [$scored[0]];
            }
        }
        $chosen = array_slice($chosen, 0, self::MAX_TESTIMONIALS);

        $out = [];
        foreach ($chosen as $s) {
            $map = $this->mapTestimonial($s['entry']);
            if ($map !== null) {
                $out[] = $map;
            }
        }

        return $out;
    }

    /**
     * The distinctive phrase to match a client's name on: the leading two
     * distinctive words of a multi-word name ("white paper"), or the single word
     * of a one-word name ("vaiie"). Articles/corporate suffixes and short tokens
     * are dropped, so a lone generic word can't stand in for the whole name.
     * Lowercased, single-spaced; '' when there's nothing distinctive.
     */
    private function nameKey(string $name): string
    {
        $generic = ['the', 'a', 'an', 'and', 'of', 'ltd', 'limited', 'inc', 'llc', 'co', 'com', 'plc', 'group', 'company', 'holdings'];
        $words = array_values(array_filter(
            preg_split('/\s+/', trim(preg_replace('/[^\p{L}\p{N}]+/u', ' ', mb_strtolower($name)) ?? '')) ?: [],
            static fn($w) => mb_strlen($w) >= 3 && !in_array($w, $generic, true),
        ));

        if (count($words) >= 2) {
            return $words[0] . ' ' . $words[1];
        }

        return $words[0] ?? '';
    }

    /** Normalise a testimonial entry to a rail-style map, or null if it has no quote. */
    private function mapTestimonial(Entry $entry): ?array
    {
        // The blockquote is a CKEditor (rich text) field — keep its HTML (<p>…),
        // rendered raw in the template. Guard on the text, not the markup.
        $quote = trim((string) ($entry->blockquote ?? ''));
        if (trim(strip_tags($quote)) === '') {
            return null;
        }

        return [
            'quote' => $quote,
            'name' => trim((string) ($entry->personName ?? '')),
            'role' => trim((string) ($entry->jobTitle ?? '')),
            // The linked case study's name where there is one, else the typed
            // `company` — the same read the templates make (Testimonials::company).
            'company' => Testimonials::company($entry),
            'image' => $this->firstAsset($entry, ['profileImage']),
        ];
    }

    /**
     * The clients Jon has worked with, for the [[clients]] logo marquee — each a
     * { name, logo } map. It's the whole roster (no relevance scoring — a marquee
     * shows everyone). Skips cleanly until the `clients` section exists; entries
     * without a logo, and entries with Hidden? switched on, are dropped.
     */
    public function clients(): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('clientList')) {
            return [];
        }

        $out = [];
        foreach (Entry::find()->status(Entry::STATUS_LIVE)->section('clientList')->all() as $entry) {
            // The client's own Hidden? switch, same gate the two static views apply —
            // a marquee is a marquee wherever it's rendered, and a client kept out of
            // one but drifting past in another is the worse kind of wrong.
            //
            // NOT fieldVal(): that ends `is_string($value) ? $value : null`, so a
            // Lightswitch always comes back null and the switch would read as off for
            // every client. It's for text fields only.
            if ($this->isHidden($entry)) {
                continue;
            }

            $logo = $this->firstAsset($entry, ['logo']);
            if ($logo instanceof Asset) {
                $out[] = [
                    'name' => trim((string) $entry->title),
                    'logo' => $logo,
                    'summary' => trim((string) ($entry->summary ?? '')),
                ];
            }
        }

        return $out;
    }

    /**
     * Clients/brands Jon has worked with and what he did for each — background
     * knowledge for the persona to speak concretely about relevant work (NOT the
     * logo marquee; see clients()). Every client is included; the `summary` (what
     * he did for them) is the useful detail. Reads only fields present; skips
     * until the section exists. Returns [{ name, summary }].
     */
    public function clientWork(): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('clientList')) {
            return [];
        }

        $out = [];
        foreach (Entry::find()->status(Entry::STATUS_LIVE)->section('clientList')->all() as $entry) {
            $name = trim((string) $entry->title);
            if ($name === '') {
                continue;
            }
            $out[] = [
                'name' => $name,
                'summary' => trim((string) ($this->fieldVal($entry, 'summary') ?? '')),
            ];
        }

        return $out;
    }

    /**
     * The case studies — for the [[casestudies]] discovery cards AND as background so
     * Jonson can speak to specific projects. Each study is self-contained: its Title
     * is the client it was for, plus the case-study title, a public `summary` blurb,
     * a private `jonsonSummary` (AI context only), and its sector/skill categories.
     * Independent of the Client List (not every client has a study). Skips until the
     * section exists; entries with no case-study title are dropped. Returns maps.
     */
    public function caseStudies(?string $context = null, bool $all = false, ?string $question = null): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('caseStudies')) {
            return [];
        }

        $out = [];
        foreach (Entry::find()->status(Entry::STATUS_LIVE)->section('caseStudies')->all() as $entry) {
            // The client is the `clientSelector` relation, NOT the Title. Those were the
            // same thing while a client had one study; the moment one has two, Title has
            // to name the study. CaseStudies is the only thing that knows how to follow
            // the relation, and the templates read it through craft.frontend, so a card
            // in an answer and the study's own page can't disagree. Short form here —
            // it's a card eyebrow, same as the static strip.
            $client = CaseStudies::clientName($entry);
            // `longTitle ?: title` — the same pattern every other section uses (the
            // contact single, the case study index). One display title, not two: the
            // card, the study's own page and the model's background list all name a
            // project the same way, so a visitor never meets it under two names.
            $project = trim((string) ($this->fieldVal($entry, 'longTitle') ?? ''));
            $title = $project !== '' ? $project : trim((string) $entry->title);
            if ($title === '') {
                continue; // truly empty entry — nothing to show
            }
            $out[] = [
                'client' => $client,
                'title' => $title,        // longTitle, else the study's own Title
                // The study's own short Title ("StreetPal iOS App Design & Development",
                // "Logo Design") — what the title MATCH tier reads word by word. The
                // display title above is a sentence ("Giving street photographers a
                // missing companion app"), and matching its words named StreetPal on
                // "street" and Vaiie on "into"; the short title has no such words.
                'name' => trim((string) $entry->title),
                'slug' => (string) $entry->slug, // the id a [[next:]] prompt cites (@study:slug)
                // `bio` on this entry type — the field other sections still call
                // `summary` (clientList, curriculumVitae), so don't unify the two by
                // hand. fieldVal returns null for a missing field rather than throwing,
                // which is why the rename emptied this silently instead of erroring.
                'summary' => trim((string) ($this->fieldVal($entry, 'bio') ?? '')),                   // public blurb
                'jonsonSummary' => trim((string) ($this->fieldVal($entry, 'jonsonSummary') ?? '')),    // private AI context
                'sectors' => $this->categoryTitles($entry, 'sectorSelector'),
                'skills' => $this->categoryTitles($entry, 'skills'),
                'featured' => $this->isFeatured($entry),
                'url' => (string) $entry->getUrl(),
                // The client's own logo first, then the study's. Used to be the other
                // way round, with the Client List matched BY NAME as the fallback —
                // which only worked because a study's Title was its client's name.
                // The relation says it outright, so the string match is gone.
                'logo' => CaseStudies::clientLogo($entry),
                // Card thumbnail. `largeImage` is the entry-level field the CP labels
                // "Thumbnail"; the same field also appears inside the caseContent
                // matrix, but this reads the one on the entry itself.
                'image' => $this->firstAsset($entry, ['largeImage']),
            ];
        }

        // No context — the prompt's background list + the availability check — gets the
        // FULL set, so the model always knows every study exists.
        if ($context === null || trim($context) === '') {
            return $out;
        }

        // The visitor asked outright to see everything ([[casestudies:all]]). `featured`
        // is quality control for generic answers — "why should I hire you" gets a
        // curated taste rather than the catalogue — but it was never meant to be a
        // permission list. An explicit ask for all the work gets all the work, with the
        // featured picks leading so the strongest still land first.
        if ($all) {
            usort($out, static fn(array $a, array $b) => ($b['featured'] <=> $a['featured']));
            return $out;
        }

        // A specific client ("do you know white paper") or sector ("worked in events")
        // was named → the studies that actually match it.
        //
        // A CLIENT match outranks a sector match. An answer about one client names
        // it once and then talks about the work — "a startup", "0 to 1" — and those
        // words match every other study in the same sector. Treated as one pool that
        // was a sweep of five, narrowed to the featured ones, and the study the answer
        // was actually about (not featured) fell out. So: studies matched by name
        // first; the sector pool only when no name was matched.
        // Four tiers, the first that matches wins: the study's own TITLE ("logos"
        // names the Logo Design study, and nothing else), then its client, then
        // its sector, then a skill it lists. Title above client because an answer
        // name-drops clients freely ("…as I did for Vaiie"), and a client match
        // alongside a title match used to outvote it: three matches read as a
        // sweep, the sweep narrowed to the featured, and the one study actually
        // asked for — not featured — fell out. Skills last and only as a
        // fallback: they are the trade's vocabulary and match broadly (five
        // studies list Logo Design).
        // The visitor's own words first. A study the QUESTION names — by title,
        // client, sector OR skill — is what they asked to see, and every study it
        // names is the selection: "show me your logos" is the five studies whose
        // skills list Logo Design, not a curated taste of them. The answer's
        // name-drops ("…as I did for Vaiie") get no vote here. Featured lead.
        if ($question !== null && trim($question) !== '') {
            $named = $this->studiesNamedIn($question);
            if ($named) {
                usort($named, static fn(array $a, array $b) => ($b['featured'] <=> $a['featured']));
                return $named;
            }
        }
        // Nothing named outright: the whole exchange decides, by tier, and a broad
        // match narrows to the featured.
        //
        // Title and client are ONE pool. Both are the answer naming a study
        // outright, and an answer that talks about two projects will often name
        // one by what it built ("the booking engine") and the other by who it
        // was for ("Urban.co.uk"). Title-first-wins dropped the second: White
        // Paper matched on its title, so the client tier — where Urban sat — was
        // never consulted, and a study the answer plainly named showed no card.
        //
        // The reason title used to outrank client still holds, and is handled
        // below: answers name-drop clients freely ("…as I did for Vaiie"), so a
        // title match plus a couple of name-drops can read as a sweep. When the
        // named pool is too big to be a targeted pick, the title matches alone
        // are the pick — before falling back to the featured among them.
        $tiers = [];
        foreach ($out as $s) {
            $tiers[(int) $this->studyMatchTier($context, $s)][] = $s;
        }
        $byTitle = $tiers[1] ?? [];
        $named = array_merge($byTitle, $tiers[2] ?? []);
        if ($named && count($named) > self::CASE_STUDY_TARGETED_MAX
            && $byTitle && count($byTitle) <= self::CASE_STUDY_TARGETED_MAX
        ) {
            return $byTitle;
        }
        $relevant = $named ?: ($tiers[3] ?? ($tiers[4] ?? []));
        if ($relevant) {
            // A targeted ask matches only a study or two — show exactly those. But a
            // broad answer ("why should I hire you") name-drops several clients/sectors
            // and matches most of the catalogue; that's a sweep, not a targeted match,
            // so narrow it to the featured picks among the matches rather than dumping
            // everything. (Fall through to the global featured curation if none of the
            // many matches are flagged featured.)
            if (count($relevant) <= self::CASE_STUDY_TARGETED_MAX) {
                return $relevant;
            }
            $featuredRelevant = array_values(array_filter($relevant, static fn(array $s) => $s['featured']));
            if ($featuredRelevant) {
                return $featuredRelevant;
            }
        }

        // A broad question ("why should I hire you") → only the FEATURED studies, so
        // it's a curated taste rather than a firehose. If nothing is flagged featured,
        // surface NOTHING for generic questions (empty payload skips the panel) — the
        // "where next?" suggestions become the entry point into the work instead. A
        // targeted ask still shows its specific match above, featured or not.
        return array_values(array_filter($out, static fn(array $s) => $s['featured']));
    }

    /** Whether the case study is flagged Featured (the `isFeatured` lightswitch). */
    /** Whether the entry is switched off from public display (the `isHidden` lightswitch). */
    private function isHidden(Entry $entry): bool
    {
        return $entry->getFieldLayout()?->getFieldByHandle('isHidden')
            ? (bool) $entry->isHidden
            : false;
    }

    private function isFeatured(Entry $entry): bool
    {
        return $entry->getFieldLayout()?->getFieldByHandle('isFeatured')
            ? (bool) $entry->isFeatured
            : false;
    }

    /**
     * Whether $context (the answer) names this study — by its client or one of its
     * sectors. Matches the whole label or any distinctive word of it (≥ 4 chars, minus
     * generic company suffixes), whole-word + case-insensitive. So "white paper" hits
     * "The White Paper Conference Company", and "events" hits an Events-tagged study.
     * Skills are deliberately NOT matched — too generic ("design" is in every answer).
     */
    /**
     * How the text names this study: 1 by its title, 2 by its client, 3 by a
     * sector, 4 by a skill, 0 not at all. See studyRelevantTo for what counts.
     */
    public function studyMatchTier(string $context, array $study): int
    {
        // Two ways to name a study by title. The display title (a sentence — "Giving
        // street photographers a missing companion app") counts only as a WHOLE
        // phrase: its individual words are ordinary English, and matching them put
        // StreetPal into a chat about street photography and Vaiie into anything
        // with "into" in it. The short CMS Title ("Vaiie Identify Product Design",
        // "Logo Design") is matched word by word, less the client's name — it's
        // named by "identify", not by "Vaiie", which is the client tier's job.
        $long = trim((string) ($study['title'] ?? ''));
        if ($long !== '' && $this->studyRelevantTo($context, $study, labels: [$long], wholeOnly: true)) {
            return 1;
        }
        $name = trim((string) ($study['name'] ?? ''));
        $client = trim((string) ($study['client'] ?? ''));
        if ($client !== '') {
            $name = trim((string) preg_replace('/(?<![a-z0-9])' . preg_quote(mb_strtolower($client), '/') . '(?![a-z0-9])/iu', ' ', $name));
        }
        if ($name !== '' && $name !== $long && $this->studyRelevantTo($context, $study, labels: [$name])) {
            return 1;
        }
        if ($this->studyRelevantTo($context, $study, labels: [(string) ($study['client'] ?? '')])) {
            return 2;
        }
        if ($this->studyRelevantTo($context, $study, labels: $study['sectors'] ?? [])) {
            return 3;
        }
        if ($this->studyRelevantTo($context, $study, labels: $study['skills'] ?? [])) {
            return 4;
        }
        return 0;
    }

    /** The studies a piece of text names — by title, client, sector or skill. */
    public function studiesNamedIn(string $text): array
    {
        return array_values(array_filter(
            $this->caseStudies(),
            fn(array $s) => $this->studyMatchTier($text, $s) > 0,
        ));
    }

    private function studyRelevantTo(string $context, array $study, bool $clientOnly = false, ?array $labels = null, bool $wholeOnly = false): bool
    {
        // Words that a label can carry but that say nothing on their own — company
        // suffixes, and the trade's own vocabulary, which is in every answer Jonson
        // gives. "0 to 1 Design" and "Side Project" (StreetPal's sectors) used to match
        // on "design" and "project", which put an iPhone app for street photographers
        // into a conversation about regtech. A sector still matches on its whole label
        // and on any distinctive word it has left ("regulatory", "events", "startup").
        static $generic = [
            'the', 'and', 'company', 'limited', 'ltd', 'inc', 'group', 'plc', 'llc',
            'design', 'designs', 'designer', 'designing', 'project', 'projects', 'side',
            'product', 'products', 'digital', 'development', 'developer', 'developing',
            'web', 'website', 'websites', 'online', 'service', 'services', 'work', 'works',
            'app', 'apps', 'application', 'applications', 'system', 'systems', 'platform',
        ];
        $haystack = ' ' . mb_strtolower($context) . ' ';
        if ($labels === null) {
            $labels = $clientOnly
                ? [(string) ($study['client'] ?? '')]
                : array_merge([(string) ($study['client'] ?? '')], $study['sectors'] ?? []);
        }

        foreach ($labels as $label) {
            $label = trim((string) $label);
            if ($label === '') {
                continue;
            }
            // The whole label, then its distinctive words — or the whole label alone.
            $terms = $wholeOnly ? [$label] : array_merge([$label], preg_split('/\s+/', $label) ?: []);
            foreach ($terms as $term) {
                $term = mb_strtolower(trim((string) $term));
                if (mb_strlen($term) < 4 || in_array($term, $generic, true)) {
                    continue;
                }
                // Whole word, with a plural tolerated: "logos" names the logo work.
                if (preg_match('/(?<![a-z0-9])' . preg_quote($term, '/') . '(?:e?s)?(?![a-z0-9])/u', $haystack)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Titles of the categories related to $entry through a category field, or [] if
     * the field is absent or empty.
     */
    private function categoryTitles(Entry $entry, string $handle): array
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle($handle)) {
            return [];
        }

        return array_values(array_filter(array_map(
            static fn($c) => trim((string) $c->title),
            $entry->$handle->all(),
        )));
    }

    /**
     * Whether the text names a known client (HSBC, Lloyds, …). Used to recognise
     * a work/projects answer even when the model placed no [[clients]] marker, so
     * the personal photo rail can be suppressed (personal photos are off-topic on
     * a work answer). Whole-word / phrase match against the client roster; names
     * shorter than 3 chars are skipped as too collision-prone.
     */
    public function mentionsClient(string $text): bool
    {
        if (trim($text) === '') {
            return false;
        }

        foreach ($this->clientWork() as $c) {
            $name = trim((string) $c['name']);
            if (mb_strlen($name) < 3) {
                continue;
            }
            $pattern = '/(?<![a-z0-9])' . preg_quote($name, '/') . '(?![a-z0-9])/iu';
            if (preg_match($pattern, $text)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The sectors Jon has experience in, for the [[sectors]] tag list — the
     * titles of every category in the `sectorExperience` group. Skips cleanly
     * until the group exists.
     */
    public function sectors(): array
    {
        if (!Craft::$app->getCategories()->getGroupByHandle('sectorExperience')) {
            return [];
        }

        $out = [];
        foreach (Category::find()->group('sectorExperience')->all() as $category) {
            // Prefer an optional public-facing `longTitle` (so the back-office
            // title can stay tidy, e.g. "Regulatory" → shown as "RegTech");
            // fall back to the title when it's not set.
            $label = '';
            if ($category->getFieldLayout()?->getFieldByHandle('longTitle')) {
                $label = trim((string) $category->longTitle);
            }
            if ($label === '') {
                $label = trim((string) $category->title);
            }
            if ($label !== '') {
                $out[] = $label;
            }
        }

        return $out;
    }

    /**
     * Jon's "how I can help" journey — the ordered project phases from the
     * `methodology` single's `howICanHelp` Matrix, for the [[method]] timeline.
     * Each "How" block gives a { title, summary, services }, services being the
     * names from its Table field. Order follows the CMS (Research & Planning →
     * Design → Development). Skips cleanly until the section/field exists.
     */
    public function methodology(): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('methodology')) {
            return [];
        }

        $entry = Entry::find()->status(Entry::STATUS_LIVE)->section('methodology')->one();
        if (!$entry || !$entry->getFieldLayout()?->getFieldByHandle('howICanHelp')) {
            return [];
        }

        $out = [];
        foreach ($entry->howICanHelp->all() as $block) {
            $title = trim((string) $block->title);
            if ($title === '') {
                continue;
            }

            // The Services table is one column, handle `name` — collect its rows.
            $services = [];
            if ($block->getFieldLayout()?->getFieldByHandle('services')) {
                foreach (($block->services ?? []) as $row) {
                    $name = trim((string) ($row['name'] ?? ''));
                    if ($name !== '') {
                        $services[] = $name;
                    }
                }
            }

            $out[] = [
                'title' => $title,
                'summary' => trim((string) ($block->summary ?? '')),
                'services' => $services,
            ];
        }

        return $out;
    }

    /**
     * Jon's career history from the `curriculumVitae` section — one item per role
     * (a company can hold several via its `role` Matrix), most recent first. Each:
     * { company, companySummary, title, summary, start, end, types }. Background
     * knowledge for the persona to reason about his experience — NOT a surfaced
     * component. Reads only fields present on the layout, so it degrades cleanly
     * as the CV is filled in. Skips until the section exists.
     */
    public function curriculumVitae(): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('curriculumVitae')) {
            return [];
        }

        $out = [];
        foreach (Entry::find()->status(Entry::STATUS_LIVE)->section('curriculumVitae')->all() as $job) {
            $company = trim((string) $job->title);
            if ($company === '') {
                continue;
            }
            $companySummary = trim((string) ($this->fieldVal($job, 'summary') ?? ''));

            $roles = $job->getFieldLayout()?->getFieldByHandle('role')
                ? $job->role->all()
                : [];

            if (!$roles) {
                // No role blocks yet — still surface the company as context.
                $out[] = [
                    'company' => $company,
                    'companySummary' => $companySummary,
                    'title' => '',
                    'summary' => '',
                    'start' => null,
                    'end' => null,
                    'types' => [],
                ];
                continue;
            }

            foreach ($roles as $role) {
                $types = [];
                if ($role->getFieldLayout()?->getFieldByHandle('employmentType')) {
                    foreach ($role->employmentType->all() as $cat) {
                        $types[] = trim((string) $cat->title);
                    }
                }
                $start = $role->getFieldLayout()?->getFieldByHandle('startDate') ? $role->startDate : null;
                $end = $role->getFieldLayout()?->getFieldByHandle('endDate') ? $role->endDate : null;

                $out[] = [
                    'company' => $company,
                    'companySummary' => $companySummary,
                    'title' => trim((string) $role->title),
                    'summary' => trim((string) ($this->fieldVal($role, 'summary') ?? '')),
                    'start' => $start?->format('Y'),
                    'end' => $end?->format('Y'),
                    'types' => array_values(array_filter($types)),
                ];
            }
        }

        return $out;
    }

    /**
     * The catalogue of "where next?" candidates — the single registry the slot
     * composer draws from. Every candidate is a real, guaranteed-showable path (a
     * content chip, or the always-available lead path), tagged with:
     *   - role:   the funnel slot it competes for — 'progress' (the path to
     *             working together), 'proof' (credibility / evaluation), or
     *             'discovery' ('who is this person' colour);
     *   - stages: the funnel stages it belongs in ('cold' | 'warm' | 'hot'), so a
     *             discovery chip simply isn't a candidate once a visitor is warm;
     *   - an availability guard, so a chip appears only when its content/action is
     *             real (scales as content is added; drops silently when it isn't);
     *   - topics, used to score relevance to the current answer.
     *
     * Returns candidates sorted by relevance (registry order breaks ties), each a
     * map { handle, role, stages, prompt, score }. Composing these into a final
     * slate — which roles to fill for the current stage — is the caller's job.
     *
     * $excludeHandles are handles already surfaced this conversation, dropped so a
     * chip never points at content already on screen.
     */
    public function suggestionCandidates(string $forText, array $excludeHandles = []): array
    {
        // Compute each content source once — some feed both a guard and topics.
        $inventory = $this->inventory();
        $sectors = $this->sectors();
        $hasMethod = (bool) $this->methodology();
        $hasClients = (bool) $this->clients();
        $hasCaseStudies = (bool) $this->caseStudies();
        $hasMusic = Jonson::getInstance()->spotify->isConfigured();

        $sectorLabels = array_map(static fn($s) => mb_strtolower((string) $s), $sectors);
        $photoLabels = array_map(static fn(array $i) => mb_strtolower((string) $i['label']), $inventory);

        // The registry. Add a content type by adding one entry here — role +
        // stages slot it into the funnel automatically; no composer change needed.
        // Registry order is the tie-break when two candidates score equally.
        $registry = [
            // The lead path — always real, so no availability guard. It's the
            // funnel's destination: a candidate from 'warm' on, and it leads 'hot'.
            [
                'handle' => 'contact',
                'role' => 'progress',
                'stages' => ['warm', 'hot'],
                'available' => true,
                'prompt' => 'How do we start working together?',
                'topics' => ['hire', 'work', 'together', 'start', 'project', 'help', 'available', 'availability', 'cost', 'quote', 'budget', 'contact', 'brief', 'redesign', 'build'],
            ],
            // Proof / evaluation — for a visitor weighing Jon up (cold, and warm).
            [
                'handle' => 'method',
                'role' => 'proof',
                'stages' => ['cold', 'warm', 'hot'],
                'available' => $hasMethod,
                'prompt' => 'What’s your process?',
                'topics' => ['process', 'approach', 'method', 'work', 'services', 'start', 'help'],
            ],
            [
                'handle' => 'clients',
                'role' => 'proof',
                'stages' => ['cold', 'warm', 'hot'],
                'available' => $hasClients,
                'prompt' => 'Who have you worked with?',
                'topics' => ['clients', 'companies', 'brands', 'background', 'worked', 'experience'],
            ],
            // The strongest evaluation proof — actual project write-ups the visitor
            // can open. A candidate whenever they're weighing Jon up or want to see
            // concrete work.
            [
                'handle' => 'casestudies',
                'role' => 'proof',
                'stages' => ['cold', 'warm', 'hot'],
                'available' => $hasCaseStudies,
                'prompt' => 'Can I see some of your work?',
                'topics' => ['work', 'portfolio', 'projects', 'project', 'case', 'study', 'studies', 'examples', 'example', 'results', 'hire', 'proof', 'showcase'],
            ],
            [
                'handle' => 'sectors',
                'role' => 'proof',
                'stages' => ['cold', 'warm', 'hot'],
                'available' => (bool) $sectors,
                'prompt' => 'What sectors have you worked in?',
                'topics' => array_merge(['sector', 'sectors', 'industry', 'industries', 'experience'], $sectorLabels),
            ],
            // Discovery — 'who is this person' colour, for a cold visitor orienting.
            // Not a candidate once warm/hot, so it drops out as the visitor warms.
            [
                'handle' => 'photo',
                'role' => 'discovery',
                'stages' => ['cold'],
                'available' => (bool) $inventory,
                'prompt' => 'Where have you travelled?',
                'topics' => array_merge(['travel', 'travelled', 'photography', 'photos', 'trips', 'places'], $photoLabels),
            ],
            [
                'handle' => 'music',
                'role' => 'discovery',
                'stages' => ['cold'],
                'available' => $hasMusic,
                'prompt' => 'What music do you listen to?',
                'topics' => ['music', 'listening', 'listen', 'artists', 'dj', 'records', 'vinyl', 'sound', 'spotify', 'band', 'bands', 'song', 'songs'],
            ],
        ];

        $terms = $this->terms($forText);
        $out = [];
        foreach ($registry as $i => $c) {
            if (!$c['available'] || in_array($c['handle'], $excludeHandles, true)) {
                continue;
            }
            $topicTerms = [];
            foreach ($c['topics'] as $topic) {
                $topicTerms = array_merge($topicTerms, $this->terms((string) $topic));
            }
            $score = $terms ? count(array_intersect($terms, array_unique($topicTerms))) : 0;
            $out[] = [
                'handle' => $c['handle'],
                'role' => $c['role'],
                'stages' => $c['stages'],
                'prompt' => $c['prompt'],
                'topics' => $c['topics'],
                'score' => $score,
                'i' => $i,
            ];
        }

        // Relevance first; registry order breaks ties.
        usort($out, static fn($a, $b) => $b['score'] <=> $a['score'] ?: $a['i'] <=> $b['i']);

        return $out;
    }

    /**
     * Stable keys for a set of rail items — so the caller can record which photos
     * it showed and pass them back as $excludeKeys next turn (see forHandles).
     * Nulls (unkeyable items) are dropped.
     */
    public function itemKeys(array $items): array
    {
        return array_values(array_filter(
            array_map(fn(array $it) => $this->itemKey($it), $items),
            fn($k) => $k !== null,
        ));
    }

    private function itemKey(array $item): ?string
    {
        if (($item['image'] ?? null) instanceof Asset) {
            return 'a' . $item['image']->id;
        }

        return isset($item['url']) ? 'u' . $item['url'] : null;
    }

    /**
     * Photos: match the query's terms against each memory asset's tags.
     */
    private function byTags(array $source, string $query): array
    {
        $entry = Entry::find()->status(Entry::STATUS_LIVE)->section($source['single'])->one();
        $field = $source['field'];
        $assets = $entry?->$field?->all() ?? [];
        if (!$assets) {
            return [];
        }

        $terms = $this->terms($query);
        $items = [];
        foreach ($assets as $asset) {
            // Match the query against the photo's themes (tags) + places
            // (location categories, expanded up the tree).
            $vocab = array_merge($this->assetTags($asset), $this->assetLocations($asset));
            if ($this->overlaps($terms, $vocab)) {
                $items[] = ['kind' => 'photo', 'image' => $asset];
            }
        }

        return $items;
    }

    /**
     * True if any query term matches any vocab term. A match is exact, or one
     * term is a prefix of the other with the shorter ≥ 4 chars — so the "photo"
     * tag matches "photography"/"photographer", and "jersey" matches "jerseys",
     * while the length floor keeps place names (all ≥ 5 chars here) specific.
     */
    private function overlaps(array $terms, array $vocab): bool
    {
        foreach ($terms as $t) {
            if ($t === '') {
                continue;
            }
            foreach ($vocab as $v) {
                if ($v === '') {
                    continue;
                }
                if ($t === $v) {
                    return true;
                }
                [$short, $long] = strlen($t) <= strlen($v) ? [$t, $v] : [$v, $t];
                if (strlen($short) >= 4 && str_starts_with($long, $short)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Text content: Craft's search index across the entry's own fields.
     */
    private function bySearch(string $kind, array $source, string $query): array
    {
        // Skip cleanly until the section exists.
        if (!Craft::$app->getEntries()->getSectionByHandle($source['section'])) {
            return [];
        }

        $entries = Entry::find()->status(Entry::STATUS_LIVE)
            ->section($source['section'])
            ->search($query)
            ->limit(self::MAX_ITEMS)
            ->all();

        return array_map(fn(Entry $e) => $this->mapEntry($kind, $e), $entries);
    }

    /**
     * Normalise an entry to a rail item. Reads only fields present on the
     * entry's layout, so different sections can share this mapper.
     */
    private function mapEntry(string $kind, Entry $entry): array
    {
        return [
            'kind' => $kind,
            'title' => $entry->title,
            'url' => $entry->getUrl(),
            'summary' => $this->fieldVal($entry, 'summary'),
            'quote' => $this->fieldVal($entry, 'quote'),
            'cite' => $this->fieldVal($entry, 'cite'),
            'image' => $this->firstAsset($entry, ['image', 'featuredImage']),
        ];
    }

    private function fieldVal(Entry $entry, string $handle): ?string
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle($handle)) {
            return null;
        }
        $value = $entry->$handle;

        return is_string($value) ? $value : null;
    }

    private function firstAsset(Entry $entry, array $handles): ?Asset
    {
        foreach ($handles as $handle) {
            if ($entry->getFieldLayout()?->getFieldByHandle($handle)) {
                $asset = $entry->$handle?->one();
                if ($asset instanceof Asset) {
                    return $asset;
                }
            }
        }

        return null;
    }

    private function assetTags(Asset $asset): array
    {
        if (!$asset->getFieldLayout()?->getFieldByHandle('tags')) {
            return [];
        }

        // Split each tag into words so a multi-word tag ("street photo") matches
        // a single query term ("street" / "photo"), plus keep the whole slug.
        $out = [];
        foreach ($asset->tags->all() as $tag) {
            $title = (string) $tag->title;
            $out[] = $this->slug($title);
            $out = array_merge($out, $this->terms($title));
        }

        return array_values(array_unique(array_filter($out)));
    }

    /**
     * A photo's place vocabulary: each selected location category plus its
     * ancestors, so a photo tagged "Bordeaux" also answers to "france"
     * (France › Bordeaux).
     */
    private function assetLocations(Asset $asset): array
    {
        if (!$asset->getFieldLayout()?->getFieldByHandle('location')) {
            return [];
        }

        $out = [];
        foreach ($asset->location->all() as $category) {
            foreach (array_merge([$category], $category->getAncestors()->all()) as $node) {
                $title = (string) $node->title;
                $out[] = $this->slug($title);
                $out = array_merge($out, $this->terms($title));
            }
        }

        return array_values(array_unique(array_filter($out)));
    }

    /** Split a free-text query into normalised terms. */
    private function terms(string $query): array
    {
        $parts = preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower($query), -1, PREG_SPLIT_NO_EMPTY) ?: [];

        return array_values(array_unique(array_map([$this, 'slug'], $parts)));
    }

    private function slug(string $value): string
    {
        return trim(preg_replace('/[^a-z0-9]+/', '-', mb_strtolower($value)) ?? '', '-');
    }
}
