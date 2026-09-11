<?php

namespace craft\contentmigrations;

use craft\db\Migration;

/**
 * Jonson conversation analytics — two tables, one per grain.
 *
 * The point of these is to answer questions about the assistant itself rather than
 * about any one visitor: what do people actually ask, which "where next?" chips get
 * used, where do conversations start, how far do they get, and do any of them turn
 * into a lead. Everything here already passed through AskController; none of it was
 * kept beyond the 3h cache TTL.
 *
 * WHY TWO TABLES. Chips and questions are facts about a TURN; origin, exit and
 * conversion are facts about a VISIT. Flattening them either repeats the visit columns
 * on every turn or loses the per-turn detail, and the queries worth running ("chip
 * click-through", "drop-off by turn") need both grains.
 *
 * WHY NOT CRAFT ENTRIES. A section would put these in the CP for free, but it is one
 * element (and its revisions, search index and element-index rows) per row, on a table
 * that grows with every question anyone asks. These are events, not content.
 *
 * IDENTIFIERS — the distinction matters and is easy to get wrong:
 *
 *   cid   localStorage `jonson.cid`. Durable per browser: minted once and rotated only
 *         by a thread wipe. It is the VISITOR, and it is what makes "were they
 *         returning" answerable. It is NOT a conversation id, despite the name it
 *         carries in the client.
 *   sid   sessionStorage `jonson.sid`. Per tab, dies with it, survives navigation
 *         within the visit — the same semantics the thread snapshot beside it already
 *         relies on. This is the VISIT, and what these tables are keyed on.
 *
 * Neither is a cookie and neither is new storage: cid already existed, sid is minted in
 * the same sessionStorage the thread snapshot and the nudge allowance already use.
 */
class m260911_150000_jonson_analytics extends Migration
{
    public const VISITS = '{{%jonson_visits}}';
    public const TURNS = '{{%jonson_turns}}';

    public function safeUp(): bool
    {
        $this->createTable(self::VISITS, [
            'id' => $this->primaryKey(),
            // The visit. Unique: every turn of a visit updates this one row.
            'sid' => $this->string(64)->notNull(),
            // The visitor (see the class note). Nullable because localStorage can be
            // blocked, and a visit we can't attribute is still worth recording.
            'cid' => $this->string(64)->null(),
            'startedAt' => $this->dateTime()->notNull(),
            // Moved on every turn, so a visit that is never formally ended still has
            // a last-seen time — nobody clicks "end conversation".
            'endedAt' => $this->dateTime()->notNull(),
            'turns' => $this->integer()->notNull()->defaultValue(0),
            // Where the conversation began: the URL, and the entry whose ask bar was
            // used (null for the homepage front door, which has no entry behind it).
            'originUrl' => $this->string(255)->null(),
            'originEntryId' => $this->integer()->null(),
            // The VIP door, if they came through one.
            'vipId' => $this->integer()->null(),
            // How many "lost for words" prompts they burned — the read on whether that
            // drawer is doing a job or just being played with.
            'promptUses' => $this->integer()->notNull()->defaultValue(0),
            // Where they were when they last spoke, and where they went if we saw them
            // go (the exit beacon). exitTo stays null for a closed tab, which is the
            // honest answer rather than a guess.
            'exitUrl' => $this->string(255)->null(),
            'exitTo' => $this->string(255)->null(),
            // The CRM entry this conversation turned into, if it did. Stamped by
            // CrmController — the only reason lead capture touches this at all.
            'leadEntryId' => $this->integer()->null(),
            'dateCreated' => $this->dateTime()->notNull(),
            'dateUpdated' => $this->dateTime()->notNull(),
            'uid' => $this->uid(),
        ]);

        // One row per visit, and the lookup every turn does.
        $this->createIndex(null, self::VISITS, ['sid'], true);
        // "Were they returning" is a query over one visitor's visits.
        $this->createIndex(null, self::VISITS, ['cid']);
        // Reporting by period, and "which conversations became leads".
        $this->createIndex(null, self::VISITS, ['startedAt']);
        $this->createIndex(null, self::VISITS, ['leadEntryId']);

        $this->createTable(self::TURNS, [
            'id' => $this->primaryKey(),
            'sid' => $this->string(64)->notNull(),
            'turn' => $this->integer()->notNull(),
            'askedAt' => $this->dateTime()->notNull(),
            'question' => $this->text()->null(),
            // Did this question come from a chip rather than the keyboard, and which
            // one — position is what tells you whether anything past the first is ever
            // read. Null means typed.
            'fromChip' => $this->integer()->null(),
            // What was offered AFTER this answer, as a JSON array. Offered-vs-taken is
            // the whole measure of whether the chips are any good, and it can only be
            // computed if the ones nobody clicked were recorded too.
            'chipsOffered' => $this->text()->null(),
            // Which panels went on screen (casestudies, testimonial, contact, …), JSON.
            'surfaces' => $this->text()->null(),
            'pageUrl' => $this->string(255)->null(),
            // How the turn was answered: 'answered', or one of the paths that costs no
            // API call — 'junk', 'repeat', 'cached', 'rateLimited', 'apiError'. Without
            // this, a question that was never really answered looks like one that was.
            'outcome' => $this->string(20)->notNull()->defaultValue('answered'),
            'answerWords' => $this->integer()->null(),
            // Wall-clock milliseconds for the turn — the cheap read on whether answers
            // are getting slower.
            'ms' => $this->integer()->null(),
            'dateCreated' => $this->dateTime()->notNull(),
            'dateUpdated' => $this->dateTime()->notNull(),
            'uid' => $this->uid(),
        ]);

        // Every turn of one visit, in order — the join these tables exist for.
        $this->createIndex(null, self::TURNS, ['sid', 'turn']);
        $this->createIndex(null, self::TURNS, ['askedAt']);
        // "What is being asked" groups on this. MySQL can't index a TEXT column
        // without a prefix length, and Yii's createIndex() has no syntax for one — it
        // takes column NAMES only — so this is raw SQL. 191 chars is the old
        // utf8mb4 index-length ceiling and comfortably longer than any real question.
        $this->execute(
            'CREATE INDEX `idx_jonson_turns_question` ON ' . $this->db->quoteTableName(self::TURNS) . ' (`question`(191))',
        );

        return true;
    }

    public function safeDown(): bool
    {
        $this->dropTableIfExists(self::TURNS);
        $this->dropTableIfExists(self::VISITS);

        return true;
    }
}
