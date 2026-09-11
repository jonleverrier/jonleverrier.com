<?php

namespace modules\jonson\services;

use Craft;
use craft\helpers\Db;
use yii\base\Component;

/**
 * ANALYTICS — what the assistant is actually doing, kept.
 *
 * Writes the two tables from m260911_150000_jonson_analytics: one row per VISIT, one
 * per TURN. Read that migration first — it carries the reasoning for the split and,
 * more importantly, the cid/sid distinction, which is the thing to get right here.
 *
 * This exists to improve Jonson, not to profile anyone: the questions people ask, the
 * chips they were offered against the ones they took, where conversations begin and how
 * far they get. The one place it meets lead capture is `convert()`, so a conversation
 * that became an enquiry can be told apart from one that didn't.
 *
 * NOTHING IN HERE MAY THROW. Every method is wrapped, because analytics failing is not
 * a reason for a visitor's question to fail — a missing table, a lock, a disk full, all
 * of it degrades to a log line and an unanswered reporting question. That is also why
 * it writes with the query builder rather than through an ActiveRecord with
 * validation: fewer moving parts on a path that must never break the answer.
 */
class Analytics extends Component
{
    public const VISITS = '{{%jonson_visits}}';
    public const TURNS = '{{%jonson_turns}}';

    /** Longest URL we keep. Matches the column, and CrmController's own referrer cap. */
    private const URL_MAX = 255;

    /**
     * Record one turn, and create or update the visit it belongs to.
     *
     * Called after the answer has been sent, never before — see the call site. A turn
     * that the visitor never saw is not a turn worth counting, and doing it after means
     * the write can never delay a reply.
     *
     * $turn keys: question, outcome, fromChip, chipsOffered, surfaces, pageUrl,
     *             answerWords, ms
     * $visit keys: cid, originUrl, originEntryId, vipId, promptUses
     */
    public function recordTurn(string $sid, array $turn, array $visit = []): void
    {
        $sid = $this->id($sid);
        if ($sid === null) {
            return;
        }

        try {
            $db = Craft::$app->getDb();
            $now = Db::prepareDateForDb(new \DateTime());

            // The visit row first, because the turn number comes from it. Insert on the
            // first turn, bump on every one after — so `turns` is authoritative and
            // `endedAt` is a last-seen time, which matters because nobody ever ends a
            // conversation deliberately.
            $existing = (new \craft\db\Query())
                ->select(['id', 'turns'])
                ->from(self::VISITS)
                ->where(['sid' => $sid])
                ->one();

            if ($existing === false || $existing === null) {
                $db->createCommand()->insert(self::VISITS, [
                    'sid' => $sid,
                    'cid' => $this->id($visit['cid'] ?? null),
                    'startedAt' => $now,
                    'endedAt' => $now,
                    'turns' => 1,
                    // Origin is written ONCE, on the first turn, and never revisited.
                    // It is where the conversation began; a later turn happening
                    // somewhere else is navigation, not a different origin.
                    'originUrl' => $this->url($visit['originUrl'] ?? ($turn['pageUrl'] ?? null)),
                    'originEntryId' => $this->int($visit['originEntryId'] ?? null),
                    'vipId' => $this->int($visit['vipId'] ?? null),
                    'promptUses' => (int) ($visit['promptUses'] ?? 0),
                    'exitUrl' => $this->url($turn['pageUrl'] ?? null),
                    'dateCreated' => $now,
                    'dateUpdated' => $now,
                    'uid' => \craft\helpers\StringHelper::UUID(),
                ])->execute();
                $number = 1;
            } else {
                $number = (int) $existing['turns'] + 1;
                $db->createCommand()->update(self::VISITS, [
                    'endedAt' => $now,
                    'turns' => $number,
                    // exitUrl tracks the last place they spoke from, so a visit that
                    // simply stops still says where it stopped. The beacon overwrites
                    // it with something better when it gets the chance.
                    'exitUrl' => $this->url($turn['pageUrl'] ?? null),
                    'promptUses' => (int) ($visit['promptUses'] ?? 0),
                    'dateUpdated' => $now,
                ], ['sid' => $sid])->execute();
            }

            $db->createCommand()->insert(self::TURNS, [
                'sid' => $sid,
                'turn' => $number,
                'askedAt' => $now,
                'question' => $this->text($turn['question'] ?? null),
                'fromChip' => $this->int($turn['fromChip'] ?? null),
                // JSON rather than a join table: these are read by eye and by the odd
                // aggregate query, never joined on. A list of three strings does not
                // earn a table of its own.
                'chipsOffered' => $this->json($turn['chipsOffered'] ?? null),
                'surfaces' => $this->json($turn['surfaces'] ?? null),
                'pageUrl' => $this->url($turn['pageUrl'] ?? null),
                'outcome' => (string) ($turn['outcome'] ?? 'answered'),
                'answerWords' => $this->int($turn['answerWords'] ?? null),
                'ms' => $this->int($turn['ms'] ?? null),
                'inTokens' => $this->int($turn['inTokens'] ?? null),
                'cacheReadTokens' => $this->int($turn['cacheReadTokens'] ?? null),
                'cacheWriteTokens' => $this->int($turn['cacheWriteTokens'] ?? null),
                'outTokens' => $this->int($turn['outTokens'] ?? null),
                'dateCreated' => $now,
                'dateUpdated' => $now,
                'uid' => \craft\helpers\StringHelper::UUID(),
            ])->execute();
        } catch (\Throwable $e) {
            $this->shrug($e, 'recordTurn');
        }
    }

