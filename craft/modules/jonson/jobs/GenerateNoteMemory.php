<?php

namespace modules\jonson\jobs;

use Craft;
use craft\elements\Entry;
use craft\queue\BaseJob;
use modules\jonson\Jonson;

/**
 * Write Jonson's memory card for one note — see services\NoteMemory.
 *
 * Queued rather than run inline on save, so saving a note never waits on the
 * model and a failed call can be retried by the queue. `force` regenerates a
 * card that already has content; the after-save path never sets it.
 */
class GenerateNoteMemory extends BaseJob
{
    public int $entryId;
    public bool $force = false;

    public function execute($queue): void
    {
        $entry = Entry::find()->id($this->entryId)->status(null)->one();
        if (!$entry) {
            return; // deleted since it was queued
        }

        $memory = Jonson::getInstance()->noteMemory;
        $wantCard = $this->force || $memory->needs($entry);
        $wantPrompts = $this->force || $memory->needsPrompts($entry);
        if (!$wantCard && !$wantPrompts) {
            return; // filled in meanwhile, unpublished, or the fields aren't there
        }
        if (!$memory->hasEnoughText($entry)) {
            return; // nothing to remember yet — the entry will be saved again when there is
        }
        if ($wantCard) {
            $card = $memory->generate($entry);
            if ($card === null) {
                // Surface it to the queue so it retries with backoff rather than
                // quietly leaving the entry without a memory.
                throw new \RuntimeException('No memory card came back for entry ' . $this->entryId);
            }
            if (!$memory->store($entry, $card)) {
                throw new \RuntimeException('Could not save the memory card on note ' . $this->entryId
                    . ': ' . implode('; ', $entry->getFirstErrors()));
            }
            Craft::info('[jonson] memory card written for note ' . $this->entryId, __METHOD__);
        }
        // The page's own ask-bar questions, from the same text. A second, small
        // call rather than one combined reply, so a bad answer to either can't
        // spoil the other.
        if ($wantPrompts) {
            $prompts = $memory->generatePrompts($entry);
            if ($prompts === null) {
                throw new \RuntimeException('No prompts came back for entry ' . $this->entryId);
            }
            if (!$memory->storePrompts($entry, $prompts)) {
                throw new \RuntimeException('Could not save the prompts on entry ' . $this->entryId
                    . ': ' . implode('; ', $entry->getFirstErrors()));
            }
            Craft::info('[jonson] ' . count($prompts) . ' prompts written for entry ' . $this->entryId, __METHOD__);
        }
    }

    protected function defaultDescription(): ?string
    {
        return 'Writing Jonson’s memory of a page and its ask-bar questions';
    }
}
