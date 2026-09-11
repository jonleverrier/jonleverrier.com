<?php

namespace modules\frontend\helpers;

use craft\elements\Entry;

/**
 * Notes — what the notes channel and its index share.
 */
final class Notes
{
    /**
     * How long a note takes to read, in whole minutes (never below one).
     *
     * Words in the prose — the Summary plus every content block — at 220 a
     * minute; code at half that, since nobody skims a snippet; and a few
     * seconds a picture, tapering from 12 for the first down to 3, so a
     * photo-led note isn't rated a thirty-second read. Counted from the field
     * data, not a render, so the index can price every note without drawing
     * one: stripping tags and splitting a few thousand characters is well
     * under a millisecond per note.
     */
    public static function readingTime(Entry $entry): int
    {
        $wordsPerMinute = 220;
        $words = self::wordCount((string) ($entry->summary ?? ''));
        $codeWords = 0;
        $pictures = 0;

        $blocks = $entry->getFieldValue('caseContent');
        foreach ($blocks ? $blocks->all() : [] as $block) {
            switch ($block->getType()->handle) {
                case 'content':
                    $words += self::wordCount(strip_tags((string) ($block->content ?? '')));
                    break;
                case 'code':
                    $codeWords += self::wordCount((string) ($block->codeSnippet ?? ''));
                    break;
                case 'largeImage':
                case 'legacyImage':
                case 'video':
                case 'lottie':
                    $pictures += 1;
                    break;
                case 'twoUpImage':
                    $pictures += 2;
                    break;
                case 'threeUpImage':
                    $pictures += 3;
                    break;
            }
        }

        $pictureSeconds = 0;
        for ($i = 0; $i < $pictures; $i++) {
            $pictureSeconds += max(3, 12 - $i);
        }

        $seconds = ($words + $codeWords * 2) * 60 / $wordsPerMinute + $pictureSeconds;

        return max(1, (int) ceil($seconds / 60));
    }

    private static function wordCount(string $text): int
    {
        return count(preg_split('/\s+/u', trim($text), -1, PREG_SPLIT_NO_EMPTY) ?: []);
    }
}
