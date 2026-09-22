<?php

namespace modules\leadgenerator\audit\jobs;

use Craft;
use craft\elements\Asset;
use craft\elements\Entry;
use craft\queue\BaseJob;
use modules\leadgenerator\LeadGenerator;

/**
 * SEND REPORT
 *
 * The email a lead gets, with their PDF on it.
 *
 * QUEUED, AND NOT SENT INSIDE THE SAVE. The status is changed in the control panel, and a
 * save that also has to open a connection to Postmark is a save that can hang or fail while
 * Jon is looking at a spinner. Worse, a send that throws inside `afterSave` leaves the
 * entry saying `sent` with nothing sent — here a failure is a red job in the queue with the
 * reason on it, and it can be retried without touching the entry at all.
 *
 * PLAIN TEXT ON PURPOSE. This is one person writing to another about their homepage; an
 * HTML template would make it look like a newsletter, which is the one thing it must not
 * look like. The PDF carries the design.
 *
 * A FAILURE IS WRITTEN TO THE ENTRY AS WELL AS THROWN. The queue keeps the stack trace;
 * `auditFailure` keeps the sentence, beside the lead it belongs to, where it will actually
 * be seen — and the status goes back to `failed` so the entry stops claiming it was sent.
 *
 * The limitation worth knowing: the body is written here rather than in a CMS field, so
 * changing the wording is a deploy. That is the right trade while there is one email and
 * one person sending it; the moment there are two, it belongs on the Home single beside
 * jonsonShortQuestion and the rest.
 */
class SendReport extends BaseJob
{
    public int $entryId = 0;

    public function execute($queue): void
    {
        $entry = Craft::$app->getEntries()->getEntryById($this->entryId);
        if (!$entry) {
            // Nowhere to write the reason, so the queue is the only record there can be.
            throw new \RuntimeException("no entry {$this->entryId}");
        }

        try {
            $this->send($entry);
        } catch (\Throwable $e) {
            // THE REASON GOES ON THE ENTRY, NOT ONLY IN THE QUEUE. A failed send that only
            // shows up in a queue nobody has open is a lead who never got their report and
            // an entry that says it was sent. Writing `failed` also undoes that claim, and
            // makes a retry possible: moving the status back to `sent` fires the job again,
            // which a status left at `sent` could never do.
            $this->save($entry, ['auditStatus' => 'failed', 'auditFailure' => $e->getMessage()]);

            throw $e;
        }
    }

    private function send(Entry $entry): void
    {
        $to = trim((string) $entry->email);
        if ($to === '') {
            throw new \RuntimeException("entry {$this->entryId} has no email address");
        }

        $asset = $this->report($entry);
        if (!$asset) {
            throw new \RuntimeException("entry {$this->entryId} has no report to attach");
        }

        // COPIED OUT OF THE VOLUME FIRST. `getCopyOfFile()` gives a real path on disk
        // whatever the filesystem is — local today, and not necessarily local later. The
        // attachment needs a file, not a stream.
        $path = $asset->getCopyOfFile();

        $name = trim((string) $entry->firstName);
        // The address stays in the SUBJECT and not the body: a lead may have asked for more
        // than one, and the subject is the only part of an email that survives a full inbox.
        $site = $this->host((string) $entry->auditUrl);
        // The same name the filename uses, from the same entry — see Audit::toolName.
        $tool = LeadGenerator::getInstance()->audit->toolName();

        $message = Craft::$app->getMailer()
            ->compose()
            ->setTo($to)
            ->setSubject("Your {$tool} report for {$site}")
            ->setTextBody($this->body($name, $tool))
            ->attach($path, ['fileName' => $asset->getFilename(), 'contentType' => 'application/pdf']);

        if (!$message->send()) {
            // The mailer logs the transport's own reason; this is the line that ties it to
            // a lead, because a failure with no entry id on it cannot be chased.
            throw new \RuntimeException("the mailer refused the report for entry {$this->entryId}");
        }

        // Cleared on the way out, so a reason from a previous attempt cannot sit under a
        // status that now says it went.
        if (trim((string) $entry->auditFailure) !== '') {
            $this->save($entry, ['auditFailure' => '']);
        }

        Craft::info("[leadgenerator] report for entry {$this->entryId} sent to {$to}", __METHOD__);
    }

    /**
     * Save field values without disturbing anything else on the entry.
     *
     * `setFieldValues` merges, so a reason written here cannot blank the email or the URL.
     */
    private function save(Entry $entry, array $values): void
    {
        $entry->setFieldValues($values);
        if (!Craft::$app->getElements()->saveElement($entry)) {
            Craft::error(
                "[leadgenerator] could not save audit {$entry->id}: " . json_encode($entry->getErrors()),
                __METHOD__,
            );
        }
    }

    /**
     * The bare domain, as a person would say it out loud.
     *
     * NOT THE URL. `https://kohde.agency/` in a subject line is three pieces of punctuation
     * a reader has to look past to find the only word that tells them what this is about,
     * and on a phone the scheme eats the preview. `www.` goes for the same reason. The whole
     * address is still on the cover of the PDF, where it is the subject rather than the
     * label.
     *
     * Falls back to whatever was submitted if it will not parse, because a subject line with
     * a blank in it is worse than an ugly one.
     */
    private function host(string $url): string
    {
        $host = parse_url(trim($url), PHP_URL_HOST) ?: trim($url);

        return preg_replace('~^www\.~i', '', (string) $host);
    }

    /** The attached PDF, or null when the audit never produced one. */
    private function report(Entry $entry): ?Asset
    {
        $asset = $entry->getFieldValue('auditReport')?->one();

        return $asset instanceof Asset ? $asset : null;
    }

    /**
     * NO GREETING WHEN THERE IS NO NAME. "Hi ," is worse than no greeting at all, and the
     * form does not make the first name required.
     *
     * The tool's name comes in from its own entry, the same one the subject uses, so the
     * email and the page a lead read before they gave their address say the same words.
     */
    private function body(string $name, string $tool): string
    {
        $hello = $name !== '' ? "Hi {$name}," : 'Hi,';

        return <<<TEXT
            {$hello}

            Here's the {$tool} you asked for attached as a PDF.

            It measures the budget spent on each of the key segments that make up a homepage
            along with some other key signals that provide a route to a great first
            impression.

            If the report raises any questions, or if you would like to discuss in more
            detail, simply reply back to this email.

            Best wishes,

            Jon


            TEXT;
    }

    protected function defaultDescription(): string
    {
        return 'Sending a homepage audit';
    }
}