    /**
     * Where they went when they left, from the exit beacon.
     *
     * `$to` is null for a closed tab — which is most of them, and is recorded as null
     * rather than guessed at. The distinction between "closed the tab after two turns"
     * and "clicked through to a case study" is the entire reason this exists.
     */
    public function recordExit(string $sid, ?string $from, ?string $to): void
    {
        $sid = $this->id($sid);
        if ($sid === null) {
            return;
        }

        try {
            $values = ['dateUpdated' => Db::prepareDateForDb(new \DateTime())];
            if ($from !== null) {
                $values['exitUrl'] = $this->url($from);
            }
            if ($to !== null) {
                $values['exitTo'] = $this->url($to);
            }

            Craft::$app->getDb()->createCommand()
                // No insert fallback: a beacon for a visit with no turns is a page view,
                // not a conversation, and this table is about conversations.
                ->update(self::VISITS, $values, ['sid' => $sid])
                ->execute();
        } catch (\Throwable $e) {
            $this->shrug($e, 'recordExit');
        }
    }

    /**
     * This conversation became a lead. Stamped by CrmController on a successful save.
     *
     * Matched on the VISITOR (cid) rather than the visit, because the contact form
     * posts its own request and the client sends the cid it already had to hand — and
     * because a person who chats, navigates, opens the panel and writes to Jon has
     * plainly converted that conversation even if the tab, and therefore the sid,
     * changed on the way. Only the most recent visit for that visitor is stamped: an
     * enquiry belongs to the conversation that prompted it, not to every chat they
     * have ever had.
     */
    public function convert(string $cid, int $leadEntryId): void
    {
        $cid = $this->id($cid);
        if ($cid === null || $leadEntryId <= 0) {
            return;
        }

        try {
            $latest = (new \craft\db\Query())
                ->select(['sid'])
                ->from(self::VISITS)
                ->where(['cid' => $cid])
                ->orderBy(['startedAt' => SORT_DESC])
                ->scalar();

            if (!$latest) {
                return;
            }

            Craft::$app->getDb()->createCommand()->update(
                self::VISITS,
                ['leadEntryId' => $leadEntryId, 'dateUpdated' => Db::prepareDateForDb(new \DateTime())],
                ['sid' => $latest],
            )->execute();
        } catch (\Throwable $e) {
            $this->shrug($e, 'convert');
        }
    }

    public const PRESENCE = '{{%jonson_presence}}';

    /** Segments the widget's tabs filter by. */
    public const ALL = 'all';
    public const GENERAL = 'general';
    public const VIP = 'vip';

    /** How long after their last page view someone still counts as "here". */
    private const PRESENCE_WINDOW = 300; // 5 minutes

