<?php

namespace modules\leadgenerator\controllers;

use Craft;
use craft\elements\Entry;
use craft\helpers\Queue;
use craft\web\Controller;
use modules\jonson\Jonson;
use modules\leadgenerator\audit\jobs\RunAudit;
use modules\leadgenerator\LeadGenerator;
use yii\web\BadRequestHttpException;
use yii\web\Response;

/**
 * The audit form: a URL and an email address in, a queued audit out.
 *
 * THE URL IS ASKED FOR FIRST AND THE EMAIL SECOND, and that is a decision about conversion
 * rather than about code. Somebody who has typed their domain and watched something start
 * is far likelier to give an address than somebody asked for one up front. It also avoids
 * the trap in validating a URL synchronously: a prospect whose site 403s would see an
 * error and leave, and the address would be lost with them. Accept, queue, and let a
 * failure become an entry Jon can act on.
 *
 * The guard is shared with the contact form — see services\FormGuard. Every rule in it was
 * earned on that form and none is worth learning twice.
 */
class AuditController extends Controller
{
    /**
     * THE FORM ONLY. This was `true`, which is the whole controller, and `runNow` queues an
     * audit against any entry id it is handed — an action that spends money and must never
     * answer a stranger. Naming the one anonymous action leaves every action added later
     * closed by default, which is the right way round.
     *
     * `['submit']` normalises to ALLOW_ANONYMOUS_LIVE, which is exactly what `true` meant,
     * so nothing about the live form changes.
     */
    protected int|bool|array $allowAnonymous = ['submit'];

    public function actionSubmit(): ?Response
    {
        $this->requirePostRequest();
        $request = $this->request;
        $guard = LeadGenerator::getInstance()->formGuard;

        // A bot filled the hidden field. Accept, save nothing, say nothing — telling it
        // that it was caught only improves the next one.
        if ($guard->isHoneypotFilled($request)) {
            return $this->succeed();
        }

        // A submission costs a browser, a model call and a PDF, so an open form is a way
        // to spend somebody else's money as fast as they can paste URLs.
        if ($guard->filledTooFast($request) || $guard->overRateLimit($request, 'audit')) {
            return $this->fail('', [], [], true);
        }

        $firstName = trim((string) $request->getBodyParam('firstName'));
        $surname = trim((string) $request->getBodyParam('surname'));
        $email = trim((string) $request->getBodyParam('email'));
        $url = $this->homepageUrl((string) $request->getBodyParam('auditUrl'));
        // OPTIONAL, SO EMPTY IS NOT AN ERROR — but a competitor that was typed and is not a
        // homepage is, because silently dropping it would leave the lead expecting a
        // comparison the report will not carry.
        $rival = trim((string) $request->getBodyParam('auditCompetitorUrl'));
        $rivalUrl = $rival === '' ? null : $this->homepageUrl($rival);

        $fieldErrors = [];
        if ($firstName === '') {
            $fieldErrors['firstName'] = 'Please add your first name.';
        }
        // REQUIRED ON THE SERVER AS WELL AS IN THE MARKUP. `required` is a courtesy to the
        // person filling the form in; it is not a check, because a post that never went
        // through the form never saw it.
        if ($surname === '') {
            $fieldErrors['surname'] = 'Please add your surname.';
        }
        if ($url === null) {
            $fieldErrors['auditUrl'] = 'Please add your homepage address, like example.com';
        }
        if ($rival !== '' && $rivalUrl === null) {
            $fieldErrors['auditCompetitorUrl'] = 'Please add a homepage address, like example.com';
        }
        $emailProblem = $guard->emailProblem($email);
        if ($emailProblem !== null) {
            $fieldErrors['email'] = $emailProblem;
        }
        if ($fieldErrors) {
            return $this->fail('', $fieldErrors, compact('firstName', 'surname', 'email') + [
                'auditUrl' => $request->getBodyParam('auditUrl'),
                'auditCompetitorUrl' => $request->getBodyParam('auditCompetitorUrl'),
            ]);
        }

        $section = Craft::$app->getEntries()->getSectionByHandle('leadGenerator');
        $entryType = Craft::$app->getEntries()->getEntryTypeByHandle('auditEntry');
        if (!$section || !$entryType) {
            Craft::error('[leadgenerator] leadGenerator section or auditEntry type missing', __METHOD__);

            return $this->fail('Sorry — something went wrong. Please try again.');
        }

        $entry = new Entry();
        $entry->sectionId = $section->id;
        $entry->typeId = $entryType->id;
        // Not live: an audit is a record, not a page, and nothing should be reachable at
        // lead-generator/<slug> just because somebody submitted a form.
        $entry->enabled = false;
        $entry->setFieldValues([
            'firstName' => $firstName,
            'surname' => $surname,
            'email' => $email,
            'auditUrl' => $url,
            'auditCompetitorUrl' => $rivalUrl,
            'auditStatus' => 'received',
            'referrerUrl' => $guard->ownReferrer((string) $request->getBodyParam('referrerUrl')),
        ]);

        if (!Craft::$app->getElements()->saveElement($entry)) {
            Craft::error('[leadgenerator] audit save failed: ' . json_encode($entry->getErrors()), __METHOD__);

            return $this->fail('Sorry — something went wrong. Please try again.');
        }

        // The one place a chat gets tied to the lead it produced. Same call the contact
        // form makes, on the VISITOR id rather than the visit — see Analytics::convert.
        Jonson::getInstance()->analytics->convert((string) $request->getBodyParam('cid', ''), (int) $entry->id);

        // NO PUSH HERE ANY MORE. Saving the entry is what queues the audit (see
        // LeadGenerator::watchStatus), so the form and an entry made by hand in the control
        // panel behave the same way. It is still queued, so the visitor's thank-you never
        // waits on a browser, a model and a PDF.
        return $this->succeed();
    }

