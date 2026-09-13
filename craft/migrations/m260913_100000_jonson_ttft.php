<?php

namespace craft\contentmigrations;

use craft\db\Migration;

/**
 * How long a visitor waits before Jonson starts saying anything.
 *
 * `ms` already records the whole turn, and it is the wrong number for this question:
 * it runs until the last token, so a long answer scores worse than a short one even
 * when both began replying instantly. Nobody sits there feeling the length of a reply
 * they are already reading — what is felt is the silence before the first word.
 *
 * So this is measured to the FIRST streamed token, from the same clock `ms` starts on
 * (before any work, not at the API call), which makes the gap between the two columns
 * readable as "getting ready" versus "writing". A rise in ttftMs with `ms` flat is a
 * cache miss or a slow persona build; both rising together is the model.
 *
 * NULLABLE, and it stays null for the degraded replies. The junk gate and the API-error
 * reply answer without calling the model at all, so they have no first token to wait
 * for — recording their near-zero as a measurement would drag the median down and hide
 * exactly the slowness this is meant to expose. Every row written before this migration
 * is null for the same reason: it was never measured.
 */
class m260913_100000_jonson_ttft extends Migration
{
    public const TURNS = '{{%jonson_turns}}';

    public function safeUp(): bool
    {
        $this->addColumn(self::TURNS, 'ttftMs', $this->integer()->null());

        return true;
    }

    public function safeDown(): bool
    {
        $this->dropColumn(self::TURNS, 'ttftMs');

        return true;
    }
}
