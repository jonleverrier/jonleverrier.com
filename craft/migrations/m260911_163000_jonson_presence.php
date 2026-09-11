<?php

namespace craft\contentmigrations;

use craft\db\Migration;

/**
 * Who is on the site right now.
 *
 * Deliberately NOT a log. One row per active visitor, overwritten on every page they
 * view and deleted once it goes stale, so the table's size is the number of people
 * currently browsing — usually nought, occasionally one. It answers "who is here" and
 * nothing else; it cannot answer "who was here on Tuesday", and that is on purpose:
 * a page-view history is a much bigger thing to keep, and to justify keeping, than a
 * presence light on a dashboard.
 *
 * Keyed on the VISIT (sessionStorage sid, see the analytics migration) where there is
 * one, falling back to the PHP session id for someone who has never opened a chat —
 * presence has to count the person reading a case study, not just the person talking
 * to Jonson.
 *
 * No page-view ping: this is written by a render event on the page the visitor was
 * already asking for, so it costs no extra request.
 */
class m260911_163000_jonson_presence extends Migration
{
    public const PRESENCE = '{{%jonson_presence}}';

    public function safeUp(): bool
    {
        $this->createTable(self::PRESENCE, [
            'id' => $this->primaryKey(),
            // The visitor. Unique — a second page view updates the row rather than
            // adding one, which is what keeps this a snapshot instead of a log.
            'token' => $this->string(64)->notNull(),
            'path' => $this->string(255)->null(),
            'seenAt' => $this->dateTime()->notNull(),
            // Is this person mid-conversation, or just reading? The interesting split
            // on a dashboard, and free to record here.
            'inChat' => $this->boolean()->notNull()->defaultValue(false),
            'dateCreated' => $this->dateTime()->notNull(),
            'dateUpdated' => $this->dateTime()->notNull(),
            'uid' => $this->uid(),
        ]);

        $this->createIndex(null, self::PRESENCE, ['token'], true);
        // Both the "who is here" read and the sweep of stale rows run on this.
        $this->createIndex(null, self::PRESENCE, ['seenAt']);

        return true;
    }

    public function safeDown(): bool
    {
        $this->dropTableIfExists(self::PRESENCE);

        return true;
    }
}
