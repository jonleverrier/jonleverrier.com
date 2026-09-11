<?php

namespace modules\jonson\services;

use Craft;
use craft\elements\Entry;
use yii\base\Component;
use yii\web\Cookie;

/**
 * VIP — a private front door per person.
 *
 * Jon makes a `vip` entry for someone (a hiring manager, a prospect), writes a
 * private note on them in `jonsonSummary` — who they are, what they're weighing
 * up, what of the work speaks to them — and sends them /vip/{slug}. Landing there
 * sets a cookie holding the entry's uid and redirects to the homepage; from then
 * on, for the whole visit, the ask endpoint primes Jonson with the note and every
 * page carries a small strip saying VIP + their name.
 *
 * Two properties fall out of the cookie holding a uid rather than the note:
 *   - it can't be forged: Craft signs its cookies (cookie validation), and a uid
 *     isn't guessable the way an entry id is;
 *   - disabling the entry in the CP revokes the door instantly, cookie or not —
 *     current() resolves against LIVE entries on every request.
 */
class Vip extends Component
{
    public const COOKIE = 'jonson_vip';
    public const SECTION = 'vip';
    public const FIELD = 'jonsonSummary';
    /** How long the door stays open after they walk through it. */
    public const DAYS = 30;

    /**
     * Why Jon made the door — the entry's `purpose` dropdown. Each purpose carries
     * the framing Jonson speaks from (who the visitor is to Jon, what the natural
     * next step is) and the question the contact copy asks in place of the contact
     * single's default. Keyed by the dropdown's option VALUE.
     *
     * Kept abstract on purpose: no names, no specifics — those live in the note.
     */
    public const PURPOSES = [
        'lookingForAJob' => [
            'label' => 'Looking for a job',
            'contact' => 'Want to talk?',
            'prompt' => "You made this door because you'd like to work for them — but that's YOUR hope, "
                . "not something they've said. They haven't told you they're hiring, and there may be "
                . "no open role at all. So never assume a position exists: don't interview for it, "
                . "don't ask about \"the role\" or \"the team I'd be joining\", don't talk like a "
                . "candidate who's been shortlisted. You're someone they've been introduced to who'd "
                . "be a strong fit if a need ever arose. Be genuinely curious about their business "
                . "and what they're wrestling with, let them see the shape and depth of your "
                . "experience and how you think (your career history is the thing to draw on), and "
                . "let the idea of working together surface lightly — once, when it's natural, as a "
                . "door left open rather than a pitch. Don't sell a project engagement either: no "
                . "proposals, quotes or phases-for-their-project. The natural next step is a "
                . "conversation, nothing more formal; wherever your other instructions say \"the "
                . "work\" or \"working together\", read them that way.",
        ],
        'lookingToWinWork' => [
            'label' => 'Looking to win work',
            'contact' => null, // the contact single's own question already asks this
            'prompt' => "You made this door because you'd like to win work from them — a prospective "
                . "client, though they may not have a brief, a budget or a project in mind yet. Don't "
                . "assume one: be curious about their business and where the friction is, and let how "
                . "you help — your process, the kinds of problems you solve, the work of yours that "
                . "maps onto their situation — speak for itself. The natural next step is a "
                . "conversation about what they might need.",
        ],
        'lookingToFormAPartnership' => [
            'label' => 'Looking to form a partnership',
            'contact' => 'Want to talk about working together?',
            'prompt' => "You made this door because you'd like to form a partnership with them — a peer, "
                . "a studio, an agency, a complementary business — though they may not have thought "
                . "about it yet. Speak as a potential collaborator, not a supplier and not a "
                . "candidate: where your strengths might meet theirs, what you could make together, "
                . "how you like to work alongside other people. Don't presume an arrangement exists; "
                . "the natural next step is a conversation about whether working together makes sense.",
        ],
    ];

    /** The field holding the door's alternate slug — the short code form of the URL. */
    public const ALT_SLUG_FIELD = 'altSlug';

    private ?Entry $current = null;
    private bool $resolved = false;