    /**
     * Mark this visitor as present, on this page. Called from a page-render event, so
     * it rides the request the visitor already made and costs no extra round trip.
     *
     * An UPSERT, never an insert: one row per person, overwritten as they move around.
     * That is what keeps this a snapshot of who is here rather than a history of
     * everywhere anyone has been — a different and much larger thing to keep.
     *
     * `$token` is the visit id where there is one and the PHP session id otherwise,
     * because presence has to count the person reading a case study, not just the one
     * talking to Jonson.
     */
    public function touchPresence(string $token, string $path, bool $inChat = false): void
    {
        $token = $this->id($token);
        if ($token === null) {
            return;
        }

        try {
            $now = Db::prepareDateForDb(new \DateTime());
            Craft::$app->getDb()->createCommand()->upsert(self::PRESENCE, [
                'token' => $token,
                'path' => $this->url($path),
                'seenAt' => $now,
                'inChat' => $inChat,
                'dateCreated' => $now,
                'dateUpdated' => $now,
                'uid' => \craft\helpers\StringHelper::UUID(),
            ], [
                'path' => $this->url($path),
                'seenAt' => $now,
                'inChat' => $inChat,
                'dateUpdated' => $now,
            ])->execute();

            // Sweep the stale rows here rather than on a schedule: it is one indexed
            // DELETE on a table that is only ever a handful of rows, and a cron job to
            // tidy a five-row table would be the more complicated choice. Only on
            // roughly one request in twenty, because every visitor doing it on every
            // page view is twenty times the writes for the same empty table.
            if (random_int(1, 20) === 1) {
                Craft::$app->getDb()->createCommand()->delete(
                    self::PRESENCE,
                    ['<', 'seenAt', Db::prepareDateForDb((new \DateTime())->modify('-' . self::PRESENCE_WINDOW . ' seconds'))],
                )->execute();
            }
        } catch (\Throwable $e) {
            $this->shrug($e, 'touchPresence');
        }
    }

    /**
     * Who is on the site right now: a count, how many of them are mid-conversation,
     * and which pages they are on.
     */
    public function presence(): array
    {
        try {
            $cutoff = Db::prepareDateForDb((new \DateTime())->modify('-' . self::PRESENCE_WINDOW . ' seconds'));
            $rows = (new \craft\db\Query())
                ->select(['path', 'inChat'])
                ->from(self::PRESENCE)
                ->where(['>=', 'seenAt', $cutoff])
                ->all();

            $pages = [];
            $inChat = 0;
            foreach ($rows as $row) {
                $path = (string) ($row['path'] ?? '') ?: '/';
                $pages[$path] = ($pages[$path] ?? 0) + 1;
                $inChat += $row['inChat'] ? 1 : 0;
            }
            arsort($pages);

            return ['now' => count($rows), 'inChat' => $inChat, 'pages' => array_slice($pages, 0, 5, true)];
        } catch (\Throwable $e) {
            $this->shrug($e, 'presence');

            return ['now' => 0, 'inChat' => 0, 'pages' => []];
        }
    }

