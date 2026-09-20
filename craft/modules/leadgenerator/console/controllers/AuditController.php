<?php

namespace modules\leadgenerator\console\controllers;

use Craft;
use craft\console\Controller;
use craft\elements\Entry;
use craft\helpers\Console;
use modules\leadgenerator\audit\jobs\RunAudit;
use yii\console\ExitCode;

/**
 * Running an audit without a form.
 *
 *   craft/craft leadgenerator/audit/run https://example.com
 *   craft/craft leadgenerator/audit/rerun 1234
 *   craft/craft leadgenerator/audit/list
 *
 * TWO JOBS, AND BOTH ARE REAL. It is the only way to exercise the pipeline before a form
 * exists, and it is how a failed audit gets another go afterwards — captures fail for
 * transient reasons, and a prospect should not be lost to one. The re-run costs a capture
 * and usually not a model call: an unchanged page reuses its stored answer, which is what
 * lib/signature.mjs is for.
 *
 * SYNCHRONOUS ON PURPOSE. The queue would swallow the output, and the output is the point
 * when you are trying to find out why something did not work.
 */
class AuditController extends Controller
{
    /** Run an audit for a URL, making an entry for it first. */
    public function actionRun(string $url): int
    {
        $section = Craft::$app->getEntries()->getSectionByHandle('leadGenerator');
        $entryType = Craft::$app->getEntries()->getEntryTypeByHandle('auditEntry');
        if (!$section || !$entryType) {
            $this->stderr("no leadGenerator section or auditEntry type\n", Console::FG_RED);

            return ExitCode::UNSPECIFIED_ERROR;
        }

        $entry = new Entry();
        $entry->sectionId = $section->id;
        $entry->typeId = $entryType->id;
        $entry->enabled = false;
        $entry->setFieldValues([
            'auditUrl' => $url,
            'auditStatus' => 'submitted',
            'firstName' => 'Console',
            'email' => 'console@example.com',
        ]);
        if (!Craft::$app->getElements()->saveElement($entry)) {
            $this->stderr('could not save: ' . json_encode($entry->getErrors()) . "\n", Console::FG_RED);

            return ExitCode::UNSPECIFIED_ERROR;
        }
        $this->stdout("entry {$entry->id} created\n");

        return $this->actionRerun((int) $entry->id);
    }

    /** Run, or run again, the audit on an existing entry. */
    public function actionRerun(int $entryId): int
    {
        $entry = Craft::$app->getEntries()->getEntryById($entryId);
        if (!$entry) {
            $this->stderr("no entry {$entryId}\n", Console::FG_RED);

            return ExitCode::UNSPECIFIED_ERROR;
        }
        $this->stdout('auditing ' . $entry->auditUrl . " — this takes a couple of minutes\n");

        $started = time();
        (new RunAudit(['entryId' => $entryId]))->execute(null);

        // Read it back rather than trusting the object we handed to the job: what matters
        // is what was actually written down.
        $after = Craft::$app->getEntries()->getEntryById($entryId);
        $status = (string) $after->auditStatus?->value;
        $took = time() - $started;

        $this->stdout("status       {$status}   ({$took}s)\n", $status === 'ready' ? Console::FG_GREEN : Console::FG_RED);
        if ($status === 'failed') {
            $this->stdout('why          ' . $after->auditFailure . "\n", Console::FG_RED);

            return ExitCode::UNSPECIFIED_ERROR;
        }
        $report = $after->auditReport?->one();
        $this->stdout('report       ' . ($report ? $report->getUrl() : 'none') . "\n");
        $this->stdout('file         ' . ($report ? $report->filename : 'none') . "\n");

        return ExitCode::OK;
    }

    /** Every audit and where it got to. */
    public function actionList(): int
    {
        $entries = Entry::find()->section('leadGenerator')->type('auditEntry')->status(null)->limit(50)->all();
        if (!$entries) {
            $this->stdout("no audits yet\n");

            return ExitCode::OK;
        }
        foreach ($entries as $entry) {
            $status = (string) ($entry->auditStatus?->value ?? '-');
            $this->stdout(str_pad((string) $entry->id, 6) . str_pad($status, 12) . $entry->auditUrl . "\n");
            if ($status === 'failed') {
                $this->stdout('      ' . $entry->auditFailure . "\n", Console::FG_GREY);
            }
        }

        return ExitCode::OK;
    }
}
