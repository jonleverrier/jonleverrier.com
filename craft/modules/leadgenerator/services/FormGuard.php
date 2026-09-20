<?php

namespace modules\leadgenerator\services;

use Craft;
use craft\helpers\UrlHelper;
use yii\base\Component;
use yii\web\Request;

/**
 * The checks every public lead form needs before it will write anything down.
 *
 * LIFTED OUT OF CrmController RATHER THAN WRITTEN AFRESH. All of it was earned on that
 * form and every rule below is here because something got through without it. A second
 * form that re-implemented them would re-learn the same lessons at the same cost, and a
 * second form that skipped them would be the open door.
 *
 * Nothing here decides what happens on failure — a contact form and an audit form surface
 * a refusal differently — so each check answers and the caller chooses.
 */
class FormGuard extends Component
{
    /** Submissions allowed per IP per window. */
    public int $rateLimit = 5;

    /** …and the window, in seconds. */
    public int $rateWindow = 3600;

    /** A form filled faster than this was not filled by a person. */
    public int $minFillSeconds = 3;

    /** The cache key prefix, so two forms count separately rather than against each other. */
    public string $rateKey = 'leadgen-rate';

    /**
     * A hidden field bots fill and people never see.
     *
     * A caller that finds this true should SUCCEED SILENTLY — write nothing, say nothing.
     * Telling a bot it was caught only teaches whoever wrote it.
     */
    public function isHoneypotFilled(Request $request, string $field = 'website'): bool
    {
        return trim((string) $request->getBodyParam($field)) !== '';
    }

    /**
     * Was this form on screen long enough for a person to have filled it in?
     *
     * The timestamp is SIGNED by Craft's security component when the form renders, so this
     * does not have to trust the client's clock or its honesty: a tampered value fails
     * validation and reads as an implausible fill rather than as a valid one.
     */
    public function filledTooFast(Request $request, string $field = 'ts'): bool
    {
        $renderedAt = Craft::$app->getSecurity()->validateData((string) $request->getBodyParam($field));

        return $renderedAt === false || (time() - (int) $renderedAt) < $this->minFillSeconds;
    }

    /**
     * Has this IP had its allowance? Counts the submission when it has not.
     *
     * SKIPPED UNDER devMode, so local testing is not throttled and the rule is still
     * enforced everywhere that matters.
     *
     * The audit form needs this more than the contact form does: a submission there costs a
     * browser, a model call and a PDF, so an open form is a way to spend somebody else's
     * money as fast as they can paste URLs.
     */
    public function overRateLimit(Request $request, string $form): bool
    {
        if (Craft::$app->getConfig()->getGeneral()->devMode) {
            return false;
        }
        $key = $this->rateKey . ':' . $form . ':' . md5((string) $request->getUserIP());
        $count = (int) (Craft::$app->getCache()->get($key) ?: 0);
        if ($count >= $this->rateLimit) {
            return true;
        }
        Craft::$app->getCache()->set($key, $count + 1, $this->rateWindow);

        return false;
    }

    /**
     * Why this email address is no good, or null when it is fine.
     *
     * Three questions in the order they get cheaper to answer wrongly: is it an address at
     * all, is it a throwaway, and can that domain actually receive mail.
     */
    public function emailProblem(string $email): ?string
    {
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return 'Please add a valid email address.';
        }
        if ($this->isDisposable($email)) {
            return 'Please use a permanent (non-temporary) email address.';
        }
        if (!$this->domainAcceptsMail($email)) {
            return 'Verify your email address is correct';
        }

        return null;
    }

    /**
     * A known throwaway provider, by exact domain match.
     *
     * The list still lives in the jonson module because that is where it was built and
     * where it is maintained; this reads it rather than forking a second copy to drift.
     */
    public function isDisposable(string $email): bool
    {
        $domain = strtolower(substr((string) strrchr($email, '@'), 1));
        if ($domain === '') {
            return false;
        }

        return in_array($domain, require Craft::getAlias('@modules/jonson') . '/data/disposable-email-domains.php', true);
    }

    /**
     * Can this domain receive mail at all — an MX lookup, falling back to A/AAAA per RFC
     * 5321, since some domains accept mail on their address record. Catches a typo'd or
     * dead domain that passes the syntax check.
     *
     * FAILS OPEN. A resolver that is down must not turn every genuine address into a
     * rejection, so a failed lookup is accepted and only a definite absence of records is
     * a refusal. `dns_get_record` distinguishes the two where `checkdnsrr` cannot.
     */
    public function domainAcceptsMail(string $email): bool
    {
        $domain = substr((string) strrchr($email, '@'), 1);
        if ($domain === '') {
            return false;
        }
        // Internationalised domains have to be punycode before DNS will answer; harmless
        // for an ASCII one.
        $ascii = function_exists('idn_to_ascii') ? idn_to_ascii($domain) : $domain;
        $domain = $ascii !== false ? $ascii : $domain;

        if (checkdnsrr($domain, 'MX') || checkdnsrr($domain, 'A') || checkdnsrr($domain, 'AAAA')) {
            return true;
        }
        $records = @dns_get_record($domain, DNS_MX | DNS_A);

        return $records === false ? true : count($records) > 0;
    }

    /**
     * The page a form was sent from, kept only when it is one of this site's own.
     *
     * It is a form field like any other, which is the whole point: a lead should never
     * carry an address a stranger typed, because it is read later by a person who will
     * reasonably assume it came from us.
     */
    public function ownReferrer(string $raw): string
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

        return isset($parts['host']) && strcasecmp($parts['host'], (string) $siteHost) === 0 ? $raw : '';
    }
}
