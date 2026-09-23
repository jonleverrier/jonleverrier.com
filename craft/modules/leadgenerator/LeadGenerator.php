<?php

namespace modules\leadgenerator;

use Craft;
use craft\base\Element;
use craft\elements\Entry;
use craft\events\DefineMenuItemsEvent;
use craft\events\ModelEvent;
use craft\helpers\Queue;
use modules\leadgenerator\audit\jobs\RunAudit;
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
 * (`actions/leadgenerator/audit/submit` → `controllers\AuditController::actionSubmit`);
 * everything a single tool owns nests under its own folder.
 *
 * WHAT IT STILL BORROWS FROM jonson, deliberately: the disposable-email list, which is
 * maintained there, and `analytics->convert()`, which is the one place a chat gets tied to
 * the lead it produced. Neither is worth a second copy.
 */
class LeadGenerator extends BaseModule
{
    /**
     * The one section these handlers care about.
     *
     * Public because controllers\AuditController checks it too: an entry id arriving in a
     * POST body has to be proved to be an audit before anything is queued against it, and
     * the handle that proves it should have one spelling.
     */
    public const SECTION = 'leadGenerator';

    /** The field whose move into `sent` is what sends the report. */
    private const STATUS_FIELD = 'auditStatus';

    /**
     * Set false around a save that must NOT queue an audit.
     *
     * The console's `leadgenerator/audit/run` is the only caller: it makes an entry and then
     * runs the audit synchronously, because seeing the output is the whole point of running
     * it from a terminal. Without this the save would also queue a copy, and on production
     * — where a worker is actually listening — that copy would audit the same page a second
     * time an hour later and charge for it.
     */
    public static bool $autoRun = true;

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

        $this->watchStatus();
        $this->offerToRun();
    }

    /**
     * The two things a save can set off: an audit, and the email carrying its report.
     *
     * ONE HANDLER BECAUSE THERE IS ONE QUESTION — what changed about this entry — and the
     * stored status has to be read before the save to answer it. Two handlers meant two
     * reads of the same row to compare against the same value.
     *
     * AN AUDIT RUNS WHEN AN ENTRY REACHES `received`, whether it got there by being created
     * or by being moved back. It used to be the form alone that pushed the job, which made
     * the two routes behave differently for no reason a person could see: an audit created
     * by hand sat at `received` for ever and looked broken, because nothing was coming.
     *
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
    private function watchStatus(): void
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

            if (self::$autoRun && self::shouldRun($entry, $e->isNew, $was, $now)) {
                Queue::push(new RunAudit(['entryId' => (int) $entry->id]));

                return;
            }

            if ($now !== 'sent' || $was === 'sent' || $was === null) {
                return;
            }

            Queue::push(new SendReport(['entryId' => (int) $entry->id]));
        });
    }

    /**
     * Whether this save is one that should set an audit running.
     *
     * ARRIVING AT `received` IS THE EVENT, exactly as arriving at `sent` is the event that
     * mails the report. The status is the record of where a lead has got to, so the thing
     * that starts the work should be the status saying the work has not been done yet.
     *
     * This ran on ANY new entry at first, whatever its status, because the field had no
     * default and a lead made in the control panel would otherwise arrive blank and sit
     * there. The field now defaults to Received, which is the truthful default for a lead
     * nobody has measured, so the loose rule is gone and the trigger says what it means.
     *
     * A NEW ENTRY HAS NO `$was` TO COMPARE WITH, and that is not an edge case to paper
     * over: the before-save handler skips it because the element has no id yet. Arriving at
     * `received` by being created is the same event as being moved there, so it is written
     * as its own line rather than hidden in a null check.
     *
     * NO URL, NO RUN. An entry is saved the moment it is created in the control panel, often
     * before the address has been typed; queueing then would spend a capture on nothing and
     * mark the lead `failed` before anyone had finished making it.
     */
    private static function shouldRun(Entry $entry, bool $isNew, ?string $was, string $now): bool
    {
        if ($now !== 'received') {
            return false;
        }

        if (trim((string) $entry->getFieldValue('auditUrl')) === '') {
            return false;
        }

        if ($isNew) {
            return true;
        }

        // Moved back to `received` by hand: the re-run gesture. A save that leaves the
        // status where it was is not a request for anything. `$was === null` means the
        // before-save handler never ran, so there is nothing that can be called a change.
        return $was !== null && $was !== 'received';
    }

    /**
     * "Run audit" in an audit entry's own action menu.
     *
     * WHY A BUTTON RATHER THAN A STATUS. Sending already works by transition — move an entry
     * into `sent` and the report goes — and that mechanism is exactly as invisible as it
     * sounds: it has to be explained before anyone can use it, and a saved entry that was
     * already `sent` quietly does nothing. Running is the thing Jon reaches for most, on the
     * entry he is already looking at, so it says what it does and does it when pressed.
     *
     * The same menu serves the entry's edit screen and each row of the index, because both
     * are built from `getActionMenuItems()`. The item is scoped by `isAudit()`, so it never
     * appears on a note or a case study.
     *
     * The JS is the shape Craft uses for its own `Validate` item (see
     * craft\base\Element::safeActionMenuItems): a hidden form with a CSRF token, posted to
     * a controller action. `$bod` and `$trigger` are escaped because this is a PHP heredoc
     * and both are valid PHP variable names; `$id` and `$entryId` are not escaped because
     * they are meant to interpolate.
     */
    private function offerToRun(): void
    {
        Event::on(Entry::class, Element::EVENT_DEFINE_ACTION_MENU_ITEMS, static function (DefineMenuItemsEvent $e) {
            $entry = $e->sender;
            if (!self::isAudit($entry)) {
                return;
            }

            // NAMED FOR WHAT PRESSING IT WOULD DO. An entry that has never run and one being
            // put through again are different acts, and the second wants saying out loud:
            // it spends another capture and another model call.
            $ran = (string) ($entry->getFieldValue(self::STATUS_FIELD)?->value ?? '') !== 'received';

            $view = Craft::$app->getView();
            $id = sprintf('action-run-audit-%s', mt_rand());

            $e->items[] = [
                'id' => $id,
                'icon' => 'arrows-rotate',
                'label' => $ran ? 'Run audit again' : 'Run audit',
            ];

            $view->registerJsWithVars(fn($id, $entryId) => <<<JS
(() => {
  const btn = $('#' + $id);
  btn.on('activate', () => {
    const form = Craft.createForm()
      .addClass('hidden')
      .append(Craft.getCsrfInput())
      .appendTo(Garnish.\$bod);

    Craft.submitForm(form, {
      action: 'leadgenerator/audit/run-now',
      params: {entryId: $entryId},
    });
  });
})();
JS, [
                $view->namespaceInputId($id),
                (int) $entry->id,
            ]);
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
