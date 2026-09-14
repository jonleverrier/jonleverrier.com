<?php

namespace modules\jonson\controllers;

use Craft;
use craft\elements\Entry;
use craft\helpers\UrlHelper;
use craft\web\Controller;
use modules\jonson\Jonson;
use modules\jonson\jobs\NotifyNewLead;
use yii\web\Response;

/**
 * Handles the contact form (c-form) → creates a CRM channel entry.
 * Standard POST + redirect (no JS): success/error surface via flash messages,
 * and the submitted values are flashed back on error so the form can repopulate.
 */
class CrmController extends Controller
{
    protected int|bool|array $allowAnonymous = true;

    private const RATE_LIMIT = 5;         // max submissions per IP per window
    private const RATE_WINDOW = 3600;     // 1 hour
    private const MIN_FILL_SECONDS = 3;   // reject sub-3s submissions (bots)

    public function actionSubmit(): ?Response
    {
        $this->requirePostRequest();
        $request = $this->request;
        $session = Craft::$app->getSession();

        // Honeypot — a hidden field bots tend to fill and humans never see. If it
        // has a value, silently accept (don't tip off the bot) but save nothing.
        if (trim((string) $request->getBodyParam('website')) !== '') {
            return $this->succeed();
        }

        $firstName = trim((string) $request->getBodyParam('firstName'));
        $surname   = trim((string) $request->getBodyParam('surname'));
        $email     = trim((string) $request->getBodyParam('email'));
        $message   = trim((string) $request->getBodyParam('message'));
        $referrer  = $this->referrerUrl((string) $request->getBodyParam('referrerUrl'));

        // Time-trap — bots submit near-instantly. A signed render timestamp lets
        // us reject implausibly fast fills without trusting the client's clock
        // (validateData returns false if the value was tampered with).
        $renderedAt = Craft::$app->getSecurity()->validateData((string) $request->getBodyParam('ts'));
        if ($renderedAt === false || (time() - (int) $renderedAt) < self::MIN_FILL_SECONDS) {
            // Blocked outcome — replace the form with a "not sent" notice (like the
            // success state) rather than a banner they can retry against.
            return $this->fail('', [], [], true);
        }

        // Rate limit — cap submissions per IP (cache-based, rolling window).
        // Skipped under devMode so local testing isn't throttled; enforced in prod.
        if (!Craft::$app->getConfig()->getGeneral()->devMode) {
            $rateKey = 'crm-rate:' . md5((string) $request->getUserIP());
            $count = (int) (Craft::$app->getCache()->get($rateKey) ?: 0);
            if ($count >= self::RATE_LIMIT) {
                return $this->fail('', [], [], true); // blocked — show the "not sent" notice
            }
            Craft::$app->getCache()->set($rateKey, $count + 1, self::RATE_WINDOW);
        }

        // Per-field validation errors — flashed as a map so the form can surface
        // each message beside the field it belongs to (red border + inline note),
        // rather than one banner at the top.
        $fieldErrors = [];
        if ($firstName === '') {
            $fieldErrors['firstName'] = 'Please add your first name.';
        }
        if ($surname === '') {
            $fieldErrors['surname'] = 'Please add your surname.';
        }
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $fieldErrors['email'] = 'Please add a valid email address.';
        } elseif ($this->isDisposableEmail($email)) {
            // Throwaway / temp-mail provider — usually has valid MX, blocked by name.
            $fieldErrors['email'] = 'Please use a permanent (non-temporary) email address.';
        } elseif (!$this->emailDomainAcceptsMail($email)) {
            // Syntax is fine but the domain can't receive mail (typo / dead domain).
            $fieldErrors['email'] = 'Verify your email address is correct';
        }
        // Message is optional.

        if ($fieldErrors) {
            return $this->fail('', $fieldErrors, compact('firstName', 'surname', 'email', 'message'));
        }

        $section = Craft::$app->getEntries()->getSectionByHandle('crm');
        $entryType = Craft::$app->getEntries()->getEntryTypeByHandle('crmEntry');
        if (!$section || !$entryType) {
            Craft::error('[jonson] CRM section/entry type missing', __METHOD__);
            return $this->fail('Sorry — something went wrong. Please try again.');
        }

        $entry = new Entry();
        $entry->sectionId = $section->id;
        $entry->typeId = $entryType->id;
        // Title comes from the entry type's titleFormat ("{firstName} {surname}").
        $entry->setFieldValues([
            'firstName' => $firstName,
            'surname' => $surname,
            'email' => $email,
            'message' => $message,
            // The visitor's Jonson chat this session — the questions they asked and
            // the answers — so the lead carries its context.
            'conversation' => $this->jonsonTranscript($this->transcriptOwner($session)),
            // The page the message was sent from (see referrerUrl()).
            'referrerUrl' => $referrer,
        ]);

        if (Craft::$app->getElements()->saveElement($entry)) {
            // Mark the conversation that produced this enquiry. The one place lead
            // capture touches the analytics tables: without it you can count chats and
            // count leads but never tell which chats became them, which is the single
            // most useful thing the reporting can say about whether Jonson is working.
            //
            // Matched on the VISITOR id the form already had to hand for the
            // transcript, not the visit — see Analytics::convert() for why.
            Jonson::getInstance()->analytics->convert(
                (string) $this->request->getBodyParam('cid', ''),
                (int) $entry->id,
            );

            // Tell Jon it landed. QUEUED, so the visitor's thank-you never waits on
            // Telegram — and so a blip retries rather than losing the notification.
            // The job does nothing when the environment has no bot token, which is
            // what keeps local and staging quiet.
            \craft\helpers\Queue::push(new NotifyNewLead(['entryId' => (int) $entry->id]));
        } else {
            Craft::error('[jonson] CRM save failed: ' . json_encode($entry->getErrors()), __METHOD__);
            return $this->fail(
                'Sorry — something went wrong. Please try again.',
                [],
                compact('firstName', 'surname', 'email', 'message'),
            );
        }

