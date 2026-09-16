<?php

namespace modules\jonson\console\controllers;

use craft\console\Controller;
use craft\helpers\Console;
use modules\jonson\services\Analytics;
use yii\console\ExitCode;

/**
 * The dashboard's own data, from the command line.
 *
 *   craft jonson/analytics/stats                     what is in there, per table
 *   craft jonson/analytics/purge                     DRY RUN — says what it would delete
 *   craft jonson/analytics/purge --yes               actually delete it
 *   craft jonson/analytics/purge --table=presence    one table instead of all three
 *   craft jonson/analytics/purge --before=2026-09-01 only rows older than a date
 *
 * A command rather than SQL at a prod prompt, because this is the kind of thing that
 * gets run once, in a hurry, against the wrong database. Here the connection, the
 * table prefix and the table names all come from the same place the app uses, the
 * default is a dry run, and what happened is on screen afterwards.
 *
 * WHAT THIS DELETES, and what it does not:
 *
 *   jonson_visits    one row per visit — cid, origin, VIP, lead attribution
 *   jonson_turns     one row per question asked
 *   jonson_presence  the live "who is on the site" window (5 minutes; self-clearing)
 *
 * The tables carry no foreign keys and are joined on `sid` alone, so there is nothing
 * to cascade and no order to respect. Craft's own content is untouched — but note that
 * a visit row is what ties a lead ENTRY back to the conversation that produced it
 * (Analytics::convert writes leadEntryId). The entries survive; the trail to them does
 * not. That is the one thing here that cannot be reconstructed from anywhere else.
 */
class AnalyticsController extends Controller
{
    /** Without this it is a dry run. Deleting production data should take a keystroke. */
    public bool $yes = false;

    /** 'all' (default), or one of visits | turns | presence. */
    public string $table = 'all';

    /** Only rows older than this date (Y-m-d). Omit for everything. */
    public ?string $before = null;

    public function options($actionID): array
    {
        return array_merge(parent::options($actionID), ['yes', 'table', 'before']);
    }

    /**
     * The tables this run covers, as name => [table, dateColumn].
     *
     * The date column differs per table and is named here rather than guessed, so
     * --before cannot silently match nothing: `startedAt` is when a visit began,
     * `askedAt` when a question was asked, `seenAt` when presence was last touched.
     */
    private function targets(): array
    {
        $all = [
            'visits' => [Analytics::VISITS, 'startedAt'],
            'turns' => [Analytics::TURNS, 'askedAt'],
            'presence' => [Analytics::PRESENCE, 'seenAt'],
        ];

        if ($this->table === 'all') {
            return $all;
        }

        return isset($all[$this->table]) ? [$this->table => $all[$this->table]] : [];
    }

    /** Row count, or null where the table isn't there (a database that never migrated). */
    private function count(string $table, ?string $dateColumn = null): ?int
    {
        $db = \Craft::$app->getDb();
        if (!$db->tableExists($table)) {
            return null;
        }

        $query = (new \craft\db\Query())->from($table);
        if ($this->before !== null && $dateColumn !== null) {
            $query->where(['<', $dateColumn, $this->before]);
        }

        return (int) $query->count();
    }

    /** What is in there. Read-only — safe to run anywhere, including prod. */
    public function actionStats(): int
    {
        $targets = $this->targets();
        if (!$targets) {
            $this->stderr("Unknown --table: {$this->table} (use all, visits, turns or presence)\n", Console::FG_RED);
            return ExitCode::USAGE;
        }

        $this->stdout("\nJonson analytics — " . \Craft::$app->getDb()->dsn . "\n\n", Console::FG_GREY);

        foreach ($targets as $name => [$table, $dateColumn]) {
            $total = $this->count($table);
            if ($total === null) {
                $this->stdout(sprintf("  %-10s table not present\n", $name), Console::FG_YELLOW);
                continue;
            }
            $this->stdout(sprintf("  %-10s %d rows\n", $name, $total));
        }

        $this->stdout("\n");
        return ExitCode::OK;
    }

    /**
     * Delete it. Dry run unless --yes.
     *
     * TRUNCATE for a whole table, DELETE for a --before window: truncate also resets
     * the auto-increment, which is what you want for a reset and wrong for a trim —
     * new rows would take ids that old ones already used, and anything holding an id
     * from before would start pointing at a different row.
     */
    public function actionPurge(): int
    {
        $targets = $this->targets();
        if (!$targets) {
            $this->stderr("Unknown --table: {$this->table} (use all, visits, turns or presence)\n", Console::FG_RED);
            return ExitCode::USAGE;
        }

        if ($this->before !== null && strtotime($this->before) === false) {
            $this->stderr("Unreadable --before: {$this->before} (expected Y-m-d)\n", Console::FG_RED);
            return ExitCode::USAGE;
        }

        $db = \Craft::$app->getDb();
        $scope = $this->before !== null ? "rows before {$this->before}" : 'ALL rows';

        $this->stdout("\n" . ($this->yes ? 'Purging ' : 'DRY RUN — would purge ') . $scope . "\n");
        $this->stdout('  database: ' . $db->dsn . "\n\n", Console::FG_GREY);

        $affected = 0;
        foreach ($targets as $name => [$table, $dateColumn]) {
            $count = $this->count($table, $dateColumn);
            if ($count === null) {
                $this->stdout(sprintf("  %-10s table not present, skipped\n", $name), Console::FG_YELLOW);
                continue;
            }

            if (!$this->yes) {
                $this->stdout(sprintf("  %-10s %d rows would go\n", $name, $count));
                continue;
            }

            if ($this->before !== null) {
                $db->createCommand()->delete($table, ['<', $dateColumn, $this->before])->execute();
            } else {
                $db->createCommand()->truncateTable($table)->execute();
            }

            $affected += $count;
            $this->stdout(sprintf("  %-10s %d rows deleted\n", $name, $count), Console::FG_GREEN);
        }

        if (!$this->yes) {
            $this->stdout("\nNothing was deleted. Add --yes to do it.\n", Console::FG_YELLOW);
            return ExitCode::OK;
        }

        $this->stdout("\n{$affected} rows deleted.\n", Console::FG_GREEN);
        return ExitCode::OK;
    }
}
