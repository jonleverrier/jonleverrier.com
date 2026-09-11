<?php

namespace modules\jonson\services;

use Craft;
use craft\elements\Entry;
use craft\helpers\App;
use GuzzleHttp\Client;
use modules\jonson\Jonson;
use yii\base\Component;

/**
 * Jonson's memory of a note — and of a case study.
 *
 * A note is prose — a travel story, a museum, an opinion formed on the way —
 * and the persona can't carry every note's prose on every request. So each
 * live note gets a MEMORY CARD: a hundred-odd words of fast facts (where,
 * when, what happened, who, what he made of it), written by Claude once and
 * stored in the entry's `jonsonSummary` field, where Jon can read what Jonson
 * remembers, edit it, or blank it. Every card is then fed to the persona as
 * private background (see AskController::notesPrompt), the same way the CV is.
 *
 * A case study gets the same treatment with a project-shaped brief — client,
 * problem, what was made, decisions, outcome — from its TEXT fields only (the
 * pictures are never read). Its card lands in the same `jonsonSummary` field
 * the persona already reads for studies (AskController::caseStudiesPrompt).
 *
 * When it runs: a queue job is pushed when an entry is saved LIVE with the card
 * empty (see Jonson::init). A card that has content is never regenerated on
 * save — the field is Jon's to edit — only by the console command with --force.
 * An entry with too little text to remember anything from gets no card at all,
 * so the persona's own fallbacks (a study's Bio) stay in play.
 */
class NoteMemory extends Component
{
    /** The sections that get cards, and the shape of card each one gets. */
    public const SECTIONS = ['notes' => 'note', 'caseStudies' => 'project'];
    public const FIELD = 'jonsonSummary'; // the private AI-context field case studies already use
    // The "not sure what to ask?" questions for the page's own ask bar — the same
    // Table field the homepage's default set lives in, so an editor can rewrite
    // or drop any of them in the CMS. Filled once, on publish, like the card.
    public const PROMPTS_FIELD = 'prompts';
    public const PROMPTS_COUNT = 3;

    /** Words the card should run to. Long enough to hold the specifics, short
     *  enough that thirty of them are a few thousand tokens. */
    private const WORDS = '100 to 150';

    /** Fewer words of source than this and there is nothing to remember: no
     *  card is written, rather than one that restates a one-line bio — or worse,
     *  pads it out. A project needs more than a note: a bio, a client line and a
     *  skills list add up to forty words of labels that say nothing about the job. */
    public const MIN_SOURCE_WORDS = ['note' => 40, 'project' => 80];

    /**
     * Whether the field exists at all — on the note's layout. Everything else
     * here is a no-op until it does, so the module can ship ahead of the field.
     */
    public function available(?Entry $entry = null): bool
    {
        if ($entry) {
            return (bool) $entry->getFieldLayout()?->getFieldByHandle(self::FIELD);
        }

        return (bool) Craft::$app->getFields()->getFieldByHandle(self::FIELD);
    }

    /**
     * Should this save produce a card? Only a LIVE entry (enabled, published,
     * not a draft or revision) whose card is empty AND which has enough text to
     * write one from — so an entry that's all pictures doesn't queue a job on
     * every save only for the job to find nothing to do. The empty check is
     * also the loop guard: writing the card back saves the entry, which fires
     * the same event, which finds the card full and stops.
     */
    public function needs(Entry $entry): bool
    {
        if (!isset(self::SECTIONS[$entry->getSection()?->handle ?? ''])) {
            return false;
        }
        if ($entry->getIsDraft() || $entry->getIsRevision()) {
            return false;
        }
        if ($entry->getStatus() !== Entry::STATUS_LIVE) {
            return false;
        }
        if (!$this->available($entry)) {
            return false;
        }

        if (trim((string) $entry->getFieldValue(self::FIELD)) !== '') {
            return false;
        }

        return $this->hasEnoughText($entry);
    }