    /**
     * The door's alternate code: a short lowercase string derived from the slug, so
     * /vip/kohde-mt and /vip/2k7x9d3q open the same door. Hashids over the slug's
     * crc32 (Cryptographer's maskNumbers; alphabet and length in config/
     * cryptographer.php). Deterministic for a given slug. What's STORED on the entry
     * is the full URL (see fillAltSlug), and a visit is resolved by looking that up,
     * never by decoding — so the hashids salt differing between environments changes
     * nothing about a link that's already out.
     */
    public function altSlugFor(Entry $entry): string
    {
        $slug = trim((string) $entry->slug);
        if ($slug === '') {
            return '';
        }
        $plugin = \miranj\cryptographer\Plugin::getInstance();
        if (!$plugin) {
            return '';
        }

        return strtolower($plugin->cryptographer->maskNumbers([crc32($slug)]));
    }

    /**
     * Set the alternate slug on a vip entry — as the FULL URL (https://…/vip/2k7x9d3q),
     * so Jon can copy it straight out of the CP field and paste it into a message.
     * Called before the entry saves (see Jonson::init), so it lands in the same save.
     *
     * Derived from the slug on EVERY save, so it follows the slug: change kohde-mt to
     * kohde-marcus and the code changes with it, exactly as the real /vip/{slug} URL
     * does. A link already sent stops working in both forms alike — the slug is the
     * door's identity, and the code is just its other spelling. It also means the
     * field is not hand-editable: whatever is typed there is replaced on save.
     */
    public function fillAltSlug(Entry $entry): void
    {
        if (($entry->getSection()?->handle ?? '') !== self::SECTION) {
            return;
        }
        if (!$entry->getFieldLayout()?->getFieldByHandle(self::ALT_SLUG_FIELD)) {
            return;
        }
        $code = $this->altSlugFor($entry);
        if ($code !== '') {
            $entry->setFieldValue(self::ALT_SLUG_FIELD, \craft\helpers\UrlHelper::siteUrl('vip/' . $code));
        }
    }

    /**
     * The live vip entry a URL token names — by alternate slug first, then by the
     * real slug — or null. Lookup only, never decoding. The field holds a full URL,
     * so the match is on its tail ("…/vip/<token>") rather than the whole value:
     * the host it was minted under (dev, staging, a later domain) mustn't matter.
     */
    public function findByToken(string $token): ?Entry
    {
        $token = strtolower(trim($token));
        if ($token === '' || !preg_match('/^[a-z0-9][a-z0-9_-]{0,100}$/', $token)) {
            return null;
        }
        $live = fn() => Entry::find()->section(self::SECTION)->status(Entry::STATUS_LIVE);

        return $live()->{self::ALT_SLUG_FIELD}('*/vip/' . $token)->one()
            ?? $live()->{self::ALT_SLUG_FIELD}($token)->one() // a bare code, if one was ever typed in by hand
            ?? $live()->slug($token)->one();
    }

    /**
     * Walk through the door: remember the VIP (when the entry has a note to prime
     * Jonson with — an entry without one isn't a door, and nothing is remembered)
     * and send them to the homepage. The section template and the alt-slug
     * controller both end here, so the two URLs can't behave differently.
     */
    public function enter(?Entry $entry): \yii\web\Response
    {
        if ($entry) {
            if ($this->note($entry) !== '') {
                $this->remember($entry);
            }
            $this->countHit($entry);
        }

        return Craft::$app->getResponse()->redirect(\craft\helpers\UrlHelper::siteUrl(''));
    }

    /** The field counting visits to the door (either URL form). */
    public const HITS_FIELD = 'urlHits';

