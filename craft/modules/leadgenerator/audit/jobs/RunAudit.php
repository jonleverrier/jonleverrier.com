<?php

namespace modules\leadgenerator\audit\jobs;

use Craft;
use craft\elements\Entry;
use craft\queue\BaseJob;
use modules\leadgenerator\LeadGenerator;

/**
 * RUN AUDIT
 *
 * Takes a submitted entry from `submitted` to `ready` — or to `failed`, which is a
 * destination and not an accident.
 *
 * FAILING IS A STATE, NOT AN ERROR. Three of twenty-seven real homepages answered 403 to
 * the crawler and one served an error page with a 200. Those are ordinary outcomes for a
 * form anybody can paste a URL into, and the right response to them is a human looking at
 * it: an entry marked `failed` with a reason in `auditFailure` is in front of Jon in the
 * control panel, where he can re-run it, send something by hand, or reach out. A queue job
 * that threw would put the same information in a log instead.
 *
 * It is also why the deferred product question stayed deferrable. Nobody had to decide in
 * advance what a prospect sees when their CDN blocks us, because nothing is sent without a
 * person approving it.
 *
 * THE JOB NEVER THROWS for the same reason. A Craft queue job that throws is retried and
 * then marked failed in a table; this writes what happened onto the entry and returns.
 */
class RunAudit extends BaseJob
{
    /** The subdirectory a competitor's artefacts are measured into. */
    public const COMPETITOR = 'competitor';

    public int $entryId;

    public function execute($queue): void
    {
        $entry = Craft::$app->getEntries()->getEntryById($this->entryId);
        if (!$entry) {
            Craft::error("[leadgenerator] audit {$this->entryId} has no entry", __METHOD__);

            return;
        }

        $url = trim((string) $entry->auditUrl);
        if ($url === '') {
            $this->finish($entry, 'failed', 'no URL was submitted');

            return;
        }

        // NO INTERIM STATUS. This wrote `capturing` here and the entry sat in it for the
        // minute the audit takes; the queue's own progress already says the job is running,
        // and a status nobody acts on is a row in a dropdown that can never be chosen by
        // hand. An entry now goes straight from `submitted` to `ready` or `failed`.
        //
        // What went with it: a re-run of a failed audit keeps the old `auditFailure` text on
        // screen until the job finishes, because that blanking happened here.
        $this->progress($queue, 0.05, 'capturing');

        $audit = LeadGenerator::getInstance()->audit;
        $result = $audit->measure($url, (int) $entry->id);

        if (!$result['ok']) {
            $this->finish($entry, 'failed', (string) $result['why']);

            return;
        }

        // A COMPETITOR THAT FAILS MUST NOT COST THE LEAD THEIR OWN REPORT. It is an optional
        // extra on a document that stands up without it, and the site is somebody else's: it
        // can block a crawler, time out, or have been typed wrong, none of which is the
        // lead's doing. So it is measured, and a failure is written down and stepped over.
        // The template prints the comparison only when there is something to compare.
        $rival = trim((string) $entry->auditCompetitorUrl);
        $rivalWhy = null;
        if ($rival !== '') {
            $this->progress($queue, 0.45, 'capturing the competitor');
            $measured = $audit->measure($rival, (int) $entry->id, self::COMPETITOR);
            if (!$measured['ok']) {
                // NAME THE SITE AND THE COST. This lands in auditFailure on an audit that
                // otherwise succeeded, beside the lead's own URL — "competitor analyse:
                // the server answered 500" read as the lead's site failing.
                $host = parse_url($rival, PHP_URL_HOST) ?: $rival;
                $rivalWhy = "Competitor {$host} could not be measured, so the report has no "
                    . "comparison. {$measured['why']}";
                Craft::warning("[leadgenerator] audit {$entry->id} {$rivalWhy}", __METHOD__);
            }
        }

        // THE COVER'S FINDINGS, now that every site it can compare is on disk. Stepped over
        // on failure: a cover with no findings is a poorer report than this one, and not a
        // reason to lose a document that is otherwise sound.
        $chosen = $audit->summarise((int) $entry->id);
        if (!$chosen['ok']) {
            Craft::warning("[leadgenerator] audit {$entry->id} summary: {$chosen['why']}", __METHOD__);
        }

        // PRINTED ONCE, AFTER BOTH. One lead, one document, however many sites it covers.
        $this->progress($queue, 0.8, 'printing the report');
        $result = $audit->print((int) $entry->id);

        if (!$result['ok']) {
            $this->finish($entry, 'failed', (string) $result['why']);

            return;
        }

        $this->progress($queue, 0.9, 'attaching the report');
        $asset = $audit->attachReport($entry, (string) $result['pdf']);
        if (!$asset) {
            // The measurement survived and only the filing of it did not, so this is worth
            // saying precisely: there is a report on disk that could still be sent by hand.
            $this->finish($entry, 'failed', 'the report rendered but could not be saved to the assets volume');

            return;
        }

        $this->save($entry, [
            // `in-review` AND NOT `ready`: the report exists, and the next thing that has
            // to happen is a person reading it. The status names whose move it is.
            'auditStatus' => 'in-review',
            // A competitor that could not be measured is the one thing worth saying on an
            // otherwise successful audit: the report is sound, and the comparison the lead
            // asked for is not in it.
            'auditFailure' => $rivalWhy ?? '',
            'auditReport' => [$asset->id],
        ]);
    }

    /**
     * Progress, when there is a queue to report it to.
     *
     * The console runner executes this job synchronously with no queue — which is the only
     * way to watch an audit actually happen, and how a failed one is given another go —
     * and `setProgress` requires one. Reporting nowhere is the right answer there, not a
     * TypeError.
     */
    private function progress($queue, float $done, string $label): void
    {
        if ($queue !== null) {
            $this->setProgress($queue, $done, $label);
        }
    }

    protected function defaultDescription(): string
    {
        return 'Auditing a homepage';
    }

    private function finish(Entry $entry, string $status, string $why): void
    {
        Craft::warning("[leadgenerator] audit {$entry->id} {$status}: {$why}", __METHOD__);
        $this->save($entry, ['auditStatus' => $status, 'auditFailure' => $why]);
    }

    /**
     * Save field values without disturbing anything else on the entry.
     *
     * `setFieldValues` merges, so a status written here cannot blank the email or the note
     * Jon may have typed while the job was running.
     */
    private function save(Entry $entry, array $values): void
    {
        $entry->setFieldValues($values);
        if (!Craft::$app->getElements()->saveElement($entry)) {
            Craft::error(
                "[leadgenerator] could not save audit {$entry->id}: " . json_encode($entry->getErrors()),
                __METHOD__,
            );
        }
    }
}
