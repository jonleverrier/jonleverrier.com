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
 * Content behind the surfaces Jonson can place around an answer (see
 * AskController::surfaceRegistry). The photo rail resolves the [[handle]]
 * markers the model placed via forHandles(); the panels read their data through
 * the other public methods. find() takes a free-text query and an optional
 * `kind` and returns a flat list of normalised items — the rail only ever asks
 * it for photos.
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
    private const LEAD_PER_TURN = 3; // a lead set (a VIP's relevant work) shows at most this many a turn — large cards, never the rail

    // READ ONCE PER REQUEST (Jon, 3 Oct 2026: answers felt slower). The case studies are
    // ~40 queries — each study follows its client, logo, image, sectors and skills — and
    // one question read them five or more times: the prompt, the cards, the links, the
    // claim check. Kept here for the request, and dropped whenever an entry or category
    // is saved (Jonson::init), so a long-lived queue worker never answers from old content.
    private array $memo = [];

    private function memo(string $key, callable $load): array
    {
        return $this->memo[$key] ??= $load();
    }

    /** Forget everything read so far — called when content changes. */
    public function forget(): void
    {
        $this->memo = [];
    }

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
     * its marker). Capped at MAX_TESTIMONIALS.
     *
     * $leadSlugs — a VIP's relevant studies, most relevant first (Vip::relevantStudies).
     * A quote linked to one of them (its `caseStudyLink`) leads, in that order: asked
     * "what makes you different?", Allan got Vaiie's quote before Urban's CEO on CMS
     * order alone. On a generic beat those quotes REPLACE the featured ones — a White
     * Paper quote says nothing to a proptech founder. Never overrides a named client:
     * the answer's subject still decides WHICH quotes, this only decides their order.
     * Returns a list of
     * { quote, name, role, company, image } (empty if none).
     */
    public function testimonials(string $forText = '', string $recentText = '', array $leadSlugs = []): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('testimonials')) {
            return [];
        }

        $entries = Entry::find()->status(Entry::STATUS_LIVE)->section('testimonials')->all();
        if (!$entries) {
            return [];
        }

        $terms = $this->terms($forText);
        // Normalised, space-padded text for phrase matching (word boundaries).
        $norm = static fn(string $t) => ' ' . trim(preg_replace('/\s+/', ' ',
            preg_replace('/[^\p{L}\p{N}]+/u', ' ', mb_strtolower($t)) ?? '')) . ' ';
        $answerNorm = $norm($forText);
        // DECISION (2026-09-08): the subject is read from THIS turn first, and when
        // this turn names nobody, from the recent conversation. A visitor who asks
        // "what did you do for White Paper?" and then "what results did it deliver?"
        // is still talking about White Paper, and the follow-up used to fall to the
        // generic three featured quotes because its own text never said the name.
        // Chosen over the model naming the subject in the marker (`[[testimonial:
        // key]]`): that needs a key per client taught to the model and reproduced
        // exactly across turns, and the suite showed the model reliable on WHETHER a
        // surface belongs and weaker on exact tokens. Reading the history the model
        // itself reads is code VERIFYING, not guessing — see tools/jonson/README.md.
        // The current turn wins outright when it names anyone; the window is short
        // (the caller decides how many turns) so a client from six questions ago
        // can't hijack a quote about someone else.
        $recentNorm = $recentText !== '' ? $norm($recentText) : '';

        $scored = [];
        foreach ($entries as $i => $entry) {
            // A subject match is a PHRASE hit on the client's distinctive name —
            // the whole name for a one-word company ("vaiie"), or its leading
            // distinctive bigram for a multi-word one ("white paper"). Adjacency
            // is required, so a lone common word ("company", "jersey") can't
            // trigger it, while a single distinctive word still can.
            $companyKey = $this->nameKey(Testimonials::company($entry));
            $personKey = $this->nameKey((string) ($entry->personName ?? ''));
            $names = static fn(string $in) => ($companyKey !== '' && str_contains($in, ' ' . $companyKey . ' '))
                || ($personKey !== '' && str_contains($in, ' ' . $personKey . ' '));
            $isSubject = $names($answerNorm);
            $isRecentSubject = !$isSubject && $recentNorm !== '' && $names($recentNorm);

            // Finer relevance: overlap of the quote's own context + text.
            $vocab = $this->terms(((string) ($entry->context ?? '')) . ' ' . strip_tags((string) ($entry->blockquote ?? '')));
            $topical = count(array_intersect($terms, $vocab));

            $isFeatured = $this->isFeatured($entry);
            $studySlug = (string) ($entry->caseStudyLink?->one()?->slug ?? '');
            $leadRank = $studySlug !== '' ? array_search($studySlug, $leadSlugs, true) : false;
            $scored[] = [
                'lead' => $leadRank === false ? null : (int) $leadRank,
                'entry' => $entry,
                'isSubject' => $isSubject,
                'isRecentSubject' => $isRecentSubject,
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
        } elseif ($recent = array_values(array_filter($scored, static fn($s) => $s['isRecentSubject']))) {
            // This turn named nobody, but the conversation just did (see the
            // DECISION note above) — the follow-up is still about them.
            $chosen = $recent;
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
        if ($leadSlugs) {
            // A generic beat with quotes from their own relevant work: those, not the featured.
            if (!$scored[0]['isSubject'] && !array_filter($scored, static fn($s) => $s['isRecentSubject'])) {
                $theirs = array_values(array_filter($scored, static fn($s) => $s['lead'] !== null));
                if ($theirs) {
                    $chosen = $theirs;
                }
            }
            // Their work first, most relevant first; everything else keeps its order.
            usort($chosen, static fn($a, $b) => ($a['lead'] ?? PHP_INT_MAX) <=> ($b['lead'] ?? PHP_INT_MAX) ?: $a['i'] <=> $b['i']);
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
     * Link the first mention of each case study in an answer to its page — the model
     * was told it CAN link and did so about one time in five (Jon, 2026-09-30).
     *
     * What counts as a mention: the study's client + its first distinctive title word
     * ("Vaiie Identify"), its full short title, or — only when the client has ONE study
     * — the client's name alone ("Urban.co.uk", "White Paper"). "Vaiie" alone names
     * three studies and links none. A study with no client (Logo Design) is a
     * collection, not a project, and isn't linked.
     *
     * Skipped: $skipSlugs (the studies whose cards show right under this answer — the
     * card is the link), anything already linked, and text inside a link or a marker.
     * First mention only; the rest stay plain.
     */
    public function linkStudies(string $answer, array $skipSlugs = []): string
    {
        $studies = $this->caseStudies();
        $perClient = array_count_values(array_filter(array_map(static fn(array $s) => mb_strtolower($s['client']), $studies)));
        $phrases = []; // phrase => path, longest first so "Vaiie Identify" beats "Vaiie"
        foreach ($studies as $st) {
            $path = (string) (parse_url($st['url'], PHP_URL_PATH) ?: '');
            $client = trim($st['client']);
            if ($path === '' || $client === '' || in_array($st['slug'], $skipSlugs, true) || str_contains($answer, '](' . $path . ')')) {
                continue;
            }
            $phrases[$st['name']] = $path;
            $rest = trim((string) preg_replace('/^' . preg_quote($client, '/') . '\s*/iu', '', $st['name']));
            $first = preg_split('/\s+/', $rest)[0] ?? '';
            if ($first !== '' && mb_strlen($first) >= 4 && !in_array(mb_strtolower($first), ['product', 'design', 'booking', 'ios', 'app'], true)) {
                $phrases["{$client} {$first}"] = $path;
            }
            if (($perClient[mb_strtolower($client)] ?? 0) === 1) {
                $phrases[$client] = $path;
            }
        }
        if (!$phrases) {
            return $answer;
        }
        uksort($phrases, static fn($a, $b) => mb_strlen($b) <=> mb_strlen($a));

        // Plain text only: existing links and [[markers]] are split out and kept whole.
        $parts = preg_split('/(\[\[[^\]]*\]\]|\[[^\]\n]+\]\([^)\s]*\))/u', $answer, -1, PREG_SPLIT_DELIM_CAPTURE) ?: [$answer];
        $done = [];
        foreach ($parts as $i => $part) {
            if ($i % 2 === 1) {
                continue; // a link or a marker
            }
            foreach ($phrases as $phrase => $path) {
                if (isset($done[$path])) {
                    continue;
                }
                // Case-SENSITIVE: these are proper nouns, and "a white paper on KYC" is
                // not White Paper the client.
                $re = '/(?<![\p{L}\p{N}.\/])(' . preg_quote($phrase, '/') . ')(?![\p{L}\p{N}]|\.[\p{L}])/u';
                if (preg_match($re, $part)) {
                    $part = preg_replace($re, '[$1](' . $path . ')', $part, 1);
                    $done[$path] = true;
                    // Shorter phrases for the same study must not relink inside this one.
                    foreach ($phrases as $p2 => $path2) {
                        if ($path2 === $path) {
                            unset($phrases[$p2]);
                        }
                    }
                }
            }
            $parts[$i] = $part;
        }

        return implode('', $parts);
    }

    /**
     * Whether $text names someone with a quote — the person or their company, on the
     * same distinctive-phrase match testimonials() uses to find its subject. What lets
     * a [[testimonial]] marker stacked under a paragraph about Oliver count as framed.
     */
    public function testimonialNamedIn(string $text): bool
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('testimonials')) {
            return false;
        }
        $norm = ' ' . trim(preg_replace('/\s+/', ' ', preg_replace('/[^\p{L}\p{N}]+/u', ' ', mb_strtolower($text)) ?? '')) . ' ';
        foreach (Entry::find()->status(Entry::STATUS_LIVE)->section('testimonials')->all() as $entry) {
            foreach ([Testimonials::company($entry), (string) ($entry->personName ?? '')] as $name) {
                $key = $this->nameKey((string) $name);
                if ($key !== '' && str_contains($norm, ' ' . $key . ' ')) {
                    return true;
                }
            }
        }

        return false;
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
        return $this->memo('clientWork', fn() => $this->loadClientWork());
    }

    private function loadClientWork(): array
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
     *
     * $lead — studies that go FIRST whatever the answer picked: a VIP's own work (see
     * studiesForNote). Their note is the best evidence of what fits them, better than
     * any count over the answer's wording, and the answer's pick follows as the rest.
     * Ignored when the question itself names work — "worked for Vaiie?" is asking
     * about Vaiie, and a card from the note would answer a question they didn't ask.
     */
    public function caseStudies(?string $context = null, bool $all = false, ?string $question = null, array $lead = []): array
    {
        // ASKED ABOUT A CLIENT WITH NO STUDY, nothing on file can honestly sit under
        // the answer. "Have you worked at HSBC?" → the answer said "e-commerce team",
        // "E-commerce" is a sector tag on three studies, the sweep rule fell to the
        // featured one, and a White Paper card appeared under a paragraph about HSBC
        // (2026-10-01). A question naming work we DO have still shows it.
        if ($context !== null && trim($context) !== '' && $question !== null
            && $this->asksAboutClientWithoutStudy($question)
        ) {
            return [];
        }
        $picked = $this->pickStudies($context, $all, $question);
        if (!$lead || $context === null || trim($context) === '') {
            return $picked;
        }
        if ($question !== null && trim($question) !== '' && $this->studiesNamedIn($question)) {
            return $picked;
        }
        $slugs = array_column($lead, 'slug');

        // Their work, then any other study the answer NAMED (by title or client) — both
        // are relevance. Not the answer's sector/skill brushes or the featured fallback.
        //
        // AT MOST THREE A TURN, so they stand as large cards: the rail hides relevant work
        // in a drift, and four stacked large cards is too much (Jon, 2026-09-30). Nothing
        // is lost — the caller filters out what's been shown, so the next turn that shows
        // work leads with whatever relevant study didn't fit this time.
        $namedByAnswer = array_filter(
            $picked,
            fn(array $s) => !in_array($s['slug'], $slugs, true) && in_array($this->studyMatchTier($context, $s), [1, 2], true),
        );

        return array_slice(array_merge($lead, array_values($namedByAnswer)), 0, self::LEAD_PER_TURN);
    }

    /**
     * $picked less every study already on screen this conversation. $shown is the
     * lower-cased client names and titles recorded as cards went up (AskController::
     * rememberShownStudies); a study counts as shown when both of its are there — a
     * client's name alone doesn't hide its other studies.
     */
    public function withoutShown(array $picked, array $shown): array
    {
        if (!$shown) {
            return $picked;
        }

        return array_values(array_filter($picked, static function (array $study) use ($shown): bool {
            foreach ([$study['client'] ?? '', $study['title'] ?? ''] as $name) {
                $name = mb_strtolower(trim((string) $name));
                if ($name !== '' && !in_array($name, $shown, true)) {
                    return true;
                }
            }

            return false;
        }));
    }

    /**
     * Does the question name a client from the client list who has no case study, and
     * no work we do have? Matched on the client's name less company suffixes ("HSBC
     * International" → "HSBC", "Lloyds Bank International" → "Lloyds"), case-SENSITIVE
     * and whole-word, so it takes the proper noun and not the ordinary word. A client
     * whose short name is also an everyday word ("Sure" Telecom) is matched only in
     * full.
     */
    public function asksAboutClientWithoutStudy(string $question): bool
    {
        if ($this->studiesNamedIn($question)) {
            return false;
        }
        $withStudy = array_map(static fn(array $s) => mb_strtolower(trim($s['client'])), $this->caseStudies());
        static $suffixes = ['international', 'bank', 'telecom', 'chartered', 'accountants', 'limited', 'ltd', 'plc', 'group', 'company'];
        static $everyday = ['sure', 'feel', 'post'];
        foreach ($this->clients() as $client) {
            $full = trim($client['name']);
            if ($full === '' || in_array(mb_strtolower($full), $withStudy, true)) {
                continue;
            }
            $names = [$full];
            $short = trim(implode(' ', array_filter(
                preg_split('/\s+/', $full) ?: [],
                static fn(string $w) => !in_array(mb_strtolower($w), $suffixes, true),
            )));
            if ($short !== '' && $short !== $full && mb_strlen($short) >= 3 && !in_array(mb_strtolower($short), $everyday, true)) {
                $names[] = $short;
            }
            foreach ($names as $name) {
                if (preg_match('/(?<![\p{L}\p{N}])' . preg_quote($name, '/') . '(?![\p{L}\p{N}])/u', $question)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * The studies a VIP note names by title or client — "I designed Urban.co.uk back
     * in 2016" is Urban's work. A sector or skill mention doesn't count: a note says
     * "startup" or "logo" about the person, not about which of Jon's projects fits.
     */
    public function studiesForNote(string $note): array
    {
        if (trim($note) === '') {
            return [];
        }

        return array_values(array_filter(
            $this->caseStudies(),
            fn(array $s) => in_array($this->studyMatchTier($note, $s), [1, 2], true),
        ));
    }

    private function pickStudies(?string $context, bool $all, ?string $question): array
    {
        if (!Craft::$app->getEntries()->getSectionByHandle('caseStudies')) {
            return [];
        }

        $out = $this->studyRows();

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

        // THE CARDS FOLLOW WHAT JONSON ACTUALLY SAID.
        //
        // The answer is consulted FIRST, and the question only when the answer named
        // nothing. It used to be the other way round, and the rail could contradict the
        // prose directly above it: asked "what have you been working on since Vaiie?",
        // Jonson talked about White Paper and StreetPal and the rail showed three Vaiie
        // studies. The question had named Vaiie — as the thing being moved PAST — and
        // question-wins returned it before the answer was ever read.
        //
        // That is the general case, not a quirk of the word "since". A question sets up
        // an answer and is often not a description of it: "who else have you worked
        // with?", "anything outside fintech?", "what came after that?" all name the
        // thing they are moving away from. What Jonson then chose to talk about is the
        // best statement of what the cards should be, because the cards sit underneath
        // it and are read as its illustration.
        //
        // The question still decides when the answer names nothing — a bare "show me
        // your logos" answered with "here they are" has only the question to go on, and
        // the five studies whose skills list Logo Design are what was asked for.
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

        // ONE CLIENT'S WORK IS NEVER A SWEEP.
        //
        // The narrowing below exists to catch a broad answer that name-drops half the
        // catalogue. Three studies that all belong to the same client are the opposite
        // of that: "have you worked for Vaiie?" has exactly three right answers, and
        // showing two of them because three crossed a threshold reads as though the
        // third does not exist.
        //
        // Checked before the count, so the threshold never applies to a single-client
        // set however large it grows. Featured lead, so the strongest is still first.
        // …UNLESS THE VISITOR NAMED ONE STUDY BY TITLE. "Did you design Vaiie Identify?"
        // is about one project that happens to have two siblings, and answering it with
        // the client's whole shelf is the specificity bug this file already fixed once.
        // The answer still chooses WHICH studies; the question decides how fine-grained
        // the pick should be.
        $askedByTitle = ($question !== null && trim($question) !== '')
            ? array_filter($named, fn(array $st) => $this->studyMatchTier($question, $st) === 1)
            : [];
        // THE VISITOR NAMED ONE STUDY BY TITLE, and the answer talked about it: that
        // study is the selection, whatever else the answer's wording brushed against.
        // "Did you design Vaiie Identify?" means the one project, not its two siblings
        // and not whatever a stray phrase collided with. The answer still has to have
        // named it — $askedByTitle is filtered from the answer's own matches — so this
        // cannot resurrect work Jonson never mentioned.
        if ($askedByTitle) {
            $askedByTitle = array_values($askedByTitle);
            usort($askedByTitle, static fn(array $a, array $b) => ($b['featured'] <=> $a['featured']));

            return $askedByTitle;
        }

        // EVERY STUDY THE ANSWER NAMES SHOWS — by title, client or sector; by skill only
        // when it named nothing more specific. Nothing it talks about is held back.
        //
        // This used to keep the strongest tier alone and cut a long list to the featured
        // studies. An answer describing a spread names its pieces at different strengths
        // — "a conference booking engine" hits White Paper's title, "a regulatory
        // onboarding platform" only a sector — so "here's a mix: a regulatory onboarding
        // platform, an identity verification product, an estate agency rebrand and a
        // conference booking engine" showed ONE card. The cards are the point of the
        // answer: chat → the work. More than three already becomes the strip (see the
        // registry's `present`), so there is nothing to cut for space either.
        //
        // A SECTOR ADDS ITS WORK ONLY WHEN IT BELONGS TO ONE CLIENT. "Regulatory" is all
        // Vaiie, so a "regulatory onboarding platform" names Vaiie's work. "Startup" and
        // "E-commerce" span half the catalogue: "Vaiie, a regulatory tech startup" put
        // Urban and the logo collection under an answer about nothing but Vaiie. A shared
        // sector still counts when the answer named nothing sharper — the fallback below.
        $owners = [];
        foreach ($out as $s) {
            foreach ($s['sectorTerms'] ?? [] as $term) {
                $owners[mb_strtolower($term)][mb_strtolower((string) ($s['client'] ?: $s['name']))] = true;
            }
        }
        $bySector = array_values(array_filter($tiers[3] ?? [], function (array $s) use ($owners, $context): bool {
            $own = array_values(array_filter(
                $s['sectorTerms'] ?? [],
                static fn(string $term) => count($owners[mb_strtolower($term)] ?? []) === 1,
            ));

            return $own && $this->studyRelevantTo($context, $s, labels: $own);
        }));
        $relevant = $named
            ? array_merge($named, $bySector)
            : (($tiers[3] ?? []) ?: ($tiers[4] ?? []));
        if ($relevant) {
            usort($relevant, static fn(array $a, array $b) => ($b['featured'] <=> $a['featured']));

            return $relevant;
        }

        // THE ANSWER NAMED NOTHING — now the question gets its say.
        //
        // "Show me your logos" answered with "here they are, have a look" leaves the
        // cards nothing to read off the prose, and the visitor's own words are then the
        // only statement of what they wanted: every study whose skills list Logo Design,
        // not a curated taste of them.
        //
        // Reached only when the answer was silent about specific work, which is why it
        // can no longer overrule a reply that named studies outright.
        if ($question !== null && trim($question) !== '') {
            $asked = $this->studiesNamedIn($question);
            if ($asked) {
                // The most specific name wins. "Did you design Vaiie Identify?" names
                // one study by TITLE and three by client, and the visitor meant the
                // one: the title is the sharper claim, and the client name inside it
                // is just how that study is called.
                $byTitle = array_values(array_filter($asked, fn(array $s) => $this->studyMatchTier($question, $s) === 1));
                if ($byTitle) {
                    $asked = $byTitle;
                }
                usort($asked, static fn(array $a, array $b) => ($b['featured'] <=> $a['featured']));
                return $asked;
            }
        }

        // A broad question ("why should I hire you") → only the FEATURED studies, so
        // it's a curated taste rather than a firehose. If nothing is flagged featured,
        // surface NOTHING for generic questions (empty payload skips the panel) — the
        // "where next?" suggestions become the entry point into the work instead. A
        // targeted ask still shows its specific match above, featured or not.
        return array_values(array_filter($out, static fn(array $s) => $s['featured']));
    }

    /** Every live case study as the picker reads it — once per request (see memo). */
    private function studyRows(): array
    {
        return $this->memo('studyRows', function (): array {
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
                    // Long titles ("RegTech", not "Regulatory") — what Jonson READS, so the
                    // short back-office name can't be paraphrased into something untrue
                    // ("regulators").
                    'sectors' => $this->categoryTitles($entry, 'sectorSelector', true),
                    // MATCHING keeps the plain titles, exactly as before. Matching on the long
                    // titles too made "regtech" in an answer a sector-label hit for Vaiie — a
                    // higher tier than the looser matches that found White Paper ("conference
                    // platform"), StreetPal and Urban — so "here's a spread: regtech products,
                    // an estate agency rebrand, a conference platform…" showed two Vaiie cards
                    // and nothing else.
                    'sectorTerms' => $this->categoryTitles($entry, 'sectorSelector'),
                    'skills' => $this->categoryTitles($entry, 'skills'),
                    'featured' => $this->isFeatured($entry),
                    // The "Is present?" switch — this work is still going. The Year row
                    // on the study reads it as "2015 – present"; the persona needs it so
                    // it can tell a finished project from a live relationship instead of
                    // putting everything in the past tense.
                    'ongoing' => $this->isOngoing($entry),
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

            return $out;
        });
    }

    /** Whether the case study is flagged Featured (the `isFeatured` lightswitch). */
    /** Whether the entry is switched off from public display (the `isHidden` lightswitch). */
    private function isHidden(Entry $entry): bool
    {
        return $entry->getFieldLayout()?->getFieldByHandle('isHidden')
            ? (bool) $entry->isHidden
            : false;
    }

    /** The study's "Is present?" switch: the work is still running. */
    private function isOngoing(Entry $entry): bool
    {
        return $entry->getFieldLayout()?->getFieldByHandle('isPresent')
            ? (bool) $entry->isPresent
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
        // A study with NO client is a collection of a kind of work ("Logo Design"), and
        // is named by that kind of work in general — its whole title, or its word in the
        // plural ("my logos"). Not by the singular in passing: "a logo device that
        // stands without the wordmark" in an answer about Urban is Urban's logo, and it
        // put the Logo Design card beside Urban's.
        if ($name !== '' && $name !== $long && $client === '' && !$this->namesCollection($context, $name)) {
            $name = '';
        }
        if ($name !== '' && $name !== $long && $this->studyRelevantTo($context, $study, labels: [$name])) {
            return 1;
        }
        if ($this->studyRelevantTo($context, $study, labels: [(string) ($study['client'] ?? '')])) {
            return 2;
        }
        if ($this->studyRelevantTo($context, $study, labels: $study['sectorTerms'] ?? $study['sectors'] ?? [])) {
            return 3;
        }
        if ($this->studyRelevantTo($context, $study, labels: $study['skills'] ?? [])) {
            return 4;
        }
        return 0;
    }

    /** Whether $context names a client-less study by its whole title or a plural of one of its words. */
    private function namesCollection(string $context, string $name): bool
    {
        $haystack = ' ' . mb_strtolower($context) . ' ';
        if (str_contains($haystack, mb_strtolower($name))) {
            return true;
        }
        foreach (preg_split('/\s+/', mb_strtolower($name)) ?: [] as $word) {
            if (mb_strlen($word) >= 4 && preg_match('/(?<![a-z0-9])' . preg_quote($word, '/') . 'e?s(?![a-z0-9])/u', $haystack)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The studies a [[casestudies:id,id]] marker names, in the order it names them —
     * unknown ids dropped, duplicates once. Null when the modifier isn't a list of ids
     * (none, `all`, or nothing that matches a live study).
     */
    public function studiesBySlugs(?string $modifier): ?array
    {
        if ($modifier === null || trim($modifier) === '' || strtolower(trim($modifier)) === 'all') {
            return null;
        }
        $bySlug = [];
        foreach ($this->caseStudies() as $s) {
            $bySlug[strtolower($s['slug'])] = $s;
        }
        $out = [];
        foreach (preg_split('/[\s,]+/', strtolower($modifier)) ?: [] as $slug) {
            if ($slug !== '' && isset($bySlug[$slug]) && !isset($out[$slug])) {
                $out[$slug] = $bySlug[$slug];
            }
        }

        return $out ? array_values($out) : null;
    }

    /**
     * The studies the model listed, plus any the ANSWER names outright that it left off —
     * work mentioned in passing ("the iris device for Vaiie, the mark for Urban") under a
     * marker that listed only the logo collection. Only names count, never paraphrase:
     * a study's own title, or its client's name when that client has a single study.
     * "Vaiie" alone can't say which of three studies it means, so it adds nothing.
     */
    /**
     * Whether a text names a study by its title — by the title's DISTINCTIVE words, all of
     * them, whole-word ("Identify", "booking engine"), less the client's name and the
     * generic words every study shares. studyMatchTier()'s word-by-word title match
     * counted "product" and "design", so "logos I designed" named Vaiie Identify.
     */
    private function namesStudyByTitle(string $text, array $s): bool
    {
        $name = mb_strtolower(trim((string) ($s['name'] ?? '')));
        $client = mb_strtolower(trim((string) preg_replace('/\s*\(.*\)\s*$/', '', (string) ($s['client'] ?? ''))));
        if ($client !== '') {
            $name = str_replace($client, ' ', $name);
        }
        $generic = ['product', 'products', 'design', 'designs', 'development', 'branding', 'brand', 'app', 'ios', 'website', 'web', 'and', 'the', 'collection'];
        $words = array_values(array_filter(preg_split('/[^a-z0-9]+/u', $name) ?: [], static fn($w) => mb_strlen($w) >= 3 && !in_array($w, $generic, true)));
        if (!$words) {
            return false;
        }
        $hay = mb_strtolower($text);
        foreach ($words as $w) {
            if (!preg_match('/(?<![a-z0-9])' . preg_quote($w, '/') . '(?![a-z0-9])/u', $hay)) {
                return false;
            }
        }

        return true;
    }

    public function withNamedIn(array $listed, string $answer, ?string $question = null): array
    {
        $have = array_column($listed, 'slug');
        $all = $this->caseStudies();
        $perClient = [];
        foreach ($all as $s) {
            $key = mb_strtolower((string) ($s['client'] ?: $s['name']));
            $perClient[$key] = ($perClient[$key] ?? 0) + 1;
        }
        foreach ($all as $s) {
            if (in_array($s['slug'], $have, true)) {
                continue;
            }
            $tier = $this->studyMatchTier($answer, $s);
            // Title naming by distinctive words only — see namesStudyByTitle().
            if ($tier === 1 && !$this->namesStudyByTitle($answer, $s)) {
                $tier = $this->studyRelevantTo($answer, $s, labels: [(string) ($s['client'] ?? '')]) ? 2 : 0;
            }
            $clientKey = mb_strtolower((string) ($s['client'] ?: $s['name']));
            $single = ($perClient[$clientKey] ?? 0) === 1;
            // A client with several studies, NAMED in the prose but none of its studies
            // listed ("the iris device for Vaiie" under a logo-collection marker): the name
            // can't say which one, so the client's set comes — the same rule as below,
            // where any listed study brings its siblings.
            $clientListed = (bool) array_filter($listed, static fn(array $l) => mb_strtolower((string) ($l['client'] ?: $l['name'])) === $clientKey);
            if ($tier === 2 && !$single && !$clientListed && ($s['client'] ?? '') !== '') {
                $listed[] = $s;
                $have[] = $s['slug'];
                continue;
            }
            // The brand as people say it: "Urban" for Urban.co.uk. Case-sensitive and whole
            // word, so "urban design" in a sentence is not the client.
            $brand = trim((string) preg_replace('/\.(?:co\.uk|com|net|org|io|co)$/i', '', (string) ($s['client'] ?? '')));
            $saysBrand = $brand !== '' && $brand !== ($s['client'] ?? '')
                && preg_match('/(?<![\w.])' . preg_quote($brand, '/') . '(?![\w])/u', $answer);
            if ($tier === 1 || ($single && ($tier === 2 || $saysBrand))) {
                $listed[] = $s;
                $have[] = $s['slug'];
            }
        }

        // A CLIENT'S WORK COMES AS A SET. Listing one of Vaiie's three studies and not the
        // others was the last way the cards and the prose drifted apart ("designed the
        // identity verification journey" with only the branding card). Any study shown
        // brings its client's other studies, after the ones named, so the work Jonson
        // talks about is never held back. A study with no client (the logo collection)
        // is its own set.
        //
        // EXCEPT when the visitor named one study by TITLE: "Did you design Vaiie
        // Identify?" is about that project, not its two siblings — the specificity rule
        // the picker has always kept (see pickStudies' $askedByTitle).
        if ($question !== null && trim($question) !== ''
            && array_filter($listed, fn(array $s) => $this->namesStudyByTitle($question, $s))
        ) {
            return $listed;
        }
        $out = [];
        foreach ($listed as $s) {
            $out[$s['slug']] = $s;
            $client = mb_strtolower(trim((string) ($s['client'] ?? '')));
            if ($client === '') {
                continue;
            }
            foreach ($all as $sib) {
                if (mb_strtolower(trim((string) ($sib['client'] ?? ''))) === $client && !isset($out[$sib['slug']])) {
                    $out[$sib['slug']] = $sib;
                }
            }
        }

        return array_values($out);
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
            // Branding is the trade's word for the work, not a name. "Urban.co.uk
            // Product Branding" minus its client is "Product Branding", every word of
            // which is generic — and an answer about Vaiie that said "the regtech suite
            // branding" pulled Urban's study into a question about Vaiie. Another
            // client's work under a question naming one client is never right, and no
            // ranking further down can be trusted to hide it.
            'brand', 'brands', 'branding',
        ];
        $haystack = ' ' . mb_strtolower($context) . ' ';
        if ($labels === null) {
            $labels = $clientOnly
                ? [(string) ($study['client'] ?? '')]
                : array_merge([(string) ($study['client'] ?? '')], $study['sectorTerms'] ?? $study['sectors'] ?? []);
        }

        foreach ($labels as $label) {
            $label = trim((string) $label);
            if ($label === '') {
                continue;
            }
            // The whole label, then — depending on how much the label has to give —
            // either its single words or only its adjacent PAIRS.
            //
            // A label with one distinctive word has nothing else to offer: "Identify
            // Product Design" is named by "identify" and must stay matchable that way.
            // But a label with several is a phrase, and any one of its words on its own
            // is a trap: "The White Paper Conference Company" matched an answer that
            // said clients could "white label" their verification journey, putting White
            // Paper's study under a question about Vaiie. Requiring two adjacent words
            // keeps "White Paper" working and drops "white label", "paper trail",
            // "conference call" and the rest.
            $words = preg_split('/\s+/', $label) ?: [];
            $distinctive = array_filter(
                $words,
                static fn(string $w): bool => mb_strlen($w) >= 4 && !in_array(mb_strtolower($w), $generic, true),
            );
            if ($wholeOnly) {
                $terms = [$label];
            } elseif (count($distinctive) > 1) {
                $pairs = [];
                for ($i = 0, $n = count($words) - 1; $i < $n; $i++) {
                    $pairs[] = $words[$i] . ' ' . $words[$i + 1];
                }
                $terms = array_merge([$label], $pairs);
            } else {
                $terms = array_merge([$label], $words);
            }
            foreach ($terms as $term) {
                $term = mb_strtolower(trim((string) $term));
                if (mb_strlen($term) < 4 || in_array($term, $generic, true)) {
                    continue;
                }
                // A MULTI-WORD LABEL MADE ONLY OF TRADE WORDS NAMES NOTHING. The generic
                // list above filters single words, but a label is also tried as a whole
                // phrase — and "Product Branding", which is what both "Vaiie Product
                // Branding" and "Urban.co.uk Product Branding" are called once the
                // client is stripped, sailed through that path. An answer about Vaiie
                // that said "the product branding for their regtech suite" matched both,
                // and Urban's card appeared under a question about Vaiie.
                //
                // One distinctive word is enough: "White Paper Conference Company" keeps
                // "conference", "Putting design back into regulatory technology" keeps
                // "regulatory". Only a label with nothing of its own is dropped.
                if (str_contains($term, ' ')) {
                    $distinctive = false;
                    foreach (preg_split('/\s+/', $term) ?: [] as $word) {
                        $word = trim($word);
                        if (mb_strlen($word) >= 4 && !in_array($word, $generic, true)) {
                            $distinctive = true;
                            break;
                        }
                    }
                    if (!$distinctive) {
                        continue;
                    }
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
     * the field is absent or empty. $long prefers each category's public `longTitle`
     * (as sectors() does), falling back to the title where it isn't set.
     */
    private function categoryTitles(Entry $entry, string $handle, bool $long = false): array
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle($handle)) {
            return [];
        }

        $categories = $entry->$handle->all();
        // A parent alongside one of its own children says the same thing twice, less
        // precisely ("Technology" and "RegTech"): keep the children. A parent on its
        // own stays — it is the right label when nothing narrower was picked.
        $categories = array_filter($categories, static function ($c) use ($categories) {
            foreach ($categories as $other) {
                if ($other->id !== $c->id && $other->lft > $c->lft && $other->rgt < $c->rgt) {
                    return false; // $other sits inside $c
                }
            }
            return true;
        });

        return array_values(array_filter(array_map(
            static function ($c) use ($long) {
                $longTitle = $long && $c->getFieldLayout()?->getFieldByHandle('longTitle')
                    ? trim((string) $c->longTitle)
                    : '';
                return $longTitle !== '' ? $longTitle : trim((string) $c->title);
            },
            $categories,
        )));
    }

    /**
     * The sectors Jon has experience in, for the [[sectors]] tag list — the
     * titles of every category in the `sectorExperience` group. Skips cleanly
     * until the group exists.
     */
    public function sectors(): array
    {
        return $this->memo('sectors', fn() => $this->loadSectors());
    }

    private function loadSectors(): array
    {
        if (!Craft::$app->getCategories()->getGroupByHandle('sectorExperience')) {
            return [];
        }

        $out = [];
        foreach (Category::find()->group('sectorExperience')->all() as $category) {
            // A PARENT WITH ITS CHILDREN IN THE LIST GOES: "Technology" beside EventTech,
            // RegTech and PropTech says the same thing less precisely (Jon's rule — the
            // same one categoryTitles() applies to a study's own sectors). A category with
            // no children is just a sector, and stays.
            if ($category->getHasDescendants()) {
                continue;
            }
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
     * Everyone Jon has worked with or for, by name: the client roster, the case
     * studies' clients, his CV companies, and the companies and people behind his
     * testimonials. What ClaimCheck lets an answer put forward as his work. His sectors
     * too: a list may mix the two ("Lloyds and HSBC, RegTech and government work").
     *
     * @return string[]
     */
    public function workNames(): array
    {
        return $this->memo('workNames', fn() => $this->loadWorkNames());
    }

    private function loadWorkNames(): array
    {
        $names = array_map(static fn(array $c) => (string) ($c['name'] ?? ''), $this->clientWork());
        foreach ($this->caseStudies() as $study) {
            $names[] = (string) ($study['client'] ?? '');
        }
        array_push($names, ...$this->employers(), ...$this->sectors());
        foreach (Entry::find()->section('testimonials')->status(null)->all() as $quote) {
            $names[] = (string) ($quote->personName ?? '');
            $names[] = \modules\frontend\helpers\Testimonials::company($quote);
        }

        return array_values(array_unique(array_filter(array_map('trim', $names))));
    }

    /**
     * Every company Jon has worked at, from the CV — what "in-house at X" may name
     * (see ClaimCheck).
     *
     * @return string[]
     */
    public function employers(): array
    {
        return array_values(array_unique(array_filter(array_map(
            static fn(array $row) => trim((string) ($row['company'] ?? '')),
            $this->curriculumVitae(),
        ))));
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
        return $this->memo('curriculumVitae', fn() => $this->loadCurriculumVitae());
    }

    private function loadCurriculumVitae(): array
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
        // SHUFFLED before find() cuts the list to the rail's size, so a place or theme
        // with more photos than the rail holds shows a different few each time — in CMS
        // order, the first four of eight street photos were the only ones ever seen.
        // Never-twice (forHandles' $excludeKeys) still holds within a conversation.
        shuffle($items);

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
