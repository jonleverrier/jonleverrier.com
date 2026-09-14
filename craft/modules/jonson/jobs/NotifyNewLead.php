<?php

namespace modules\jonson\jobs;

use craft\elements\Entry;
use craft\helpers\App;
use craft\queue\BaseJob;
use GuzzleHttp\Client;

/**
 * Tell Jon on Telegram that an enquiry has landed.
 *
 * QUEUED, NEVER INLINE. The visitor has already submitted and is owed their
 * thank-you; nobody should watch a spinner because Telegram is slow. Queuing also
 * means the queue's own backoff handles a blip — a failed send throws, and the
 * message arrives late rather than never.
 *
 * TELEGRAM RATHER THAN WHATSAPP, which was the first thought. WhatsApp cannot be
 * sent to without a Meta Business account, a number that is not already on WhatsApp,
 * and — because a lead at 3am is outside the 24-hour service window — a pre-approved
 * message template. Telegram is a bot token and one POST. The channel is not the
 * point; knowing within seconds is.
 *
 * SILENT WHEN UNCONFIGURED. With no token or chat id in the environment this does
 * nothing at all, so a local or staging site never tries to message anyone and the
 * absence of credentials is not an error. Set both to switch it on:
 *
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     your own chat id — message the bot once, then read it from
 *                        https://api.telegram.org/bot<TOKEN>/getUpdates
 */
class NotifyNewLead extends BaseJob
{
    public int $entryId;

    public function execute($queue): void
    {
        $token = App::env('TELEGRAM_BOT_TOKEN');
        $chat = App::env('TELEGRAM_CHAT_ID');
        if (!$token || !$chat) {
            return; // not configured here — local, staging, or not switched on yet
        }

        $entry = Entry::find()->id($this->entryId)->status(null)->one();
        if (!$entry) {
            return; // deleted between the save and the queue getting to it
        }

        $client = new Client(['timeout' => 15, 'http_errors' => false]);
        $res = $client->post("https://api.telegram.org/bot{$token}/sendMessage", [
            'form_params' => [
                'chat_id' => $chat,
                // HTML rather than Markdown: a lead's own words are pasted into this,
                // and Telegram's Markdown breaks on a stray underscore or asterisk in
                // a way that rejects the whole message. Everything variable below is
                // escaped for HTML before it gets here.
                'parse_mode' => 'HTML',
                'disable_web_page_preview' => true,
                'text' => $this->body($entry),
            ],
        ]);

        if ($res->getStatusCode() !== 200) {
            // Thrown, not logged and swallowed: the queue retries with backoff, which
            // is the behaviour you want from a notification that matters.
            throw new \RuntimeException(
                'Telegram refused the lead notification (' . $res->getStatusCode() . '): '
                . mb_substr((string) $res->getBody(), 0, 300),
            );
        }
    }

    /**
     * The message — ONE SENTENCE, AND NOTHING ELSE.
     *
     * The fact and the time. No name, no email, no words of theirs, not the page they
     * wrote from, and no link.
     *
     * That is a privacy decision rather than a stylistic one. A notification puts
     * whatever it contains into Telegram's servers and onto a lock screen, readable by
     * anyone who glances at the phone — and an enquiry is someone else's personal data,
     * held on a basis that does not obviously stretch to a chat app. Even the control
     * panel link went: it is one tap from knowing, and knowing is the whole job here.
     *
     * $entry is still the parameter because the TIME comes from it. Nothing else does.
     */
    private function body(Entry $entry): string
    {
        // THE TIME OF THE LEAD, NOT OF THE MESSAGE. These are the same only when the
        // queue is running promptly, and production has no daemon — jobs wait for the
        // next web request, which on a quiet night is hours. A message claiming "at
        // 07:12" about something that happened at 03:40 would be worse than one with no
        // time at all. Craft's own timezone, so it reads as the clock Jon is looking at.
        $when = $entry->dateCreated
            ? $entry->dateCreated->setTimezone(new \DateTimeZone(\Craft::$app->getTimeZone()))->format('H:i')
            : '';

        return 'You got a new lead from Jonson' . ($when !== '' ? ' at ' . $when : '');
    }
}
