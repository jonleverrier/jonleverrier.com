<?php

namespace craft\contentmigrations;

use craft\db\Migration;

/**
 * Index `jonson_visits.vipId`.
 *
 * The dashboard widget renders all three segments up front, and two of them filter on
 * this column — `WHERE vipId IS NULL` for General, `IS NOT NULL` for VIPs — so it is
 * read twice on every load. Without an index both are full table scans.
 *
 * Invisible at the row counts this table has today and a real cost once it has grown,
 * which is exactly the sort of thing that never gets noticed until the table is big
 * enough that adding the index is itself disruptive. Cheap now, so now.
 *
 * The monthly-token subquery filters on the same column, which makes it three reads a
 * load rather than two.
 *
 * NOT a composite with startedAt, though every one of those queries also has a date
 * bound. MySQL will use the startedAt index for the range and this one for the segment,
 * and a composite would have to pick an order that suits one query at the expense of
 * the others — the table is small enough that the single-column index is the honest
 * choice until a query plan says otherwise.
 */
class m260911_180000_jonson_vipid_index extends Migration
{
    public const VISITS = '{{%jonson_visits}}';

    /**
     * NAMED, not null. Passing null lets Craft generate a random name — the other
     * indexes on this table are `idx_yrbmbclubynhdemedhbylgyylufadhxpyarg` and friends —
     * which leaves safeDown() with nothing it can reliably drop.
     */
    private const INDEX = 'idx_jonson_visits_vipId';

    public function safeUp(): bool
    {
        $this->createIndex(self::INDEX, self::VISITS, ['vipId']);

        return true;
    }

    public function safeDown(): bool
    {
        $this->dropIndex(self::INDEX, self::VISITS);

        return true;
    }
}
