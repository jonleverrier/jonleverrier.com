<?php

namespace modules\jonson\console\controllers;

use craft\console\Controller;
use craft\elements\Entry;
use craft\helpers\Console;
use modules\jonson\Jonson;
use yii\console\ExitCode;

/**
 * Jonson's note memories from the command line.
 *
 *   craft jonson/memory/generate                      every live note missing a card
 *   craft jonson/memory/generate --section=caseStudies  the case studies instead
 *   craft jonson/memory/generate --section=all
 *   craft jonson/memory/generate --entry-id=1580        one entry
 *   craft jonson/memory/generate --force              rewrite cards AND prompts that already exist
 *   craft jonson/memory/generate --force --promptsOnly  rewrite only the ask-bar prompts (cards kept)
 *   craft jonson/memory/rebuild                       every note AND study, rewritten — the
 *                                                     same as generate --section=all --force
 *   craft jonson/memory/show [--section=…]            print every card the persona sees
 *
 * Runs the model call directly rather than queueing, so the result is on
 * screen — this is the backfill and the "let me see it" tool.
 */
class MemoryController extends Controller
{
    // `entryId`, not `id` — yii's base Controller already owns `$id`.
    public ?int $entryId = null;
    public bool $force = false;
    public bool $promptsOnly = false; // with --force: leave the cards alone (they may be Jon's edits)
    public string $section = 'notes';

    public function options($actionID): array
    {
        return array_merge(parent::options($actionID), ['entryId', 'force', 'section', 'promptsOnly']);
    }

    /** The sections the option names: one, or all that take cards. */
    private function sections(): array
    {
        $known = array_keys(\modules\jonson\services\NoteMemory::SECTIONS);
        if ($this->section === 'all') {
            return $known;
        }
        if (!in_array($this->section, $known, true)) {
            $this->stderr("Unknown section '{$this->section}' — one of: " . implode(', ', $known) . ", all\n", Console::FG_RED);
            return [];
        }
        return [$this->section];
    }

    public function actionGenerate(): int
    {
        $memory = Jonson::getInstance()->noteMemory;
        if (!$memory->available()) {
            $this->stderr("The jonsonSummary field doesn't exist yet — add it to the Note entry type first.\n", Console::FG_RED);
            return ExitCode::CONFIG;
        }

        $sections = $this->sections();
        if (!$sections) {
            return ExitCode::USAGE;
        }
        $query = Entry::find()->section($sections)->status(Entry::STATUS_LIVE);
        if ($this->entryId) {
            $query->id($this->entryId);
        }

        $done = 0;
        $promptsDone = 0;
        foreach ($query->all() as $entry) {
            $hasCard = trim((string) $entry->getFieldValue($memory::FIELD)) !== '';
            $canPrompt = (bool) $entry->getFieldLayout()?->getFieldByHandle($memory::PROMPTS_FIELD);
            $wantCard = $this->promptsOnly ? false : ($this->force || !$hasCard);
            $wantPrompts = $canPrompt && ($this->force || !$memory->hasPrompts($entry));
            if (!$wantCard && !$wantPrompts) {
                $this->stdout("· {$entry->title} — has " . ($this->promptsOnly ? "prompts" : "a card and prompts") . ", skipped (use --force to rewrite)\n", Console::FG_GREY);
                continue;
            }
            $this->stdout("→ {$entry->title} … ");
            if (!$memory->hasEnoughText($entry)) {
                $this->stdout("too little text to remember anything from (" . $memory->sourceWords($entry)
                    . " words, needs " . $memory->minSourceWords($entry) . "; placeholder copy counts as none), skipped\n", Console::FG_YELLOW);
                continue;
            }
            if ($wantCard) {
                $card = $memory->generate($entry);
                if ($card === null) {
                    $this->stdout("no card came back (see the log)\n", Console::FG_RED);
                    continue;
                }
                if (!$memory->store($entry, $card)) {
                    $this->stdout("could not save: " . implode('; ', $entry->getFirstErrors()) . "\n", Console::FG_RED);
                    continue;
                }
                $this->stdout("card written (" . str_word_count($card) . " words)\n", Console::FG_GREEN);
                $this->stdout("  " . wordwrap($card, 96, "\n  ") . "\n");
                $done++;
            } else {
                $this->stdout("has a card; ");
            }
            if ($wantPrompts) {
                $prompts = $memory->generatePrompts($entry);
                if ($prompts === null) {
                    $this->stdout("no prompts came back (see the log)\n", Console::FG_RED);
                    continue;
                }
                if (!$memory->storePrompts($entry, $prompts)) {
                    $this->stdout("could not save prompts: " . implode('; ', $entry->getFirstErrors()) . "\n", Console::FG_RED);
                    continue;
                }
                $this->stdout(count($prompts) . " prompts written\n", Console::FG_GREEN);
                foreach ($prompts as $q) {
                    $this->stdout("  ? {$q}\n");
                }
                $promptsDone++;
            }
        }
        $this->stdout("{$done} card(s), {$promptsDone} prompt set(s) written.\n");
        return ExitCode::OK;
    }

    /** Rewrite every card, notes and studies alike — after a change to the brief. */
    public function actionRebuild(): int
    {
        $this->section = 'all';
        $this->force = true;

        return $this->actionGenerate();
    }

    public function actionShow(): int
    {
        $cards = [];
        foreach ($this->sections() as $section) {
            $cards = array_merge($cards, Jonson::getInstance()->noteMemory->cards($section));
        }
        if (!$cards) {
            $this->stdout("No cards yet.\n");
            return ExitCode::OK;
        }
        foreach ($cards as $card) {
            $this->stdout("{$card['title']} ({$card['posted']})\n", Console::FG_YELLOW);
            $this->stdout("  " . wordwrap($card['memory'], 96, "\n  ") . "\n\n");
        }
        return ExitCode::OK;
    }
}
