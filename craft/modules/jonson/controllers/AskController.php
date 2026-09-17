<?php

namespace modules\jonson\controllers;

use Craft;
use craft\elements\Entry;
use craft\helpers\App;
use craft\web\Controller;
use craft\web\View;
use GuzzleHttp\Client;
use modules\frontend\cache\ResilientRedisCache;
use modules\jonson\Jonson;
use modules\jonson\services\Spotify;
use Psr\Http\Message\StreamInterface;
use yii\web\Response;

/**
 * Front-end "ask me anything" endpoint. Public + anonymous.
 *
 * Streams Claude's reply to the browser as Server-Sent Events. The Claude call
 * is server-side (Guzzle) so the API key never reaches the client.
 *
 * Around the prose, the site can SURFACE real things — a rail of photos, case
 * study cards, client logos, sector tags, the process timeline, a testimonial,
 * the ways to get in touch, a strip of artists. The model asks for each by
 * placing a [[marker]] in the sentence that introduces it; the finished answer
 * is resolved against surfaceRegistry() and each surface is pushed as its own
 * SSE event for the front-end to slot in beneath that paragraph. The rule set
 * is documented at the resolver in actionStream(); the acceptance suite that
 * guards it is tools/jonson/.
 */
class AskController extends Controller
{
    protected int|bool|array $allowAnonymous = true;

    private const HISTORY_PREFIX = 'jonson-history'; // per-session conversation (AI prompt), Craft cache
    private const FROM_PREFIX = 'jonson-from'; // per-conversation: the note/study the opener was asked from
    private const PAGE_CONTEXT_CHARS = 7000; // how much of the page's own text rides along

    /** The entry id of the page this conversation was opened from, if any (see pageContextPrompt). */
    private ?int $pageFrom = null;

    // Analytics context for this request, filled once in actionIndex and read by
    // logTurn(). Properties rather than arguments because the six places a turn can
    // finish are scattered through a long generator, and threading eight values
    // through all of them would be worse than this.
    private string $logSid = '';
    private string $logPageUrl = '';
    private int $logPromptUses = 0;
    private ?int $logFromChip = null;
    private float $logStartedAt = 0.0;
    // When the FIRST token reached the browser, on the same clock as $logStartedAt.
    // 0.0 means none ever did — a degraded reply, or a turn that failed before it
    // spoke — and that stays null in the log rather than being recorded as instant.
    private float $logFirstTokenAt = 0.0;
    private string $logQuestion = '';
    // Token usage for this turn, accumulated across every API call it takes. Kept
    // apart rather than as one total because they are priced differently — a cache
    // WRITE is 2x base input and a read is 0.1x — so a single number could not be
    // turned back into money afterwards.
    private int $logInTokens = 0;
    private int $logCacheRead = 0;
    private int $logCacheWrite = 0;
    private int $logOutTokens = 0;
    // Set once a turn has been recorded, so no path can double-count. The generator
    // has enough branches that "this one returns early" is not a safe assumption.
    private bool $logDone = false;
    private const VIP_CONTEXT_CHARS = 6000; // how much of a VIP's note rides along (see vipPrompt)
    private const TRANSCRIPT_PREFIX = 'jonson-transcript'; // per-session full transcript (uncapped) for lead capture
    private const ANSWER_PREFIX = 'jonson-answer'; // cached answer bundle per session+question
    private const CACHE_TTL = 10800; // 3h, refreshed each turn — covers any real session
    // Every modifier any marker can carry. Used only to clear the once-per-conversation
    // slots a variant can claim (see panelSlot / resetShownOnce) — keep in step with
    // the modifiers the directives actually tell the model to emit.
    private const PANEL_MODIFIERS = ['all'];
    private const REPEAT_REPLY = 'You’ve already asked me that one — is there something else I can help you with?';
    // Answer to something that isn't a question (see looksLikeJunk). Deliberately not
    // an error: a visitor who fat-fingered the box gets a nudge in Jon's voice and a
    // set of chips, not a red warning — and it costs nothing to send.
    //
    // Editable in the CMS — see junkReply(). This is the FALLBACK, used when the field
    // hasn't been added to the layout or has been left empty; it is not dead code, and
    // it needs to stay a sentence Jon would actually say.
    private const JUNK_REPLY = 'Not quite sure what you’re after there — ask me anything about the work, how I run a project, or who I’ve worked with.';
    private const JUNK_REPLY_FIELD = 'jonsonShortQuestion'; // on the Home single
    // Shown when the model can't be reached at all — see outageReply(). Same deal as
    // JUNK_REPLY: editable in the CMS, this is the fallback, keep it a real sentence.
    private const OFFLINE_REPLY = 'I can’t reach my brain at the moment — give me a few minutes and try again. In the meantime, here’s some of the work.';
    private const OFFLINE_REPLY_FIELD = 'jonsonApiError'; // on the Home single
    private const MAX_MESSAGE_PAIRS = 50; // ceiling only (to bound abuse) — effectively the whole chat

    // Longest question that reaches the API, in characters. The junk gate below rejects
    // a question for being too SHORT or too repetitive; nothing rejected one for being
    // too long, so a 300,000-character post walked through every check and arrived at
    // the API as input tokens — one allowance spent, a whole context window billed.
    //
    // TRUNCATED, NOT REFUSED. A real question is never near this: the field is a single
    // line and the longest anyone has genuinely typed is a fraction of it. So the cap can
    // sit far above honest use and still bound the bill — and on the rare verbose
    // question it quietly takes the first 1,000 characters, which carries the ask, rather
    // than handing a real visitor an error for writing too much.
    private const MAX_QUESTION_CHARS = 1000;

    // Per-IP ceiling on questions that actually reach the API. Deliberately NOT a
    // per-conversation cap: a script doesn't care about one — it mints a fresh cid and
    // carries on — and a visitor deep into a real conversation is the most engaged lead
    // the site will ever see. This is pointed at a loop, not at a person, so the number
    // is set well above any genuine visit (most ask one to three) and no honest session
    // will ever meet it.
    //
    // Counts only turns that would spend money: junk, repeats and cached replays are all
    // answered above the gate and cost nothing, so they cost no allowance either.
    private const RATE_LIMIT = 30;      // questions per IP per window
    private const RATE_LIMIT_VIP = 150; // …and for someone who came through a VIP door
    private const RATE_WINDOW = 3600;   // 1 hour, rolling — matches CrmController's limiter
    private const RATE_REPLY = 'You’ve given me a real going over — I need a breather. Try me again shortly.';
    private const RATE_REPLY_FIELD = 'jonsonRateLimit'; // on the Home single, like the other two
    // Analytics rows per IP per RATE_WINDOW. A SEPARATE ceiling from RATE_LIMIT above,
    // because it is defending a different resource against a different cost.
    //
    // RATE_LIMIT protects the API bill, so junk, repeats and cached replays are
    // answered ABOVE it and deliberately cost a visitor nothing — they spend no money.
    // They do spend disk: logTurn() writes a row on every one of those paths, and
    // nothing between the junk gate and the database bounded how often.
    //
    // Set far above honest use. A real visit writes a handful of turns; the busiest
    // genuine session this site has seen is nowhere near 200, so no person will meet
    // this. It exists for a script that lifts a CSRF token and posts junk with an
    // invented sid, which is the one shape that reaches the writes without reaching
    // the API.
    private const LOG_LIMIT = 200;

    private const MAX_SUGGESTIONS = 3; // "where next?" prompt chips per answer — a cap, not a floor
    private const MUSIC_STRIP_MAX = 6; // latest N artists shown in the [[music]] strip
    private const SUBJECT_WINDOW_TURNS = 3; // how many recent turns still name the subject of a follow-up (see recentTurnsText)

