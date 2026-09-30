<?php

namespace modules\jonson\jobs;

use craft\elements\Entry;
use craft\queue\BaseJob;
use modules\jonson\Jonson;

/**
 * Pick the case studies a VIP would find relevant — see services\Vip::relevantStudies.
 * Queued after the entry is saved (and on a chat that finds no pick cached), so the
 * model call never sits on a visitor's clock.
 */
class PickVipStudies extends BaseJob
{
    public int $entryId;

    public function execute($queue): void
    {
        $entry = Entry::find()->id($this->entryId)->status(null)->one();
        if (!$entry) {
            return;
        }
        if (Jonson::getInstance()->vip->pickStudies($entry) === null) {
            throw new \RuntimeException('No study pick came back for VIP entry ' . $this->entryId);
        }
    }

    protected function defaultDescription(): ?string
    {
        return 'Picking the case studies a VIP would find relevant';
    }
}