        // Mark this session as submitted so the form is replaced by a thank-you
        // and doesn't show again.
        return $this->succeed();
    }

    /**
     * Failure response — JSON for AJAX (progressive enhancement), otherwise the
     * classic flash + redirect back so the server-rendered form repopulates.
     * $error is a top-level banner message; $fieldErrors maps field → message.
     */
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
        // A blocked outcome (rate limit / time-trap) replaces the form with a
        // one-time "not sent" notice; anything else is a banner + repopulated form.
        if ($blocked) {
            $session->setFlash('crmBlocked', true);
        } elseif ($error !== '') {
            $session->setError($error);
        }
        if ($fieldErrors) {
            $session->setFlash('crmErrors', $fieldErrors);
        }
        if ($values) {
            $session->setFlash('crmForm', $values);
        }

        return $this->redirect($this->request->getReferrer() ?: '/');
    }

    /**
     * Success response — marks the session submitted (so the form is replaced by
     * the thank-you and doesn't show again), then JSON for AJAX or a redirect.
     */
    /**
     * The page the form was sent from — the hidden `referrerUrl` the form carries
     * (the page it was rendered on: the contact page, or any page via the contact
     * panel). Kept only when it's one of this site's own URLs: it's a form field
     * like any other, and a lead should never carry an address someone else typed.
     */
    private function referrerUrl(string $raw): string
    {
        $raw = trim($raw);
        if ($raw === '' || mb_strlen($raw) > 255) {
            return '';
        }
        $parts = parse_url($raw);
        if (!$parts || !in_array($parts['scheme'] ?? '', ['http', 'https'], true)) {
            return '';
        }
        $siteHost = parse_url(UrlHelper::siteUrl(), PHP_URL_HOST);
        if (!isset($parts['host']) || strcasecmp($parts['host'], (string) $siteHost) !== 0) {
            return '';
        }

        return $raw;
    }

    private function succeed(): Response
    {
        Craft::$app->getSession()->set('crmSubmitted', true);

        if ($this->request->getAcceptsJson()) {
            return $this->asJson(['success' => true]);
        }

        return $this->redirectToPostedUrl();
    }

    /**
     * Whether the email is from a known disposable / temporary-mail provider
     * (exact domain match against data/disposable-email-domains.php).
     */
    private function isDisposableEmail(string $email): bool
    {
        $domain = strtolower(substr((string) strrchr($email, '@'), 1));
        if ($domain === '') {
            return false;
        }

        $list = require __DIR__ . '/../data/disposable-email-domains.php';

        return in_array($domain, $list, true);
    }

    /**
     * Whether the email's domain can actually receive mail — a DNS lookup for an
     * MX record (falling back to A/AAAA per RFC 5321, since some domains accept
     * mail on their address record). Catches typo'd / dead domains that pass the
     * syntax check. Fails open on a transient DNS error so a lookup blip doesn't
     * block a genuine address.
     */
    private function emailDomainAcceptsMail(string $email): bool
    {
        $domain = substr((string) strrchr($email, '@'), 1);
        if ($domain === '') {
            return false;
        }

        // idn_to_ascii handles internationalised domains; harmless for ASCII ones.
        $ascii = function_exists('idn_to_ascii') ? idn_to_ascii($domain) : $domain;
        $domain = $ascii !== false ? $ascii : $domain;

        // If DNS itself is unreachable, don't punish the visitor — accept.
        if (checkdnsrr($domain, 'MX')) {
            return true;
        }
        if (checkdnsrr($domain, 'A') || checkdnsrr($domain, 'AAAA')) {
            return true;
        }
        // No records found. Treat a NXDOMAIN as invalid, but a failed lookup
        // (e.g. resolver down) as acceptable — dns_get_record distinguishes them.
        $records = @dns_get_record($domain, DNS_MX | DNS_A);
        if ($records === false) {
            return true; // lookup failed transiently — fail open
        }

        return count($records) > 0;
    }

    /**
     * The visitor's full Jonson conversation this session, as a readable
     * transcript. Reads the uncapped transcript AskController writes
     * ("jonson-transcript:<sessionId>", clean prose, no markers). Empty string
     * when they haven't chatted (or the cache has expired).
     */
    /**
     * The id the chat transcript is stored under — the client-minted `cid` (sent by
     * contact-form.js from localStorage), falling back to the session id. Must match
     * AskController::convoId() so the read lands on what the chat wrote.
     */
    private function transcriptOwner($session): string
    {
        $cid = preg_replace('/[^A-Za-z0-9_-]/', '', (string) $this->request->getBodyParam('cid', ''));
        $cid = mb_substr((string) $cid, 0, 64);

        return $cid !== '' ? $cid : (string) $session->getId();
    }

    private function jonsonTranscript(string $owner): string
    {
        $history = Craft::$app->getCache()->get('jonson-transcript:' . $owner);
        if (!is_array($history)) {
            return '';
        }

        $lines = [];
        foreach ($history as $m) {
            if (!isset($m['role'], $m['content']) || !is_string($m['content'])) {
                continue;
            }
            $label = ($m['role'] === 'user') ? 'Visitor' : 'Jonson';
            $lines[] = $label . ': ' . trim($m['content']);
        }

        return implode("\n\n", $lines);
    }
}