    /** Same gates as needs(), for the page's own ask-bar questions. */
    public function needsPrompts(Entry $entry): bool
    {
        if (!isset(self::SECTIONS[$entry->getSection()?->handle ?? ''])) {
            return false;
        }
        if ($entry->getIsDraft() || $entry->getIsRevision()) {
            return false;
        }
        if ($entry->getStatus() !== Entry::STATUS_LIVE) {
            return false;
        }
        if (!$entry->getFieldLayout()?->getFieldByHandle(self::PROMPTS_FIELD)) {
            return false;
        }
        if ($this->hasPrompts($entry)) {
            return false;
        }
        return $this->hasEnoughText($entry);
    }

    public function hasPrompts(Entry $entry): bool
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle(self::PROMPTS_FIELD)) {
            return false;
        }
        foreach ((array) ($entry->getFieldValue(self::PROMPTS_FIELD) ?? []) as $row) {
            if (trim((string) ($row['prompt'] ?? $row['col1'] ?? '')) !== '') {
                return true;
            }
        }
        return false;
    }

    /**
     * The entry as plain text for the model — its TEXT, never its pictures.
     *
     * A note: title, summary, then every prose block and photo caption in page
     * order. A case study: its heading, client, bio, case summary, then the
     * blocks, plus any quote placed among them and its skills and sectors. Code
     * blocks are skipped either way — a snippet is not an experience.
     */
    public function prose(Entry $entry): string
    {
        $has = fn(string $handle) => (bool) $entry->getFieldLayout()?->getFieldByHandle($handle);
        $text = fn($v) => trim(html_entity_decode(strip_tags((string) $v)));

        $heading = $has('longTitle') ? $text($entry->longTitle) : '';
        $parts = ['# ' . ($heading !== '' ? $heading : trim((string) $entry->title))];

        if ($has('clientSelector') && ($client = $entry->clientSelector->one())) {
            $line = 'Client: ' . trim((string) $client->title);
            $what = $text($client->summary ?? '');
            if ($what !== '') {
                $line .= ' — ' . $what;
            }
            $parts[] = $line;
        }
        foreach (['bio', 'summary', 'caseSummary'] as $handle) {
            if ($has($handle) && ($v = $text($entry->getFieldValue($handle))) !== '') {
                $parts[] = $v;
            }
        }

        if ($has('caseContent')) {
            foreach ($entry->caseContent->all() as $block) {
                switch ($block->type->handle) {
                    case 'content':
                        if (($v = $text($block->content ?? '')) !== '') {
                            $parts[] = $v;
                        }
                        break;
                    case 'legacyImage':
                        if (($v = $text($block->caption ?? '')) !== '') {
                            $parts[] = '[Photo: ' . $v . ']';
                        }
                        break;
                    case 'caseTestimonial':
                        $quoted = $block->testimonial->one();
                        if ($quoted && ($q = $text($quoted->blockquote ?? '')) !== '') {
                            $who = trim(implode(', ', array_filter([
                                trim((string) ($quoted->personName ?? '')),
                                trim((string) ($quoted->jobTitle ?? '')),
                            ])));
                            $parts[] = 'What the client said' . ($who !== '' ? " ({$who})" : '') . ': "' . $q . '"';
                        }
                        break;
                }
            }
        }

        foreach (['skills' => 'Skills', 'sectorSelector' => 'Sectors'] as $handle => $label) {
            if ($has($handle)) {
                $names = array_map(fn($c) => trim((string) $c->title), $entry->getFieldValue($handle)->all());
                if ($names) {
                    $parts[] = $label . ': ' . implode(', ', $names);
                }
            }
        }

        return implode("\n\n", $parts);
    }

    /** Words of source text, the heading aside — what the floor is measured on.
     *  Placeholder copy counts for nothing: a study still carrying lorem ipsum
     *  has no text yet, whatever the word count says. */
    public function sourceWords(Entry $entry): int
    {
        $body = preg_replace('/^# .*\n?/', '', $this->prose($entry));
        if (preg_match('/lorem ipsum|dolor sit amet/i', $body)) {
            return 0;
        }

        return str_word_count($body);
    }

    /** The floor for this entry's shape of card. */
    public function minSourceWords(Entry $entry): int
    {
        $shape = self::SECTIONS[$entry->getSection()?->handle ?? ''] ?? 'note';

        return self::MIN_SOURCE_WORDS[$shape];
    }

    /** Enough text to write a card from? */
    public function hasEnoughText(Entry $entry): bool
    {
        return $this->sourceWords($entry) >= $this->minSourceWords($entry);
    }

    /**
     * Ask Claude for the card. Returns null on any failure (logged), so a
     * caller can decide whether to retry. Non-streaming: it's a queue job with
     * nobody waiting on it.
     */
    public function generate(Entry $entry): ?string
    {
        $apiKey = App::env('KEY_ANTHROPIC_API');
        if (empty($apiKey)) {
            Craft::warning('[jonson] KEY_ANTHROPIC_API is not set; no memory card for note ' . $entry->id, __METHOD__);
            return null;
        }

        // Its own model setting, so the digest can be tuned without touching
        // the conversation's. The card is written once and kept, so it's worth
        // the strongest model — judging which details are the memorable ones
        // is the whole job.
        $model = App::env('KEY_ANTHROPIC_MODEL_MEMORY') ?: 'claude-opus-5';

        if (!$this->hasEnoughText($entry)) {
            Craft::info('[jonson] too little text to write a memory card for entry ' . $entry->id, __METHOD__);
            return null;
        }

        $posted = $entry->postDate ? $entry->postDate->format('F Y') : 'an unknown date';
        $shape = self::SECTIONS[$entry->getSection()?->handle ?? ''] ?? 'note';

        // The one rule that matters most, stated first and last: the card is a
        // compression of the PAGE, never an extension of it. It exists so the
        // persona can speak about what Jon actually did and wrote — anything
        // the model adds becomes an opinion Jon never held, voiced as his.
        $rules = "STRICTLY FACTUAL. Every statement in the card must be traceable to the text you are "
            . "given. Do not infer, generalise, interpret, or supply takeaways, lessons, verdicts, "
            . "motives or feelings the text does not state. If the text states an opinion or a "
            . "conclusion, keep it, in his words; if it doesn't, the card has none. If something is "
            . "not in the text, it is not in the card — a shorter card is always better than a "
            . "fuller one that adds anything. Leave out narrative connectives, scene-setting, "
            . "sequence-of-events and marketing language. Never quote sentences back; compress "
            . "them. Output the card and nothing else — no preamble, headings, bullets or "
            . "quotation marks.";

        if ($shape === 'project') {
            $system = "You extract the key points and facts from Jon Leverrier's case studies — he is "
                . "a designer — into a memory card, so that a later conversation about a related "
                . "client, sector, problem or craft can bring the project to mind. The card stands in "
                . "for the page: it must say only what the page says.\n\n"
                . "A card is FAST FACTS, not a retelling: " . self::WORDS . " words of terse "
                . "fragments, first person where a person is needed, separated by semicolons or "
                . "short sentences. Lead with the client, what they are, and roughly when. Then "
                . "only what the text records: the brief or problem in a phrase; what he made and "
                . "did (name the deliverables, tools and techniques the text names); decisions "
                . "and constraints the text gives; the outcome and what the client said, if the "
                . "text says. Concrete nouns over adjectives.\n\n"
                . $rules;
            $user = "The case study was published in {$posted}.\n\n" . $this->prose($entry);
        } else {
            $system = "You extract the key points and facts from Jon Leverrier's notes — he is a "
                . "designer — into a memory card, so that a later conversation about a related subject "
                . "can bring the experience to mind. The card stands in for the note: it must say only "
                . "what the note says.\n\n"
                . "A card is FAST FACTS, not a retelling: " . self::WORDS . " words of terse fragments, "
                . "first person where a person is needed, separated by semicolons or short sentences. "
                . "Lead with where and when. Then only what the note records: the specific things "
                . "seen, done and made (name them — the museum, the press, the shop, the technique), "
                . "the people involved by name or role, what he noticed, and any opinion the note "
                . "itself states. Concrete nouns over adjectives.\n\n"
                . "Also leave out logistics (prices, opening hours, phone numbers, flight and route "
                . "details) unless the note is itself about them. " . $rules;
            $user = "The note was posted in {$posted}.\n\n" . $this->prose($entry);
        }

        return $this->complete($apiKey, $model, $system, $user, 'memory card for note ' . $entry->id);
    }

    /**
     * Three questions a visitor might put to the ask bar after reading this
     * page — the page's own "not sure what to ask?" set (the homepage's default
     * set follows them in the bar). Grounded the same way as the card: each has
     * to be answerable from the text, so the conversation it starts lands on
     * something Jon actually wrote. Returns the questions, or null on failure.
     */
    public function generatePrompts(Entry $entry): ?array
    {
        $apiKey = App::env('KEY_ANTHROPIC_API');
        if (empty($apiKey)) {
            Craft::warning('[jonson] KEY_ANTHROPIC_API is not set; no prompts for entry ' . $entry->id, __METHOD__);
            return null;
        }
        if (!$this->hasEnoughText($entry)) {
            return null;
        }
        $model = App::env('KEY_ANTHROPIC_MODEL_MEMORY') ?: 'claude-opus-5';
        $shape = self::SECTIONS[$entry->getSection()?->handle ?? ''] ?? 'note';
        $what = $shape === 'project' ? 'case study' : 'note';
        $n = self::PROMPTS_COUNT;

        // The angle: the site exists to win design work, so the questions should
        // open a door from the page toward Jon the designer — how he works, what
        // he made, what a client could take from it — without leaving what the
        // page actually says. A personal note still gets one or two questions
        // that are simply about the experience; the rest lean toward the work.
        $system = "Jon Leverrier is a designer (branding, product and web design, front-end build) "
            . "and his personal site exists to win design work. Under each page is an ask bar where "
            . "a visitor — often a prospective client sizing him up — can put a question to "
            . "\"Jonson\", an assistant that answers as Jon. You write the {$n} suggested questions "
            . "for one page.\n\n"
            . "Each question is something a curious visitor would ask JON, in the second person, "
            . "after reading this {$what} — asked TO him about what he did, saw, made, chose or "
            . "thought.\n\n"
            . "THE HARD RULE: ask only what the page ANSWERS, not what it merely mentions. The "
            . "assistant answering will have this same text and nothing more about the page, so a "
            . "question the text can't answer makes it invent. A \"why\" question is allowed only "
            . "when the text gives the reason; a feature, decision or event stated without a reason "
            . "gets a what/how/which/when question about what the text does say — or no question. "
            . "Test each one: could you write a two-sentence answer using ONLY the text (or the "
            . "list below)? If not, replace it.\n\n"
            . "THE ANGLE: wherever the text allows, steer toward Jon as someone to hire — the "
            . "decisions he made and why, the craft and process behind what he built, the problem "
            . "he solved, the tools and techniques he chose, what he learned that shapes how he "
            . "works, what the client got. On a case study, all {$n} should take that angle, each "
            . "on a different thread. On a personal note (travel, music, a museum), at least one "
            . "and ideally two should find the bridge to his work that the text itself offers — an "
            . "eye for detail he describes, a craft he admires, a way of working the experience "
            . "shows — and the remaining one can be plainly about the experience. Never invent the "
            . "bridge: if the text has no work in it, ask about what it does have.\n\n"
            . "WHAT JONSON CAN ACTUALLY SPEAK TO, beyond this page (below, under the heading). A "
            . "question may reach from the page into this — \"Do you build most client sites on "
            . "Craft?\" under a note about a Craft plugin, \"Is that the eye you bring to a brand?\" "
            . "under a note about type — and one of the {$n} should, when the page gives a genuine "
            . "hook. But every question must be answerable from the page OR from this list: never "
            . "name a client, project, sector or service that appears in neither.\n\n"
            . "Prefer the specific and the human over the general — \"What does the crumb fall back "
            . "to when a page has no title?\" not \"How does the plugin work?\" — and vary them: "
            . "{$n} different threads of the page, not {$n} angles on one.\n\n"
            . "Plain conversational English, sentence case, one sentence each, ending in a question "
            . "mark, at most 60 characters. No quotation marks, no names of the page or of Jon, no "
            . "preamble. Output ONLY a JSON array of {$n} strings.";
        $user = "THE PAGE:\n\n" . $this->prose($entry) . "\n\n" . $this->knowledgeBrief($entry);

        $text = $this->complete($apiKey, $model, $system, $user, 'prompts for entry ' . $entry->id, 1024);
        if ($text === null) {
            return null;
        }
        // Tolerate a fenced or chatty reply: take the first [...] in it.
        if (preg_match('/\[.*?\]/s', $text, $m)) {
            $text = $m[0];
        }
        $list = json_decode($text, true);
        if (!is_array($list)) {
            // A reply cut short mid-array (seen in the wild — the closing bracket
            // missing) still holds whole questions: salvage every complete string.
            if (preg_match_all('/"((?:[^"\\\\]|\\\\.)*\?)"/', $text, $mm) && $mm[1]) {
                $list = array_map(static fn ($q) => stripcslashes($q), $mm[1]);
                Craft::warning('[jonson] prompts for entry ' . $entry->id . ' were not clean JSON; salvaged ' . count($list), __METHOD__);
            } else {
                Craft::error('[jonson] prompts for entry ' . $entry->id . ' were not a JSON array: ' . mb_substr($text, 0, 200), __METHOD__);
                return null;
            }
        }
        $out = [];
        foreach ($list as $q) {
            $q = trim((string) $q, " \t\n\r\0\x0B\"'“”");
            if ($q === '') {
                continue;
            }
            if (!str_ends_with($q, '?')) {
                $q = rtrim($q, '.!') . '?';
            }
            $out[] = $q;
            if (count($out) === $n) {
                break;
            }
        }
        return $out ? $out : null;
    }

    /**
     * A compact list of what the persona can talk about beyond one page — the
     * case studies, clients, sectors and the phases of his process, from the same
     * sources the persona is fed — so a page's questions can reach toward real
     * work without pointing at anything the site has nothing on.
     */
    public function knowledgeBrief(?Entry $except = null): string
    {
        $find = Jonson::getInstance()->findContext;
        $lines = ["WHAT JONSON CAN ACTUALLY SPEAK TO (beyond this page):"];

        $studies = [];
        foreach ($find->caseStudies(null, true) as $s) {
            if ($except && ($s['slug'] ?? '') === $except->slug) {
                continue;
            }
            $line = trim((string) ($s['title'] ?? ''));
            if (!empty($s['client'])) {
                $line .= ' — for ' . $s['client'];
            }
            if (!empty($s['sectors'])) {
                $line .= ' (' . implode(', ', (array) $s['sectors']) . ')';
            }
            if (!empty($s['summary'])) {
                $line .= ': ' . mb_substr($s['summary'], 0, 160);
            }
            if ($line !== '') {
                $studies[] = '  - ' . $line;
            }
        }
        if ($studies) {
            $lines[] = "Case studies (projects he can talk through in detail):";
            array_push($lines, ...$studies);
        }

        $clients = array_values(array_filter(array_map(static fn ($c) => trim((string) ($c['name'] ?? '')), $find->clientWork())));
        if ($clients) {
            $lines[] = "Clients he has worked with: " . implode(', ', $clients) . '.';
        }

        $sectors = $find->sectors();
        if ($sectors) {
            $lines[] = "Sectors he has experience in: " . implode(', ', $sectors) . '.';
        }

        $phases = [];
        foreach ($find->methodology() as $step) {
            $t = trim((string) ($step['title'] ?? ''));
            if ($t === '') {
                continue;
            }
            $phases[] = $t . (!empty($step['services']) ? ' (' . implode(', ', $step['services']) . ')' : '');
        }
        if ($phases) {
            $lines[] = "How he works — the phases of a project and the services in each: " . implode('; ', $phases) . '.';
        }

        return count($lines) > 1 ? implode("\n", $lines) : '';
    }

    /** Write the questions into the page's Table field. */
    public function storePrompts(Entry $entry, array $prompts): bool
    {
        $rows = [];
        foreach ($prompts as $q) {
            $rows[] = ['col1' => $q]; // the Table field's one column, handle `prompt`
        }
        $entry->setFieldValue(self::PROMPTS_FIELD, $rows);
        $entry->setScenario(Entry::SCENARIO_LIVE);
        return Craft::$app->getElements()->saveElement($entry, true, true, false);
    }

    /** One completion; the text that came back, or null (logged) on any failure. */
    private function complete(string $apiKey, string $model, string $system, string $user, string $what, int $maxTokens = 1024): ?string
    {
        try {
            $client = new Client(['timeout' => 90, 'http_errors' => false]);
            $res = $client->post('https://api.anthropic.com/v1/messages', [
                'headers' => [
                    'x-api-key' => $apiKey,
                    'anthropic-version' => '2023-06-01',
                    'content-type' => 'application/json',
                ],
                'json' => [
                    'model' => $model,
                    'max_tokens' => $maxTokens,
                    'system' => $system,
                    'messages' => [['role' => 'user', 'content' => $user]],
                ],
            ]);
            $status = $res->getStatusCode();
            $body = json_decode((string) $res->getBody(), true);
            if ($status !== 200) {
                Craft::error('[jonson] ' . $what . ' failed: HTTP ' . $status
                    . ' ' . ($body['error']['message'] ?? ''), __METHOD__);
                return null;
            }
            $text = '';
            foreach ($body['content'] ?? [] as $block) {
                if (($block['type'] ?? '') === 'text') {
                    $text .= $block['text'];
                }
            }
            $text = trim($text);
            return $text !== '' ? $text : null;
        } catch (\Throwable $e) {
            Craft::error('[jonson] ' . $what . ': ' . $e->getMessage(), __METHOD__);
            return null;
        }
    }

    /**
     * Write the card onto the note. Saves the entry, which fires the after-save
     * event again — harmless, since the card is now full (see needs()).
     */
    public function store(Entry $entry, string $card): bool
    {
        $entry->setFieldValue(self::FIELD, $card);
        $entry->setScenario(Entry::SCENARIO_LIVE);

        return Craft::$app->getElements()->saveElement($entry, true, true, false);
    }

    /**
     * Every live note's card, newest first, for the persona:
     * { title, url, posted, memory }. Notes without a card are left out.
     */
    public function cards(string $section = 'notes'): array
    {
        if (!$this->available() || !Craft::$app->getEntries()->getSectionByHandle($section)) {
            return [];
        }

        $out = [];
        foreach (Entry::find()->status(Entry::STATUS_LIVE)->section($section)->orderBy('postDate DESC')->all() as $entry) {
            $memory = trim((string) ($entry->getFieldValue(self::FIELD) ?? ''));
            if ($memory === '') {
                continue;
            }
            $out[] = [
                'title' => trim((string) $entry->title),
                'slug' => (string) $entry->slug, // the id a [[next:]] prompt cites (@note:slug)
                'url' => $entry->getUrl(),
                'posted' => $entry->postDate ? $entry->postDate->format('F Y') : null,
                'memory' => $memory,
            ];
        }

        return $out;
    }
}