    /**
     * Run, or run again, the audit on an entry — from the control panel.
     *
     * THE SAME JOB THE FORM PUSHES, and deliberately not a second path through the audit.
     * The console has `leadgenerator/audit/rerun`, which runs it synchronously because the
     * output is the point when you are working out why something failed; here the output
     * would go to a browser waiting the best part of a minute, so it queues and the queue's
     * own progress bar reports it.
     *
     * NO STATUS IS WRITTEN HERE. The job sets `in-review` or `failed` when it lands, and an
     * entry moved to some interim value by this action would sit in it for good if the
     * worker never picked the job up. What is on screen keeps saying what actually happened
     * last until something new has happened.
     */
    public function actionRunNow(): Response
    {
        $this->requireCpRequest();
        $this->requirePostRequest();
        $this->requireLogin();

        $entryId = (int) $this->request->getRequiredBodyParam('entryId');
        $entry = Craft::$app->getEntries()->getEntryById($entryId);
        $section = $entry?->getSection();

        // The id arrives in a POST body, so it is a stranger's number until this passes:
        // anything outside the audits section is not this action's to run.
        if (!$entry || ($section?->handle ?? '') !== LeadGenerator::SECTION) {
            throw new BadRequestHttpException("entry {$entryId} is not an audit");
        }

        // Running an audit spends a browser, a model call and a PDF on somebody else's
        // behalf, so it takes the same permission as changing the entry would.
        $this->requirePermission("saveEntries:{$section->uid}");

        Queue::push(new RunAudit(['entryId' => $entryId]));

        $this->setSuccessFlash(Craft::t('app', 'Audit queued. It takes about a minute.'));

        // BACK TO THE ENTRY, NAMED RATHER THAN INFERRED. With no default,
        // redirectToPostedUrl falls back to the request's own path — which happens to be
        // right here, because Craft.submitForm posts to the page you are on, and would stop
        // being right the moment this action is called from anywhere else. The menu item
        // appears on index rows too, where landing on the entry is the useful answer anyway.
        return $this->redirectToPostedUrl($entry, $entry->getCpEditUrl());
    }

    /**
     * A submitted address as a homepage URL, or null when it is not one.
     *
     * TOLERANT OF WHAT PEOPLE TYPE AND STRICT ABOUT WHAT IT ACCEPTS. Nobody types a scheme,
     * so a bare `example.com` gets https. What it will not do is accept anything that is
     * not http(s) — `file://`, `javascript:` and friends all reach a browser we drive, and
     * this string becomes an argument to a process.
     */
    private function homepageUrl(string $raw): ?string
    {
        $raw = trim($raw);
        if ($raw === '' || mb_strlen($raw) > 255) {
            return null;
        }
        if (!preg_match('~^https?://~i', $raw)) {
            $raw = 'https://' . $raw;
        }
        $parts = parse_url($raw);
        if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) {
            return null;
        }
        $host = $parts['host'] ?? '';
        // A hostname with a dot and no spaces. Deliberately not a full RFC check: the
        // capture will tell us soon enough whether it resolves, and the honest failure of
        // a real address beats a regex refusing a valid one.
        if ($host === '' || !str_contains($host, '.') || preg_match('/\s/', $host)) {
            return null;
        }

        return $raw;
    }

    private function succeed(): Response
    {
        Craft::$app->getSession()->set('auditSubmitted', true);

        if ($this->request->getAcceptsJson()) {
            return $this->asJson(['success' => true]);
        }

        return $this->redirectToPostedUrl();
    }

    /** Mirrors CrmController's: JSON for AJAX, flash + redirect otherwise. */
    private function fail(string $error, array $fieldErrors = [], array $values = [], bool $blocked = false): Response
    {
        if ($this->request->getAcceptsJson()) {
            return $this->asJson([
                'success' => false,
                'blocked' => $blocked,
                'error' => $error,
                'fieldErrors' => (object) $fieldErrors,
            ]);
        }

        $session = Craft::$app->getSession();
        if ($blocked) {
            $session->setFlash('auditBlocked', true);
        } elseif ($error !== '') {
            $session->setError($error);
        }
        if ($fieldErrors) {
            $session->setFlash('auditErrors', $fieldErrors);
        }
        if ($values) {
            $session->setFlash('auditForm', $values);
        }

        return $this->redirect($this->request->getReferrer() ?: '/');
    }
}
