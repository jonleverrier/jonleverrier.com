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

        return $this->directives()
            . "\n\n" . $personality
            . "\n\n" . $this->nowContext();
    }

    /**
     * A live date/time signal so Jonson gets the time of day (and day/date) right
     * when he mentions it. Uses Craft's system timezone (Settings → General) purely
     * for the CLOCK — it must NOT be used to name a location: the zone is
     * "Europe/Paris", which would read as "Paris", whereas his actual city lives in
     * the CMS personality field. Built fresh on every request (the system prompt
     * isn't cached), so it's always current — without it the model guesses "morning".
     */
    private function nowContext(): string
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