    /**
     * POST /jonson/ask → streams an answer as text/event-stream.
     */
    public function actionStream(): Response
    {
        $this->requirePostRequest();

        $apiKey = App::env('KEY_ANTHROPIC_API');
        if (empty($apiKey)) {
            return $this->sendSseError('The assistant isn’t configured yet.');
        }

        $question = trim((string) $this->request->getBodyParam('question'));
        if ($question === '') {
            return $this->sendSseError('Please enter a question.');
        }

        // Capped HERE, above everything, so nothing downstream ever sees the original:
        // not the junk gate, not the repeat cache key, not the analytics row, and above
        // all not the API. A cap applied later would still have let the long string be
        // hashed, stored and billed on the way past.
        //
        // A HARD cut, deliberately not trimmed back to a word boundary. mb_strrpos
        // returns false when there is no space to find — which is precisely the shape
        // of an abusive question — and (int) false is 0, so the tidier version would
        // truncate exactly the worst case to an empty string, below a guard that has
        // already run.
        if (mb_strlen($question) > self::MAX_QUESTION_CHARS) {
            $question = mb_substr($question, 0, self::MAX_QUESTION_CHARS);
        }

        // Is this a follow-up within the live thread (a genuine repeat → nudge),
        // or a fresh opener (a repeat → replay the cached answer)? The client
        // flags it; anything but an explicit "1" is treated as an opener.
        $continuation = $this->request->getBodyParam('continuation') === '1';

        // Which page the question was asked from, when it came through a note's or
        // case study's ask bar (the handoff posts the entry id once, on the
        // opener). Remembered for the thread, so a follow-up still knows what
        // "the plugin" is; a fresh opener with no page forgets it.
        $from = (int) $this->request->getBodyParam('from', 0);

        // ANALYTICS CONTEXT, read once. None of this reaches the model or changes an
        // answer — see services\Analytics. `sid` is the VISIT (sessionStorage, dies
        // with the tab); `cid` above is the VISITOR (localStorage, durable). Confusing
        // the two is the mistake this whole design is arranged around avoiding.
        $this->logSid = (string) $this->request->getBodyParam('sid', '');
        $this->logPageUrl = (string) $this->request->getBodyParam('pageUrl', '');
        $this->logPromptUses = (int) $this->request->getBodyParam('promptUses', 0);
        $chipParam = $this->request->getBodyParam('fromChip');
        $this->logFromChip = ($chipParam === null || $chipParam === '') ? null : (int) $chipParam;
        // Wall clock for the turn, started before any work so the number means what a
        // visitor experienced rather than what the API took.
        $this->logStartedAt = microtime(true);
        $this->logFirstTokenAt = 0.0;
        $this->logQuestion = $question;

        // Conversation history for follow-ups — kept in Craft's cache (reliable
        // across the streaming response, unlike session data) so context never
        // drops mid-chat. Keyed by the session id.
        $session = Craft::$app->getSession();
        // The id is only stable — and unique per visitor — once the PHP session
        // is actually open. Yii's getId() is a bare session_id() and does NOT
        // auto-start it, and Craft doesn't open a session for anonymous front-end
        // requests (CSRF uses its own cookie). Without this, getId() returns ''
        // for everyone, so the answer cache, history and once-gating all collide
        // across visitors: one person asking "what's your process?" makes the
        // next visitor's identical question read as an already-asked repeat (the
        // nudge path, which shows no suggestions). Opening here — before any
        // streamed output — issues the CraftSessionId cookie so each visitor gets
        // their own bucket. Must happen before the stream starts (headers).
        if (!$session->getIsActive()) {
            $session->open();
        }

        $fromKey = self::FROM_PREFIX . ':' . $this->convoId($session);
        if ($from > 0) {
            Craft::$app->getCache()->set($fromKey, $from, self::CACHE_TTL);
        } elseif ($continuation) {
            $from = (int) Craft::$app->getCache()->get($fromKey);
        } else {
            Craft::$app->getCache()->delete($fromKey);
        }
        $this->pageFrom = $from > 0 ? $from : null;

        $stored = Craft::$app->getCache()->get($this->historyKey($session));
        if (!is_array($stored)) {
            $stored = [];
        }

        $messages = [];
        foreach ($stored as $m) {
            if (isset($m['role'], $m['content']) && is_string($m['content'])) {
                $messages[] = ['role' => $m['role'], 'content' => $m['content']];
            }
        }
        $messages[] = ['role' => 'user', 'content' => $question];
        while (count($messages) > self::MAX_MESSAGE_PAIRS * 2) {
            array_shift($messages);
        }

        $model = App::env('KEY_ANTHROPIC_MODEL') ?: 'claude-opus-4-8';

        try {
            $system = Jonson::getInstance()->persona->prompt();
        } catch (\Throwable $e) {
            // e.g. the directives file is missing — never answer without rails.
            Craft::error('[jonson] ' . $e->getMessage(), __METHOD__);
            return $this->sendSseError('The assistant isn’t configured yet.');
        }

        // No model-facing tool: retrieval is marker-driven. Claude references
        // what it can show via [[handle]] markers; we list the available handles
        // in the system prompt and resolve them from the finished answer.
        $tools = [];
        $inventory = $this->inventoryPrompt();
        if ($inventory !== '') {
            $system .= "\n\n" . $inventory;
        }

        // Tell the model which sectors Jon actually has experience in, so he
        // never claims — or suggests as a prompt — a sector he hasn't worked in.
        $sectorsPrompt = $this->sectorsPrompt();
        if ($sectorsPrompt !== '') {
            $system .= "\n\n" . $sectorsPrompt;
        }

        // Tell the model Jon's actual "how I can help" journey (phases +
        // services), so he speaks to his real process/offering and knows when
        // the [[method]] timeline is worth showing.
        $methodologyPrompt = $this->methodologyPrompt();
        if ($methodologyPrompt !== '') {
            $system .= "\n\n" . $methodologyPrompt;
        }

        // Feed Jon's real career history in as private background, so he can speak
        // accurately to his experience when a visitor is weighing him up — without
        // reciting the CV.
        $cvPrompt = $this->cvPrompt();
        if ($cvPrompt !== '') {
            $system .= "\n\n" . $cvPrompt;
        }

        // Feed Jon's notes in as memories — what he's done, seen and thought, as
        // memory cards (see services\NoteMemory) — so a chat about printing can
        // bring a Tokyo museum to mind. Background, never a reading list.
        $notesPrompt = $this->notesPrompt();
        if ($notesPrompt !== '') {
            $system .= "\n\n" . $notesPrompt;
        }

        // Feed the client roster + what Jon did for each in as background too, so
        // he can speak concretely about relevant work (separate from the [[clients]]
        // logo strip).
        $clientsPrompt = $this->clientsPrompt();
        if ($clientsPrompt !== '') {
            $system .= "\n\n" . $clientsPrompt;
        }

        // Case studies as background (the private jonsonSummary per study) + when to
        // surface the [[casestudies]] discovery cards.
        $caseStudiesPrompt = $this->caseStudiesPrompt();
        if ($caseStudiesPrompt !== '') {
            $system .= "\n\n" . $caseStudiesPrompt;
        }

        // Jon's music taste (Spotify) as personality/tone background — colours his
        // voice and lets him speak to what he's into when people are getting to
        // know him.
        $musicPrompt = $this->musicPrompt();
        if ($musicPrompt !== '') {
            $system .= "\n\n" . $musicPrompt;
        }

        // ——— EVERYTHING ABOVE IS THE CACHED PREFIX. EVERYTHING BELOW VARIES. ———
        //
        // The split is the whole point of $volatile. The system prompt is ~25,400
        // tokens and is marked as a cache breakpoint (see the request below), which is
        // only worth anything while its bytes are IDENTICAL from turn to turn: a 1h
        // cache WRITE costs 2× normal input, a read 0.1×, and the cache is keyed on the
        // bytes. Anything that changes re-writes the whole prefix.
        //
        // All four pieces below change — the funnel nudge by turn, the page context by
        // page, the VIP blocks by visitor — and they used to be appended straight onto
        // $system. Measured over five turns: write 25,273 / write 25,461 / write 25,457
        // / read / read. Three full re-writes of 25k tokens, triggered by a couple of
        // hundred tokens of nudge, for about 61% more than the conversation needed to
        // cost.
        //
        // They now ride in a second, UNCACHED system block. The model receives exactly
        // the same text in the same order; it just stops invalidating the cache.
        $volatile = '';

        // The clock first, because it used to sit at the end of the cached block and
        // this keeps it in the same place in the prompt the model reads. It is the
        // reason that block was being rewritten rather than read: it is accurate to
        // the minute, and a cached prefix has to be byte-identical to be a hit.
        $volatile .= "\n\n" . Jonson::getInstance()->persona->nowContext();

        // Turn-aware lead-gen nudge: the deeper into the conversation, the more the
        // [[next:]] onward prompts should lean toward the work / working together
        // rather than looping on generic get-to-know-you questions. Shapes only the
        // prompts, not the reply's voice.
        $funnelNudge = $this->funnelNudgePrompt($session);
        if ($funnelNudge !== '') {
            $volatile .= "\n\n" . $funnelNudge;
        }

        // The page the question came from, if any — its text, in full, so the
        // question is read against it.
        $pageContext = $this->pageContextPrompt();
        if ($pageContext !== '') {
            $volatile .= "\n\n" . $pageContext;
        }

        // Who they are, if they came through a VIP link (the cookie set at
        // /vip/{slug}) — Jon's private note on the person/company, so the answers
        // are tailored from the first word, for the whole visit.
        $vipContext = $this->vipPrompt($session);
        if ($vipContext !== '') {
            $volatile .= "\n\n" . $vipContext;
        }

        // The ways THIS visitor can reach Jon — the CTAs their door unlocked, with the
        // real URLs, so an offer to call names the right number instead of a plausible
        // one. Placed after the VIP note because it only ever applies to a VIP.
        $routes = $this->contactRoutesPrompt();
        if ($routes !== '') {
            $volatile .= "\n\n" . $routes;
        }

        // Ask the model to write the way in ITSELF on the turn the engagement floor
        // would otherwise bolt one on. Placed after the routes so it can name them.
        $beatCue = $this->contactBeatCue($session);
        if ($beatCue !== '') {
            $volatile .= "\n\n" . $beatCue;
        }

        // How much of the career history this particular visitor gets (see
        // cvDepthOverride). Out here rather than inside cvPrompt() so the CV itself —
        // a big, stable block — stays in the shared cached prefix for everyone, VIP or
        // not. Placed after the VIP note it belongs to, and last of the three, so it is
        // the most recent instruction on the subject when the model reads it.
        $cvDepth = $this->cvDepthOverride();
        if ($cvDepth !== '') {
            $volatile .= "\n\n" . $cvDepth;
        }

        // The grounding rule for the onward prompts, restated last so it's fresh on
        // every turn (openers included, which the funnel nudge skips): the model
        // tends to drop the citations on answers busy with other markers, and an
        // uncited prompt is discarded server-side (see groundedPrompts).
        //
        // Static, but it lives in the volatile block so it stays LAST — which is its
        // whole job. A couple of hundred uncached tokens a turn is a fair price for
        // that; putting it in the cached prefix would bury it behind the VIP note.
        $volatile .= "\n\nREMINDER: mark what you show. Every photo handle, and every `[[casestudies]]`, "
            . '`[[clients]]`, `[[sectors]]`, `[[testimonial]]`, `[[method]]`, `[[contact]]` and `[[music]]` '
            . 'marker, goes where "What you can show" says it belongs — nothing you leave unmarked can '
            . 'appear, and nothing is added for you. And every prompt in your closing [[next: …]] marker '
            . 'must end with its citation (`@note:id`, `@study:id`, `@photo:handle`, `@sector:name`, '
            . '`@client:name`, or a standing topic such as `@contact`, `@method`, `@work`, `@cv`, `@music`, '
            . '`@about`). A prompt without a citation is discarded before the visitor sees it; a prompt '
            . 'you cannot cite is one to leave out.';

        $response = Craft::$app->getResponse();
        $response->format = Response::FORMAT_RAW;
        $headers = $response->getHeaders();
        $headers->set('Content-Type', 'text/event-stream');
        $headers->set('Cache-Control', 'no-cache');
        $headers->set('X-Accel-Buffering', 'no'); // don't let nginx buffer the stream

        $response->stream = function () use ($apiKey, $model, $system, $volatile, $messages, $question, $session, $tools, $continuation) {
            // Drop any PHP output buffering so tokens flush immediately.
            while (ob_get_level() > 0) {
                ob_end_flush();
            }

            // A fresh opener starts a new conversation — the testimonial quote and
            // the clients marquee may appear again. Within a conversation they show
            // at most once each (tracked below), no matter how often the model marks
            // them.
            if (!$continuation) {
                $this->resetShownOnce($session);
            }

            // Not a question at all — answer it here and spend nothing. A single
            // character, a row of punctuation or one letter held down is worth about
            // 25,400 input tokens by the time it reaches the model, and every one of
            // them would come back with a real answer to nothing.
            //
            // Shaped exactly like the repeat nudge below: canned prose, chips, done.
            // The visitor can't tell it apart from any other turn, which is the point.
            // Nothing is written to the history or the answer cache — a non-question
            // shouldn't teach the model anything or occupy a cache slot.
            if ($this->looksLikeJunk($question)) {
                Craft::info('junk question, no API call: ' . $question, 'jonson.suggestions');
                $junkReply = $this->junkReply();
                yield $this->sse('text', ['text' => $junkReply]);
                $junkSuggestions = $this->suggestionsFor(
                    '',
                    $session,
                    $question,
                    $this->shownContentHandles($session, false),
                    null,
                    false,
                    false,
                    false, // don't spend the budget on a turn that wasn't a question
                );
                if ($junkSuggestions) {
                    yield $this->sse('suggestions', ['items' => $junkSuggestions]);
                }
                yield $this->sse('done', ['answer' => $junkReply]);
                $this->logTurn('junk', $junkReply, $junkSuggestions);

                return;
            }

            // Have we already answered this exact question this session?
            $cached = Craft::$app->getCache()->get($this->answerKey($session, $question));
            if (is_array($cached)) {
                if ($continuation) {
                    // Asked again from within the live conversation — a genuine
                    // repeat. Don't re-answer; acknowledge it and nudge onward,
                    // with fresh prompt chips to redirect them somewhere useful.
                    yield $this->sse('text', ['text' => self::REPEAT_REPLY]);
                    $nudgeSuggestions = $this->suggestionsFor(
                        '',
                        $session,
                        $question,
                        $this->shownContentHandles($session, false),
                    );
                    if ($nudgeSuggestions) {
                        yield $this->sse('suggestions', ['items' => $nudgeSuggestions]);
                    }
                    yield $this->sse('done', ['answer' => self::REPEAT_REPLY]);
                    $this->logTurn('repeat', self::REPEAT_REPLY, $nudgeSuggestions);

                    return;
                }

                // A fresh opener repeating an earlier question — replay the
                // cached answer + rail + testimonial instead of spending an API
                // call. The raw prose still carries its [[markers]], so the
                // client positions the rail/quote exactly as it did first time.
                yield $this->sse('text', ['text' => $cached['answer']]);
                if (!empty($cached['rail'])) {
                    yield $this->sse('context', ['html' => $cached['rail']]);
                }
                // Replay each cached panel under its own event (the handle is the
                // SSE event name), still gated to once per conversation.
                // Claim the same SLOT the panel claimed when it was built, so a cached
                // marquee doesn't consume the feature's slot or vice versa. Bundles
                // cached before panelSlots existed fall back to the handle.
                foreach (($cached['panels'] ?? []) as $handle => $html) {
                    $slot = $cached['panelSlots'][$handle] ?? (string) $handle;
                    if (!empty($html) && $this->markShownOnce($session, (string) $slot)) {
                        yield $this->sse((string) $handle, ['html' => $html]);
                    }
                }
                // Recompute suggestions from the cached prose rather than replaying
                // the frozen list — so a prompt is never one that's since been asked
                // (which would land on the "already asked" nudge when clicked).
                // Suppressed when the cached answer surfaced the contact beat — same
                // as the fresh path: don't pull a ready-to-connect visitor back.
                if (empty($cached['panels']['contact'])) {
                    $replaySuggestions = $this->suggestionsFor(
                        $cached['answer'],
                        $session,
                        $question,
                        $this->shownContentHandles($session, !empty($cached['rail'])),
                    );
                    if ($replaySuggestions) {
                        yield $this->sse('suggestions', ['items' => $replaySuggestions]);
                    }
                }
                yield $this->sse('done', ['answer' => $cached['answer']]);
                $this->logTurn(
                    'cached',
                    $cached['answer'],
                    $replaySuggestions ?? [],
                    array_keys($cached['panels'] ?? []),
                );

                return;
            }

            // Everything above this line is answered without an API call — junk, a
            // repeat, a cached replay. From here on the turn costs money, which is why
            // the limiter sits HERE and not at the top: allowance is spent only on
            // turns that spend.
            if (!$this->withinRateLimit()) {
                $rateReply = $this->rateLimitReply();
                yield $this->sse('text', ['text' => $rateReply]);
                // No chips. The junk reply offers them because the visitor needs
                // somewhere to go; here every one of them lands back on this same
                // message, which would read as the site taunting them.
                yield $this->sse('done', ['answer' => $rateReply]);
                $this->logTurn('rateLimited', $rateReply);

                return;
            }

            // Two different waits, two different limits.
            //
            // `timeout` covers getting a response at all — connect plus first bytes —
            // and is what decides how fast an outage is NOTICED. `read_timeout` is the
            // gap allowed between chunks once the answer is streaming, which is a
            // separate thing: a long reply legitimately takes a while, and cutting it
            // short would truncate good answers.
            //
            // NOT `connect_timeout`, which does nothing here. `stream => true` routes
            // the request through Guzzle's StreamHandler (Utils::chooseHandler ->
            // Proxy::wrapStreaming), and that handler ignores connect_timeout entirely
            // — only the cURL handler reads it. Set it and an unreachable API still
            // hangs for the full `timeout`; that was measured at 62s before this.
            //
            // It also isn't 120s any more because the answer streams from a PHP worker,
            // so every hung request holds one for its whole life. Enough at once and
            // the whole site stops serving, not just Jonson.
            $client = new Client([
                'timeout' => 10,
                'read_timeout' => 60,
                'http_errors' => false,
            ]);

            $answer = '';
            // Fast mode is an Anthropic research-preview opt-in — off unless the
            // account has it enabled and KEY_ANTHROPIC_FAST is truthy. (Attempting
            // it without access just 429s and wastes a round-trip.)
            $useFast = filter_var(App::env('KEY_ANTHROPIC_FAST'), FILTER_VALIDATE_BOOLEAN);

            try {
                // Delegates: yields `text` SSE events, returns the assembled content
                // blocks (or an error flag). Fast mode falls back to standard speed
                // if it fails before any output streamed.
                $result = yield from $this->streamTurn($client, $apiKey, $model, $system, $volatile, $messages, [], $useFast);
                if ($useFast && !empty($result['error']) && !empty($result['canRetry'])) {
                    $result = yield from $this->streamTurn($client, $apiKey, $model, $system, $volatile, $messages, [], false);
                }
            } catch (\Throwable $e) {
                Craft::error('[jonson] ' . $e->getMessage(), __METHOD__);
                $result = ['error' => 'busy'];
            }

            // Couldn't reach the model, or reached it and got nothing back. Both are
            // the same thing to the visitor — Jonson didn't answer — so both get the
            // same reply. The DISTINCTION is logged, not shown: 'busy' is a 429 or a
            // 5xx (theirs), 'generic' is anything else (ours, usually a bad request).
            if (!empty($result['error'])) {
                Craft::error('[jonson] no answer (' . $result['error'] . ') for: ' . $question, __METHOD__);
                yield from $this->outageReply($session, $question);

                return;
            }

            foreach ($result['blocks'] ?? [] as $block) {
                if (($block['type'] ?? '') === 'text') {
                    $answer .= $block['text'];
                }
            }

            // GROUND THE LINKS before anything reads the answer. inlineMarkdown() lets a
            // same-site path through by shape — it cannot know which paths exist — so
            // without this a model that misremembers a slug ships a link straight to a
            // 404. Checked against the real URIs and unlinked back to its own words when
            // it does not resolve, which leaves the sentence intact and merely flat.
            $answer = $this->groundLinks($answer);

            if ($answer === '') {
                Craft::error('[jonson] empty answer for: ' . $question, __METHOD__);
                yield from $this->outageReply($session, $question);

                return;
            }

            // ——— SURFACES ———
            //
            // Everything placed around the prose — the photo rail, case studies,
            // clients, sectors, method, testimonial, contact, music — resolves here,
            // from one registry (surfaceRegistry), under one rule:
            //
            //     THE MODEL DECIDES WHAT BELONGS. CODE DECIDES WHAT IS ALLOWED.
            //
            // The model says a surface belongs by placing its [[marker]] in the
            // sentence that introduces it; the directive's "What you can show"
            // section is the ONLY place that judgement is described, and the only
            // place to fix it when it's wrong. Code never second-guesses a marker
            // with keyword lists, text scans or intent classifiers — every one of
            // those was a regex trying to read context, and each fix broke a
            // neighbour. Code enforces four things, identically for every surface:
            //
            //   1. GROUNDING   a marker must name a registered surface or a photo
            //                  handle in the inventory, and a photo handle's own
            //                  paragraph must name the place or theme it stands for.
            //                  A handle in a paragraph that never names the thing is
            //                  the model reaching for a photo the prose didn't earn
            //                  (asked about somewhere it has no photos of, it will
            //                  mark somewhere it has). Anything else is ignored.
            //   2. FRAMING     prose must come before the marker — in its paragraph
            //                  or the one above — and the surface renders beneath
            //                  that paragraph. A marker before any prose is DROPPED,
            //                  never rendered above the first line.
            //   3. BUDGET      a surface shows once per conversation (the rail: each
            //                  photo once — see forHandles + shownRailKeys).
            //   4. EXCLUSIONS  declared per surface (`excludes`): skipped when a
            //                  surface it can't sit with already shows this turn.
            //
            // tools/jonson/ is the acceptance suite. Run it before AND after any
            // change here, to the registry, or to the directive.
            $railHtml = null;
            $panels = []; // handle => rendered html, for the cache bundle + replay
            $panelSlots = []; // handle => once-slot claimed, so a replay claims the same
            $suggestions = [];
            if ($answer !== '') {
                $clean = $this->stripMarkers($answer);
                $ctx = Jonson::getInstance()->findContext;
                $registry = $this->surfaceRegistry();
                $marks = $this->markersIn($answer);
                $inventory = array_column($ctx->inventory(), 'label', 'handle'); // handle => label

                foreach ($registry as $surface) {
                    $handle = $surface['handle'];

                    // Which markers speak for this surface: its own handle, or — for
                    // the rail — every photo handle the model placed, in the order
                    // it placed them. Grounding and framing are applied here.
                    if (($surface['marks'] ?? null) === 'photo') {
                        $hits = [];
                        foreach ($marks as $h => $mark) {
                            if ($mark['framed'] && isset($inventory[$h]) && $this->paragraphNamesLabel($answer, $question, $h, $inventory[$h])) {
                                $hits[] = $h;
                            }
                        }
                        if (!$hits) {
                            continue;
                        }
                        $modifier = null;
                    } else {
                        if (!isset($marks[$handle])) {
                            continue;
                        }
                        if (!$marks[$handle]['framed']) {
                            Craft::info("[jonson] [[{$handle}]] dropped: no framing paragraph", __METHOD__);
                            continue;
                        }
                        $hits = [$handle];
                        $modifier = $marks[$handle]['modifier'];
                    }

                    // One block per handle per response, and the cross-turn budget by
                    // slot (a variant such as [[casestudies:all]] claims its own).
                    $slot = $this->panelSlot($handle, $modifier);
                    if (isset($panels[$handle])) {
                        continue;
                    }
                    // Said out loud, because a surface the model DID mark and the budget
                    // then swallowed looks identical from the outside to one the model
                    // never marked: an empty turn either way. Without this line the only
                    // way to tell them apart is to reason about the session.
                    if (!empty($surface['once']) && $this->hasShownOnce($session, $slot)) {
                        Craft::info("[jonson] [[{$handle}]] dropped: already shown this conversation", __METHOD__);
                        continue;
                    }
                    if (array_intersect($surface['excludes'] ?? [], array_keys($panels))) {
                        continue;
                    }

                    // $clean — the answer WITHOUT the question — is passed last, for
                    // surfaces that must read only what Jonson said. Extra arguments to
                    // a closure that doesn't declare them are ignored, so every other
                    // surface is untouched and still gets the combined text it expects.
                    $payload = ($surface['data'])($question . ' ' . $clean, $modifier, $question, $hits, $session, $clean);
                    if (!$payload) {
                        continue;
                    }
                    $present = isset($surface['present']) ? ($surface['present'])($payload, $modifier) : $modifier;
                    // The contact panel carries this visitor's routes as links unless the
                    // answer above it already named them. Harmless on every other surface,
                    // whose templates do not read it.
                    $html = $this->renderComponent($surface['template'], [
                        $surface['var'] => $payload,
                        'modifier' => $present,
                        'offerRoutes' => $slot === 'contact' && !$this->answerNamesRoutes($clean),
                    ]);
                    if ($html === null) {
                        continue;
                    }

                    if (!empty($surface['once'])) {
                        $this->markShownOnce($session, $slot);
                    }
                    if (isset($surface['onShown'])) {
                        ($surface['onShown'])($payload, $session);
                    }
                    if ($handle === 'context') {
                        $railHtml = $html;
                    } else {
                        $panels[$handle] = $html;
                        $panelSlots[$handle] = $slot;
                    }
                    yield $this->sse($handle, ['html' => $html]);
                }

                // Read the exchange for the two signals that shape the slate: the
                // funnel stage (which roles fill it; whether the lead path leads),
                // and whether the visitor has signed off (the only thing that
                // suppresses chips — deterministic, never a model marker). One cheap
                // call, with funnelStage() as the fallback stage if it fails.
                $exchange = $this->classifyExchange($client, $apiKey, $question, $clean, $this->funnelStage($session));
                // Floor the stage by engagement depth: a few turns in, steer to work
                // even when the questions themselves read casual (classifier stays
                // cold/warm). The classifier can only push it warmer, never colder.
                $rawStage = $exchange['stage']; // the classifier's read of THIS question
                $exchange['stage'] = $this->warmerStage($rawStage, $this->funnelStage($session));

                // A genuine pivot back to a personal/discovery topic while already
                // engaged: the current question reads 'cold' but the engagement floor
                // pushed the stage up. Soften the slate (one on-topic discovery chip
                // alongside the work ones) so we don't push work on someone who just
                // wandered back into getting-to-know-you mode.
                $pivotedToDiscovery = ($rawStage === 'cold' && $exchange['stage'] !== 'cold');

                // Engagement-floor contact beat. The [[contact]] marker is the model's
                // call and it waits for an explicit ready-to-act moment — which a
                // visitor who's happily asking about the work may never voice, so
                // conversations ran six questions deep with no way in sight. Once the
                // exchange is 'hot' (a stated buying need, or simply the third question
                // in — the same floor the chips escalate on), surface the ways-to-
                // connect once, deterministically. Not on a personal pivot, not on a
                // sign-off, and never twice. Like every contact beat it stands alone:
                // no "where next?" chips beneath it — the way in IS the next step.
                if (!isset($panels['contact'])
                    && !$this->hasShownOnce($session, 'contact')
                    && $exchange['stage'] === 'hot'
                    && !$exchange['signedOff']
                    && !$pivotedToDiscovery
                ) {
                    foreach ($registry as $p) {
                        if ($p['handle'] !== 'contact') {
                            continue;
                        }
                        $payload = ($p['data'])($question . ' ' . $clean);
                        // offerRoutes, and ONLY on this path. The beat here is added by
                        // code, so the answer above it was written without one — there is
                        // no sentence carrying the call and WhatsApp links the way a
                        // model-marked [[contact]] carries them, and without this the
                        // visitor gets a bare button where a VIP should be getting the
                        // quickest way in. The marker-driven renders (see the resolver)
                        // deliberately do not pass it: their prose already has the links,
                        // and the panel repeating them would say everything twice.
                        $html = $payload
                            ? $this->renderComponent($p['template'], [
                                $p['var'] => $payload,
                                'offerRoutes' => !$this->answerNamesRoutes($clean),
                            ])
                            : null;
                        if ($html !== null) {
                            $this->markShownOnce($session, 'contact');
                            $panels['contact'] = $html;
                            yield $this->sse('contact', ['html' => $html]);
                        }
                        break;
                    }
                }

                // "Where next?" prompt chips — a funnel-shaped slate for this stage,
                // minus anything already asked. Empty only on a genuine sign-off, OR
                // when the contact beat surfaced: once the visitor is on the path to
                // reaching out, don't pull them back into more browsing.
                if (!isset($panels['contact'])) {
                    $suggestions = $this->suggestionsFor(
                        $answer,
                        $session,
                        $question,
                        $this->shownContentHandles($session, $railHtml !== null),
                        $exchange['stage'],
                        $exchange['signedOff'],
                        $pivotedToDiscovery,
                    );
                    if ($suggestions) {
                        yield $this->sse('suggestions', ['items' => $suggestions]);
                    }
                }
            }

            // Best-effort: persist the exchange for follow-up context.
            //
            // The model-facing history keeps EVERY marker in, the [[next: …]] block
            // included. Its earlier replies are the strongest example it has of how
            // it writes, and a history scrubbed of markers taught it, turn by turn,
            // that it doesn't place them — follow-up questions under-marked for
            // exactly that reason. The block used to be stripped here to save its
            // tokens, and it cost the same way: measured over six-turn conversations
            // the model wrote [[next:]] on every opening turn and began dropping it
            // around turn four, where the slate fell back to the canned candidates —
            // the hardcoded menu this design exists to avoid. The transcript for lead
            // capture below stays clean: that one is for a human.
            if ($answer !== '') {
                $clean = $this->stripMarkers($answer);
                $forModel = trim($answer);

                $history = Craft::$app->getCache()->get($this->historyKey($session));
                if (!is_array($history)) {
                    $history = [];
                }
                $history[] = ['role' => 'user', 'content' => $question];
                $history[] = ['role' => 'assistant', 'content' => $forModel];
                while (count($history) > self::MAX_MESSAGE_PAIRS * 2) {
                    array_shift($history);
                }
                Craft::$app->getCache()->set($this->historyKey($session), $history, self::CACHE_TTL);

                // Full transcript for lead capture — uncapped, so it holds the
                // whole conversation regardless of the prompt window above.
                $transcript = Craft::$app->getCache()->get($this->transcriptKey($session));
                if (!is_array($transcript)) {
                    $transcript = [];
                }
                $transcript[] = ['role' => 'user', 'content' => $question];
                $transcript[] = ['role' => 'assistant', 'content' => $clean];
                Craft::$app->getCache()->set($this->transcriptKey($session), $transcript, self::CACHE_TTL);

                // Cache the full answer bundle (raw prose + rendered rail +
                // panels map) keyed by session + normalised question. A fresh
                // opener repeating this question replays it verbatim (no API
                // call); a repeat mid-conversation gets the nudge instead. Craft
                // cache is reliable across the stream, unlike session data.
                Craft::$app->getCache()->set(
                    $this->answerKey($session, $question),
                    [
                        'answer' => $answer,
                        'rail' => $railHtml,
                        'panels' => $panels,
                        'panelSlots' => $panelSlots,
                        'suggestions' => $suggestions,
                    ],
                    self::CACHE_TTL,
                );
            }

            yield $this->sse('done', ['answer' => $answer]);
            $this->logTurn('answered', $answer, $suggestions ?? [], array_keys($panels ?? []));
        };

        return $response;
    }

