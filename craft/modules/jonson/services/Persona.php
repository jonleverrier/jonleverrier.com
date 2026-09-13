<?php

namespace modules\jonson\services;

use Craft;
use craft\elements\Entry;
use yii\base\Component;

/**
 * Builds the system prompt for Jonson.
 *
 * Composition:
 *   [ code-owned directives ]  — prompts/directives.md, version-controlled,
 *                                deployed with the module, not CP-editable
 * + [ CMS personality ]        — the "personality" single's `personality` field
 *
 * Per-company /loves overlays will append to this later (Phase 3).
 */
class Persona extends Component
{
    public function prompt(): string
    {
        $personality = trim($this->personality() ?? '');

        // NO nowContext() HERE. This is the CACHED block (AskController sets the
        // cache_control breakpoint on it), and the clock changes every minute — so
        // appending it re-keyed 25,400 tokens on almost every turn, at 2x input, to
        // save nothing. Measured before the move: 551,437 tokens written against
        // 50,126 read back, a ratio of 0.09 where a conversation should write once and
        // read on every turn after. The two turns that DID hit the cache were the ones
        // asked within the same minute as the turn before them.
        //
        // It is served from nowContext() into the volatile block instead — same text,
        // same position in the prompt, just after the breakpoint. See AskController.
        return $this->directives()
            . "\n\n" . $personality;
    }

    /**
     * A live date/time signal so Jonson gets the time of day (and day/date) right
     * when he mentions it. Uses Craft's system timezone (Settings → General) purely
     * for the CLOCK — it must NOT be used to name a location: the zone is
     * "Europe/Paris", which would read as "Paris", whereas his actual city lives in
     * the CMS personality field.
     *
     * PUBLIC, and it goes in the VOLATILE block. It used to be appended to prompt()
     * under a comment reading "the system prompt isn't cached" — true when it was
     * written, and false from the moment the cache breakpoint was added. A clock
     * accurate to the minute inside a cached prefix means the prefix is never the same
     * twice. Anything that moves belongs after the breakpoint, not before it.
     */
    public function nowContext(): string
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone(Craft::$app->getTimeZone()));
        $hour = (int) $now->format('G');
        $partOfDay = match (true) {
            $hour < 5  => 'the middle of the night',
            $hour < 12 => 'morning',
            $hour < 17 => 'afternoon',
            $hour < 21 => 'evening',
            default    => 'late evening',
        };

        return 'Current moment (use this whenever you naturally reference the time or '
            . 'the day/date, and never assume it is morning): it is '
            . $now->format('l, j F Y, g:i a') . ' where you are — ' . $partOfDay . '.';
    }

    /**
     * Load the code-owned directives (safety rails + framing) from
     * `prompts/directives.md`. Version-controlled and deployed with the module;
     * not editable from the control panel. Throws if the file is missing or
     * empty so we never ship a persona with no rails — AskController catches
     * this and surfaces the "not configured" error instead of answering.
     */
    private function directives(): string
    {
        $path = __DIR__ . '/../prompts/directives.md';
        $raw = is_file($path) ? (string) file_get_contents($path) : '';

        // Strip HTML comments so `<!-- … -->` authoring notes (e.g. the reminder
        // at the top of directives.md not to bake in specific personal examples)
        // never reach the model.
        $text = trim((string) preg_replace('/<!--.*?-->/s', '', $raw));

        if ($text === '') {
            throw new \RuntimeException("Jonson directives file missing or empty: {$path}");
        }

        return $text;
    }

    /**
     * Read the editable persona from the "personality" single's `personality`
     * field.
     */
    private function personality(): ?string
    {
        $entry = Entry::find()->section('personality')->one();

        return $entry?->personality;
    }
}