    /**
     * Everything the dashboard widget shows, for the last $days.
     *
     * One method rather than a query per panel: the widget renders once, and a dozen
     * round trips to answer one screen is a silly way to spend them. Everything here
     * is aggregate — no transcripts, nothing per-visitor — because the question being
     * asked is "how is the assistant doing", not "who came".
     */
    public function insights(int $days = 30, string $segment = self::ALL): array
    {
        $since = (new \DateTime())->modify("-{$days} days");
        $sinceDb = Db::prepareDateForDb($since);

        $empty = [
            'days' => $days, 'chats' => 0, 'questions' => 0, 'avgTurns' => 0.0,
            'tokensPerChat' => 0, 'tokensPeriod' => 0, 'tokensMonth' => 0,
            'cacheWriteMonth' => 0, 'cacheReadMonth' => 0,
            'chipCtr' => 0.0, 'toWork' => 0.0, 'toLead' => 0.0, 'leads' => 0,
            'asked' => [], 'suggested' => [], 'origins' => [], 'endings' => ['closed' => 0, 'work' => 0, 'browsing' => 0, 'contact' => 0, 'elsewhere' => 0], 'elsewhereTop' => [], 'workTop' => [], 'endingRows' => [], 'vips' => [],
            'daily' => [], 'returning' => 0, 'junk' => 0, 'apiErrors' => 0, 'rateLimited' => 0,
        ];

        try {
            // The segment filter. VIP conversations are a different population and not
            // really comparable to cold traffic: the visitor was hand-picked and sent a
            // private link, the persona is primed with a note about them, they are
            // greeted by name, and the chats run longer and cost more tokens by design.
            // Averaged together they quietly distort most asked, chat → lead, avg
            // questions and tokens per chat — so they can be looked at apart.
            $query = (new \craft\db\Query())
                ->select(['sid', 'cid', 'turns', 'originUrl', 'originEntryId', 'vipId', 'exitTo', 'leadEntryId', 'startedAt'])
                ->from(self::VISITS)
                ->where(['>=', 'startedAt', $sinceDb]);

            if ($segment === self::GENERAL) {
                $query->andWhere(['vipId' => null]);
            } elseif ($segment === self::VIP) {
                $query->andWhere(['not', ['vipId' => null]]);
            }

            $visits = $query->all();

            if (!$visits) {
                return $empty;
            }

            $sids = array_column($visits, 'sid');
            $turns = (new \craft\db\Query())
                ->select(['question', 'fromChip', 'chipsOffered', 'outcome'])
                ->from(self::TURNS)
                ->where(['sid' => $sids])
                ->all();

            $chats = count($visits);
            $leads = count(array_filter($visits, static fn($v) => $v['leadEntryId'] !== null));
            $totalTurns = array_sum(array_column($visits, 'turns'));

            // ENDINGS. exitTo null covers both "closed the tab" and "we never saw them
            // go" — the beacon can't fire on a force-quit — which are the same fact
            // from here and the honest way to report it. It makes every destination
            // below a FLOOR rather than an exact rate: under-reported, never over.
            //
            // A SPECIFIC STUDY IS NOT THE INDEX. These used to share one '/case-stud'
            // prefix, which counted them together and flattered the number: reaching
            // /case-studies is browsing a list they could have found from the nav,
            // while reaching /case-study/{slug} means Jonson pointed at one piece of
            // work and they took it. The second is the signal; only it counts as
            // 'work'. Order matters — the specific path is tested FIRST, because
            // '/case-stud' would swallow both.
            $endings = ['closed' => 0, 'work' => 0, 'browsing' => 0, 'contact' => 0, 'elsewhere' => 0];
            // …and WHERE elsewhere actually was. exitTo holds the real path, so rolling
            // it into an anonymous total threw away something already recorded — and
            // "12% went somewhere" is a worse answer than "8% went to /about". The
            // named buckets above stay, because they are the outcomes worth tracking
            // deliberately; this just stops the remainder being a shrug.
            $elsewhere = [];
            // …and WHICH study, for the same reason. This is the destination the whole
            // feature is pointed at — "which piece of work is Jonson actually sending
            // people to" is a better question than "how many went to one" — and naming
            // /about while bucketing the case studies had it exactly backwards.
            $work = [];

            foreach ($visits as $v) {
                $to = (string) ($v['exitTo'] ?? '');
                if ($to === '') {
                    $endings['closed']++;
                } elseif (str_starts_with($to, '/case-study/')) {
                    $endings['work']++;
                    $work[$to] = ($work[$to] ?? 0) + 1;
                } elseif (str_starts_with($to, '/case-studies')) {
                    $endings['browsing']++;
                } elseif (str_starts_with($to, '/contact')) {
                    $endings['contact']++;
                } else {
                    $endings['elsewhere']++;
                    $elsewhere[$to] = ($elsewhere[$to] ?? 0) + 1;
                }
            }
            arsort($elsewhere);
            arsort($work);

            // ORIGINS, and the daily count for the sparkline.
            //
            // originEntryId FIRST, and originUrl only as the fallback — the other way
            // round is wrong, and was. Jonson only exists on the homepage: a question
            // typed into a case study's ask bar is stashed by ask-handoff.js and the
            // browser NAVIGATES to '/', which asks it on arrival. So by the time the
            // first turn is recorded the URL is always '/', and every conversation
            // reported as starting at the homepage — including the ones that didn't.
            // The handoff carries the originating entry id through for exactly this
            // reason; it just wasn't being read.
            $origins = [];
            $daily = [];
            $entryIds = array_values(array_filter(array_unique(array_column($visits, 'originEntryId'))));
            $titles = $entryIds
                ? \craft\elements\Entry::find()->id($entryIds)->status(null)->indexBy('id')->all()
                : [];

            foreach ($visits as $v) {
                $entryId = $v['originEntryId'] ?? null;
                if ($entryId && isset($titles[$entryId])) {
                    // The entry's URI, not its title, so this column reads in the same
                    // units as Ended by — both are places on the site, and one showing
                    // "Vaiie Product Branding" while the other showed
                    // "/case-study/vaiie-product-branding" made the same page look like
                    // two different things. The homepage single's URI is Craft's
                    // `__home__` sentinel, which has to become '/' by hand.
                    $uri = (string) $titles[$entryId]->uri;
                    $origin = ($uri === '' || $uri === '__home__') ? '/' : '/' . ltrim($uri, '/');
                } elseif ($entryId) {
                    // The entry has since been deleted. Better than dropping the visit
                    // or crediting it to the homepage it never came from.
                    $origin = 'deleted page';
                } else {
                    // No entry id is the genuine front door — the homepage's own bar.
                    $origin = ((string) ($v['originUrl'] ?? '') ?: '/');
                }
                $origins[$origin] = ($origins[$origin] ?? 0) + 1;
                $day = substr((string) $v['startedAt'], 0, 10);
                $daily[$day] = ($daily[$day] ?? 0) + 1;
            }
            arsort($origins);
            // Every day in the window, zeros included — a sparkline with the quiet days
            // missing is a lie about the shape.
            $series = [];
            for ($i = $days - 1; $i >= 0; $i--) {
                $day = (new \DateTime())->modify("-{$i} days")->format('Y-m-d');
                $series[] = ['day' => $day, 'n' => $daily[$day] ?? 0];
            }

            // RETURNING: a visitor with more than one visit, ever — not just inside the
            // window, or someone's second visit today counts and their second visit
            // last month doesn't.
            $cids = array_values(array_filter(array_unique(array_column($visits, 'cid'))));
            $returning = 0;
            if ($cids) {
                // A SUBQUERY, not ->count() on the grouped query. Yii builds that as
                // COUNT(DISTINCT cid) alongside a GROUP BY, which MySQL rejects under
                // ONLY_FULL_GROUP_BY (1055) — and because insights() swallows its own
                // errors, it failed silently and the whole widget read zero.
                $repeat = (new \craft\db\Query())
                    ->select(['cid'])
                    ->from(self::VISITS)
                    ->where(['cid' => $cids])
                    ->groupBy(['cid'])
                    ->having(['>', 'COUNT(*)', 1]);

                $returning = (int) (new \craft\db\Query())->from(['r' => $repeat])->count();
            }

            // QUESTIONS. Typed and suggested are counted apart on purpose: a chip click
            // records the CHIP's wording, so a combined list just reflects Jonson's own
            // suggestions back at you and buries what people actually came to ask.
            $asked = [];
            $takenByText = [];
            $offered = [];
            $outcomes = ['junk' => 0, 'apiError' => 0, 'rateLimited' => 0];
            $chipsTaken = 0;
            $chipsOffered = 0;

            foreach ($turns as $t) {
                $q = trim(mb_strtolower((string) $t['question']));
                $outcome = (string) $t['outcome'];
                if (isset($outcomes[$outcome])) {
                    $outcomes[$outcome]++;
                }

                if ($t['fromChip'] !== null) {
                    $chipsTaken++;
                    if ($q !== '') {
                        $takenByText[$q] = ($takenByText[$q] ?? 0) + 1;
                    }
                } elseif ($q !== '' && $outcome !== 'junk') {
                    $asked[$q] = ($asked[$q] ?? 0) + 1;
                }

                $chips = json_decode((string) $t['chipsOffered'], true);
                if (is_array($chips)) {
                    $chipsOffered += count($chips);
                    foreach ($chips as $chip) {
                        $key = trim(mb_strtolower((string) $chip));
                        if ($key !== '') {
                            $offered[$key] = ($offered[$key] ?? 0) + 1;
                        }
                    }
                }
            }

            arsort($asked);
            arsort($offered);

            // Offered against taken, per chip. The 0% rows are the point: a suggestion
            // shown twenty times and never once pressed is one to rewrite, and there is
            // no other way to see it.
            $suggested = [];
            foreach (array_slice($offered, 0, 8, true) as $text => $count) {
                $taken = $takenByText[$text] ?? 0;
                $suggested[] = [
                    'text' => $text,
                    'offered' => $count,
                    'taken' => $taken,
                    'rate' => $count > 0 ? round($taken / $count * 100) : 0,
                ];
            }

            // TOKENS. Summed over the turns in the window, and again over the calendar
            // month — the month is what a bill is cut on, and a rolling 30 days is not
            // the same period no matter how close it looks.
            $tokens = (new \craft\db\Query())
                ->select([
                    'inT' => 'SUM(inTokens)',
                    'readT' => 'SUM(cacheReadTokens)',
                    'writeT' => 'SUM(cacheWriteTokens)',
                    'outT' => 'SUM(outTokens)',
                ])
                ->from(self::TURNS)
                ->where(['sid' => $sids])
                ->one() ?: [];

            $periodTokens = (int) ($tokens['inT'] ?? 0) + (int) ($tokens['readT'] ?? 0)
                + (int) ($tokens['writeT'] ?? 0) + (int) ($tokens['outT'] ?? 0);

            $monthStart = Db::prepareDateForDb(new \DateTime('first day of this month 00:00:00'));
            $monthQuery = (new \craft\db\Query())
                ->select([
                    'total' => 'SUM(COALESCE(inTokens,0) + COALESCE(cacheReadTokens,0)'
                        . ' + COALESCE(cacheWriteTokens,0) + COALESCE(outTokens,0))',
                    'writeT' => 'SUM(cacheWriteTokens)',
                    'readT' => 'SUM(cacheReadTokens)',
                ])
                ->from(self::TURNS)
                ->where(['>=', 'askedAt', $monthStart]);

            // Scoped to the segment as well — otherwise the VIP tab would report the
            // whole site's monthly spend beside its own handful of chats.
            if ($segment !== self::ALL) {
                $monthQuery->andWhere(['sid' => (new \craft\db\Query())
                    ->select(['sid'])
                    ->from(self::VISITS)
                    ->where($segment === self::VIP ? ['not', ['vipId' => null]] : ['vipId' => null]),
                ]);
            }

            $month = $monthQuery->one() ?: [];

            return [
                'days' => $days,
                'chats' => $chats,
                // Per chat and per month, as asked. The month figure deliberately
                // ignores the window above — it is a calendar month, because that is
                // the period a bill covers.
                'tokensPerChat' => $chats > 0 ? (int) round($periodTokens / $chats) : 0,
                'tokensPeriod' => $periodTokens,
                'tokensMonth' => (int) ($month['total'] ?? 0),
                // The prompt cache's own health: writes should be a small fraction of
                // reads. If this climbs, something has started varying inside the
                // cached block again — see the tokens migration.
                'cacheWriteMonth' => (int) ($month['writeT'] ?? 0),
                'cacheReadMonth' => (int) ($month['readT'] ?? 0),
                'questions' => count($turns),
                'avgTurns' => $chats > 0 ? round($totalTurns / $chats, 1) : 0.0,
                // Totals over totals, not a true per-impression rate: chips offered on
                // one turn are pressed on the next, so they can't be paired exactly.
                // Fine for trend, and labelled as approximate in the widget.
                'chipCtr' => $chipsOffered > 0 ? round($chipsTaken / $chipsOffered * 100) : 0,
                'toWork' => $chats > 0 ? round($endings['work'] / $chats * 100) : 0,
                'toLead' => $chats > 0 ? round($leads / $chats * 100) : 0,
                'leads' => $leads,
                'asked' => array_slice($asked, 0, 8, true),
                'suggested' => $suggested,
                'origins' => array_slice($origins, 0, 5, true),
                'endings' => $endings,
                // Named destinations for the remainder, commonest first. Four, because
                // beyond that it is a tail rather than a pattern and the column has to
                // fit beside two others.
                'elsewhereTop' => array_slice($elsewhere, 0, 4, true),
                'workTop' => array_slice($work, 0, 4, true),
                'endingRows' => $this->endingRows($endings, $work, $elsewhere),
                // Only built for the VIP tab — on All it would be a list of named
                // people sitting under figures that are mostly about strangers, which
                // is a different question than the one that panel answers.
                'vips' => $segment === self::VIP ? $this->vipRows($visits) : [],
                'daily' => $series,
                'returning' => $returning,
                'junk' => $outcomes['junk'],
                'apiErrors' => $outcomes['apiError'],
                'rateLimited' => $outcomes['rateLimited'],
            ];
        } catch (\Throwable $e) {
            $this->shrug($e, 'insights');

            return $empty;
        }
    }