    /**
     * Stream one Claude call. Yields `text` SSE events as tokens arrive and
     * returns ['blocks' => [...], 'stop' => <stop_reason>] — or ['error' =>
     * 'busy'|'generic'] on failure. `blocks` is the assistant's content (text +
     * tool_use blocks) ready to append to the conversation.
     */
    private function streamTurn(
        Client $client,
        string $apiKey,
        string $model,
        string $system,
        string $volatile,
        array $messages,
        array $tools,
        bool $fast = false,
    ): \Generator {
        $headers = [
            'x-api-key' => $apiKey,
            'anthropic-version' => '2023-06-01',
            'content-type' => 'application/json',
        ];
        if ($fast) {
            // Fast mode: same model, ~2.5× output speed (research preview).
            $headers['anthropic-beta'] = 'fast-mode-2026-02-01';
        }

        $res = $client->post('https://api.anthropic.com/v1/messages', [
            'headers' => $headers,
            'json' => array_filter([
                'model' => $model,
                'max_tokens' => 2048,
                'stream' => true,
                'speed' => $fast ? 'fast' : null,
                // TWO blocks, and only the first is cached.
                //
                // $system is large (~25,400 tokens) and byte-stable per unchanged CMS
                // content — and, crucially, the SAME for every visitor: it's all about
                // Jon, never the asker. The breakpoint on it means Anthropic serves it
                // from cache (~0.1× input cost, faster first token) rather than
                // re-processing it every turn, and the 1h TTL keeps it warm across gaps
                // between visitors. A content edit changes the bytes and transparently
                // re-keys it.
                //
                // $volatile carries everything that does NOT hold still: the turn-aware
                // funnel nudge, the page's own text, the VIP note, and the closing
                // REMINDER. It must stay OUT of the cached block and AFTER it — a cache
                // breakpoint caches a prefix, so one varying byte inside re-writes the
                // whole thing at 2× input. That is exactly what used to happen: three
                // full 25k re-writes in a five-turn conversation.
                //
                // Sent uncached at 1× input, which for a few hundred tokens a turn is
                // far cheaper than the writes it prevents.
                'system' => array_values(array_filter([
                    [
                        'type' => 'text',
                        'text' => $system,
                        'cache_control' => ['type' => 'ephemeral', 'ttl' => '1h'],
                    ],
                    trim($volatile) === '' ? null : [
                        'type' => 'text',
                        'text' => ltrim($volatile, "\n"),
                    ],
                ])),
                'messages' => $messages,
                'tools' => $tools ?: null,
                // Low effort: a warm, short reply needs no deliberation, and
                // fewer tokens means a quicker answer.
                'output_config' => ['effort' => 'low'],
            ], static fn($v) => $v !== null),
            'stream' => true,
        ]);

        $status = $res->getStatusCode();
        if ($status !== 200) {
            // `canRetry` marks a failure that happened before any output streamed,
            // so the caller can safely fall back (e.g. fast mode → standard speed).
            return [
                'error' => ($status === 429 || $status >= 500) ? 'busy' : 'generic',
                'canRetry' => true,
            ];
        }

        $body = $res->getBody();
        $blocks = [];
        $cur = null; // block being assembled
        $stop = null;
        $eventType = '';

        while (!$body->eof()) {
            $line = $this->readLine($body);
            if ($line === '') {
                $eventType = '';
                continue;
            }
            if (str_starts_with($line, 'event: ')) {
                $eventType = substr($line, 7);
                continue;
            }
            if (!str_starts_with($line, 'data: ')) {
                continue;
            }

            $data = json_decode(substr($line, 6), true);
            if (!is_array($data)) {
                continue;
            }

            switch ($eventType) {
                case 'message_start':
                    // Prompt-cache verification. From the 2nd turn on, `read`
                    // should be non-zero (the system prefix served from cache);
                    // a persistent read=0 with write>0 means a silent invalidator
                    // is changing the prefix bytes between requests. `uncached_in`
                    // is the varying remainder (the messages array).
                    $usage = $data['message']['usage'] ?? [];
                    // Bank the input side for the analytics tables. `+=` rather than
                    // `=` because a turn can involve more than one call — fast mode
                    // falling back to standard speed, or a tool round trip — and the
                    // cost of a turn is all of them, not the last one.
                    $this->logInTokens += (int) ($usage['input_tokens'] ?? 0);
                    $this->logCacheRead += (int) ($usage['cache_read_input_tokens'] ?? 0);
                    $this->logCacheWrite += (int) ($usage['cache_creation_input_tokens'] ?? 0);
                    Craft::info(sprintf(
                        'cache read=%d write=%d uncached_in=%d model=%s%s',
                        $usage['cache_read_input_tokens'] ?? 0,
                        $usage['cache_creation_input_tokens'] ?? 0,
                        $usage['input_tokens'] ?? 0,
                        $model,
                        $fast ? ' fast' : '',
                    ), 'jonson.cache');
                    break;

                case 'content_block_start':
                    $type = $data['content_block']['type'] ?? '';
                    if ($type === 'text') {
                        $cur = ['type' => 'text', 'text' => ''];
                    } elseif ($type === 'tool_use') {
                        $cur = [
                            'type' => 'tool_use',
                            'id' => $data['content_block']['id'] ?? '',
                            'name' => $data['content_block']['name'] ?? '',
                            'json' => '',
                        ];
                    } else {
                        $cur = null;
                    }
                    break;

                case 'content_block_delta':
                    $delta = $data['delta'] ?? [];
                    if (($delta['type'] ?? '') === 'text_delta' && ($cur['type'] ?? '') === 'text') {
                        $text = $delta['text'] ?? '';
                        if ($text !== '') {
                            // The moment the silence ends. Taken HERE rather than at the
                            // first event off the API: the earlier ones are message_start
                            // and content_block_start, which carry no words, so timing to
                            // them would flatter the number by however long the model
                            // spends before its first actual token.
                            if ($this->logFirstTokenAt === 0.0) {
                                $this->logFirstTokenAt = microtime(true);
                            }
                            $cur['text'] .= $text;
                            yield $this->sse('text', ['text' => $text]);
                        }
                    } elseif (($delta['type'] ?? '') === 'input_json_delta' && ($cur['type'] ?? '') === 'tool_use') {
                        $cur['json'] .= $delta['partial_json'] ?? '';
                    }
                    break;

                case 'content_block_stop':
                    if (($cur['type'] ?? '') === 'tool_use') {
                        $input = json_decode($cur['json'] !== '' ? $cur['json'] : '{}', true);
                        $blocks[] = [
                            'type' => 'tool_use',
                            'id' => $cur['id'],
                            'name' => $cur['name'],
                            'input' => is_array($input) ? $input : [],
                        ];
                    } elseif (($cur['type'] ?? '') === 'text') {
                        $blocks[] = ['type' => 'text', 'text' => $cur['text']];
                    }
                    $cur = null;
                    break;

                case 'message_delta':
                    $stop = $data['delta']['stop_reason'] ?? $stop;
                    // The output count only lands here — message_start carries the
                    // input side, and the completion length isn't known until the end.
                    $this->logOutTokens += (int) ($data['usage']['output_tokens'] ?? 0);
                    break;

                case 'error':
                    return ['error' => 'generic', 'blocks' => $blocks];
            }
        }

        return ['blocks' => $blocks, 'stop' => $stop];
    }

    /**
     * The list of showable handles, injected into the system prompt so Claude
     * knows what it can reference inline. Empty string when there's nothing to
     * show (the answer then simply carries no markers).
     */
    private function inventoryPrompt(): string
    {
        $items = Jonson::getInstance()->findContext->inventory();
        if (!$items) {
            return '';
        }

        $lines = array_map(
            static fn(array $i) => "- [[{$i['handle']}]] — {$i['label']}",
            $items,
        );

        return 'Photos you can show — the places and themes your street photography covers, each with '
            . 'its handle. Whenever your reply names one of these while you speak about your own life, '
            . 'place its handle inline immediately after the word — the word first, then the handle with '
            . 'no space, like `word[[handle]]` — one for EACH distinct place or theme you name (see "What '
            . "you can show\"). Use only these handles, never invent one:\n"
            . implode("\n", $lines);
    }

    /**
     * Tells the model exactly which sectors Jon has experience in, so he answers
     * "have you worked in X?" honestly and never suggests a sector he lacks.
     */
    /**
     * Case studies context + the [[casestudies]] marker. Feeds each study's private
     * `jonsonSummary` (plus client, title, sectors, skills) so the model speaks
     * concretely about specific projects, and tells it when to surface the discovery
     * cards. Gated: '' when there are no studies.
     */
    private function caseStudiesPrompt(): string
    {
        $studies = Jonson::getInstance()->findContext->caseStudies();
        if (!$studies) {
            return '';
        }

        $lines = [];
        foreach ($studies as $s) {
            $meta = array_filter([
                $s['client'] !== '' ? 'for ' . $s['client'] : '',
                // Still running (the study's "Is present?" switch). Said here so the
                // model can tell a delivered project from a live relationship.
                !empty($s['ongoing']) ? '(ONGOING)' : '',
                $s['sectors'] ? '[' . implode(', ', $s['sectors']) . ']' : '',
                $s['skills'] ? '{' . implode(', ', $s['skills']) . '}' : '',
            ]);
            $note = $s['jonsonSummary'] !== '' ? $s['jonsonSummary'] : $s['summary'];
            // The same title the cards and the study's own page show. The model uses
            // these names in prose, so naming a project here by anything a visitor
            // won't see teaches it a name that exists nowhere on the site. The
            // description travels in the summary below, not in the title.
            // The study's own page, as a path. Taken from the entry's real URL rather
            // than assembled from the slug and a guessed pattern: the section decides
            // its URI format, and a path built by hand here would break silently the
            // day it changes. This is what the model copies when it links the study in
            // a sentence — and groundLinks() unlinks anything that is not a live page,
            // so a mistyped one costs a link rather than a 404.
            $path = !empty($s['url']) ? (parse_url($s['url'], PHP_URL_PATH) ?: '') : '';
            $lines[] = '- ' . $s['title'] . ($meta ? ' ' . implode(' ', $meta) : '')
                . (!empty($s['slug']) ? ' [study:' . $s['slug'] . ']' : '') // cite as @study:slug in a [[next:]] prompt
                . ($path !== '' ? ' (' . $path . ')' : '')
                . ($note !== '' ? ': ' . $note : '');
        }

        return "Your case studies — full write-ups of specific projects the visitor can open "
            . "(PRIVATE background: use it to speak concretely, never read it out verbatim). The path "
            . "in parentheses on each line is THAT STUDY'S OWN PAGE — it is what you link when you "
            . "point someone at the write-up (see LINKING TO A PAGE below):\n"
            . implode("\n", $lines) . "\n"
            . 'The `[[casestudies]]` marker shows the cards for whichever studies fit — see "What you can '
            . 'show" for when to place it. The cards are filtered to what\'s relevant automatically, so '
            . 'place it even when several studies could apply. A study\'s card appears ONCE per '
            . 'conversation: if a visitor asks to see a study whose card is already on screen, it is '
            . 'already in front of them — say so plainly ("that\'s the card just above") and answer with '
            . 'something about the work itself, never "the write-up is here" pointing at nothing. And '
            . 'never offer, in your [[next:]] prompts, to show a study whose card has already appeared.'
            . "\n\nLINKING TO A PAGE, in your prose. When you draw on a specific piece of work, a note "
            . "of yours, or one of your standing pages, you can point at it in the sentence rather than "
            . "describing where it lives: write it as [the words you would say anyway](/the-path), with "
            . "the path copied EXACTLY from the list above, the notes list, or this one:\n"
            . "- /about — who you are\n"
            . "- /case-studies — the work in general\n"
            . "- /contact — getting in touch\n"
            // TWO INDEXES ARE DELIBERATELY ABSENT, and both would otherwise look obvious.
            //
            // /notes — Jon does not want people sent to the top of a list of hundreds of
            // notes. A note he names is still linkable: its own url travels with it in the
            // notes block, and that page is the thing worth opening. The list is not.
            //
            // /methodology — it 404s (20 rows carry the uri, no page resolves), and even if
            // it did not, the `[[method]]` marker puts how-you-work on the page inside the
            // answer, so a link would send someone away to read what is about to appear
            // under the sentence they are reading.

            . "Only these and the paths listed with each item: a path you assemble from a slug, or "
            . "remember rather than copy, will not resolve and the link comes off before the visitor "
            . "sees it. Link the natural words in the sentence — the project's name, the thing you "
            . "wrote about it — never a bare URL, and never the words \"click here\".\n"
            . "NAME IT, LINK IT. If you name a specific project in a sentence, that name carries its "
            . "path. Naming two or three of them and linking none — or linking only the index while the "
            . "projects themselves sit there as plain words — is the exact failure these paths exist to "
            . "prevent: the visitor has just been told which work to look at and given no way to open "
            . "it. Same for a note of yours you mention by name.\n"
            . "PREFER THE SPECIFIC PAGE. Naming a particular project means linking that project's own "
            . "page, not the list of all of them; the index is for when you genuinely mean the work in "
            . "general. A NOTE is the same: each one in your notes list carries its own path in "
            . "parentheses, and that single piece is what you link when you mention it. Never send "
            . "anyone to the top of the notes list — it is hundreds of entries deep and answers "
            . "nothing; if a note is worth naming, name it and link it, and if none is, don't gesture "
            . "at the pile.\n"
            . "THERE IS NO RATION — link each project you actually name. What to avoid is the other "
            . "thing: linking words that are not the thing itself (\"here\", \"this page\", \"have a "
            . "look\"), linking the same page twice in one reply, and linking a study whose "
            . "[[casestudies]] card is already on screen, because the card IS the way in to it.\n\n"
            . "AN OFFER TO BE CONTACTED IS THE CONTACT BEAT. \"Drop me a line\", \"get in touch\", "
            . "\"I'm easy to reach\", \"give me a shout\" — these all MEAN the same thing, and saying "
            . "one of them is not a warm sign-off, it is you offering the way in. So when you write it: "
            . "put [[contact]] in that paragraph, and give them the actual route in the same breath — "
            . "the ways listed for this visitor if they have any, otherwise the words themselves "
            . "carrying /contact. Never gesture at getting in touch and leave them to work out how; "
            . "that is an invitation with nowhere to go, and it reads as a brush-off rather than an "
            . "opening.";
    }

    private function sectorsPrompt(): string
    {
        $sectors = Jonson::getInstance()->findContext->sectors();
        if (!$sectors) {
            return '';
        }

        return 'The sectors/industries you have hands-on experience in are: '
            . implode(', ', $sectors) . '. That\'s not an exhaustive list — it\'s a representative '
            . 'sample of where you\'ve worked, not the full extent of it — so don\'t present it as '
            . 'the complete set or imply you\'ve only ever touched those. Equally, don\'t claim '
            . 'you\'ve actually worked *in* a specific sector that isn\'t on it. You\'re not precious '
            . 'about sector labels — don\'t over-index on them. Your experience genuinely transfers '
            . 'between industries, so when a visitor is in a sector you haven\'t worked in, don\'t '
            . 'treat it as a gap or hesitate: briefly acknowledge it isn\'t one you\'ve done directly, '
            . 'then show — concretely, and in words you choose fresh each time — why the way you work '
            . 'carries over to their situation. Don\'t lean on a set phrase for this point; make it '
            . 'differently every time, in your own voice, never a canned line. And don\'t steer the '
            . 'conversation into asking which sector they\'re in — you don\'t need them to name one. '
            . '(For your knowledge — don\'t recite the list in your prose; the [[sectors]] marker '
            . 'shows it.)';
    }

    /**
     * Tells the model Jon's real "how I can help" journey — the ordered project
     * phases and the services under each — so he describes his process/offering
     * accurately and knows what the [[method]] timeline will show.
     */
    private function methodologyPrompt(): string
    {
        $method = Jonson::getInstance()->findContext->methodology();
        if (!$method) {
            return '';
        }

        $lines = [];
        foreach ($method as $step) {
            $line = '- ' . $step['title'];
            if (!empty($step['services'])) {
                $line .= ' (' . implode(', ', $step['services']) . ')';
            }
            $lines[] = $line;
        }

        return "The way you take on a project runs in this order — it's how you help:\n"
            . implode("\n", $lines) . "\n"
            . 'Speak to these as your genuine process when someone asks what your process or approach '
            . 'to a project is, how you work, or what services you offer. The `[[method]]` marker shows '
            . 'the journey as a visual timeline alongside — see "What you can show" for when to place it — '
            . 'so keep the prose itself short and don\'t enumerate every phase or service in words.';
    }

    /**
     * Jon's real career history as private background for the persona. It's fed
     * in so he can speak accurately to his experience — the depth of it, the
     * kinds of places and problems he's worked on — when a visitor is weighing
     * him up. Deliberately NOT a component: it must never be recited like a CV.
     */
    private function cvPrompt(): string
    {
        $cv = Jonson::getInstance()->findContext->curriculumVitae();
        if (!$cv) {
            return '';
        }

        // Group the flat role list back under each company (keeping newest-first
        // order), so the company `summary` (what the place is) frames the role
        // summaries (what you actually did there) — both fields carry weight.
        $companies = [];
        foreach ($cv as $role) {
            $company = $role['company'];
            if (!isset($companies[$company])) {
                $companies[$company] = ['summary' => $role['companySummary'], 'roles' => []];
            }
            if (!empty($role['title']) || !empty($role['summary'])) {
                $companies[$company]['roles'][] = $role;
            }
        }

        $lines = [];
        foreach ($companies as $company => $data) {
            $head = '- ' . $company;
            if (!empty($data['summary'])) {
                $head .= ' — ' . $data['summary']; // what the company is
            }
            $lines[] = $head;

            foreach ($data['roles'] as $role) {
                $when = '';
                if (!empty($role['start'])) {
                    $when = $role['start'] . '–' . ($role['end'] ?: 'present');
                } elseif (!empty($role['end'])) {
                    $when = 'to ' . $role['end'];
                }

                $line = '    · ' . ($role['title'] ?: 'Role');
                if ($when !== '') {
                    $line .= ' (' . $when . ')';
                }
                if (!empty($role['types'])) {
                    $line .= ' [' . implode(', ', $role['types']) . ']';
                }
                if (!empty($role['summary'])) {
                    $line .= ': ' . $role['summary']; // what you did in the role
                }
                $lines[] = $line;
            }
        }

        // NOTE: the default clamp below is deliberately written as the answer for
        // EVERYONE, so this block stays byte-identical for every visitor and holds its
        // place in the cached prefix. The one visitor who needs more — a VIP door made
        // in the hope of a job — is handled by cvDepthOverride(), which arrives later
        // and uncached. Branching in here instead would split the cache in two.
        $depth = 'Synthesise — talk to the shape and depth of it, the kinds of businesses and '
            . 'problems you\'ve worked on, and how that bears on their situation. NEVER recite it '
            . 'like a CV, never list your jobs, and don\'t rattle off dates or titles mechanically. '
            . 'Reach for a specific role only when it genuinely answers what they asked. ';

        return "Your real career history, newest first (PRIVATE background — knowledge, not something "
            . "to read out). Each company has a note on what it is, then the role(s) you held there and "
            . "what you did:\n" . implode("\n", $lines) . "\n"
            . 'Use it to speak accurately and confidently about your experience when a visitor is '
            . 'getting a feel for whether you\'re the right fit — asking what you\'ve done, or the kind '
            . 'of work and problems you\'ve handled. '
            . $depth
            . 'Never invent roles, '
            . 'dates, or employers beyond what\'s listed here. A role ending in "present" has NOT '
            . 'ended — it is work you are still doing, so speak about it in the present. Long '
            . 'relationships are the pattern here rather than the exception, and that is a good thing '
            . 'to let a visitor see: say that people stay, not that someone once kept you on. Never '
            . 'phrase a relationship that is still running as though it finished, and don\'t put a '
            . 'number of years on one unless they asked — how long it has lasted matters less than '
            . 'the fact it is still going.';
    }

