<?php

namespace craft\contentmigrations;

use craft\db\Migration;

/**
 * WHY a question went unanswered, beside the outcome that says it did.
 *
 * The dashboard said "1 answer failed — visitors saw the fallback" and nothing else:
 * no question, no cause, nothing to do (Jon, 3 Oct 2026). The cause was only in the
 * server log. Now each apiError / rateLimited turn carries a short reason —
 * timeout, overloaded:529, anthropic:500, auth:401, request:400, stream:<type>,
 * connection, empty, rateLimit — which the widget turns into words and advice
 * (Analytics::incidents).
 *
 * Earlier failures have no reason. One is inferable: an apiError that took 10–12 s is
 * the 10-second wait for Anthropic running out (AskController's Guzzle `timeout`), so
 * those are backfilled as 'timeout'. The rest stay null and read as "not recorded".
 */
class m261003_100000_jonson_fail_reason extends Migration
{
    public const TURNS = '{{%jonson_turns}}';

    public function safeUp(): bool
    {
        $this->addColumn(self::TURNS, 'failReason', $this->string(64)->null());
        $this->update(self::TURNS, ['failReason' => 'timeout'], ['and',
            ['outcome' => 'apiError'],
            ['between', 'ms', 10000, 12000],
        ], [], false);
        $this->update(self::TURNS, ['failReason' => 'rateLimit'], ['outcome' => 'rateLimited'], [], false);

        return true;
    }

    public function safeDown(): bool
    {
        $this->dropColumn(self::TURNS, 'failReason');

        return true;
    }
}