    /**
     * The Ended by column as one list, commonest first.
     *
     * Built here rather than in the template because the ordering is the point: it used
     * to render in a fixed funnel order (best outcome down to worst), which reads
     * nicely but buries whatever actually happened. Sorted by count, the biggest
     * ending is the first thing you see — usually "closed the tab", which is the honest
     * headline rather than something to tuck at the bottom.
     *
     * The FIXED rows stay in the list even at zero, because they are the outcomes worth
     * watching whether or not they occurred: a 0% beside /contact is information. They
     * simply sort to the bottom. Discovered destinations only appear once someone has
     * actually gone there.
     */
    private function endingRows(array $endings, array $work, array $elsewhere): array
    {
        $rows = [];

        // Named destinations, capped — past the top few it is a tail, not a pattern,
        // and the column sits beside two others.
        $namedWork = array_slice($work, 0, 4, true);
        foreach ($namedWork as $path => $n) {
            $rows[] = ['label' => $path, 'n' => $n];
        }
        if (($rest = $endings['work'] - array_sum($namedWork)) > 0) {
            $rows[] = ['label' => 'other case studies', 'n' => $rest];
        }

        $namedElse = array_slice($elsewhere, 0, 4, true);
        foreach ($namedElse as $path => $n) {
            $rows[] = ['label' => $path, 'n' => $n];
        }
        if (($rest = $endings['elsewhere'] - array_sum($namedElse)) > 0) {
            $rows[] = ['label' => 'elsewhere', 'n' => $rest];
        }

        $rows[] = ['label' => '/contact', 'n' => $endings['contact']];
        $rows[] = ['label' => '/case-studies', 'n' => $endings['browsing']];
        // Not a destination — the absence of one — so it keeps a plain label while
        // everything around it is a path. "exit" rather than "closed the tab", which
        // claimed more than the data supports: this bucket is every visit with no
        // recorded destination, and that covers a closed tab, a force-quit, a crash,
        // and anyone whose beacon simply never arrived.
        $rows[] = ['label' => 'exit', 'n' => $endings['closed']];

        usort($rows, static fn($a, $b) => $b['n'] <=> $a['n']);

        return $rows;
    }