    /**
     * The purpose of the VIP door this visitor came through — a PURPOSES key, or ''
     * for anyone who isn't a VIP (and for a door with no purpose set).
     *
     * Vip::current() memoises the cookie lookup, so asking repeatedly costs nothing.
     */
    private function vipPurpose(): string
    {
        $vip = Jonson::getInstance()->vip;
        $entry = $vip->current();

        return $entry ? $vip->purpose($entry) : '';
    }

    /** Did this visitor come through a VIP door? */
    private function isVip(): bool
    {
        return Jonson::getInstance()->vip->current() !== null;
    }

    /**
     * How much of the career history this visitor gets — an OVERRIDE on the default
     * clamp in cvPrompt(), and empty for everyone it doesn't apply to.
     *
     * For an ordinary visitor the default is right: a portfolio conversation isn't an
     * interview, and a CV read aloud is the failure mode that block exists to prevent.
     * But a VIP door made in the hope of working FOR someone is the one case where the
     * clamp is simply wrong — the career IS what they came to weigh, and Vip::PURPOSES
     * already tells the persona "your career history is the thing to draw on". Two
     * instructions pulling opposite ways is what produced a hedged, shape-only answer;
     * this resolves it in favour of the purpose.
     *
     * Lives out here, in the uncached tail, rather than inside cvPrompt(): the CV is a
     * big stable block that every visitor should share a cache entry for, and branching
     * inside it would split that entry in two. Arriving later also means recency is on
     * its side when the model reconciles the two.
     */
    private function cvDepthOverride(): string
    {
        if ($this->vipPurpose() !== 'lookingForAJob' || $this->cvPrompt() === '') {
            return '';
        }

        return 'CAREER HISTORY — DEPTH (this overrides the "synthesise, never recite" instruction '
            . 'in your career-history background for THIS visitor only): they came through a private '
            . 'door you made in the hope of working for them, so your history is the thing they are '
            . 'here to weigh. Go into REAL detail when they ask about it — name the company, the role, '
            . 'roughly when, and what you actually did there: the problems, the scale, what you were '
            . 'responsible for. Depth is welcome here; a thin answer reads as having little to show. '
            . 'Still don\'t open a conversation by reciting the list end to end, and don\'t answer a '
            . 'question about something else with your CV — but when they ask about your background, a '
            . 'period, a company, or whether you\'ve done a thing before, give them the specifics '
            . 'rather than the shape. Never invent anything beyond what the background lists.';
    }

    /**
     * Jon's notes as memories. One card per live note (services\NoteMemory):
     * where he was, what he did and saw, what he made of it. The persona draws
     * on them the way a person draws on their own past — a related subject
     * brings one to mind — and may point at the note when that's natural, but
     * the point is the recollection, not the link.
     */
    private function notesPrompt(): string
    {
        $cards = Jonson::getInstance()->noteMemory->cards();
        if (!$cards) {
            return '';
        }

        $lines = [];
        foreach ($cards as $card) {
            $head = '- ' . $card['title'];
            if (!empty($card['posted'])) {
                $head .= ' (' . $card['posted'] . ')';
            }
            // THE PATH, not the absolute url it arrives as. This line is what the model
            // copies when it links a note in a sentence, and inlineMarkdown() only lets a
            // same-site link through as a path — an "https://…" copied verbatim is refused
            // by the allowlist and lands on the screen as raw brackets. groundLinks() would
            // not save it either: it only inspects same-site paths.
            if (!empty($card['url'])) {
                $head .= ' (' . (parse_url($card['url'], PHP_URL_PATH) ?: $card['url']) . ')';
            }
            if (!empty($card['slug'])) {
                $head .= ' [note:' . $card['slug'] . ']'; // cite as @note:slug in a [[next:]] prompt
            }
            $lines[] = $head;
            $lines[] = '    ' . $card['memory'];
        }

        return "Things you have actually done, seen and written about — your own memories, newest "
            . "first (PRIVATE background — knowledge, not something to read out). Each is a note "
            . "you published, with its address, then what you remember of it:\n"
            . implode("\n", $lines) . "\n"
            . 'Let these surface the way memories do: when a subject touches one of them — a place, '
            . 'a craft, a technique, a thing you noticed — draw on it in your own words, as a person '
            . 'recalling an experience, and only where it genuinely bears on what they asked. Never '
            . 'recite a card, never list your notes, and never invent detail beyond what\'s here. '
            . 'Mention the note itself by name or address only when the visitor would plainly want '
            . 'to read it; the memory is the point, not the link.';
    }

    /**
     * Jon's music taste (Spotify top artists + genres) as personality/tone
     * background. It colours how he comes across and lets him speak to what he's
     * into when a visitor is getting to know him — the same "who is this person"
     * territory as the photography. Never a recited playlist.
     */
    private function musicPrompt(): string
    {
        $taste = Jonson::getInstance()->spotify->taste('long_term'); // defining taste
        if (!$taste || empty($taste['artists'])) {
            return '';
        }

        $names = array_column($taste['artists'], 'name');
        $lines = ['- Long-time top artists: ' . implode(', ', array_slice($names, 0, 15))];
        if (!empty($taste['genres'])) {
            $lines[] = '- Leans towards: ' . implode(', ', $taste['genres']);
        }

        return "What you actually listen to (PRIVATE background — for your personality and voice, not "
            . "something to read out):\n" . implode("\n", $lines) . "\n"
            . 'Let it colour how you come across, and speak to your taste naturally when someone asks '
            . 'what you\'re into, about your personality, or is otherwise getting to know you (the same '
            . 'ground as your street photography). Talk about the feel of it — the moods and artists you '
            . 'gravitate to — not a ranked playlist. Don\'t force it into unrelated answers, don\'t list '
            . 'everything, and never invent artists or tastes beyond what\'s here. When they ask about your '
            . 'music or what you listen to, end the sentence about your taste with `[[music]]` so the strip '
            . 'of artists appears (see "What you can show").';
    }

    /**
     * The client roster + what Jon did for each, as private background — so he
     * can speak concretely about relevant work (a fitting piece for a sector or
     * project type). Separate from the [[clients]] logo strip: this is knowledge,
     * never read out like a portfolio.
     */
    private function clientsPrompt(): string
    {
        $clients = Jonson::getInstance()->findContext->clientWork();
        if (!$clients) {
            return '';
        }

        $lines = [];
        foreach ($clients as $client) {
            $line = '- ' . $client['name'];
            if (!empty($client['summary'])) {
                $line .= ': ' . $client['summary'];
            }
            $lines[] = $line;
        }

        return "A selection of past projects you've delivered — each line is the client/brand it was "
            . "for and what you did on it (PRIVATE background — knowledge, not something to read out):\n"
            . implode("\n", $lines) . "\n"
            . 'Some of this work is finished and some of it is still running — your career history and '
            . 'the case studies say which (a role with no end date, or a study marked ONGOING). Let that '
            . 'decide the tense, and when you don\'t know, speak about the WORK rather than the state of '
            . 'the relationship. Never announce that a relationship ended, and never put a long one in '
            . 'the past as though it were over — several of these have run for years and some still do, '
            . 'which is the point worth making: you are someone people keep working with, not someone '
            . 'who was once kept on. Equally, don\'t claim anyone as a current client unless the '
            . 'background actually says so. Draw on this to speak concretely when a visitor asks about '
            . 'your experience, a sector, or a kind of project — name a fitting project when it '
            . 'genuinely answers what they asked. Synthesise; never recite the whole '
            . 'list or read it out like a portfolio, and never invent projects or clients beyond what\'s '
            . 'here. (The [[clients]] logo strip is a separate, deliberate beat — this is just so you '
            . 'can speak to the work knowledgeably.)';
    }

    /**
     * Every surface in one place — the single source of truth. The resolver loop
     * in actionStream(), the cache replay, the once-per-conversation reset and
     * the chips' "already shown" list all derive from this: adding a surface is
     * one entry here and one paragraph under "What you can show" in the
     * directive. No PHP anywhere else.
     *
     * Every surface is marker-driven. Each descriptor:
     *   - handle:    the marker, the SSE event name, and the once-slot key.
     *   - marks:     'photo' for the rail, which answers to every inventory photo
     *                handle rather than its own; absent for the others.
     *   - once:      true to show at most once per conversation.
     *   - excludes:  handles that, already emitted this turn, suppress this one.
     *                Order matters: a surface can only exclude on what precedes it.
     *   - template/var: the component and its variable.
     *   - data:      fn(string $text, ?string $modifier, string $question, array $hits, $session)
     *                => payload; an empty payload skips the surface. $text is the
     *                question + clean answer; $hits the photo handles (rail only).
     *   - present:   optional fn(payload, $modifier) => the modifier the template
     *                gets, when presentation depends on what came back.
     *   - onShown:   optional fn(payload, $session), for cross-turn memory.
     */
    private function surfaceRegistry(): array
    {
        $ctx = Jonson::getInstance()->findContext;
        $spotify = Jonson::getInstance()->spotify;

        return [
            [
                'handle' => 'testimonial',
                'once' => true,
                'template' => '_components/testimonials',
                'var' => 'items',
                // Which quote: this turn's text first, then the last few turns — a
                // follow-up about a client named two questions ago is still about
                // them (the DECISION note in FindContext::testimonials says why this
                // and not a model-named key).
                'data' => fn(string $text, ?string $modifier, string $question, array $hits, $session) => $ctx->testimonials($text, $this->recentTurnsText($session, self::SUBJECT_WINDOW_TURNS)),
            ],
            [
                'handle' => 'clients',
                'once' => true,
                'template' => '_components/clients',
                'var' => 'clients',
                'data' => static fn() => $ctx->clients(),
            ],
            [
                'handle' => 'sectors',
                'once' => true,
                'template' => '_components/sectors',
                'var' => 'sectors',
                'data' => static fn() => $ctx->sectors(),
            ],
            [
                'handle' => 'casestudies',
                // NOT once-gated as a whole — each STUDY shows once, exactly as each
                // photo does on the rail above. The panel was spent by the first turn
                // that earned any cards at all: "why should I hire you" took it for a
                // curated taste, and the next turn, which named White Paper and
                // StreetPal outright, was dropped before selection even ran.
                'once' => false,
                'template' => '_components/case-studies',
                'var' => 'caseStudies',
                // Selection is FindContext's: what the question names wins, else the
                // answer's context. `:all` hands over the catalogue — unless the
                // visitor's own words named a study, when the whole strip is the
                // wrong answer to a targeted ask.
                // THE ANSWER, NOT THE EXCHANGE. Every other surface reads the question
                // and the answer together, which is right for them — they are asking
                // "what is this turn about?". The rail is answering a narrower question:
                // "which work did Jonson just describe?", and the visitor's phrasing is
                // actively misleading for it. "What have you worked on since Vaiie?" put
                // three Vaiie studies in the pool at client tier, which tipped the count
                // past the sweep threshold and discarded StreetPal — leaving one card
                // under a paragraph about two projects.
                //
                // $question is still passed separately, and still decides the pick when
                // the answer named nothing at all.
                'data' => function (string $text, ?string $modifier, string $question, array $hits, $session, string $answer) use ($ctx): array {
                    $picked = $ctx->caseStudies(
                        $answer,
                        $modifier === 'all' && !$ctx->studiesNamedIn($question),
                        $question,
                    );

                    // THE BUDGET DECIDES WHETHER TO SHOW THE PANEL, NEVER WHAT IS IN IT.
                    //
                    // Filtering already-seen studies out of the selection itself put the
                    // rail back in the business of contradicting the prose: a turn whose
                    // answer led with White Paper showed a lone StreetPal card, because
                    // White Paper's card had appeared earlier for a different reason.
                    //
                    // So the whole selection stands, and history only answers a narrower
                    // question — "is there anything here the visitor has not already
                    // seen?" If not, the panel is skipped and the turn says nothing it
                    // has already said. If so, it shows in full, White Paper included.
                    $shown = $this->shownStudies($session);
                    if (!$shown) {
                        return $picked;
                    }
                    foreach ($picked as $study) {
                        foreach ([$study['client'] ?? '', $study['title'] ?? ''] as $name) {
                            $name = mb_strtolower(trim((string) $name));
                            if ($name !== '' && !in_array($name, $shown, true)) {
                                return $picked;
                            }
                        }
                    }

                    return [];
                },
                // More than a couple of studies is a strip, not a stack of cards.
                'present' => static fn(array $studies, ?string $modifier) => count($studies) > 2 ? 'all' : $modifier,
                // Which studies are on screen, so a later chip can't offer one again.
                'onShown' => fn(array $studies, $session) => $this->rememberShownStudies($session, $studies),
            ],
            [
                'handle' => 'method',
                'once' => true,
                // An answer about who or where you've worked isn't a process answer.
                'excludes' => ['clients', 'sectors'],
                'template' => '_components/method',
                'var' => 'method',
                'data' => static fn() => $ctx->methodology(),
            ],
            [
                'handle' => 'contact',
                'once' => true,
                'template' => '_components/jonson-ctas',
                'var' => 'contact',
                'data' => static fn() => \craft\elements\Entry::find()->section('contact')->one(),
            ],
            [
                'handle' => 'music',
                'once' => true,
                'template' => '_components/music',
                'var' => 'artists',
                // Recent top artists (~last 4 weeks) with artwork — "what I'm into
                // right now", distinct from the long-term taste that shapes the
                // persona. Capped at the latest MUSIC_STRIP_MAX.
                'data' => static fn() => self::musicStrip($spotify),
            ],
            [
                // The photo rail. Personal street photography only — never work
                // content, and never beside a work surface. Not once-gated as a
                // whole: each PHOTO shows once, so a second place question surfaces
                // new photos or nothing.
                'handle' => 'context',
                'marks' => 'photo',
                'once' => false,
                'excludes' => ['clients', 'sectors', 'method', 'casestudies'],
                'template' => '_components/rail',
                'var' => 'items',
                'data' => fn(string $text, ?string $modifier, string $question, array $hits, $session) => $ctx->forHandles($hits, $this->shownRailKeys($session)),
                'onShown' => fn(array $items, $session) => $this->addShownRailKeys($session, $ctx->itemKeys($items)),
            ],
        ];
    }

    /**
     * The "on heavy rotation" strip: recent top artists, topped up to a full row.
     *
     * Spotify's short_term window is the last ~4 weeks, and it only reflects what was
     * actually played — a quiet month returns a handful rather than a short list of
     * favourites. Jon's returned 5 against a cap of 6, which reads as a broken strip
     * rather than a quiet month.
     *
     * So: recent artists first, in Spotify's own order, then padded from the ~6-month
     * window to reach the cap. The padding only ever appends, so the strip still leads
     * with what's genuinely current and the fallback is invisible when the recent
     * window is full on its own.
     *
     * Artists without artwork are dropped from both — the strip is the artwork.
     *
     * @return array<int, array{name: string, image: string}>
     */
    private static function musicStrip(Spotify $spotify): array
    {
        $withArt = static fn(array $taste): array => array_values(array_filter(
            $taste['artists'] ?? [],
            static fn($a) => !empty($a['image']),
        ));

        $strip = $withArt($spotify->taste('short_term'));

        if (count($strip) < self::MUSIC_STRIP_MAX) {
            // Match on name: the same artist in both windows must not appear twice.
            $seen = array_column($strip, 'name');
            foreach ($withArt($spotify->taste('medium_term')) as $artist) {
                if (count($strip) >= self::MUSIC_STRIP_MAX) {
                    break;
                }
                if (!in_array($artist['name'], $seen, true)) {
                    $strip[] = $artist;
                    $seen[] = $artist['name'];
                }
            }
        }

        return array_slice($strip, 0, self::MUSIC_STRIP_MAX);
    }

