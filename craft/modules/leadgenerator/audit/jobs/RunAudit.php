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

        $this->progress($queue, 0.05, 'capturing');
        $this->save($entry, ['auditStatus' => 'capturing', 'auditFailure' => '']);

        $audit = LeadGenerator::getInstance()->audit;
        $result = $audit->run($url, (int) $entry->id);

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
            'auditStatus' => 'ready',
            'auditFailure' => '',
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
