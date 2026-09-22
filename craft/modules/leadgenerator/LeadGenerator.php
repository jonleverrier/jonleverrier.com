<?php

namespace modules\leadgenerator;

use Craft;
use craft\elements\Entry;
use craft\events\ModelEvent;
use craft\helpers\Queue;
use modules\leadgenerator\audit\jobs\SendReport;
use modules\leadgenerator\audit\services\Audit;
use modules\leadgenerator\services\FormGuard;
use yii\base\Event;
use yii\base\Module as BaseModule;

/**
 * LEAD GENERATOR
 *
 * The tools that take a stranger's URL and give them something worth an email address.
 *
 * ITS OWN MODULE RATHER THAN PART OF jonson, because jonson is the persona — the chat, the
 * memories, the music, the VIP doors — and a homepage audit shares none of it. The one
 * thing they have in common is that both produce leads, which is also true of the contact
 * form and does not make them the same thing.
 *
 * `leadgenerator` AND NOT `audit`, because the audit is the first tool here and not the
 * last. The Craft channel is already called Lead Generator; a second tool is one more
 * controller and one more folder beside `audit/`, and it inherits the form guard rather
 * than re-learning it.
 *
 * Controllers sit at the module root because that is where Craft routes to
 * (`actions/lead-generator/audit/submit` → `controllers\AuditController::actionSubmit`);
 * everything a single tool owns nests under its own folder.
 *
 * WHAT IT STILL BORROWS FROM jonson, deliberately: the disposable-email list, which is
 * maintained there, and `analytics->convert()`, which is the one place a chat gets tied to
 * the lead it produced. Neither is worth a second copy.
 */
class LeadGenerator extends BaseModule
{
    /** The one section these handlers care about. */
    private const SECTION = 'leadGenerator';

    /** The field whose move into `sent` is what sends the report. */
    private const STATUS_FIELD = 'auditStatus';

    public function init(): void
    {
        Craft::setAlias('@modules/leadgenerator', __DIR__);
        $this->controllerNamespace = Craft::$app->getRequest()->getIsConsoleRequest()
            ? 'modules\\leadgenerator\\console\\controllers'
            : 'modules\\leadgenerator\\controllers';

        parent::init();

        $this->setComponents([
            'formGuard' => FormGuard::class,
            'audit' => Audit::class,
        ]);

        $this->watchForSending();
    }

    /**
     * Setting the status to `sent` is what sends the report.
     *
     * THE TRANSITION, NOT THE VALUE. An entry is saved every time anything on it is
     * touched — a typo in the name, a note, a resave from the console — and a handler that
     * only checks "is it sent?" mails the lead again each time. So the stored status is read
     * BEFORE the save and compared with the one going in: the mail goes out on the move into
     * `sent` and never on a save that leaves it there.
     *
     * The limitation worth knowing: it is a transition and not a receipt. If the send fails,
     * the entry still says `sent` and saving it again will not retry, because it was already
     * `sent` beforehand. The retry lives in the queue, where the failure is; to send again
     * from the entry, move it off `sent` and back.
     */
    private function watchForSending(): void
    {
        $before = [];

        Event::on(Entry::class, Entry::EVENT_BEFORE_SAVE, static function (ModelEvent $e) use (&$before) {
            $entry = $e->sender;
            if (!self::isAudit($entry)) {
                return;
            }
            // The value as the database still has it. Reading it off $entry here would give
            // the one being saved, which is the thing we are trying to compare against.
            $stored = Craft::$app->getEntries()->getEntryById($entry->id, $entry->siteId);
            $before[$entry->id] = (string) ($stored?->getFieldValue(self::STATUS_FIELD)?->value ?? '');
        });

        Event::on(Entry::class, Entry::EVENT_AFTER_SAVE, static function (ModelEvent $e) use (&$before) {
            $entry = $e->sender;
            if (!self::isAudit($entry)) {
                return;
            }
            $was = $before[$entry->id] ?? null;
            unset($before[$entry->id]);

            $now = (string) ($entry->getFieldValue(self::STATUS_FIELD)?->value ?? '');
            if ($now !== 'sent' || $was === 'sent' || $was === null) {
                return;
            }

            Queue::push(new SendReport(['entryId' => (int) $entry->id]));
        });
    }

    /**
     * An audit entry worth watching: saved, not a draft or a revision, and carrying the
     * field this is all about.
     *
     * SECTION FIRST, THEN THE LAYOUT — the shape jonson\services\Vip already uses, for the
     * same reason. These handlers fire on EVERY entry save on the site, so the first test
     * has to be the cheapest one that rules most of them out, and it must not touch a field.
     *
     * The layout check went in after `getFieldValue('auditStatus')` threw
     * `InvalidFieldException` on an entry whose type has no such field: editing the title of
     * a page in the Tools structure died with a stack trace from this module. The section
     * check goes in front of it because it is exact — audit entries live in one section —
     * and because a second tool added to that section would fail the layout test anyway.
     */
    private static function isAudit(mixed $entry): bool
    {
        return $entry instanceof Entry
            && $entry->id !== null
            && ($entry->getSection()?->handle ?? '') === self::SECTION
            && !$entry->getIsDraft()
            && !$entry->getIsRevision()
            && $entry->getFieldLayout()?->getFieldByHandle(self::STATUS_FIELD) !== null;
    }
}