    /**
     * Reads one exchange for the two signals that shape the suggestion slate:
     *   - stage: where the visitor is in the funnel — 'cold' (orienting), 'warm'
     *            (evaluating Jon as a hire), or 'hot' (a concrete need / buying
     *            signal). Picks which roles fill the slate (see slotPlan).
     *   - signedOff: the visitor has ended the conversation (thanks/that's all/
     *            bye/not right now). This is the ONLY thing that suppresses the
     *            slate, so "show nothing" is a deterministic decision made here —
     *            never a side effect of a model marker.
     * One cheap structured call (fast model, forced tool), judged mainly on the
     * visitor's question. Runs only on a genuine answer turn; the instant-replay
     * and repeat-nudge paths keep the deterministic funnelStage() and stay
     * call-free. On any failure it returns { stage: $default, signedOff: false } —
     * the safe floor: keep the deterministic stage, and keep offering chips.
     */
    private function classifyExchange(Client $client, string $apiKey, string $question, string $answer, string $default): array
    {
        $fallback = ['stage' => $default, 'signedOff' => false];

        $model = App::env('KEY_ANTHROPIC_MODEL_FAST') ?: 'claude-haiku-4-5';
        $system = 'You read one exchange on a freelance product designer\'s portfolio and report two '
            . 'things about the VISITOR (judge mainly by their question; the answer is context only).'
            . "\n\nstage — where they are in the sales funnel, exactly one of:"
            . "\n- cold: just orienting or getting to know Jon — who he is, what he does, personal or background curiosity."
            . "\n- warm: weighing Jon up as a potential hire — his process, experience, clients, sectors, or whether he fits something they're considering."
            . "\n- hot: a concrete need or buying signal — describing a project or problem of their own, a change in their business, or asking about availability, cost, timelines, or how to start / get in touch."
            . "\nWhen genuinely torn between two, pick the cooler one."
            . "\n\nsigned_off — true ONLY if the visitor is clearly ending the conversation (e.g. \"thanks, that's all\", \"bye\", \"not right now\", \"I'll be in touch\"). A normal question, however brief, is not signing off. When unsure, false.";
        $user = "Visitor's question:\n{$question}\n\nAnswer given (context only):\n{$answer}";

        $tool = [
            'name' => 'read_exchange',
            'description' => 'Report the visitor\'s funnel stage and whether they have signed off.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'stage' => [
                        'type' => 'string',
                        'enum' => ['cold', 'warm', 'hot'],
                        'description' => 'The visitor\'s current funnel stage.',
                    ],
                    'signed_off' => [
                        'type' => 'boolean',
                        'description' => 'True only if the visitor is clearly ending the conversation.',
                    ],
                ],
                'required' => ['stage', 'signed_off'],
            ],
        ];

        try {
            $res = $client->post('https://api.anthropic.com/v1/messages', [
                'headers' => [
                    'x-api-key' => $apiKey,
                    'anthropic-version' => '2023-06-01',
                    'content-type' => 'application/json',
                ],
                'json' => [
                    'model' => $model,
                    'max_tokens' => 64,
                    'system' => $system,
                    'messages' => [['role' => 'user', 'content' => $user]],
                    'tools' => [$tool],
                    'tool_choice' => ['type' => 'tool', 'name' => 'read_exchange'],
                ],
            ]);

            if ($res->getStatusCode() === 200) {
                $data = json_decode((string) $res->getBody(), true);
                foreach ($data['content'] ?? [] as $block) {
                    if (($block['type'] ?? '') === 'tool_use' && ($block['name'] ?? '') === 'read_exchange') {
                        $input = is_array($block['input'] ?? null) ? $block['input'] : [];
                        $stage = $input['stage'] ?? '';

                        return [
                            'stage' => in_array($stage, ['cold', 'warm', 'hot'], true) ? $stage : $default,
                            'signedOff' => ($input['signed_off'] ?? false) === true,
                        ];
                    }
                }
            }
        } catch (\Throwable $e) {
            Craft::error('[jonson] classifyExchange: ' . $e->getMessage(), __METHOD__);
        }

        return $fallback;
    }

    /**
     * The "where next?" prompt chips for an answer. Model-only: the sole source is the
     * model's own `[[next: …]]` — contextual prompts that follow the actual exchange
     * (the funnel lean toward work is applied upstream, via funnelNudgePrompt in the
     * system prompt, not by injecting canned candidate strings here).
     *
     * Pipeline: parse the pipe-separated prompts (tolerant of a full-width "｜"); sort
     * tightest-to-the-answer first; drop any that re-ask a panel already on screen
     * (matched on the panel's DISTINCTIVE terms — see panelEchoTerms — so "which sectors
     * have you worked in?" dies after the sector tags showed, but a generic shared word
     * like "work" never over-drops); drop anything already asked; sentence-case /
     * punctuate (normalizeChip); cap at MAX_SUGGESTIONS. No candidates, no padding — a
     * short slate, or none, is fine; the client hides the block when empty.
     *
     * Showing no chips is legitimate: a genuine sign-off ($signedOff, from the exchange
     * classifier), a bare `[[next: none]]`, or every prompt filtered as an echo/already-
     * asked. Never padded back up with filler.
     *
     * $shownHandles are handles already surfaced this conversation — their echo terms
     * bin any chip that re-asks them. $stage overrides the derived stage; $signedOff
     * (default false) is the deterministic suppression signal.
     */
    private function suggestionsFor(string $answer, $session, string $current, array $shownHandles = [], ?string $stage = null, bool $signedOff = false, bool $pivotedToDiscovery = false, bool $remember = true): array
    {
        // A genuine sign-off shows no chips — a deterministic signal from the exchange
        // classifier. (An empty slate below can also legitimately show nothing: we
        // never pad with filler; the client hides the block when there are no chips.)
        if ($signedOff) {
            return [];
        }

        // The model's own contextual prompts are the ONLY source — every chip follows
        // the actual exchange, never a canned menu. A bare `[[next: none]]` is a genuine
        // dead-end (a sign-off / handed-off moment): the slate is simply empty.
        // Parse the model's [[next: …]] block. Three outcomes matter:
        //   - prompts present → use them.
        //   - "[[next: none]]" → a DELIBERATE dead-end; show nothing (no fallback).
        //   - marker missing   → the model forgot it (common on answers busy with panel
        //     markers like [[sectors]]/[[casestudies]]); NOT deliberate, so we fall back
        //     below rather than dead-ending an engaged visitor.
        $modelGiven = [];
        $deliberateNone = false;
        if (preg_match('/\[\[next:\s*(.+?)\]\]/is', $answer, $m)) {
            // Split on the pipe separator, tolerant of the model occasionally using a
            // full-width "｜" (or other vertical-bar variants) instead of ASCII "|" —
            // otherwise all three prompts fuse into a single chip.
            foreach (preg_split('/\s*[|｜‖¦│]\s*/u', $m[1]) ?: [] as $s) {
                $s = trim($s);
                if ($s === '') {
                    continue;
                }
                if (strcasecmp($s, 'none') === 0) {
                    $deliberateNone = true;
                    continue;
                }
                $modelGiven[] = $s;
            }
        }

        // Grounding: every prompt must cite the thing it's about (`… @note:slug`,
        // `… @study:slug`, `… @photo:handle`, `… @sector:name`, `… @client:name`, or
        // a standing topic like `@contact`), and the citation must resolve to
        // something this site actually has. A prompt with no citation, or one that
        // names a thing that doesn't exist, is dropped — so a chip can never lead
        // the visitor to a topic Jon has nothing on. The citation is stripped from
        // the chip text but kept as the prompt's SOURCE, which the budget below
        // spends. From here each entry is ['text' => …, 'source' => …].
        $modelGiven = $this->groundedPrompts($modelGiven);

        // Order: a contact / "how do we start working together?" prompt leads the
        // slate — this is a lead-gen site, so the path to a real conversation goes
        // first. Otherwise, closest-following prompt first, so if we cap (or fall
        // back to one) we keep the tightest thread to what was just said.
        if (count($modelGiven) > 1) {
            usort($modelGiven, function (array $a, array $b) use ($answer): int {
                $ac = $this->isContactPrompt($a['text']) ? 1 : 0;
                $bc = $this->isContactPrompt($b['text']) ? 1 : 0;
                return $ac !== $bc
                    ? $bc <=> $ac
                    : $this->promptRelevance($b['text'], $answer) <=> $this->promptRelevance($a['text'], $answer);
            });
        }

        // Drop any prompt that re-asks a panel already on screen this conversation.
        // Match on the panel's DISTINCTIVE terms — the words that MEAN it ("sectors"
        // for the sector tags, "process"/"approach" for the method timeline) — so a
        // single hit is a re-ask ("which sectors have you worked in?" after the tags
        // showed) and gets dropped, while a merely-shared generic word ("work",
        // "experience") never drops a genuine new direction. If this empties the slate,
        // showing nothing beats echoing content already on screen.
        if ($shownHandles) {
            $echoTerms = [];
            foreach ($shownHandles as $h) {
                $echoTerms = array_merge($echoTerms, $this->panelEchoTerms($h));
            }
            if ($echoTerms) {
                $modelGiven = array_values(array_filter(
                    $modelGiven,
                    fn(array $p): bool => !$this->containsAnyTerm($p['text'], $echoTerms),
                ));
            }
            // Process paraphrases the term list can miss ("how would you approach…").
            if (in_array('method', $shownHandles, true)) {
                $modelGiven = array_values(array_filter(
                    $modelGiven,
                    fn(array $p): bool => !$this->isProcessRestate($p['text']),
                ));
            }
        }
        // A chip offering to show a study whose card is already on screen — the
        // panel terms above don't catch "can I see the Urban work itself?".
        $shownStudies = $this->shownStudies($session);
        if ($shownStudies) {
            $modelGiven = array_values(array_filter(
                $modelGiven,
                fn(array $p): bool => !$this->isShownStudyReask($p['text'], $shownStudies),
            ));
        }

        // Take up to MAX. A short slate is fine. Two budgets keep it moving, because
        // a chip repeats in two ways:
        //   - the SAME WORDS again. askedKeys() only knows what the visitor actually
        //     typed or tapped, so a chip they ignored came back next turn — and once
        //     the fallback engaged it re-served its canned candidates every turn after.
        //   - the SAME SOURCE asked another way. "How do you approach a project like
        //     this?" then "What's your process?" share not one word, and both are
        //     @method. One prompt per source per conversation is what stops that.
        // `contact` is the one source exempt from the second budget: the path to a
        // real conversation may come round again (worded differently — the first
        // budget still applies), because that door is what the site is for.
        //
        // The words are a WALL; the source is only a PREFERENCE. Hence two passes:
        // unused sources first, spent ones only to fill a slate that would otherwise
        // be short. Held as a hard rule the source budget ran the slate dry by turn
        // six — measured — and a second question about the work beats no question.
        $exclude = $this->askedKeys($session) + $this->offeredKeys($session);
        $exclude[$this->cacheKey($current)] = true;
        $usedSources = $this->offeredSources($session);
        $out = [];
        foreach ([true, false] as $freshSourcesOnly) {
            foreach ($modelGiven as $p) {
                if (count($out) >= self::MAX_SUGGESTIONS) {
                    break 2;
                }
                $chip = $this->normalizeChip($p['text']);
                $key = $this->cacheKey($chip);
                $source = (string) ($p['source'] ?? '');
                if ($key === '' || isset($exclude[$key])) {
                    continue;
                }
                if ($freshSourcesOnly && $source !== '' && $source !== 'contact' && isset($usedSources[$source])) {
                    continue;
                }
                $exclude[$key] = true;
                $usedSources[$source] = true;
                $out[] = ['text' => $chip, 'source' => $source];
            }
        }

        // Never dead-end an engaged visitor: if we've got nothing and it wasn't a
        // deliberate [[next: none]] — the model dropped the marker, or every prompt it
        // gave was filtered as an echo — fall back to content-grounded candidates
        // (the get-started lead path + available content they haven't seen).
        if (!$out && !$deliberateNone) {
            $out = $this->candidateFallback($answer, $session, $stage ?? 'warm', $shownHandles);
        }

        // Bank the slate before it goes out, so next turn's budgets can see it —
        // unless this turn wasn't one. The junk nudge still READS the budget (no point
        // re-offering what they've seen) but must not SPEND it: two fat-fingered
        // keystrokes were emptying the candidate list, and the real question that
        // followed came back with one chip instead of three.
        if ($remember) {
            $this->rememberOfferedChips($session, $out);
        }

        return array_column($out, 'text');
    }

    /**
     * Fallback slate from content-grounded candidates (FindContext::suggestionCandidates),
     * used ONLY when the model gave nothing usable and it wasn't a deliberate
     * [[next: none]]. The get-started lead path leads (when it's in-stage), then
     * available content the visitor hasn't seen, most relevant to the answer first.
     * Skips content already on screen, questions already asked and chips already
     * offered. Returns the same ['text' => …, 'source' => …] shape as the model path.
     */
    private function candidateFallback(string $answer, $session, string $stage, array $shownHandles): array
    {
        $cands = Jonson::getInstance()->findContext->suggestionCandidates($answer, $shownHandles);
        usort($cands, function (array $a, array $b) use ($answer): int {
            $ac = $a['handle'] === 'contact' ? 1 : 0;
            $bc = $b['handle'] === 'contact' ? 1 : 0;
            return $ac !== $bc
                ? $bc <=> $ac
                : $this->promptRelevance($b['prompt'], $answer) <=> $this->promptRelevance($a['prompt'], $answer);
        });

        // suggestionCandidates() already drops unavailable content and the shown
        // handles (passed above), so here we only gate by funnel stage and skip
        // anything already asked.
        // Same two budgets as the model's own slate (see suggestionsFor): the
        // candidate list is short and fixed, so without them this path re-serves the
        // identical three chips for the rest of the conversation.
        $exclude = $this->askedKeys($session) + $this->offeredKeys($session);
        $usedSources = $this->offeredSources($session);
        $out = [];
        foreach ([true, false] as $freshSourcesOnly) {
            foreach ($cands as $c) {
                if (count($out) >= self::MAX_SUGGESTIONS) {
                    break 2;
                }
                if (!in_array($stage, $c['stages'], true)) {
                    continue; // not for this funnel stage
                }
                $chip = $this->normalizeChip($c['prompt']);
                $key = $this->cacheKey($chip);
                $source = (string) ($c['handle'] ?? '');
                if ($key === '' || isset($exclude[$key])) {
                    continue; // already asked / already offered / duplicate
                }
                if ($freshSourcesOnly && $source !== '' && $source !== 'contact' && isset($usedSources[$source])) {
                    continue; // save it for the second pass
                }
                $exclude[$key] = true;
                $usedSources[$source] = true;
                $out[] = ['text' => $chip, 'source' => $source];
            }
        }
        return $out;
    }

    /**
     * The visitor's current funnel stage. A deterministic bridge until the intent
     * classifier feeds a real stage: an opener (no prior turns) is a 'cold' visitor
     * orienting; once they've engaged it's 'warm' (evaluating / lead-shaped). 'hot'
     * — a stated buying need — is reserved for the classifier to set.
     */
    private function funnelStage($session): string
    {
        $history = Craft::$app->getCache()->get($this->historyKey($session));
        $priorTurns = 0;
        if (is_array($history)) {
            foreach ($history as $m) {
                if (($m['role'] ?? '') === 'user') {
                    $priorTurns++;
                }
            }
        }

        // Engagement floor. An opener is a cold visitor orienting; a turn in they're
        // warm (evaluating); a few turns deep they're genuinely engaged, so floor to
        // hot and let the slate lead with work rather than circling the current
        // topic. The classifier can only push this WARMER (see warmerStage), never
        // colder — so casual chat still steers toward work once someone's invested.
        return match (true) {
            $priorTurns >= 2 => 'hot',
            $priorTurns >= 1 => 'warm',
            default => 'cold',
        };
    }

    /**
     * A turn-aware funnel nudge for the [[next:]] prompts, injected into the system
     * prompt. WHY the site exists is stated once, in the mission at the top of
     * prompts/directives.md, and reaches the model on every turn; this fragment only
     * applies the resulting lean — the more get-to-know-you turns spent, the more the
     * ONWARD prompts should point at the work and working together, rather than
     * looping on generic personality questions and burning the exchange.
     *
     * Deterministic on the visitor's turn count (not the model inferring "interest",
     * which is what let purely-generic slates persist): empty for the opening turn or
     * two (let rapport build), a gentle one-prompt lean once a few in, a firmer
     * two-prompt lean deeper still. It shapes ONLY the prompts — never the warmth or
     * wording of the reply itself (that guard is stated in the fragment).
     */
    private function funnelNudgePrompt($session): string
    {
        $priorTurns = $this->priorUserTurns($session);

        // Just the opener: let rapport build, no push.
        if ($priorTurns < 1) {
            return '';
        }

        // No restatement of WHY the site exists — that's the mission at the top of
        // directives.md, which reaches the model on every turn including the opener.
        // Saying it again here made the purpose look like a property of the funnel,
        // arriving only from turn two and scoped to the onward prompts. This fragment
        // is now just the LEAN: where the prompts should point, and how hard.
        $base = 'FUNNEL (this shapes ONLY your [[next:]] onward prompts — never the warmth, '
            . 'wording or content of your actual reply, which stays as personal and un-pushy as '
            . 'ever): you\'re past the opening question now. ';

        // A turn in: a gentle single-prompt lean toward the work.
        if ($priorTurns < 2) {
            return $base
                . 'So make at least ONE of your three onward prompts steer naturally toward the '
                . 'work or working together — seeing the actual work, the kinds of projects you '
                . 'take on, how you\'d approach their situation, or an easy way to start a '
                . 'conversation — rather than three more purely get-to-know-you questions. Keep '
                . 'the rest contextual and in your voice; this is a gentle lean, not a hard sell.';
        }

        // Deeper in: lead the onward prompts toward moving things forward.
        return $base
            . 'You\'ve had several get-to-know-you turns, so now lead the onward prompts toward '
            . 'moving forward: at least TWO of the three should be about the work, how you\'d help '
            . 'with their thing, or getting in touch to talk properly. Stay warm and natural, never '
            . 'pushy — but don\'t let the conversation keep drifting as small talk when there\'s a '
            . 'real chance to take it somewhere.';
    }

    /**
     * Does a suggestion prompt just re-ask the process/approach — the thing the
     * method timeline already shows? Used to drop redundant model chips like
     * "how would you approach a new project" or "your process for a project" once
     * the method panel is on screen. Deliberately narrow: it only fires on the
     * process/approach/methodology framing, so genuinely different design sub-topics
     * that merely contain "approach" ("how do you approach type on a project", "how
     * do you handle baseline rhythm") are NOT matched and stay.
     */
    private function isProcessRestate(string $text): bool
    {
        $t = ' ' . mb_strtolower(trim($text)) . ' ';

        return (bool) preg_match('/\byour (design |creative |whole )?process\b/', $t)
            || (bool) preg_match('/\bprocess (for|on) (a )?(new )?(project|build)\b/', $t)
            || (bool) preg_match('/\bapproach (a )?(new )?(project|build)\b/', $t)
            || (bool) preg_match('/\bhow (do|would|d) you (usually )?(work|approach|tackle|run|start) (a )?(new )?project\b/', $t)
            || (bool) preg_match('/\b(your|the) (methodology|workflow)\b/', $t);
    }

    /** The warmer of two funnel stages (cold < warm < hot). */
    private function warmerStage(string $a, string $b): string
    {
        $rank = ['cold' => 0, 'warm' => 1, 'hot' => 2];
        return ($rank[$b] ?? 0) > ($rank[$a] ?? 0) ? $b : $a;
    }

    /**
     * How many meaningful words (4+ letters) a prompt shares with a text — used to
     * rank the model's [[next]] prompts by topical fit with the current answer.
     */
    /**
     * The DISTINCTIVE terms that mean a given panel — the words a suggestion would use
     * to re-ask for content already on screen. Deliberately NOT the generic topic words
     * ("work", "experience", "projects"): those recur in every genuine next question and
     * must never trigger a drop. A single distinctive hit is enough to bin the chip.
     */
    private function panelEchoTerms(string $handle): array
    {
        return match ($handle) {
            'sectors' => ['sector', 'sectors', 'industry', 'industries'],
            'clients' => ['client', 'clients', 'brand', 'brands'],
            'method' => ['process', 'approach', 'methodology', 'workflow'],
            'casestudies' => ['portfolio', 'case study', 'case studies'],
            'music' => ['music', 'listen', 'listening', 'artist', 'artists', 'spotify', 'band', 'bands'],
            'photo' => ['photography', 'photo', 'photos', 'photograph', 'photographs'],
            default => [],
        };
    }

    /**
     * Whether a suggestion chip is a "let's work together / get in touch" prompt —
     * the lead-gen path, which we float to the top of the slate. Matched on phrases
     * that clearly mean starting a working relationship, not Jon's own history (so
     * "how did you get started in design?" doesn't count — it lacks the together/us).
     */
    /**
     * Keep only the [[next:]] prompts whose citation resolves to a known topic.
     * The citation is the trailing `@kind:id` (or bare `@topic`) the directive
     * asks the model to append; it leaves the chip text and becomes the prompt's
     * SOURCE. Unknown, malformed or missing citations drop the prompt — logged
     * with the reason, so a directive drift shows up in the log rather than as an
     * empty slate.
     *
     * Returns [['text' => …, 'source' => 'study:foo'], …].
     */
    private function groundedPrompts(array $prompts): array
    {
        if (!$prompts) {
            return [];
        }
        $known = $this->knownTopics();
        $out = [];
        foreach ($this->pairCitations($prompts) as [$text, $kind, $id]) {
            if ($kind === null) {
                Craft::info('dropped (no citation): ' . $text, 'jonson.suggestions');
                continue;
            }
            $key = $id !== '' ? "{$kind}:{$id}" : $kind;
            if ($text === '') {
                Craft::info("dropped (citation with no prompt): @{$key}", 'jonson.suggestions');
                continue;
            }
            if (!isset($known[$key])) {
                Craft::info("dropped (unknown topic {$key}): " . $text, 'jonson.suggestions');
                continue;
            }
            $out[] = ['text' => $text, 'source' => $key];
        }

        return $out;
    }

    /**
     * Split each raw [[next:]] segment into [text, kind, id], repairing the one
     * malformation that costs a whole slate.
     *
     * The model usually writes `prompt @citation` per segment. Sometimes it writes
     * all three prompts and THEN all three citations:
     *
     *     [[next: one | two | three @method | @sectors | @clients]]
     *
     * Split on the pipe, that leaves "one" and "two" uncited, "three" wearing the
     * FIRST citation, and two citation-only fragments — three good prompts
     * collapsing into one mis-grounded chip. When the texts and the citations both
     * arrive in order and in equal number, that is what the model meant, so pair
     * them off in order.
     *
     * Any other shape is left exactly as parsed. A single forgotten citation can't
     * be repaired — we don't know which prompt it belonged to, and guessing would
     * ground a chip on the wrong thing, which is the failure this whole path exists
     * to prevent.
     */
    private function pairCitations(array $segments): array
    {
        $parsed = [];
        foreach ($segments as $s) {
            $parsed[] = $this->splitCitation((string) $s) ?? [trim((string) $s), null, null];
        }

        $texts = array_values(array_filter($parsed, static fn(array $p): bool => $p[0] !== ''));
        $cites = array_values(array_filter($parsed, static fn(array $p): bool => $p[1] !== null));
        $uncited = array_filter($parsed, static fn(array $p): bool => $p[0] !== '' && $p[1] === null);
        if (!$uncited || count($texts) !== count($cites)) {
            return $parsed;
        }

        $paired = [];
        foreach ($texts as $i => $t) {
            $paired[] = [$t[0], $cites[$i][1], $cites[$i][2]];
        }

        return $paired;
    }

    /**
     * One segment split into [text, kind, id], or null when it carries no citation.
     * Trailing punctuation AFTER the citation ("… @cv?") is the model finishing the
     * sentence out of habit; it used to take the whole prompt down with it, so it is
     * tolerated and discarded.
     */
    private function splitCitation(string $segment): ?array
    {
        if (!preg_match('/^(.*?)\s*@([a-z]+)(?::\s*([^@]+?))?[\s?.!,;:]*$/iu', $segment, $m)) {
            return null;
        }

        return [trim($m[1]), strtolower($m[2]), isset($m[3]) ? $this->topicSlug($m[3]) : ''];
    }

    /**
     * Everything a [[next:]] prompt may be about, as citation keys: each note
     * (`note:slug`), each case study (`study:slug`), each photo place/theme
     * (`photo:handle`), each sector (`sector:slug`) and client (`client:slug`),
     * plus the standing topics that exist on this site. Built from the same
     * sources the persona is fed, so "known" here means "in the prompt".
     */
    private function knownTopics(): array
    {
        $ctx = Jonson::getInstance()->findContext;
        $known = ['contact' => true, 'work' => true, 'about' => true];

        foreach (Jonson::getInstance()->noteMemory->cards() as $card) {
            if (!empty($card['slug'])) {
                $known['note:' . $card['slug']] = true;
                $known['notes'] = true;
            }
        }
        foreach ($ctx->caseStudies() as $s) {
            if (!empty($s['slug'])) {
                $known['study:' . $s['slug']] = true;
                $known['casestudies'] = true;
            }
        }
        foreach ($ctx->inventory() as $i) {
            $known['photo:' . $i['handle']] = true;
            $known['photos'] = true;
        }
        foreach ($ctx->sectors() as $label) {
            $known['sector:' . $this->topicSlug((string) $label)] = true;
            $known['sectors'] = true;
        }
        foreach ($ctx->clientWork() as $c) {
            $known['client:' . $this->topicSlug((string) $c['name'])] = true;
            $known['clients'] = true;
        }
        if ($ctx->methodology()) {
            $known['method'] = true;
        }
        if (Jonson::getInstance()->spotify->isConfigured()) {
            $known['music'] = true;
        }
        if ($this->cvPrompt() !== '') {
            $known['cv'] = true;
        }

        return $known;
    }

    /** A citation id or a label, normalised so `@sector:Financial Services` meets `sector:financial-services`. */
    private function topicSlug(string $value): string
    {
        $value = mb_strtolower(trim($value));
        $value = preg_replace('/[^\p{L}\p{N}]+/u', '-', $value) ?? $value;
        return trim($value, '-');
    }

    private function isContactPrompt(string $prompt): bool
    {
        return $this->containsAnyTerm($prompt, [
            'work together', 'working together', 'get in touch', 'in touch',
            'next step', 'next steps', 'start a project', 'start a conversation',
            'set up a call', 'book a call', 'schedule a call', 'reach out',
            'hire you', 'get started working', 'start working together',
        ]);
    }

    /** Whether $text contains any of $terms as a whole word/phrase (case-insensitive). */
    private function containsAnyTerm(string $text, array $terms): bool
    {
        $norm = ' ' . mb_strtolower(trim(preg_replace('/[^\p{L}\p{N}]+/u', ' ', $text) ?? '')) . ' ';
        foreach ($terms as $t) {
            if (str_contains($norm, ' ' . mb_strtolower($t) . ' ')) {
                return true;
            }
        }
        return false;
    }

    private function promptRelevance(string $prompt, string $text): int
    {
        $words = static function (string $s): array {
            $parts = preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower($s)) ?: [];
            return array_unique(array_filter($parts, static fn($w) => mb_strlen($w) >= 4));
        };

        return count(array_intersect($words($prompt), $words($text)));
    }

    /**
     * The ordered roles that make up the slate for a stage — its shape. 'model' is
     * the model's contextual momentum prompt; the rest are content roles ('proof',
     * 'discovery', 'progress'). Editing a plan re-shapes the funnel without touching
     * the registry or the composer. A role with no in-stage candidate is skipped.
     */
    private function slotPlan(string $stage): array
    {
        // Two model-phrased chips (the natural, in-voice momentum prompts) + one
        // structured funnel chip, so the slate reads like a person, not a canned menu,
        // while a deterministic proof/progress/discovery chip still guarantees the
        // funnel path. Registry candidates backfill if the model gives too few.
        return match ($stage) {
            // Orienting: momentum-led, with one discovery chip for colour.
            'cold' => ['model', 'discovery', 'model'],
            // Engaged / stated a need: lead with the path to working together, then
            // two natural momentum chips.
            'hot' => ['progress', 'model', 'model'],
            // Evaluating (default): momentum-led with one proof chip guaranteed.
            default => ['model', 'proof', 'model'],
        };
    }

    /**
     * The content handles the visitor has already seen — panels shown once this
     * conversation (method/clients/sectors), plus 'photo' when a rail is on the
     * current answer. Fed to suggestionsFor so we don't suggest content already
     * on screen.
     */
    private function shownContentHandles($session, bool $railShown): array
    {
        $handles = [];
        foreach (['method', 'clients', 'sectors', 'casestudies', 'music'] as $handle) {
            // Any variant counts as shown: the point is "this content is already on
            // screen, don't suggest asking for it", and the marquee puts case studies
            // there just as the feature does.
            $shown = $this->hasShownOnce($session, $handle);
            foreach (self::PANEL_MODIFIERS as $modifier) {
                $shown = $shown || $this->hasShownOnce($session, $this->panelSlot($handle, $modifier));
            }
            if ($shown) {
                $handles[] = $handle;
            }
        }
        if ($railShown) {
            $handles[] = 'photo';
        }

        return $handles;
    }

    /**
     * Capitalise the first letter, leave the rest untouched — so a chip reads as
     * a sentence ("what sectors…" → "What sectors…") without mangling proper
     * nouns mid-phrase (Bordeaux, RegTech). Unicode-safe.
     */
    private function capitaliseFirst(string $s): string
    {
        if ($s === '') {
            return $s;
        }

        return mb_strtoupper(mb_substr($s, 0, 1)) . mb_substr($s, 1);
    }

    /**
     * Normalise a "where next?" chip: sentence-cased first letter (proper nouns kept)
     * and end punctuation matched to its KIND. A question — starts with an interrogative
     * word (mirrors the directive's own list) or the model already ended it with "?" —
     * gets a single trailing "?". A statement — the visitor's first-person answer to a
     * question Jon posed ("I'm a startup…", "Unsure where to begin") — gets none. Stray
     * end punctuation is stripped first either way.
     */
    private function normalizeChip(string $s): string
    {
        $s = trim($s);
        if ($s === '') {
            return $s;
        }

        // Decide question vs statement BEFORE stripping, so an existing "?" still counts.
        $firstWord = mb_strtolower((preg_split('/[^\p{L}]+/u', $s, 2)[0]) ?? '');
        $interrogatives = ['how', 'what', 'whats', 'why', 'where', 'wheres', 'which', 'who', 'whos', 'whom', 'whose', 'when', 'whens', 'can', 'could', 'do', 'does', 'did', 'is', 'are', 'am', 'was', 'were', 'will', 'would', 'should', 'shall', 'have', 'has', 'had', 'may', 'might', 'must', 'any', 'anything'];
        $isQuestion = in_array($firstWord, $interrogatives, true)
            || preg_match('/[?？]\s*$/u', $s) === 1;

        $s = $this->capitaliseFirst($s);
        // The first-person pronoun is always capitalised — "Can i see…" → "Can I see…"
        // (also catches "i'm", "i've", "i'd", "i'll"; the apostrophe is a word boundary).
        $s = preg_replace('/\bi\b/u', 'I', $s) ?? $s;
        $s = rtrim($s, " \t.!?？。");
        if ($s === '') {
            return $s;
        }

        // Questions end in "?"; statements (tappable answers) take no trailing mark.
        return $isQuestion ? $s . '?' : $s;
    }

    /**
     * The chips already OFFERED this conversation: their normalised text keys, and
     * the sources they were grounded on. Kept apart from askedKeys(), which only
     * knows what the visitor typed or tapped — an ignored chip leaves no trace
     * there, which is how the same slate came back turn after turn.
     */
    private function offeredChips($session): array
    {
        $rec = Craft::$app->getCache()->get($this->shownKey($session, 'chips'));

        return is_array($rec) ? $rec + ['keys' => [], 'sources' => []] : ['keys' => [], 'sources' => []];
    }

    private function offeredKeys($session): array
    {
        return $this->offeredChips($session)['keys'];
    }

    private function offeredSources($session): array
    {
        return $this->offeredChips($session)['sources'];
    }

    /** Bank a slate on its way out. $chips is [['text' => …, 'source' => …], …]. */
    private function rememberOfferedChips($session, array $chips): void
    {
        if (!$chips) {
            return;
        }
        $rec = $this->offeredChips($session);
        foreach ($chips as $c) {
            $key = $this->cacheKey((string) ($c['text'] ?? ''));
            if ($key !== '') {
                $rec['keys'][$key] = true;
            }
            if (($c['source'] ?? '') !== '') {
                $rec['sources'][$c['source']] = true;
            }
        }
        Craft::$app->getCache()->set($this->shownKey($session, 'chips'), $rec, self::CACHE_TTL);
    }

    /** Normalised keys of every question asked this session (from the history). */
    private function askedKeys($session): array
    {
        $history = Craft::$app->getCache()->get($this->historyKey($session));
        $keys = [];
        if (is_array($history)) {
            foreach ($history as $m) {
                if (($m['role'] ?? '') === 'user' && is_string($m['content'] ?? null)) {
                    $keys[$this->cacheKey($m['content'])] = true;
                }
            }
        }

        return $keys;
    }

    /** Strip inline markers (the [[next: …]] suggestions block + [[handle]]s). */
    /**
     * Every marker the model placed, by handle: its modifier (`[[handle:mod]]`),
     * whether it is FRAMED, and the order it first appeared in. A handle placed
     * twice keeps its first modifier and counts as framed if either placement is.
     * `[[next: …]]` is not a marker (its body has a space) and never matches.
     *
     * Framed means prose comes before it: the marker sits in a paragraph with
     * prose, or on its own line after one — the surface then renders beneath
     * that paragraph, which is the frame the visitor reads it against (the
     * client places it there). Unframed is a marker before any prose at all, and
     * that one is dropped rather than rendered above the first line.
     */
    private function markersIn(string $answer): array
    {
        $marks = [];
        $order = 0;
        $proseSeen = false;
        foreach (preg_split('/\n{2,}/', $answer) ?: [] as $paragraph) {
            $hasProse = trim($this->stripMarkers($paragraph)) !== '';
            if (!preg_match_all('/\[\[([a-z0-9][a-z0-9-]*)(?::([a-z0-9-]+))?\]\]/i', $paragraph, $m, PREG_SET_ORDER)) {
                $proseSeen = $proseSeen || $hasProse;
                continue;
            }
            $framed = $hasProse || $proseSeen;
            $proseSeen = $proseSeen || $hasProse;
            foreach ($m as $match) {
                $handle = strtolower($match[1]);
                if ($handle === 'next') {
                    continue;
                }
                if (isset($marks[$handle])) {
                    $marks[$handle]['framed'] = $marks[$handle]['framed'] || $framed;
                    continue;
                }
                $marks[$handle] = [
                    'modifier' => ($match[2] ?? '') !== '' ? strtolower($match[2]) : null,
                    'framed' => $framed,
                    'order' => $order++,
                ];
            }
        }

        return $marks;
    }

    /**
     * Whether the conversation names the thing a photo handle stands for: the
     * question does, or the paragraph carrying the marker does —
     * `…born on Jersey, and I still go back[[jersey]]`, `…I mostly shoot
     * street[[street-photo]]` (a word of the label, with an inflected tail). The
     * model places a marker at the end of the sentence about the thing, the same
     * way it places every other marker, so adjacency to the word is too strict;
     * but a handle in a paragraph that never names the place or theme is not a
     * reference to it, and is dropped. Syntax, not a reading of the sentence.
     */
    private function paragraphNamesLabel(string $answer, string $question, string $handle, string $label): bool
    {
        $marker = '/\[\[' . preg_quote($handle, '/') . '(?::[a-z0-9-]+)?\]\]/i';
        // Any substantive word of the label counts as naming it: the model says
        // "I shoot street[[street-photo]]" for the theme labelled "street photo",
        // and that IS the thing named, in its own words. Short words (of, the)
        // don't count; a label with none falls back to the whole phrase.
        $words = array_values(array_filter(preg_split('/\s+/', trim($label)) ?: [], static fn($w) => mb_strlen($w) >= 4)) ?: [trim($label)];
        $named = '/(?<!\p{L})(?:' . implode('|', array_map(static fn($w) => preg_quote($w, '/'), $words)) . ')\p{L}{0,6}(?!\p{L})/iu';
        // The question is part of what the conversation names: asked "much time
        // in Jersey?", the answer says "I was born there, on the island[[jersey]]".
        if (preg_match($named, $question)) {
            return (bool) preg_match($marker, $answer);
        }
        foreach (preg_split('/\n{2,}/', $answer) ?: [] as $paragraph) {
            // Match the PROSE, with the markers stripped: the label's words sit
            // inside the handle itself ("street" in `[[street-photo]]`), and a
            // check that read the marker would ground every marker on itself.
            if (preg_match($marker, $paragraph) && preg_match($named, $this->stripMarkers($paragraph))) {
                return true;
            }
        }

        return false;
    }

    private function stripMarkers(string $text): string
    {
        $text = preg_replace('/\s*\[\[next:[^\]]*\]{1,2}/is', '', $text) ?? $text;

        // Must accept the optional :modifier too — otherwise a [[casestudies:all]]
        // survives this pass and renders as literal text in the answer.
        $text = preg_replace('/\s*\[\[[a-z0-9-]+(?::[a-z0-9-]+)?\]\]/i', '', $text) ?? $text;

        // Then the malformed ones. The model sometimes closes a marker with a single
        // bracket ("[[france]") or not at all, and the strict pass above leaves those
        // sitting in the prose for the reader to see. Handles are matched the same
        // way, so this only ever eats something that was trying to be a marker —
        // `[[` doesn't otherwise occur in the writing.
        //
        // Note this catches invented handles too, which is the point: the model made
        // up [[france]] once, and an unknown marker should vanish rather than render.
        return trim(preg_replace('/\s*\[\[[a-z0-9-]+(?::[a-z0-9-]+)?\]?/i', '', $text) ?? $text);
    }

    /**
     * Normalise a question so "Tell me about yourself?" and "tell me about
     * yourself" hit the same cache entry.
     */
    private function cacheKey(string $question): string
    {
        $key = trim(preg_replace('/[^\p{L}\p{N}]+/u', ' ', mb_strtolower($question)) ?? '');

        return $key !== '' ? $key : mb_strtolower(trim($question));
    }

    /**
     * Stable conversation id for keying every Jonson cache (history, answer bundle,
     * shown-state, transcript). Prefers the client-minted `cid` — a token the browser
     * generates once and sends with every request — because the PHP session id can
     * shift on a brand-new visitor before its cookie round-trips, which mis-keyed the
     * caches (a shown panel written under one id, read under another → the "already
     * shown" exclusion missed and chips echoed). Falls back to the session id when
     * there's no token (no-JS / old client). Sanitised: UUID-safe chars, capped.
     */
    private function convoId($session): string
    {
        $cid = preg_replace('/[^A-Za-z0-9_-]/', '', (string) $this->request->getBodyParam('cid', ''));
        $cid = mb_substr((string) $cid, 0, 64);

        return $cid !== '' ? $cid : (string) $session->getId();
    }

    /** Per-conversation Craft-cache key for the conversation history. */
    private function historyKey($session): string
    {
        return self::HISTORY_PREFIX . ':' . $this->convoId($session);
    }

    /** Per-conversation Craft-cache key for the full (uncapped) transcript. */
    private function transcriptKey($session): string
    {
        return self::TRANSCRIPT_PREFIX . ':' . $this->convoId($session);
    }

    /** Per-conversation Craft-cache key for a question's cached answer bundle. */
    private function answerKey($session, string $question): string
    {
        // The page it was asked from is part of the question: "why did you build
        // it that way?" under one note is not the same question under another.
        $page = $this->pageFrom ? ':p' . $this->pageFrom : '';

        return self::ANSWER_PREFIX . ':' . $this->convoId($session) . ':' . $this->cacheKey($question) . $page;
    }

    /**
     * How many questions the visitor has asked BEFORE this one — 0 on an opener.
     * Read from the cached history, which at this point holds the prior turns only.
     */
    /**
     * The text of the last $turns exchanges (question + answer each) as one string,
     * markers stripped — the recent conversation, for reading what a follow-up is
     * still about (see FindContext::testimonials). Empty on an opener. Reads the
     * cached history, which at this point holds the prior turns only.
     */
    private function recentTurnsText($session, int $turns): string
    {
        $history = Craft::$app->getCache()->get($this->historyKey($session));
        if (!is_array($history) || !$history) {
            return '';
        }
        $recent = array_slice($history, -2 * $turns);

        return $this->stripMarkers(implode(' ', array_map(static fn($m) => (string) ($m['content'] ?? ''), $recent)));
    }

    private function priorUserTurns($session): int
    {
        $history = Craft::$app->getCache()->get($this->historyKey($session));
        $n = 0;
        if (is_array($history)) {
            foreach ($history as $m) {
                if (($m['role'] ?? '') === 'user') {
                    $n++;
                }
            }
        }

        return $n;
    }

    /**
     * The VIP note as a system block: who the visitor is and what Jon wants Jonson
     * to know about them (see services\Vip — the visitor came in through
     * /vip/{slug} and holds its cookie). The note is Jon's own private background:
     * it shapes what Jonson leads with and how he reads the questions, and is
     * never recited, quoted or acknowledged as a briefing. Empty for anyone else.
     */
    private function vipPrompt($session): string
    {
        $vip = Jonson::getInstance()->vip;
        $entry = $vip->current();
        if (!$entry) {
            return '';
        }
        $name = trim((string) $entry->title);
        $text = $vip->note($entry);
        if (mb_strlen($text) > self::VIP_CONTEXT_CHARS) {
            $text = mb_substr($text, 0, self::VIP_CONTEXT_CHARS);
            $text = mb_substr($text, 0, (int) mb_strrpos($text, ' ')) . ' […]';
        }

        // The facts Jon typed into the entry's own fields, when he has: the person's
        // name and where they work. Stated once, plainly; the note carries the rest.
        $first = $vip->field($entry, 'firstName');
        $person = trim($first . ' ' . $vip->field($entry, 'surname'));
        $company = $vip->field($entry, 'company');
        $who = '';
        if ($person !== '' || $company !== '') {
            $who = ' They are ' . ($person !== '' ? $person : 'someone')
                . ($company !== '' ? " at {$company}" : '') . '.';
        }

        // The name, at the right moments. The first reply greets them — that's the
        // beat that says the door was made for them. After that the name comes back
        // only where it would in conversation; a name in every reply is a mail-merge.
        $opener = $this->priorUserTurns($session) < 1;
        // Been through the door before? The entry counts every arrival, and this
        // visit's own arrival is already on the count — so 1 is a first visit and
        // anything above it means they've come back. A proxy (a reload of the door
        // URL counts too), but good enough to say "welcome back" rather than "good to
        // have you here" — and to stop a returning visitor being met like a stranger
        // once the conversation history (3h) has lapsed.
        $returning = (int) $entry->{$vip::HITS_FIELD} > 1;
        if ($first !== '') {
            $naming = $opener
                ? ($returning
                    ? "This is your first reply in THIS conversation, but they've been here before — "
                        . "greet them by first name ({$first}) as someone coming back, not a stranger, "
                        . "in one brief line. Don't pretend to recall what you talked about last time "
                        . "(you don't have it) and don't make a thing of the return — then answer what "
                        . "they asked. Warm and brief, never gushing. "
                    : "This is your FIRST reply to them, so greet them: open with their first name "
                        . "({$first}) and one line that shows you know who they are and why they're likely "
                        . "here — then answer what they asked. Warm and brief, never gushing. THE GREETING "
                        . "IS THE FIRST THING IN THE REPLY, before the answer — never a line at the end and "
                        . "never a sign-off. Asked something short and practical, the pull is to answer it "
                        . "and greet afterwards; that lands the welcome as an afterthought, which is the "
                        . "opposite of what a door made for someone is for. ")
                : "You've already greeted them. Use their first name ({$first}) only where you'd "
                    . "naturally say it in conversation — a moment of emphasis, a direct question, a "
                    . "sign-off — not in every reply, and never to open reply after reply. ";
        } else {
            $naming = "You don't have their first name, so don't guess one or address them by the "
                . "name of the link. ";
        }

        // Why Jon made the door — the frame everything else sits in. A hiring
        // manager and a prospective client want different things from the same
        // answer, and the next step at the end differs too (see Vip::PURPOSES).
        $purpose = $vip->purpose($entry);
        $why = $purpose !== '' ? '- WHY YOU MADE THIS DOOR: ' . $vip::PURPOSES[$purpose]['prompt'] . "\n" : '';

        // A DOOR WITHOUT A NOTE still knows who it was made for — the name, the company
        // and the purpose all sit on the entry, and an empty note stopped disqualifying a
        // door in services\Vip::enter(). What it hasn't got is private background, and the
        // block has to SAY so: the wording below promised a note and then handed over an
        // empty string, which is an invitation to fill the gap with an invented one.
        $hasNote = $text !== '';
        $background = $hasNote
            ? "Below is your own private note on them: who they are, what they're likely weighing up, "
                . "what of your work and experience speaks to them.\n"
            : "You have NO NOTE on them. You know you made them a link and you know their name, and "
                . "not one thing beyond it — so don't invent a history between you, a referral, a "
                . "mutual contact, or a reason you suppose they're here, and don't imply you know "
                . "their situation. What they tell you is where it comes from.\n";

        return "WHO YOU ARE TALKING TO. This visitor came in through a private link you made for "
            . "\"{$name}\" — you know who they are, the way you'd know a guest someone had introduced.{$who} "
            . $background
            . $why
            . "- " . $naming . "\n"
            . ($hasNote
                ? "- Draw on what you know about them openly, as shared context between two people who've "
                    . "been introduced — \"as someone who's run a design team…\", \"given what you're building…\" — "
                    . "and let it colour the angle, the examples and the depth you pitch at. What you must NOT do "
                    . "is recite the note, list facts about them back at them, or say you were briefed, given "
                    . "notes or sent a link. You simply know them.\n"
                : "- Treat them as someone you invited and are glad to see, and let what they ask tell "
                    . "you the rest — ask, rather than assume, what brings them here. What you must NOT "
                    . "do is say you were briefed, given notes or sent a link.\n")
            . "- The work you show is chosen FOR THEM: when work fits the question, pick the case studies, "
            . "clients and sectors that speak to their situation and name those in your reply — the cards "
            . "follow what you name, so naming the right ones is how the right cards appear.\n"
            . "- Your [[next:]] onward prompts are the questions THIS person would ask next, given who they "
            . "are and what they're weighing up — never generic ones. Tailoring them doesn't lift the "
            . "citation rule: each still ends with its @source, or it's dropped before they see it.\n"
            . "- They were invited, so the moment to connect can come a little sooner than it would for a "
            . "stranger — but still only at a genuine ready-to-act beat, and still once.\n"
            . ($hasNote
                ? "- Don't fawn, and if they say they're someone else, take their word for it and let the "
                    . "note go.\n"
                    . "Your note, in full:\n\n" . $text
                : "- Don't fawn, and if they say they're someone else, take their word for it.\n");
    }

    /**
     * Ask for the way in, on the turn it is due — so the model writes it rather than
     * code appending it afterwards.
     *
     * THE POINT IS THE SENTENCE. Asked outright, Jonson writes "Easiest is to call me
     * on +33668430934, or if you'd rather keep it async, send me a WhatsApp — either
     * reaches me directly." The engagement floor cannot produce that: it runs AFTER the
     * answer is generated, so it has nothing to weave into and can only bolt a line
     * underneath. Same information, and it reads like a form rather than like Jon.
     *
     * The floor's trigger, though, is knowable in advance — funnelStage() is counted
     * off the history, so on the turn it will read 'hot' we already know before
     * generating. Ask then, and the answer arrives with a real closing sentence and its
     * own [[contact]] marker; the panel resolves through the ordinary marker path, and
     * answerNamesRoutes() sees the routes in the prose and adds no line of its own.
     *
     * THE FLOOR STAYS, as the net under this. A cue is a request and the model may not
     * take it — it might be mid-sign-off, or read the question as needing something
     * else — and a visitor who is never offered a way in is the failure both of these
     * exist to prevent. So this tries for the good version and the floor guarantees the
     * adequate one, which is the right way round.
     *
     * Empty once a way in has been offered: like every contact beat, only ever once.
     */
    private function contactBeatCue($session): string
    {
        if ($this->hasShownOnce($session, 'contact') || $this->funnelStage($session) !== 'hot') {
            return '';
        }

        $routes = (new \modules\frontend\variables\FrontEndVariable())->doorCtas() ? true : false;

        return "THE WAY IN BELONGS IN THIS REPLY. They have asked a few things now and you have "
            . "not yet offered them a way to reach you. So finish this answer by saying how they "
            . "can — in your own words, the way you would say it out loud, as one short sentence "
            . "that follows naturally from what you have just told them. Put the [[contact]] "
            . "marker in that paragraph.\n"
            . ($routes
                ? "- Name the quickest of the routes listed above and one alternative, written as "
                    . "links exactly as that list shows them. Not all of them, and not as a list.\n"
                : "")
            . "- Once, warmly, and without pitching: an open door, not a close. Do not ask whether "
            . "they would like to book anything, and do not follow it with another question.\n"
            . "- If they are plainly signing off, or have just said they will be in touch, let it "
            . "go and do not force it — saying goodbye twice is worse than not offering.";
    }

    /**
     * Unlink any same-site link in the answer that does not point at a real page.
     *
     * The model is given the paths of the things it is told about, so a correct link is
     * a copy. A wrong one is a slug it half-remembered — and a portfolio answering a
     * question with a 404 is worse than one answering it in plain words, so the link
     * comes off and the words stay. Only the brackets are removed; nothing is deleted.
     *
     * Same-site only. tel: and mailto: are checked by the renderer and an external URL
     * never renders at all, so neither can arrive here needing a page to exist.
     */
    private function groundLinks(string $answer): string
    {
        if ($answer === '' || !str_contains($answer, '](/')) {
            return $answer;
        }

        return preg_replace_callback(
            '~\[([^\]\n]+)\]\((/[^)\s]*)\)~',
            fn(array $m) => $this->siteUriExists($m[2]) ? $m[0] : $m[1],
            $answer,
        ) ?? $answer;
    }

    /**
     * Is there a live page at this path? Memoised per request — an answer that links the
     * same study twice should cost one lookup, and answers rarely carry more than three.
     *
     * STATUS_LIVE, not merely "an element owns this URI": a disabled or expired entry
     * still has its row, and linking to one sends the visitor to a 404 just the same.
     */
    private function siteUriExists(string $path): bool
    {
        static $seen = [];

        $uri = trim(parse_url($path, PHP_URL_PATH) ?: '', '/');
        if ($uri === '') {
            return true; // "/" — the homepage, which always exists
        }
        if (isset($seen[$uri])) {
            return $seen[$uri];
        }

        return $seen[$uri] = \craft\elements\Entry::find()
            ->uri($uri)
            ->status(\craft\elements\Entry::STATUS_LIVE)
            ->exists();
    }

    /**
     * Does this answer already carry the visitor's own contact routes?
     *
     * The contact panel offers them as links ONLY when the prose did not, and this is
     * the question that decides it. Asked of the text rather than of which code path
     * produced the beat, because "the model marked it" turned out not to predict it:
     * a marked [[contact]] sometimes arrives under a sentence with the number in it and
     * sometimes under one without, and the engagement floor's beat never has one. The
     * text is the only thing that actually knows.
     *
     * Matched on the URL, not on the label or the digits — the URL is what a link has
     * to contain to be a link, and it is the same string the panel would render.
     */
    private function answerNamesRoutes(string $answer): bool
    {
        foreach ((new \modules\frontend\variables\FrontEndVariable())->doorCtas() as $cta) {
            $url = trim((string) ($cta->ctaUrl->url ?? ''));
            if ($url !== '' && str_contains($answer, $url)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The ways this visitor can reach Jon, as a system block — the CTAs their VIP door
     * unlocked (craft.frontend.doorCtas()), with the real URLs.
     *
     * WHY THE URLS AND NOT JUST "OFFER A CALL": a model asked to give out a phone
     * number will give out a phone number, and it will be a plausible one. These come
     * from the globals single, so the sentence names the number the CMS holds or it
     * names nothing.
     *
     * The same list is on the page as data-jonson-links (see _views/single/home), and
     * that is what makes an https: route like WhatsApp linkable at all: inlineMarkdown()
     * allows tel:, mailto: and same-site paths by shape, and everything else only by
     * exact match against that list. So the routes below are precisely the set that can
     * render — a link this block does not name cannot appear, however plausible.
     *
     * IN THE SENTENCE, NOT AS BUTTONS. The [[contact]] beat renders one button, "Let's
     * talk more", and that is all it renders: a row of buttons mid-conversation reads
     * as a form, where "call me on <number>" reads as a person saying it.
     *
     * Empty for anyone without a door, and for a door whose purpose unlocked nothing.
     */
    private function contactRoutesPrompt(): string
    {
        $ctas = (new \modules\frontend\variables\FrontEndVariable())->doorCtas();

        $routes = [];
        foreach ($ctas as $cta) {
            $label = trim((string) $cta->title);
            $url = trim((string) ($cta->ctaUrl->url ?? ''));
            if ($label === '' || $url === '') {
                continue;
            }
            // A PHONE NUMBER IS ITS OWN LABEL. "call me" hides the one piece of
            // information the visitor needs: someone reading on a desktop cannot tap a
            // link, and someone who wants to save the number cannot see it. Said firmly
            // because the model does hide it otherwise — asked for "[+33…](tel:+33…)" it
            // came back with "[call me](tel:+33…)" until told why the digits matter.
            //
            // Every other route is named in words, and the label stays as Jon spelled it
            // in the CP: strtolower() here turned "Send me a WhatsApp" into "send me a
            // whatsapp" in a real answer, which is a brand name spelled wrong by us
            // rather than by the model.
            if (preg_match('~^tel:~i', $url)) {
                $number = preg_replace('~^tel:~i', '', $url);
                // EVERY ILLUSTRATION HERE CARRIES THE LINK SYNTAX, including the one in
                // running prose. Written once as a bare sentence — call me on <number> —
                // the model copied that shape instead of the markdown above it and the
                // digits arrived as plain text three times out of three. It parrots the
                // nearest example, so the nearest example has to be the finished article.
                $routes[] = "- {$label}: the link text is THE NUMBER ITSELF — [{$number}]({$url}) — "
                    . "never hidden behind words like \"call me\", because a number that can be "
                    . "read is one that can be dialled from a desk or saved. In a sentence: "
                    . "\"call me on [{$number}]({$url})\".";
            } else {
                // SHOW THE FINISHED FORM, don't describe how to make it. The label is the
                // CTA's title as Jon typed it in the CP, so it is capitalised like a title and
                // reads wrong mid-sentence ("you can Send me a WhatsApp"). Handing over the
                // title plus permission to adjust it produced worse answers than either on its
                // own — one reply dropped the link entirely, another wrote "send me a WhatsApp
                // on [Send me a WhatsApp](…)". The model follows an example far better than a
                // rule, so the example is simply the sentence-ready version.
                //
                // lcfirst, not strtolower: it lowers only the leading word, so the brand keeps
                // its capitals — "Send me a WhatsApp" becomes "send me a WhatsApp". (A title
                // that opened ON a name would come out wrong, and none does; the alternative
                // lowercased the lot and shipped "whatsapp".)
                $face = lcfirst($label);
                $routes[] = "- {$label} — link it on the words that fit your sentence, like this: "
                    . "[{$face}]({$url}). The URL must be exactly as given.";
            }
        }

        if (!$routes) {
            return '';
        }

        return "HOW THIS VISITOR CAN REACH YOU. You made them a door, and these are the routes it "
            . "opened. They are facts from the CMS: never invent, reword or improve a number, an "
            . "address or a link, and never offer a route that is not here.\n"
            . implode("\n", $routes) . "\n"
            . "\nWrite them INTO THE SENTENCE as links, exactly as shown above — not as a list, not "
            . "as buttons. Asked how to reach you, name the quickest route for what this person is "
            . "trying to do, offer one alternative if it genuinely suits them better, and leave it "
            . "there. Two routes in a sentence is an offer; four is a switchboard.\n"
            . "\nTHAT SENTENCE IS THE END OF THE REPLY. Stop on it. Don't add a sign-off, a second "
            . "invitation, or a line about being around whenever they like: you have just told them "
            . "how to reach you, and \"whenever you'd like to talk, I'm here\" underneath it says the "
            . "same thing again and lands the reply on its third ending. The [[contact]] marker puts a "
            . "single \"Let's talk more\" button below your answer by itself — it needs no sentence "
            . "introducing it and no words about a button.\n"
            . "\nA link you write that is not on the list above will not render: it will sit on the "
            . "screen as raw brackets.";
    }

    /**
     * The note or case study the conversation was opened from, put in front of
     * the model: what it is, where it lives, and its text in full (capped), so a
     * question asked under it — "why did you make the plugin bring its own
     * HTML?" — is read against the page rather than guessed at from the whole
     * site. The memory card the persona already carries is not enough here:
     * it's a digest, and the question is usually about a detail.
     */
    private function pageContextPrompt(): string
    {
        if (!$this->pageFrom) {
            return '';
        }
        $memory = Jonson::getInstance()->noteMemory;
        $entry = \craft\elements\Entry::find()->id($this->pageFrom)->status(\craft\elements\Entry::STATUS_LIVE)->one();
        if (!$entry) {
            return '';
        }
        $section = $entry->getSection()?->handle ?? '';
        $shape = $memory::SECTIONS[$section] ?? null;
        if ($shape === null) {
            return '';
        }
        $what = $shape === 'project' ? 'case study' : 'note';
        $cite = ($shape === 'project' ? 'study' : 'note') . ':' . $entry->slug;
        $posted = $entry->postDate ? $entry->postDate->format('F Y') : null;

        $text = trim($memory->prose($entry));
        if (mb_strlen($text) > self::PAGE_CONTEXT_CHARS) {
            $text = mb_substr($text, 0, self::PAGE_CONTEXT_CHARS);
            $text = mb_substr($text, 0, (int) mb_strrpos($text, ' ')) . ' […]';
        }

        $head = "THE PAGE THIS CONVERSATION WAS OPENED FROM. The visitor typed their first question "
            . "into the ask bar under your {$what} \"" . trim((string) $entry->title) . '"'
            . ($posted ? " ({$posted})" : '') . ($entry->getUrl() ? ' — ' . $entry->getUrl() : '')
            . " [{$cite}]. Read their questions against it unless they clearly move on: \"it\", "
            . "\"the plugin\", \"there\", \"that trip\" mean this page. Answer from what the page "
            . "says, in your own words; where the page doesn't say, say so rather than invent. "
            . "The page, in full:\n\n";

        return $head . $text;
    }

    /**
     * Once-per-conversation gating for panels. `$what` is the panel handle (or a
     * bookkeeping key like 'rail-keys'). Keyed by the conversation id; reset on a
     * fresh opener.
     */
    private function shownKey($session, string $what): string
    {
        return 'jonson-shown:' . $what . ':' . $this->convoId($session);
    }

    /**
     * The once-per-conversation slot a panel claims. Normally the handle — but a
     * modifier makes a genuinely DIFFERENT panel from the same handle, and those must
     * not share a slot.
     *
     * [[casestudies]] and [[casestudies:all]] are the case: one is a relevant pick
     * backing a point, the other the whole catalogue, and asking outright to see
     * everything is a different request from anything that came before. Keyed on the
     * handle alone, "can I see some of your work?" claimed the slot and a follow-up
     * "show me all your work" was skipped before its marquee was ever built — the
     * model wrote "here's the lot" over nothing at all.
     */
    private function panelSlot(string $handle, ?string $modifier): string
    {
        return $modifier !== null && $modifier !== '' ? $handle . ':' . $modifier : $handle;
    }

    private function hasShownOnce($session, string $what): bool
    {
        return (bool) Craft::$app->getCache()->get($this->shownKey($session, $what));
    }

    /** Claim the "shown" slot: true the first time (and records it), false after. */
    private function markShownOnce($session, string $what): bool
    {
        if ($this->hasShownOnce($session, $what)) {
            return false;
        }
        Craft::$app->getCache()->set($this->shownKey($session, $what), true, self::CACHE_TTL);

        return true;
    }

    private function resetShownOnce($session): void
    {
        foreach ($this->surfaceRegistry() as $panel) {
            Craft::$app->getCache()->delete($this->shownKey($session, $panel['handle']));
            // Variant slots too (see panelSlot) — a fresh opener has to clear every
            // slot a handle can claim, or the marquee stays blocked into the next
            // conversation. Add to this list when a panel gains a new modifier.
            foreach (self::PANEL_MODIFIERS as $modifier) {
                Craft::$app->getCache()->delete(
                    $this->shownKey($session, $this->panelSlot($panel['handle'], $modifier)),
                );
            }
        }
        Craft::$app->getCache()->delete($this->shownKey($session, 'rail-keys'));
        Craft::$app->getCache()->delete($this->shownKey($session, 'studies'));
        Craft::$app->getCache()->delete($this->shownKey($session, 'chips'));
        Craft::$app->getCache()->delete($this->shownKey($session, 'outage'));
    }

    /**
     * Record the studies whose cards just went on screen: client and title, lower-
     * cased, merged with any shown earlier this conversation. Read back by
     * shownStudies() when the chips are filtered.
     */
    private function rememberShownStudies($session, array $studies): void
    {
        $names = $this->shownStudies($session);
        foreach ($studies as $s) {
            foreach ([(string) ($s['client'] ?? ''), (string) ($s['title'] ?? '')] as $name) {
                $name = mb_strtolower(trim($name));
                if ($name !== '' && !in_array($name, $names, true)) {
                    $names[] = $name;
                }
            }
        }
        Craft::$app->getCache()->set($this->shownKey($session, 'studies'), $names, self::CACHE_TTL);
    }

    /** The client names and titles of every study card shown this conversation. */
    private function shownStudies($session): array
    {
        $names = Craft::$app->getCache()->get($this->shownKey($session, 'studies'));

        return is_array($names) ? $names : [];
    }

    /**
     * Is this chip asking to SEE a study whose card is already on screen? "Can I
     * see the Urban work itself?" after the Urban card has shown is a re-ask the
     * panel-level echo terms miss (nothing in it says "case study"). Matched on a
     * viewing verb plus a distinctive word from a shown study's client or title —
     * "urban", "vaiie" — so "tell me more about Urban" (conversation, not a
     * re-show) survives and "show me the Urban project" doesn't.
     */
    private function isShownStudyReask(string $chip, array $shownStudies): bool
    {
        if (!$shownStudies) {
            return false;
        }
        static $viewing = ['see', 'show', 'look', 'view', 'open', 'read', 'browse', 'write-up', 'write up', 'case study', 'the work', 'project'];
        static $generic = ['the', 'and', 'for', 'with', 'design', 'product', 'branding', 'development', 'app', 'website', 'online', 'their', 'your', 'home', 'homes', 'owners', 'sell', 'helping', 'getting', 'putting', 'designing', 'experience', 'easy', 'use', 'that', 'into', 'back', 'front'];
        if (!$this->containsAnyTerm($chip, $viewing)) {
            return false;
        }
        $haystack = ' ' . mb_strtolower($chip) . ' ';
        foreach ($shownStudies as $name) {
            foreach (preg_split('/[^a-z0-9.]+/u', $name) ?: [] as $word) {
                $word = trim($word, '.');
                if (mb_strlen($word) < 4 || in_array($word, $generic, true)) {
                    continue;
                }
                if (preg_match('/(?<![a-z0-9])' . preg_quote($word, '/') . '(?![a-z0-9])/u', $haystack)) {
                    return true;
                }
            }
        }

        return false;
    }

    /** Photo keys the rail has already shown this conversation (see forHandles). */
    private function shownRailKeys($session): array
    {
        $keys = Craft::$app->getCache()->get($this->shownKey($session, 'rail-keys'));
        return is_array($keys) ? $keys : [];
    }

    /** Record photo keys just shown in a rail, so later rails can skip them. */
    private function addShownRailKeys($session, array $keys): void
    {
        if (!$keys) {
            return;
        }
        $merged = array_values(array_unique(array_merge($this->shownRailKeys($session), $keys)));
        Craft::$app->getCache()->set($this->shownKey($session, 'rail-keys'), $merged, self::CACHE_TTL);
    }

    /** Render a site template to a string; failures are logged and swallowed. */
    private function renderComponent(string $template, array $vars): ?string
    {
        try {
            return Craft::$app->getView()->renderTemplate($template, $vars, View::TEMPLATE_MODE_SITE);
        } catch (\Throwable $e) {
            Craft::error('[jonson] render ' . $template . ': ' . $e->getMessage(), __METHOD__);

            return null;
        }
    }

    /**
     * Read a single line from a Guzzle stream body.
     */
    private function readLine(StreamInterface $body): string
    {
        $line = '';
        while (!$body->eof()) {
            $char = $body->read(1);
            if ($char === "\n") {
                return rtrim($line, "\r");
            }
            $line .= $char;
        }

        return rtrim($line, "\r");
    }

    /**
     * Format one Server-Sent Event. The stream closure yields these; Yii
     * echoes and flushes each yielded chunk.
     */
    private function sse(string $event, array $data): string
    {
        return "event: {$event}\ndata: " . json_encode($data) . "\n\n";
    }

    /**
     * SSE error response for early validation failures (before streaming starts).
     */
    /**
     * What the visitor gets when the model can't be reached: the message, the work,
     * and nothing else.
     *
     * NO CHIPS, deliberately. Every chip is a question, and the one thing that cannot
     * answer a question right now is Jonson — a slate of them is an invitation to hit
     * the same wall three more times. The case studies are the opposite: they are
     * ordinary server-rendered links that work whatever Anthropic is doing, so an
     * outage still leaves the visitor somewhere to go.
     *
     * The turn is NOT written to history or the answer cache. Nothing was answered,
     * so there is nothing for the model to carry forward, and caching this would
     * serve it again after the API came back.
     */
    private function outageReply($session, string $question): \Generator
    {
        // The work goes out ONCE per conversation. The follow-up bar is taken away
        // below, so a second outage needs a reload to reach — and a reload restores
        // the thread, which already has the strip in it. Sending it again stacked the
        // entire catalogue twice down the page (measured: 2 turns, 30 cards). The
        // repeat gets the line on its own; they can already see the work.
        $first = $this->markShownOnce($session, 'outage');

        // The marker places the strip beneath the prose through the same path every
        // surface uses. The client does have an end-of-answer append for a panel that
        // finds no paragraph, but its own comment calls that a safety net rather than
        // a path — so give it the paragraph.
        $answer = $this->offlineReply() . ($first ? "\n\n[[casestudies:all]]" : '');

        yield $this->sse('text', ['text' => $answer]);

        $html = $first ? $this->outageStudies($session, $question) : null;
        if ($html !== null) {
            yield $this->sse('casestudies', ['html' => $html]);
        }

        // `apiError` tells the client to take the follow-up bar away (see
        // jonson-ask.js). Same reasoning as the missing chips: the ask bar is an
        // invitation to hit the same wall again. The header logo still wipes the
        // thread, so the visitor isn't stranded.
        yield $this->sse('done', ['answer' => $answer, 'apiError' => true]);
        // The one outcome worth spotting in the reporting without being asked: if this
        // starts appearing, the assistant was down and visitors saw it.
        $this->logTurn('apiError', $answer, [], $first ? ['casestudies'] : []);
    }

    /**
     * The case-study strip for an outage, built through the registry entry rather than
     * rebuilt here — one definition of what that surface is made of, so a change to
     * the selection or the template reaches this path too.
     *
     * `all` hands over the catalogue, but the registry still narrows to a study the
     * visitor named: if they asked about one piece of work and the API fell over, that
     * piece is a better consolation than the whole shelf.
     */
    private function outageStudies($session, string $question): ?string
    {
        foreach ($this->surfaceRegistry() as $surface) {
            if ($surface['handle'] !== 'casestudies') {
                continue;
            }

            $payload = ($surface['data'])($question, 'all', $question, [], $session);
            if (!$payload) {
                return null;
            }
            $present = isset($surface['present']) ? ($surface['present'])($payload, 'all') : 'all';
            $html = $this->renderComponent($surface['template'], [$surface['var'] => $payload, 'modifier' => $present]);
            if ($html === null) {
                return null;
            }

            // Record WHICH studies went on screen, so a chip after a successful retry
            // can't offer one straight back. Deliberately NOT markShownOnce: the slot
            // stays unclaimed, because a real answer to their actual question deserves
            // its own cards rather than being skipped as already-shown.
            if (isset($surface['onShown'])) {
                ($surface['onShown'])($payload, $session);
            }

            return $html;
        }

        return null;
    }

    /**
     * The outage message, from the CMS if it's been set. Same three fallbacks as
     * junkReply(): no entry, no field on the layout, or an empty field.
     */
    private function offlineReply(): string
    {
        return $this->homeText(self::OFFLINE_REPLY_FIELD, self::OFFLINE_REPLY);
    }

    /**
     * What Jonson says to something that isn't a question.
     *
     * Editable on the Home single, in a plain-text field handled `jonsonShortQuestion`
     * (Home rather than Personality: the persona single feeds the MODEL, and this text
     * never reaches it — it is what gets sent when no model call happens at all).
     * Falls back to the constant on all three ways it can be unavailable: no entry, the
     * field not on the layout, or the field left empty. A visitor must never get a
     * blank answer because a field was cleared.
     *
     * Read per request rather than cached: this path only runs when someone typed a
     * non-question, which is rare, and one entry query is far cheaper than the API
     * call it replaced.
     */
    private function junkReply(): string
    {
        return $this->homeText(self::JUNK_REPLY_FIELD, self::JUNK_REPLY);
    }

    /**
     * Record this turn. Called at each of the points a turn can finish — the real
     * answer and the five paths that cost no API call — so a question that was never
     * really answered can be told from one that was.
     *
     * AFTER the answer has gone out, always. A visitor waits for their reply, not for
     * a reporting write, and the service swallows its own failures so a broken table
     * can never cost someone an answer.
     *
     * Guarded against double-counting: several of these paths sit inside the same
     * generator and it is not safe to assume each one returns.
     */
    private function logTurn(string $outcome, string $answer, array $chips = [], array $surfaces = []): void
    {
        if ($this->logDone || $this->logSid === '') {
            return;
        }
        // Set BEFORE the budget check, so a dropped write is still "handled" and no
        // later completion point in this request tries again.
        $this->logDone = true;

        // Bounds the WRITE, never the answer. By the time logTurn runs the visitor has
        // already been served, so a dropped row costs them nothing — it costs only a
        // line in the stats, which is the right thing to sacrifice when someone is
        // hammering the endpoint hard enough to be writing 200 rows an hour.
        if (!$this->withinLogBudget()) {
            return;
        }

        $vip = Jonson::getInstance()->vip->current();

        Jonson::getInstance()->analytics->recordTurn(
            $this->logSid,
            [
                'question' => $this->logQuestion,
                'outcome' => $outcome,
                'fromChip' => $this->logFromChip,
                'chipsOffered' => $chips,
                'surfaces' => array_values(array_unique($surfaces)),
                'pageUrl' => $this->logPageUrl,
                // Words, not characters: the useful read is "are answers getting long
                // and waffly", and that is a word count in any language worth counting.
                'answerWords' => $answer === '' ? null : count(preg_split('/\s+/u', trim($answer)) ?: []),
                'ms' => (int) round((microtime(true) - $this->logStartedAt) * 1000),
                // The wait, as opposed to the duration. Null when nothing was ever
                // streamed — see the migration.
                'ttftMs' => $this->logFirstTokenAt === 0.0
                    ? null
                    : (int) round(($this->logFirstTokenAt - $this->logStartedAt) * 1000),
                'inTokens' => $this->logInTokens,
                'cacheReadTokens' => $this->logCacheRead,
                'cacheWriteTokens' => $this->logCacheWrite,
                'outTokens' => $this->logOutTokens,
            ],
            [
                'cid' => (string) $this->request->getBodyParam('cid', ''),
                'originUrl' => $this->logPageUrl,
                // The entry whose ask bar opened this conversation — null on the
                // homepage front door, which has no entry behind it.
                'originEntryId' => $this->pageFrom,
                'vipId' => $vip?->id,
                'promptUses' => $this->logPromptUses,
            ],
        );
    }

    /** The editable line shown when an IP has asked too much, too fast. */
    private function rateLimitReply(): string
    {
        return $this->homeText(self::RATE_REPLY_FIELD, self::RATE_REPLY);
    }

    /**
     * Has this IP got allowance left? Counts up in Craft's cache over a rolling window
     * — the same shape CrmController uses for form submissions.
     *
     * A VIP gets a much higher ceiling — NOT an exemption, which is what this was.
     * The door is a link sent to one person, and a link's ordinary lifecycle is to be
     * forwarded: whoever opens it then holds a 30-day cookie, so "no limit" meant an
     * unbounded endpoint reachable by anyone the URL reached. It can't be FORGED (the
     * cookie is signed, and current() re-resolves it to a live entry every request, so
     * disabling the entry revokes it) — sharing is the whole risk, and sharing is not
     * an attack, just what happens to links.
     *
     * 150 an hour is far above human behaviour, so the person the door was made for
     * still never meets a wall — which was the entire point of the exemption — while a
     * leaked door costs a bounded amount instead of an open-ended one.
     *
     * devMode is still a true exemption: local work would otherwise throttle itself
     * after thirty questions, and the surfacing suite alone spends more than that in a
     * single run.
     *
     * Fails OPEN: if the cache is unavailable the question goes through. A limiter
     * that silences the site when its own bookkeeping breaks is worse than the loop
     * it is guarding against.
     */
    /**
     * Is this IP still within its analytics-write budget?
     *
     * The same INCR-with-fallback shape as withinRateLimit() below, and the same
     * reasons for it — read that one's comments for why there are two keys and why the
     * two windows differ. What differs here is only what it is protecting.
     *
     * SEPARATE KEYS AGAIN, and not shared with the rate limiter's: these count
     * different events (every logged turn, versus only the ones that reach the API), so
     * one counter could not answer both questions.
     *
     * FAILS OPEN, like the limiter. A cache outage should cost statistics, not
     * correctness — and the disk exposure during one is no worse than it was before
     * this existed.
     */
    private function withinLogBudget(): bool
    {
        if (Craft::$app->getConfig()->getGeneral()->devMode) {
            return true;
        }

        try {
            $cache = Craft::$app->getCache();
            $ip = md5((string) Craft::$app->getRequest()->getUserIP());
            $key = 'jonson-log:' . $ip;
            $fallbackKey = 'jonson-log-files:' . $ip;

            $counted = $cache instanceof ResilientRedisCache
                ? $cache->increment($key, self::RATE_WINDOW)
                : null;

            if ($counted !== null) {
                if ($counted > self::LOG_LIMIT) {
                    // Logged once per turn it drops, which is itself bounded: the thing
                    // that trips this is by definition already being counted.
                    Craft::info(sprintf('analytics write budget reached for this IP (%d/%d), row dropped', $counted, self::LOG_LIMIT), 'jonson.rate');

                    return false;
                }

                return true;
            }

            $count = (int) ($cache->get($fallbackKey) ?: 0);
            if ($count >= self::LOG_LIMIT) {
                Craft::info(sprintf('analytics write budget reached for this IP (%d/%d), row dropped', $count, self::LOG_LIMIT), 'jonson.rate');

                return false;
            }
            $cache->set($fallbackKey, $count + 1, self::RATE_WINDOW);
        } catch (\Throwable $e) {
            Craft::warning('[jonson] analytics write budget unavailable: ' . $e->getMessage(), __METHOD__);
        }

        return true;
    }

    private function withinRateLimit(): bool
    {
        if (Craft::$app->getConfig()->getGeneral()->devMode) {
            return true;
        }

        $limit = $this->isVip() ? self::RATE_LIMIT_VIP : self::RATE_LIMIT;

        try {
            $cache = Craft::$app->getCache();
            // One counter per IP, NOT per door: the ceiling that applies is whichever
            // the current visitor qualifies for. So a VIP's own questions still count
            // toward the stricter number a later non-VIP on that IP is held to, which
            // is the safe way round — the alternative would let a door launder an
            // unlimited allowance onto a shared address.
            $ip = md5((string) Craft::$app->getRequest()->getUserIP());

            // TWO KEYS, one per strategy, and they must never be the same one.
            //
            // INCR writes a BARE INTEGER; Cache::set() writes a SERIALIZED value. Point
            // both at one key and a Redis flap mid-window corrupts the counter in
            // whichever direction it flaps: get() can't unserialize "3" so it reads as
            // no value and resets the count to 1, and INCR on a serialized string is a
            // Redis error. Measured before this was split — three questions against a
            // ceiling of two, and the third went through.
            //
            // Separate keys means the two counters are independent, so a flap loses
            // count rather than corrupting it. That only matters while Redis is
            // actually flapping, which is exactly when approximate is fine.
            $key = 'jonson-rate:' . $ip;
            $fallbackKey = 'jonson-rate-files:' . $ip;

            // ATOMIC where it can be. get()-then-set() is a read-modify-write: two
            // requests landing together both read 29 and both write 30, so one slips
            // past the ceiling. Redis INCR closes that. It returns null when Redis
            // isn't behind the cache — not configured, or already degraded to files
            // this request — and then the read-modify-write below is what we have; a
            // counter that is occasionally out by one is much better than a limiter
            // that stops working when Redis does.
            //
            // NOTE THE DIFFERENT WINDOWS, which is a real behavioural difference and
            // not an oversight:
            //
            //   INCR       EXPIRE is set only when the counter is created, so the hour
            //              runs from the FIRST counted question.
            //   get/set    every set() rewrites the TTL, so the hour runs from the LAST
            //              counted question.
            //
            // Either is defensible and both cap throughput at the ceiling per hour. The
            // INCR form is the stricter read (the window can't creep forward), and it
            // is the one that will actually run in production.
            //
            // A blocked attempt is not a counted turn under either — the ceiling check
            // returns before anything is written — so retrying never extends the wait.
            // Verified on the get/set path with a 15s window: two blocked retries at
            // 0.7s and 5.9s, then answered again at 16.7s. That is deliberate; the
            // alternative punishes a real person who tries twice at minute 55 with a
            // fresh hour, and buys nothing against a script, whose throughput is capped
            // either way.
            $counted = $cache instanceof ResilientRedisCache
                ? $cache->increment($key, self::RATE_WINDOW)
                : null;

            if ($counted !== null) {
                // INCR already counted this turn, so the ceiling test is against the
                // value it returned: the Nth question through is allowed, the N+1th is
                // not. Nothing to write — the increment WAS the write.
                //
                // A blocked attempt DOES increment here, unlike the fallback below,
                // because the count happens before the decision. Harmless: EXPIRE is
                // set only when the counter is created, so the window still runs from
                // the first question and hammering cannot push the expiry out. It just
                // means the number in the log keeps climbing past the ceiling, which is
                // a fair record of how hard someone is trying.
                if ($counted > $limit) {
                    Craft::info(sprintf('rate limit reached for this IP (%d/%d), no API call', $counted, $limit), 'jonson.rate');

                    return false;
                }

                return true;
            }

            $count = (int) ($cache->get($fallbackKey) ?: 0);
            if ($count >= $limit) {
                Craft::info(sprintf('rate limit reached for this IP (%d/%d), no API call', $count, $limit), 'jonson.rate');

                return false;
            }
            $cache->set($fallbackKey, $count + 1, self::RATE_WINDOW);
        } catch (\Throwable $e) {
            Craft::warning('[jonson] rate limiter unavailable: ' . $e->getMessage(), __METHOD__);
        }

        return true;
    }

    /**
     * One editable line of Jonson's copy from the Home single, or the fallback.
     *
     * Falls back on all three ways the field can be unavailable — no entry, the field
     * not on the layout, an empty field — because each of them otherwise ends with a
     * visitor reading a blank answer bubble.
     */
    private function homeText(string $handle, string $fallback): string
    {
        $entry = Entry::find()->section('homepage')->one();
        if (!$entry?->getFieldLayout()?->getFieldByHandle($handle)) {
            return $fallback;
        }

        return trim((string) $entry->getFieldValue($handle)) ?: $fallback;
    }

    /**
     * Is this not a question, but a keypress? The three shapes that reach the box and
     * cannot be answered by anything — checked server-side because that is the only
     * side that can't be bypassed by posting the endpoint directly.
     *
     * Deliberately NOT a keyboard-mash test. "asdfgh" is catchable, but every rule
     * that catches it also catches real short questions in other languages or with
     * unusual spelling, and a false positive here tells a genuine visitor their
     * question is nonsense. These three are unambiguous; that is the whole bar.
     */
    private function looksLikeJunk(string $question): bool
    {
        // Two characters, not three: "Hi" is a real opener the surfacing suite covers.
        if (mb_strlen($question) < 2) {
            return true;
        }

        // Nothing to answer without a letter somewhere — "...", "123", "!!!".
        if (!preg_match('/\\p{L}/u', $question)) {
            return true;
        }

        // One letter held down. Counted as DISTINCT letters rather than by looking for
        // runs, so "aaa", "aAaAa" and "a a a" all land here while "hi", "ok" and
        // "hmm" survive on two.
        $letters = preg_replace('/[^\\p{L}]/u', '', mb_strtolower($question)) ?? '';
        $distinct = array_unique(preg_split('//u', $letters, -1, PREG_SPLIT_NO_EMPTY) ?: []);

        return count($distinct) < 2;
    }

    private function sendSseError(string $message): Response
    {
        $response = Craft::$app->getResponse();
        $response->format = Response::FORMAT_RAW;
        $response->getHeaders()->set('Content-Type', 'text/event-stream');
        $response->getHeaders()->set('Cache-Control', 'no-cache');
        $response->content = "event: error\ndata: " . json_encode(['message' => $message]) . "\n\n";

        return $response;
    }
}
