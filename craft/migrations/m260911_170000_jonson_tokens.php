<?php

namespace craft\contentmigrations;

use craft\db\Migration;

/**
 * What each turn actually cost, in tokens.
 *
 * FOUR COLUMNS, NOT ONE TOTAL, because they are priced differently and a single
 * number can never be turned back into money:
 *
 *   inTokens          base input rate — the messages array, and anything uncached
 *   cacheReadTokens   0.1x base input — the system prefix served from cache
 *   cacheWriteTokens  2x base input (1h TTL) — the prefix being written
 *   outTokens         the completion, the most expensive of the four
 *
 * The whole point of the prompt-cache work is visible in the ratio between the two
 * cache columns: a healthy conversation writes once and reads on every turn after. If
 * cacheWriteTokens starts appearing on every turn, something has begun varying inside
 * the cached block again — which is exactly the bug that was there before, and cost
 * about 60% more per conversation than it needed to.
 *
 * No price stored anywhere. Rates change, they differ per model, and a number baked
 * into a migration in September is wrong by Christmas — the tables record what was
 * spent and leave what it cost to whoever is reading.
 */
class m260911_170000_jonson_tokens extends Migration
{
    public const TURNS = '{{%jonson_turns}}';

    public function safeUp(): bool
    {
        foreach (['inTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outTokens'] as $column) {
            // Nullable, not zero-default: every row written before this migration
            // genuinely has no measurement, and recording that as 0 would quietly drag
            // every average down rather than being excluded from it.
            $this->addColumn(self::TURNS, $column, $this->integer()->null());
        }

        return true;
    }

    public function safeDown(): bool
    {
        foreach (['inTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outTokens'] as $column) {
            $this->dropColumn(self::TURNS, $column);
        }

        return true;
    }
}