    /**
     * Who came through a VIP door, and how far they got.
     *
     * ORDERED BY QUESTIONS, not visits. A door is sent to one named person, so the
     * question is never "how popular was this" — it is "did the person I sent it to
     * actually engage". Three visits of one question each is someone bouncing; one
     * visit of nine is someone reading properly, and depth is the stronger signal of
     * the two. Visits ride along on the row because coming back at all still means
     * something; they just don't decide the order.
     */
    private function vipRows(array $visits): array
    {
        $byVip = [];
        $sidsByVip = [];
        foreach ($visits as $v) {
            $id = (int) ($v['vipId'] ?? 0);
            if ($id <= 0) {
                continue;
            }
            if (!isset($byVip[$id])) {
                $byVip[$id] = ['id' => $id, 'name' => '', 'visits' => 0, 'questions' => 0, 'lead' => false, 'last' => '', 'asked' => []];
            }
            $sidsByVip[$id][] = $v['sid'];
            $byVip[$id]['visits']++;
            $byVip[$id]['questions'] += (int) $v['turns'];
            $byVip[$id]['lead'] = $byVip[$id]['lead'] || $v['leadEntryId'] !== null;
            $byVip[$id]['last'] = max($byVip[$id]['last'], (string) $v['startedAt']);
        }

        if (!$byVip) {
            return [];
        }

        // THE QUESTIONS THEMSELVES, for the expandable row under each name. One query
        // for every VIP rather than one per VIP, then split by sid — these lists are
        // short, and a query inside the loop would be a query per person on every
        // dashboard load.
        //
        // Capped per VIP: a door is for one person, so this cannot run away, but an
        // unbounded list would still put an entire conversation history into the page
        // for someone who may never click the name.
        $allSids = array_merge(...array_values($sidsByVip)) ?: [];
        $turnsBySid = [];
        if ($allSids) {
            $rows = (new \craft\db\Query())
                ->select(['sid', 'question', 'askedAt', 'fromChip', 'outcome'])
                ->from(self::TURNS)
                ->where(['sid' => $allSids])
                ->orderBy(['askedAt' => SORT_ASC])
                ->all();
            foreach ($rows as $row) {
                $turnsBySid[$row['sid']][] = $row;
            }
        }

        foreach ($sidsByVip as $id => $sids) {
            $asked = [];
            foreach ($sids as $sid) {
                foreach ($turnsBySid[$sid] ?? [] as $row) {
                    $asked[] = [
                        'question' => (string) $row['question'],
                        'at' => \craft\helpers\DateTimeHelper::toDateTime($row['askedAt'], true) ?: null,
                        // Whether they typed it or took a suggestion — worth seeing on a
                        // VIP, where a chip click means Jonson steered them there.
                        'fromChip' => $row['fromChip'] !== null,
                        'outcome' => (string) $row['outcome'],
                    ];
                }
            }
            usort($asked, static fn($a, $b) => $a['at'] <=> $b['at']);
            $byVip[$id]['asked'] = array_slice($asked, 0, 50);
        }

        // status(null): a door that has since been disabled — which is how a VIP is
        // revoked — should still report the visits it received while it was live.
        $entries = \craft\elements\Entry::find()->id(array_keys($byVip))->status(null)->indexBy('id')->all();
        foreach ($byVip as $id => &$row) {
            $row['name'] = isset($entries[$id]) ? (string) $entries[$id]->title : 'Deleted door';
            // A DateTime, not the raw column. Rows are stored UTC (Db::prepareDateForDb),
            // and handing Twig the bare string would format it as UTC too — an hour or
            // two out, which on a "last seen" is exactly the kind of wrong nobody
            // notices. DateTimeHelper reads it as UTC and the |datetime filter then
            // renders it in the control panel's own timezone.
            $row['last'] = \craft\helpers\DateTimeHelper::toDateTime($row['last'], true) ?: null;
        }
        unset($row);

        usort($byVip, static fn($a, $b) => [$b['questions'], $b['visits']] <=> [$a['questions'], $a['visits']]);

        return $byVip;
    }