    /**
     * One more visit to the door. Every arrival counts, note or no note, and both
     * URL forms count alike — the number Jon reads in the CP is "how many times
     * has this link been opened". Saved without validation, propagation or a search
     * re-index: it's a counter, not an edit. A failure to count is logged and
     * swallowed — the visitor must still get through the door.
     */
    private function countHit(Entry $entry): void
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle(self::HITS_FIELD)) {
            return;
        }
        try {
            $entry->setFieldValue(self::HITS_FIELD, (int) $entry->{self::HITS_FIELD} + 1);
            if (!Craft::$app->getElements()->saveElement($entry, false, false, false)) {
                Craft::warning('[jonson] VIP hit not counted: ' . json_encode($entry->getErrors()), __METHOD__);
            }
        } catch (\Throwable $e) {
            Craft::warning('[jonson] VIP hit not counted: ' . $e->getMessage(), __METHOD__);
        }
    }

    /**
     * Remember this VIP for the visit: the cookie on the current response. Twig
     * calls this from the section's template right before redirecting home.
     */
    public function remember(Entry $entry): void
    {
        $request = Craft::$app->getRequest();
        Craft::$app->getResponse()->getCookies()->add(new Cookie([
            'name' => self::COOKIE,
            'value' => $entry->uid,
            'expire' => time() + self::DAYS * 86400,
            'httpOnly' => true,
            'secure' => $request->getIsSecureConnection(),
            'sameSite' => Cookie::SAME_SITE_LAX,
        ]));
    }

    /**
     * The VIP this request belongs to, or null: a live entry in the vip section
     * matching the cookie's uid, with a non-empty note. Anything else — no cookie,
     * a stale or forged one, a disabled entry, an empty note — is null, and the
     * visitor is treated as anyone else. Resolved once per request.
     */
    public function current(): ?Entry
    {
        if ($this->resolved) {
            return $this->current;
        }
        $this->resolved = true;

        $request = Craft::$app->getRequest();
        if ($request->getIsConsoleRequest()) {
            return null;
        }
        $uid = strtolower(trim((string) $request->getCookies()->getValue(self::COOKIE, '')));
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $uid)) {
            return null;
        }

        $entry = Entry::find()
            ->section(self::SECTION)
            ->uid($uid)
            ->status(Entry::STATUS_LIVE)
            ->one();

        return $this->current = ($entry && $this->note($entry) !== '') ? $entry : null;
    }

    /** The private note on the VIP — empty if the field isn't on the layout. */
    public function note(Entry $entry): string
    {
        return $this->field($entry, self::FIELD);
    }

    /**
     * A line of copy with the VIP's first name worked in — "Want to talk about a
     * project?" becomes "Want to talk about a project, Marcus?". The name goes
     * before a closing ?, ! or full stop, else on the end. Unchanged when there's
     * no VIP or no first name, so every caller can pass its copy through blind.
     */
    public function personalise(string $line, ?Entry $entry = null): string
    {
        $entry ??= $this->current();
        $first = $entry ? $this->field($entry, 'firstName') : '';
        $line = trim($line);
        if ($first === '' || $line === '') {
            return $line;
        }
        if (preg_match('/^(.*?)([?!.])$/u', $line, $m)) {
            return $m[1] . ', ' . $first . $m[2];
        }

        return $line . ', ' . $first;
    }

    /**
     * The door's purpose — one of the PURPOSES keys, or '' when the dropdown isn't
     * on the layout, is unset, or holds a value this code doesn't know.
     */
    public function purpose(Entry $entry): string
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle('purpose')) {
            return '';
        }
        $value = trim((string) $entry->purpose); // SingleOptionFieldData casts to its value

        return isset(self::PURPOSES[$value]) ? $value : '';
    }

    /**
     * The question the contact copy asks this visitor: the purpose's own line when
     * it has one ("Want to talk about the role?"), else $default (the contact
     * single's), either way with the first name worked in. $default unchanged for
     * anyone who isn't a VIP — every caller passes its copy through blind.
     */
    public function contactLine(string $default, ?Entry $entry = null): string
    {
        $entry ??= $this->current();
        if (!$entry) {
            return trim($default);
        }
        $line = self::PURPOSES[$this->purpose($entry)]['contact'] ?? null;

        return $this->personalise($line ?? $default, $entry);
    }

    /**
     * A plain-text field on the VIP entry, or '' when the field isn't on the
     * layout or is empty — so a template or prompt can ask for `firstName`,
     * `surname`, `company`, `email` without caring which of them Jon has filled in.
     */
    public function field(Entry $entry, string $handle): string
    {
        if (!$entry->getFieldLayout()?->getFieldByHandle($handle)) {
            return '';
        }
        $value = $entry->$handle;

        return is_string($value) ? trim($value) : '';
    }
}