    // ——— normalising, so nothing reaches the table longer or odder than the column ———

    /** An id from the client is untrusted: bound the length, keep it to safe characters. */
    private function id(?string $value): ?string
    {
        $value = trim((string) $value);
        if ($value === '' || !preg_match('/^[A-Za-z0-9._-]{1,64}$/', $value)) {
            return null;
        }

        return $value;
    }

    /**
     * Paths only, never absolute URLs, and never a query string.
     *
     * A query string is where personal data ends up by accident (a search term, a
     * token someone pasted), and this table is about which PAGE, not which request.
     * Dropping it means there is nothing to scrub later.
     */
    private function url(?string $value): ?string
    {
        $value = trim((string) $value);
        if ($value === '') {
            return null;
        }

        $path = parse_url($value, PHP_URL_PATH);
        if (!is_string($path)) {
            return null;
        }

        // The homepage arrives as '' from getPathInfo() and as '/' from the client.
        // Both are the same page and both must store as '/', or the homepage shows up
        // as a null origin and drops out of every "where did they start" count.
        $path = '/' . ltrim($path, '/');

        return mb_substr($path, 0, self::URL_MAX);
    }

    private function text(?string $value): ?string
    {
        $value = trim((string) $value);

        return $value === '' ? null : mb_substr($value, 0, 2000);
    }

    private function int($value): ?int
    {
        return $value === null || $value === '' ? null : (int) $value;
    }

    private function json($value): ?string
    {
        if (!is_array($value) || !$value) {
            return null;
        }

        return json_encode(array_values($value), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: null;
    }

    /**
     * Analytics failing must never be a visitor's problem. WARNING, not error: nothing
     * a person can see has gone wrong, and the only cost is a gap in the reporting.
     */
    private function shrug(\Throwable $e, string $where): void
    {
        Craft::warning('[jonson analytics] ' . $where . ' failed: ' . $e->getMessage(), __METHOD__);
    }
}
