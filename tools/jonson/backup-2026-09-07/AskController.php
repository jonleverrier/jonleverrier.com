<?php

namespace modules\jonson\controllers;

use Craft;
use craft\helpers\App;
use craft\web\Controller;
use craft\web\View;
use GuzzleHttp\Client;
use modules\jonson\Jonson;
use modules\jonson\services\Spotify;
use Psr\Http\Message\StreamInterface;
use yii\web\Response;

/**
 * Front-end "ask me anything" endpoint. Public + anonymous.
 *
 * Streams Claude's reply to the browser as Server-Sent Events. The Claude call
 * is server-side (Guzzle) so the API key never reaches the client. Claude can
 * call the `find_context` tool mid-answer to surface real photos/content; when
 * it does, the matched items are rendered as a rail and pushed as a `context`
 * event for the front-end to slot in after the first paragraph.
 */
class AskController extends Controller
{
    protected int|bool|array $allowAnonymous = true;

    private const HISTORY_PREFIX = 'jonson-history'; // per-session conversation (AI prompt), Craft cache
    private const FROM_PREFIX = 'jonson-from'; // per-conversation: the note/study the opener was asked from
    private const PAGE_CONTEXT_CHARS = 7000; // how much of the page's own text rides along

    /** The entry id of the page this conversation was opened from, if any (see pageContextPrompt). */
    private ?int $pageFrom = null;
    private const VIP_CONTEXT_CHARS = 6000; // how much of a VIP's note rides along (see vipPrompt)
    private const TRANSCRIPT_PREFIX = 'jonson-transcript'; // per-session full transcript (uncapped) for lead capture
    private const ANSWER_PREFIX = 'jonson-answer'; // cached answer bundle per session+question
    private const CACHE_TTL = 10800; // 3h, refreshed each turn — covers any real session
    // Every modifier any marker can carry. Used only to clear the once-per-conversation
    // slots a variant can claim (see panelSlot / resetShownOnce) — keep in step with
    // the modifiers the directives actually tell the model to emit.
    private const PANEL_MODIFIERS = ['all'];
    private const REPEAT_REPLY = 'You’ve already asked me that one — is there something else I can help you with?';
    private const MAX_MESSAGE_PAIRS = 50; // ceiling only (to bound abuse) — effectively the whole chat
    private const MAX_TURNS = 4; // cap the tool loop
    private const MAX_SUGGESTIONS = 3; // "where next?" prompt chips per answer — a cap, not a floor
    private const MUSIC_STRIP_MAX = 6; // latest N artists shown in the [[music]] strip

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

        // Is this a follow-up within the live thread (a genuine repeat → nudge),
        // or a fresh opener (a repeat → replay the cached answer)? The client
        // flags it; anything but an explicit "1" is treated as an opener.
        $continuation = $this->request->getBodyParam('continuation') === '1';

        // Which page the question was asked from, when it came through a note's or
        // case study's ask bar (the handoff posts the entry id once, on the
        // opener). Remembered for the thread, so a follow-up still knows what
        // "the plugin" is; a fresh opener with no page forgets it.
        $from = (int) $this->request->getBodyParam('from', 0);

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

        // Tell the model when to surface the ways-to-connect buttons ([[contact]]).
        $contactPrompt = $this->contactPrompt();
        if ($contactPrompt !== '') {
            $system .= "\n\n" . $contactPrompt;
        }

        // Turn-aware lead-gen nudge: the deeper into the conversation, the more the
        // [[next:]] onward prompts should lean toward the work / working together
        // rather than looping on generic get-to-know-you questions. Shapes only the
        // prompts, not the reply's voice.
        $funnelNudge = $this->funnelNudgePrompt($session);
        if ($funnelNudge !== '') {
            $system .= "\n\n" . $funnelNudge;
        }

        // The page the question came from, if any — its text, in full, so the
        // question is read against it.
        $pageContext = $this->pageContextPrompt();
        if ($pageContext !== '') {
            $system .= "\n\n" . $pageContext;
        }

        // Who they are, if they came through a VIP link (the cookie set at
        // /vip/{slug}) — Jon's private note on the person/company, so the answers
        // are tailored from the first word, for the whole visit.
        $vipContext = $this->vipPrompt($session);
        if ($vipContext !== '') {
            $system .= "\n\n" . $vipContext;
        }

        // The grounding rule for the onward prompts, restated last so it's fresh on
        // every turn (openers included, which the funnel nudge skips): the model
        // tends to drop the citations on answers busy with other markers, and an
        // uncited prompt is discarded server-side (see groundedPrompts).
        $system .= "\n\nREMINDER: every prompt in your closing [[next: …]] marker must end with its "
            . 'citation (`@note:id`, `@study:id`, `@photo:handle`, `@sector:name`, `@client:name`, '
            . 'or a standing topic such as `@contact`, `@method`, `@work`, `@cv`, `@music`, `@about`). '
            . 'A prompt without a citation is discarded before the visitor sees it; a prompt you '
            . 'cannot cite is one to leave out.';

        $response = Craft::$app->getResponse();
        $response->format = Response::FORMAT_RAW;
        $headers = $response->getHeaders();
        $headers->set('Content-Type', 'text/event-stream');
        $headers->set('Cache-Control', 'no-cache');
        $headers->set('X-Accel-Buffering', 'no'); // don't let nginx buffer the stream

        $response->stream = function () use ($apiKey, $model, $system, $messages, $question, $session, $tools, $continuation) {
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

                return;
            }

            $client = new Client(['timeout' => 120, 'http_errors' => false]);
            $busyMessage = 'I’m getting more questions than I can keep up with right now — give me a moment and try again.';
            $genericMessage = 'Sorry — something went wrong. Please try again.';

            $convo = $messages; // grows as tools are called
            $answer = '';
            $errored = false;
            // Fast mode is an Anthropic research-preview opt-in — off unless the
            // account has it enabled and KEY_ANTHROPIC_FAST is truthy. (Attempting
            // it without access just 429s and wastes a round-trip.)
            $useFast = filter_var(App::env('KEY_ANTHROPIC_FAST'), FILTER_VALIDATE_BOOLEAN);

            for ($turn = 0; $turn < self::MAX_TURNS; $turn++) {
                // Continuing after a tool call: keep the resumed text from jamming
                // onto the previous sentence — separate it as a new paragraph.
                if ($turn > 0 && $answer !== '' && !preg_match('/\s$/', $answer)) {
                    yield $this->sse('text', ['text' => "\n\n"]);
                    $answer .= "\n\n";
                }

                try {
                    // Delegates: yields `text` SSE events, returns the turn's
                    // assembled content blocks + stop reason (or an error flag).
                    // Fast mode (opt-in via KEY_ANTHROPIC_FAST) with a fallback to
                    // standard speed if it fails before any output streamed.
                    $result = yield from $this->streamTurn($client, $apiKey, $model, $system, $convo, $tools, $useFast);
                    if ($useFast && !empty($result['error']) && !empty($result['canRetry'])) {
                        $result = yield from $this->streamTurn($client, $apiKey, $model, $system, $convo, $tools, false);
                    }
                } catch (\Throwable $e) {
                    Craft::error('[jonson] ' . $e->getMessage(), __METHOD__);
                    $result = ['error' => 'busy'];
                }

                if (!empty($result['error'])) {
                    yield $this->sse('error', ['message' => $result['error'] === 'busy' ? $busyMessage : $genericMessage]);
                    $errored = true;
                    break;
                }

                $blocks = $result['blocks'] ?? [];
                foreach ($blocks as $block) {
                    if (($block['type'] ?? '') === 'text') {
                        $answer .= $block['text'];
                    }
                }

                // Not a tool call → the answer is complete.
                if (($result['stop'] ?? '') !== 'tool_use') {
                    break;
                }

                // Run each find_context call, push a rail, feed results back.
                $convo[] = ['role' => 'assistant', 'content' => $blocks];
                $toolResults = [];
                foreach ($blocks as $block) {
                    if (($block['type'] ?? '') !== 'tool_use' || ($block['name'] ?? '') !== 'find_context') {
                        continue;
                    }

                    // Photos only — the rail is a personal-photography strip; work
                    // content (case studies etc.) is surfaced elsewhere, never here.
                    //
                    // Grounded in the CONVERSATION, not in the model's query. The
                    // query is the model's claim of what's being discussed, and it
                    // reaches for whatever the inventory offers: asked about Japan,
                    // with no Japan photos to show, it asked for "street-photo" and
                    // the rail showed Bordeaux and Jersey. So the photos come from
                    // the places/themes actually named in the question and the
                    // answer so far — the same scan the post-pass below runs — and
                    // the query only adds order. Nothing named → nothing shown.
                    // …and only when the QUESTION is the kind the rail answers (see
                    // isPhotoQuestion): a place named in passing by an answer about
                    // something else — "a record label for a friend on Jersey" in an
                    // answer about logos — is not a cue for travel photos.
                    $ctx = Jonson::getInstance()->findContext;
                    $named = $this->isPhotoQuestion($question) || $this->mentionsPhotography($answer)
                        ? $ctx->handlesInText($question . ' ' . $answer)
                        : [];
                    $items = $named
                        ? $ctx->forHandles($named, $this->shownRailKeys($session))
                        : [];

                    if ($items) {
                        $html = $this->renderRail($items);
                        if ($html !== null) {
                            yield $this->sse('context', ['html' => $html]);
                            // Remember them, so the post-pass on the finished answer
                            // doesn't push the same photos a second time.
                            $this->addShownRailKeys($session, $ctx->itemKeys($items));
                        }
                    }

                    $toolResults[] = [
                        'type' => 'tool_result',
                        'tool_use_id' => $block['id'],
                        'content' => $items
                            ? count($items) . ' item(s) are now shown to the visitor alongside your reply. '
                                . 'Do NOT mention, describe, or refer to these images — carry on with your answer as if they appeared on their own.'
                            : 'Nothing matched. Show and say nothing about it.',
                    ];
                }
                $convo[] = ['role' => 'user', 'content' => $toolResults];
            }

            if ($answer === '' && !$errored) {
                yield $this->sse('error', ['message' => $busyMessage]);
            }

            // Resolve the context rail. The client buffers the whole answer,
            // strips the markers, and reveals text + rail composed together.
            $railHtml = null;
            $panels = []; // handle => rendered html, for the cache bundle + replay
            $panelSlots = []; // handle => once-slot claimed, so a replay claims the same
            $suggestions = [];
            if ($answer !== '' && !$errored) {
                $clean = $this->stripMarkers($answer);

                // Explicit [[handle]] markers the model placed — precise + ordered.
                // A marker may carry a modifier: [[handle:modifier]]. Only the model
                // knows whether the visitor asked to browse or asked for everything,
                // so the modifier is how it says which — there's no intent classifier
                // to infer it. Currently used by [[casestudies:all]].
                $markerHandles = [];
                $markerModifiers = []; // handle => modifier
                if (preg_match_all('/\[\[([a-z0-9][a-z0-9-]*)(?::([a-z0-9-]+))?\]\]/i', $answer, $matches, PREG_SET_ORDER)) {
                    foreach ($matches as $m) {
                        $handle = strtolower($m[1]);
                        $markerHandles[] = $handle;
                        if (($m[2] ?? '') !== '') {
                            $markerModifiers[$handle] = strtolower($m[2]);
                        }
                    }
                }

                // Resolve every surfaceable panel from one registry. A panel shows
                // when the model marked it with [[handle]]. Each shows at most once
                // per conversation. The handle is the SSE event name.
                $registry = $this->panelRegistry();
                foreach ($registry as $panel) {
                    $handle = $panel['handle'];
                    // No block twice in one response: $panels records every handle
                    // emitted this turn, so a duplicate registry entry — or any other
                    // path that already emitted this handle — is skipped here. The
                    // invariant is enforced, not merely implied by the single pass.
                    // (hasShownOnce is the separate cross-turn guard.)
                    //
                    // The cross-turn guard is per SLOT, not per handle: a variant is a
                    // different panel and claims its own (see panelSlot). Within one
                    // response it's still one block per handle — two case study panels
                    // in a single answer would be noise however they differ.
                    $slot = $this->panelSlot($handle, $markerModifiers[$handle] ?? null);
                    if (isset($panels[$handle]) || $this->hasShownOnce($session, $slot)) {
                        continue;
                    }

                    if (!in_array($handle, $markerHandles, true)) {
                        continue;
                    }

                    // Music is a personality beat, not a Q&A lookup: it surfaces
                    // whenever the model places [[music]] in a getting-to-know-you
                    // answer (like the photo rail on a "tell me about yourself"), not
                    // only on an explicit "what do you listen to?". The once-per-
                    // conversation guard keeps it to a single reveal, and the directive
                    // already limits placement to genuine personality/music moments.
                    // Deterministic guard: the process timeline is off-topic when
                    // the answer is really about clients or sectors — an over-placed
                    // [[method]] marker on a work/experience answer. Clients/sectors
                    // precede method in the registry, so they're resolved by now.
                    if ($handle === 'method' && (isset($panels['clients']) || isset($panels['sectors']))) {
                        continue;
                    }

                    // Pass the question + clean answer, so relevance matching (e.g.
                    // the testimonial's named-client match) still fires when the
                    // answer refers to the client by pronoun but the question named it.
                    // Second arg is the marker's modifier (null when there wasn't one).
                    // Registry closures that don't care simply don't declare it — PHP
                    // ignores surplus positional args to userland functions.
                    $modifier = $markerModifiers[$handle] ?? null;
                    // "Show me your logos" is a targeted ask however the model marked
                    // it: when the visitor's own words name a study (client, title or
                    // sector), `:all` gives way to the relevant selection — the whole
                    // catalogue scrolling past is the wrong answer to it. The QUESTION
                    // only: an answer that name-drops a client must not narrow a
                    // genuine "show me everything".
                    if ($handle === 'casestudies' && $modifier === 'all'
                        && Jonson::getInstance()->findContext->studiesNamedIn($question)
                    ) {
                        $modifier = null;
                    }
                    $payload = ($panel['data'])($question . ' ' . $clean, $modifier, $question);
                    if (!$payload) {
                        continue;
                    }
                    // More than a couple of studies is a strip, not a stack of feature
                    // cards — the marquee is the presentation for a set, however it
                    // was arrived at.
                    if ($handle === 'casestudies' && count($payload) > 2) {
                        $modifier = 'all';
                    }
                    // `modifier` goes to every panel template (null when the marker
                    // carried none), so a panel can present the same data
                    // differently — [[casestudies:all]] renders a marquee where the
                    // plain marker renders the grid.
                    $html = $this->renderComponent($panel['template'], [
                        $panel['var'] => $payload,
                        'modifier' => $markerModifiers[$handle] ?? null,
                    ]);
                    if ($html === null) {
                        continue;
                    }

                    $this->markShownOnce($session, $slot);
                    if ($handle === 'casestudies') {
                        // Which studies are on screen now — so a later chip can't
                        // offer to "show" one of them again (see suggestionsFor).
                        $this->rememberShownStudies($session, $payload);
                    }
                    $panels[$handle] = $html;
                    // Which slot this panel claimed, so a cached replay can claim the
                    // same one. $panels stays keyed by handle because the handle is
                    // the SSE event name the client listens on.
                    $panelSlots[$handle] = $slot;
                    yield $this->sse($handle, ['html' => $html]);
                }

                // Deterministic music fallback. The model marks [[music]] reliably
                // on an opener but drops it on follow-ups, so the strip was position-
                // dependent. If the visitor's QUESTION is genuinely about music and
                // it hasn't shown this conversation, surface it anyway — like the
                // photo rail's text-scan. Gated on the QUESTION (not a passing answer
                // mention) so it never appears out of context; the once-per-convo
                // guard keeps it from showing twice.
                if (!isset($panels['music'])
                    && !$this->hasShownOnce($session, 'music')
                    && $this->isMusicQuestion($question)
                ) {
                    foreach ($registry as $p) {
                        if ($p['handle'] !== 'music') {
                            continue;
                        }
                        $payload = ($p['data'])($question . ' ' . $clean);
                        $html = $payload ? $this->renderComponent($p['template'], [$p['var'] => $payload]) : null;
                        if ($html !== null) {
                            $this->markShownOnce($session, 'music');
                            $panels['music'] = $html;
                            yield $this->sse('music', ['html' => $html]);
                        }
                        break;
                    }
                }

                // Deterministic contact fallback. When the visitor's QUESTION is an
                // explicit "how do we start / get in touch / work together" ask, the
                // ways-to-connect CTA must show — that's the whole point of the site.
                // Fire it even if the model dropped the [[contact]] marker, and even
                // if a softer contact beat showed earlier (exempt from the once-per-
                // conversation guard): someone explicitly asking how to begin should
                // never be left without the button. This also suppresses the "where
                // next?" chips (see below), so a ready-to-act visitor isn't nudged to
                // keep chatting.
                // Deterministic case-study fallback. When the visitor's QUESTION
                // names a study outright — a client, a study's own title, a sector
                // — the cards must follow whether or not the model placed the
                // marker; "can you show other logos you've designed?" with no card
                // is the site failing at the one thing it's for. Once per
                // conversation, like the marker path.
                if (!isset($panels['casestudies'])
                    && !$this->hasShownOnce($session, 'casestudies')
                    && Jonson::getInstance()->findContext->studiesNamedIn($question)
                ) {
                    foreach ($registry as $p) {
                        if ($p['handle'] !== 'casestudies') {
                            continue;
                        }
                        $payload = ($p['data'])($question . ' ' . $clean, null, $question);
                        $html = $payload ? $this->renderComponent($p['template'], [$p['var'] => $payload, 'modifier' => count($payload) > 2 ? 'all' : null]) : null;
                        if ($html !== null) {
                            $this->markShownOnce($session, 'casestudies');
                            $this->rememberShownStudies($session, $payload);
                            $panels['casestudies'] = $html;
                            yield $this->sse('casestudies', ['html' => $html]);
                        }
                        break;
                    }
                }
                if (!isset($panels['contact']) && $this->isContactQuestion($question)) {
                    foreach ($registry as $p) {
                        if ($p['handle'] !== 'contact') {
                            continue;
                        }
                        $payload = ($p['data'])($question . ' ' . $clean);
                        $html = $payload ? $this->renderComponent($p['template'], [$p['var'] => $payload]) : null;
                        if ($html !== null) {
                            $this->markShownOnce($session, 'contact');
                            $panels['contact'] = $html;
                            yield $this->sse('contact', ['html' => $html]);
                        }
                        break;
                    }
                }

                // Photo rail: the places/themes the CONVERSATION names — a
                // deterministic scan of the question and the answer against the
                // photo inventory's labels — minus the panel handles resolved above,
                // which aren't rail items. The model's [[markers]] can put a place
                // first but can never add one the text doesn't name: handed the
                // inventory, the model will mark whatever it offers ("street-photo"
                // on a Japan answer, because there are no Japan photos), and the
                // rail must not follow it there. Nothing named → no rail.
                // And only for a question the rail is FOR — one that names a place or
                // theme the photos cover, or is about travel or photography (see
                // isPhotoQuestion). An answer about anything else may name a place
                // in passing ("…for an old friend on Jersey", in an answer about
                // logos), and that is not the conversation being about the place.
                $panelHandles = array_column($registry, 'handle');
                // The gate opens on the QUESTION (it asks about a place, travel or
                // photos) or on an ANSWER that talks about photography itself — the
                // intro ("I'm obsessed with street photography… Jersey… Brighton") is
                // the rail's canonical moment, and gating on the question alone lost
                // it. A passing place name on a work answer ("a record label for a
                // friend on Jersey") still opens nothing: no photo word, no rail.
                $textHandles = $this->isPhotoQuestion($question) || $this->mentionsPhotography($clean)
                    ? Jonson::getInstance()->findContext->handlesInText($question . ' ' . $clean)
                    : [];
                $markerHandles = array_values(array_filter(
                    $markerHandles,
                    static fn($h) => !in_array($h, $panelHandles, true) && in_array($h, $textHandles, true),
                ));
                $handles = array_values(array_unique(array_merge($markerHandles, $textHandles)));

                // The photo rail is personal photography — off-topic when the answer
                // is about work. If a work panel (clients/sectors/method) is showing,
                // suppress the rail, so e.g. a "Jersey Finance" mention can't surface
                // personal Jersey travel photos on a client/brands answer.
                $hasWorkPanel = (bool) array_intersect(['clients', 'sectors', 'method', 'casestudies'], array_keys($panels));

                // Also a work answer when it names a known client but the model
                // placed no [[clients]] marker (e.g. "redesigned HSBC and Lloyds'
                // sites") — a place mention like "Jersey" there is work geography,
                // not a travel-photo cue, so the personal rail stays suppressed.
                $isWorkAnswer = $hasWorkPanel
                    || Jonson::getInstance()->findContext->mentionsClient($question . ' ' . $clean);

                if ($handles && !$isWorkAnswer) {
                    // Exclude photos already shown in an earlier rail this
                    // conversation, so a repeat travel-flavoured question surfaces
                    // only new photos (or nothing) rather than the same set again.
                    $ctx = Jonson::getInstance()->findContext;
                    $items = $ctx->forHandles($handles, $this->shownRailKeys($session));
                    if ($items) {
                        $railHtml = $this->renderRail($items);
                        if ($railHtml !== null) {
                            yield $this->sse('context', ['html' => $railHtml]);
                            $this->addShownRailKeys($session, $ctx->itemKeys($items));
                        }
                    }
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
                        $html = $payload ? $this->renderComponent($p['template'], [$p['var'] => $payload]) : null;
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

            // Best-effort: persist the text exchange for follow-up context.
            // Store the clean prose (markers stripped) so history stays readable.
            if ($answer !== '') {
                $clean = $this->stripMarkers($answer);

                $history = Craft::$app->getCache()->get($this->historyKey($session));
                if (!is_array($history)) {
                    $history = [];
                }
                $history[] = ['role' => 'user', 'content' => $question];
                $history[] = ['role' => 'assistant', 'content' => $clean];
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
                // The system prompt is large and byte-stable per unchanged CMS
                // content, and identical for every visitor (it's all about Jon,
                // never the asker). Mark it as a cache breakpoint so Anthropic
                // serves the prefix from cache (~0.1× input cost, faster first
                // token) instead of re-processing it every turn. 1h TTL keeps the
                // shared prefix warm across gaps between visitors; a content edit
                // changes the bytes and transparently re-keys the cache.
                'system' => [[
                    'type' => 'text',
                    'text' => $system,
                    'cache_control' => ['type' => 'ephemeral', 'ttl' => '1h'],
                ]],
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

        return 'Things you can show the visitor. When you mention one of these, place its '
            . "handle inline immediately after you name the thing — the word first, then its "
            . "handle with no space, like `word[[handle]]` (a place you name would read "
            . "`‹that place›[[‹that-place›]]`). Use only these handles, never invent one:\n"
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
                $s['sectors'] ? '[' . implode(', ', $s['sectors']) . ']' : '',
                $s['skills'] ? '{' . implode(', ', $s['skills']) . '}' : '',
            ]);
            $note = $s['jonsonSummary'] !== '' ? $s['jonsonSummary'] : $s['summary'];
            // The same title the cards and the study's own page show. The model uses
            // these names in prose, so naming a project here by anything a visitor
            // won't see teaches it a name that exists nowhere on the site. The
            // description travels in the summary below, not in the title.
            $lines[] = '- ' . $s['title'] . ($meta ? ' ' . implode(' ', $meta) : '')
                . (!empty($s['slug']) ? ' [study:' . $s['slug'] . ']' : '') // cite as @study:slug in a [[next:]] prompt
                . ($note !== '' ? ': ' . $note : '');
        }

        return "Your case studies — full write-ups of specific projects the visitor can open "
            . "(PRIVATE background: use it to speak concretely, never read it out verbatim):\n"
            . implode("\n", $lines) . "\n"
            . 'Place a `[[casestudies]]` marker at the end of the relevant sentence or paragraph '
            . 'WHENEVER a study of yours fits what the visitor is asking about — the cards let them '
            . 'open the actual work. That includes: asking to see your work/portfolio/examples; asking '
            . 'HOW you\'ve worked in a particular sector or area, or WHETHER you\'ve done a certain kind '
            . 'of project ("how have you worked in events?", "have you done fintech?", "any e-commerce '
            . 'experience?"); when they\'re getting a feel for whether you\'re the right fit — ANY question '
            . 'about why they should choose you, what sets you apart or makes you different, why they should '
            . 'hire you, what you\'re like to work with, or whether you\'ve handled their kind of thing — '
            . 'point them at a relevant study, because the actual work and the way you thought '
            . 'through it says far more than any self-description, and lets your personality and experience '
            . 'come through (a client quote can sit alongside it); or any '
            . 'time you\'re genuinely pointing them at concrete work. If a study fits what they\'re '
            . 'actually asking about, showing it beats only telling them. BUT do NOT place the marker '
            . 'on reflective or personal questions where they\'re just getting to know you — what you '
            . 'enjoy about the work, what you\'re proud of, how you got started, your interests, or any '
            . 'casual chat about you as a person. Those are conversation, not a request to see work, and '
            . 'dropping a case-study card into one reads as a jarring lurch from chatting to selling. When '
            . 'work would make a good next step but they haven\'t asked for it, let your onward [[next:]] '
            . 'prompts invite it instead — never force the cards into a casual or reflective answer. Keep '
            . 'it warm and matter-of-fact: you\'re simply sharing your work when it fits, letting them get '
            . 'a feel for how you think. The cards are '
            . 'filtered to what\'s relevant automatically, '
            . 'so place the marker even when several studies could apply. At most once in a conversation. '
            . 'Invisible like the other markers — never refer to it ("here are some case studies…"), just '
            . 'make your point and let the cards follow. The cards for a study appear ONCE per conversation: '
            . 'if a visitor asks to see a study whose card is already on screen, it is already in front of '
            . 'them — say so plainly ("that\'s the card just above") and answer with something about the '
            . 'work itself, never "the write-up is here" pointing at nothing. And never offer, in your '
            . '[[next:]] prompts, to show a study whose card has already appeared. '
            . 'ONE VARIANT: when the visitor asks outright to see EVERYTHING — all your work, the full '
            . 'portfolio, every case study, "what else have you done?" — use `[[casestudies:all]]` instead, '
            . 'which shows the whole catalogue rather than a relevant selection. Only for an explicit ask '
            . 'for the lot; a question that merely happens to fit several studies still takes the plain marker.';
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
     * Tells the model when to surface the ways-to-connect buttons. Marker-only:
     * a `[[contact]]` at a genuine ready-to-connect moment shows the contact form
     * link plus the CTAs (call, scheduled call, email) as buttons alongside.
     */
    private function contactPrompt(): string
    {
        return 'When the visitor is ready to act — asking how to get in touch or get started, about '
            . 'availability or next steps, or clearly wrapping up to take things forward — place a '
            . '`[[contact]]` marker at the end of that sentence. The ways to reach Jon (a message via '
            . 'the contact form, a call, a scheduled call, email) then appear as buttons alongside, so '
            . 'keep the prose warm and brief and DON\'T list the contact methods in words — let the '
            . 'buttons do that. Use it sparingly: only on a real ready-to-connect moment, at most once '
            . 'in a conversation, never as a default sign-off on every answer.';
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
            . 'to a project is, how you work, or what services you offer. When that\'s the question, '
            . 'place a `[[method]]` marker at the end of the sentence or paragraph where you describe '
            . 'how you work, and the journey appears as a visual timeline alongside — so keep the prose '
            . 'itself short and don\'t enumerate every phase or service in words; let the timeline do '
            . 'that. Do NOT place the marker for engagement-logistics questions about first contact or '
            . 'getting started (e.g. "how do we start working together?", "how do I get in touch?", '
            . '"what are the next steps?"): those ask how to begin a conversation, not what the process '
            . 'is, so answer them plainly with no timeline. Nor for answers about your clients, brands, '
            . 'sectors, or career/experience — those are about WHO and WHERE you\'ve worked, not HOW you '
            . 'work, so no timeline there either. Invisible like the other markers: never refer to it, '
            . 'and use it at most once in a conversation.';
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

        return "Your real career history, newest first (PRIVATE background — knowledge, not something "
            . "to read out). Each company has a note on what it is, then the role(s) you held there and "
            . "what you did:\n" . implode("\n", $lines) . "\n"
            . 'Use it to speak accurately and confidently about your experience when a visitor is '
            . 'getting a feel for whether you\'re the right fit — asking what you\'ve done, or the kind '
            . 'of work and problems you\'ve handled. Synthesise — talk to the shape and depth of it, the kinds of businesses and '
            . 'problems you\'ve worked on, and how that bears on their situation. NEVER recite it like '
            . 'a CV, never list your jobs, and don\'t rattle off dates or titles mechanically. Reach '
            . 'for a specific role only when it genuinely answers what they asked. Never invent roles, '
            . 'dates, or employers beyond what\'s listed here.';
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
            if (!empty($card['url'])) {
                $head .= ' — ' . $card['url'];
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
            . 'everything, and never invent artists or tastes beyond what\'s here.';
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
            . 'These are past pieces of work, not current or ongoing clients — speak about them in the '
            . 'past tense and don\'t imply a live relationship. Draw on them to speak concretely when a '
            . 'visitor asks about your experience, a sector, or a kind of project — name a fitting past '
            . 'project when it genuinely answers what they asked. Synthesise; never recite the whole '
            . 'list or read it out like a portfolio, and never invent projects or clients beyond what\'s '
            . 'here. (The [[clients]] logo strip is a separate, deliberate beat — this is just so you '
            . 'can speak to the work knowledgeably.)';
    }

    /**
     * Every surfaceable panel in one place — the single source of truth. The
     * resolver loop, cache replay, once-per-conversation reset, and marker
     * exclusion all derive from this, so adding a panel is one entry here.
     *
     * Every panel is marker-driven: it surfaces only when the model places its
     * [[handle]] in the prose. Each descriptor:
     *   - handle:   marker name, SSE event name, and once-per-conversation key.
     *   - template/var: the component template and its variable.
     *   - data:     fn(string $answer) => payload; an empty payload skips it.
     */
    private function panelRegistry(): array
    {
        $ctx = Jonson::getInstance()->findContext;
        $spotify = Jonson::getInstance()->spotify;

        return [
            [
                'handle' => 'testimonial', // a deliberate credibility beat — never auto-surfaced
                'template' => '_components/testimonials',
                'var' => 'items',
                'data' => static fn(string $answer) => $ctx->testimonials($answer),
            ],
            [
                'handle' => 'clients',
                // A logo wall is evidence that needs the claim made in the prose, so
                // it surfaces only where the model has written the lead-in.
                'template' => '_components/clients',
                'var' => 'clients',
                'data' => static fn(string $answer) => $ctx->clients(),
            ],
            [
                'handle' => 'sectors',
                // Supporting validation that should only appear when the visitor is
                // actually asking about the sectors/industries Jon has worked in —
                // so it rides on the model's lead-in, not an incidental mention.
                'template' => '_components/sectors',
                'var' => 'sectors',
                'data' => static fn(string $answer) => $ctx->sectors(),
            ],
            [
                'handle' => 'casestudies',
                // Discovery cards for full case study pages — surfaces where the model
                // is genuinely pointing the visitor at concrete work to explore.
                'template' => '_components/case-studies',
                'var' => 'caseStudies',
                // `:all` means the visitor asked to see everything, so skip the
                // featured curation and hand over the whole catalogue. (The marker
                // loop drops the modifier when the QUESTION names a study — see there.)
                'data' => static fn(string $answer, ?string $modifier = null, ?string $question = null) => $ctx->caseStudies($answer, $modifier === 'all', $question),
            ],
            [
                'handle' => 'method',
                // Marker-only. The model over-places [[method]] on engagement-logistics
                // questions ("how do we start working together?" read as "how you work"),
                // so the logistics-vs-process boundary lives in methodologyPrompt() — the
                // directive that governs marker placement — not in a classifier.
                'template' => '_components/method',
                'var' => 'method',
                'data' => static fn(string $answer) => $ctx->methodology(),
            ],
            [
                'handle' => 'contact',
                // The call-to-action beat: ways to reach Jon (the contact form +
                // the CTAs on the personality single). Marker-only — the model
                // places [[contact]] at a genuine ready-to-connect moment.
                'template' => '_components/jonson-ctas',
                'var' => 'contact',
                'data' => static fn() => \craft\elements\Entry::find()->section('contact')->one(),
            ],
            [
                'handle' => 'music',
                // A personality beat: the artwork strip shows only where the model
                // is genuinely on Jon's music.
                'template' => '_components/music',
                'var' => 'artists',
                // Recent top artists (~last 4 weeks) with artwork — "what I'm into
                // right now", distinct from the long-term taste that shapes
                // personality below. Capped at the latest MUSIC_STRIP_MAX.
                'data' => static fn(string $answer) => self::musicStrip($spotify),
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
    private function suggestionsFor(string $answer, $session, string $current, array $shownHandles = [], ?string $stage = null, bool $signedOff = false, bool $pivotedToDiscovery = false): array
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
        // the chip text. See groundedPrompts().
        $modelGiven = $this->groundedPrompts($modelGiven);

        // Order: a contact / "how do we start working together?" prompt leads the
        // slate — this is a lead-gen site, so the path to a real conversation goes
        // first. Otherwise, closest-following prompt first, so if we cap (or fall
        // back to one) we keep the tightest thread to what was just said.
        if (count($modelGiven) > 1) {
            usort($modelGiven, function (string $a, string $b) use ($answer): int {
                $ac = $this->isContactPrompt($a) ? 1 : 0;
                $bc = $this->isContactPrompt($b) ? 1 : 0;
                return $ac !== $bc
                    ? $bc <=> $ac
                    : $this->promptRelevance($b, $answer) <=> $this->promptRelevance($a, $answer);
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
                    fn(string $s): bool => !$this->containsAnyTerm($s, $echoTerms),
                ));
            }
            // Process paraphrases the term list can miss ("how would you approach…").
            if (in_array('method', $shownHandles, true)) {
                $modelGiven = array_values(array_filter(
                    $modelGiven,
                    fn(string $s): bool => !$this->isProcessRestate($s),
                ));
            }
        }
        // A chip offering to show a study whose card is already on screen — the
        // panel terms above don't catch "can I see the Urban work itself?".
        $shownStudies = $this->shownStudies($session);
        if ($shownStudies) {
            $modelGiven = array_values(array_filter(
                $modelGiven,
                fn(string $s): bool => !$this->isShownStudyReask($s, $shownStudies),
            ));
        }

        // Take up to MAX, skipping anything already asked. A short slate is fine.
        $exclude = $this->askedKeys($session);
        $exclude[$this->cacheKey($current)] = true;
        $out = [];
        foreach ($modelGiven as $s) {
            if (count($out) >= self::MAX_SUGGESTIONS) {
                break;
            }
            $key = $this->cacheKey($s);
            if ($key === '' || isset($exclude[$key])) {
                continue;
            }
            $exclude[$key] = true;
            $out[] = $this->normalizeChip($s);
        }

        // Never dead-end an engaged visitor: if we've got nothing and it wasn't a
        // deliberate [[next: none]] — the model dropped the marker, or every prompt it
        // gave was filtered as an echo — fall back to content-grounded candidates
        // (the get-started lead path + available content they haven't seen).
        if (!$out && !$deliberateNone) {
            $out = $this->candidateFallback($answer, $session, $stage ?? 'warm', $shownHandles);
        }

        return $out;
    }

    /**
     * Fallback slate from content-grounded candidates (FindContext::suggestionCandidates),
     * used ONLY when the model gave nothing usable and it wasn't a deliberate
     * [[next: none]]. The get-started lead path leads (when it's in-stage), then
     * available content the visitor hasn't seen, most relevant to the answer first.
     * Skips content already on screen and questions already asked.
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
        $exclude = $this->askedKeys($session);
        $out = [];
        foreach ($cands as $c) {
            if (count($out) >= self::MAX_SUGGESTIONS) {
                break;
            }
            if (!in_array($stage, $c['stages'], true)) {
                continue; // not for this funnel stage
            }
            $chip = $this->normalizeChip($c['prompt']);
            $key = $this->cacheKey($chip);
            if ($key === '' || isset($exclude[$key])) {
                continue; // already asked / duplicate
            }
            $exclude[$key] = true;
            $out[] = $chip;
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
     * Whether the visitor's question is genuinely about music — the gate for the
     * deterministic music-strip fallback. Whole-word match so a passing mention in
     * an unrelated answer can't trip it (keeping the strip in context).
     */
    /**
     * Is this a question the photo rail answers? Either it names a place or
     * theme the photos cover (the inventory's own labels — "Jersey", "Brighton",
     * "street photo"), or it's about travel or photography in general. Anything
     * else is not a cue, however many places the answer goes on to mention.
     */
    private function isPhotoQuestion(string $question): bool
    {
        if (Jonson::getInstance()->findContext->handlesInText($question)) {
            return true;
        }
        $terms = [
            'photo', 'photos', 'photograph', 'photographs', 'photography', 'photographer',
            'picture', 'pictures', 'pics', 'camera', 'cameras', 'shoot', 'shooting', 'shot', 'shots',
            'travel', 'travels', 'travelled', 'traveled', 'travelling', 'traveling', 'trip', 'trips',
            'visit', 'visited', 'visiting', 'been to', 'holiday', 'holidays', 'abroad',
            'where have you', 'where did you', 'places', 'countries', 'cities', 'city',
        ];
        $pattern = '/(?<![a-z])(' . implode('|', array_map(static fn($t) => preg_quote($t, '/'), $terms)) . ')(?![a-z])/i';

        return (bool) preg_match($pattern, $question);
    }

    /**
     * Whether a piece of ANSWER text talks about photography itself — the nouns
     * only (photo, camera, photographer…), not the travel words isPhotoQuestion
     * accepts on a question, and not loose verbs like "shot" that turn up in any
     * prose. An answer that mentions photography is on-topic for a rail of photos
     * even when the question didn't ask; an answer that merely names a place is not.
     */
    private function mentionsPhotography(string $text): bool
    {
        $terms = [
            'photo', 'photos', 'photograph', 'photographs', 'photography', 'photographer',
            'camera', 'cameras', 'street photo',
        ];
        $pattern = '/(?<![a-z])(' . implode('|', array_map(static fn($t) => preg_quote($t, '/'), $terms)) . ')(?![a-z])/i';

        return (bool) preg_match($pattern, $text);
    }

    private function isMusicQuestion(string $question): bool
    {
        $terms = [
            'music', 'listen', 'listening', 'artist', 'artists', 'band', 'bands',
            'song', 'songs', 'track', 'tracks', 'album', 'albums', 'genre', 'genres',
            'dj', 'record', 'records', 'vinyl', 'spotify', 'playlist', 'sound',
        ];
        $pattern = '/(?<![a-z])(' . implode('|', $terms) . ')(?![a-z])/i';

        return (bool) preg_match($pattern, $question);
    }

    /**
     * Whether the question is an explicit "how do we start / get in touch / work
     * together" ask — the gate for the deterministic contact-CTA fallback. Phrase
     * matches (not single loose words like "start", which appears everywhere), so
     * it only fires on a genuine ready-to-connect question.
     */
    private function isContactQuestion(string $question): bool
    {
        $q = mb_strtolower($question);
        // Genuine "ready to proceed" asks only — NOT evaluation questions like
        // "why should I hire you" or "should I work with you", which are the visitor
        // still weighing you up. The CTA should wait for them to ask HOW to begin.
        $phrases = [
            'how do we start', 'how do i start', 'how do we begin', 'get started',
            'getting started', 'work together', 'working together', 'start working',
            'get in touch', 'in touch', 'contact you', 'contact', 'reach you', 'get hold of you',
            'next step', 'start a project', 'begin a project', 'engage you', 'book you',
        ];
        foreach ($phrases as $p) {
            if (str_contains($q, $p)) {
                return true;
            }
        }

        return false;
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
     * Keep only the [[next:]] prompts whose citation resolves to a known topic,
     * and strip the citation from the text. The citation is the trailing
     * `@kind:id` (or bare `@topic`) the directive asks the model to append.
     * Unknown, malformed or missing citations drop the prompt — logged, so a
     * directive drift shows up in the log rather than as an empty slate.
     */
    private function groundedPrompts(array $prompts): array
    {
        if (!$prompts) {
            return [];
        }
        $known = $this->knownTopics();
        $out = [];
        foreach ($prompts as $raw) {
            if (!preg_match('/^(.*?)\s*@([a-z]+)(?::\s*([^@]+?))?\s*$/iu', $raw, $m)) {
                Craft::info('dropped (no citation): ' . $raw, 'jonson.suggestions');
                continue;
            }
            $text = trim($m[1]);
            $kind = strtolower($m[2]);
            $id = isset($m[3]) ? $this->topicSlug($m[3]) : '';
            $key = $id !== '' ? "{$kind}:{$id}" : $kind;
            if ($text === '' || !isset($known[$key])) {
                Craft::info("dropped (unknown topic {$key}): " . $raw, 'jonson.suggestions');
                continue;
            }
            $out[] = $text;
        }

        return $out;
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
                        . "here — then answer what they asked. Warm and brief, never gushing. ")
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

        return "WHO YOU ARE TALKING TO. This visitor came in through a private link you made for "
            . "\"{$name}\" — you know who they are, the way you'd know a guest someone had introduced.{$who} "
            . "Below is your own private note on them: who they are, what they're likely weighing up, "
            . "what of your work and experience speaks to them.\n"
            . $why
            . "- " . $naming . "\n"
            . "- Draw on what you know about them openly, as shared context between two people who've "
            . "been introduced — \"as someone who's run a design team…\", \"given what you're building…\" — "
            . "and let it colour the angle, the examples and the depth you pitch at. What you must NOT do "
            . "is recite the note, list facts about them back at them, or say you were briefed, given "
            . "notes or sent a link. You simply know them.\n"
            . "- The work you show is chosen FOR THEM: when work fits the question, pick the case studies, "
            . "clients and sectors that speak to their situation and name those in your reply — the cards "
            . "follow what you name, so naming the right ones is how the right cards appear.\n"
            . "- Your [[next:]] onward prompts are the questions THIS person would ask next, given who they "
            . "are and what they're weighing up — never generic ones. Tailoring them doesn't lift the "
            . "citation rule: each still ends with its @source, or it's dropped before they see it.\n"
            . "- They were invited, so the moment to connect can come a little sooner than it would for a "
            . "stranger — but still only at a genuine ready-to-act beat, and still once.\n"
            . "- Don't fawn, and if they say they're someone else, take their word for it and let the "
            . "note go.\n"
            . "Your note, in full:\n\n" . $text;
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
        foreach ($this->panelRegistry() as $panel) {
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

    /**
     * Render the context rail from resolved items. Failures are logged and
     * swallowed so a bad template never breaks the answer stream.
     */
    private function renderRail(array $items): ?string
    {
        // No placeholder enrichment here any more. The blur-up used to be attached to
        // each item on the way past, because the rail was the only thing that had one;
        // the `media.picture` macro now asks for it per image, so every rail photo gets
        // one by going through the same macro as the rest of the site.
        try {
            return Craft::$app->getView()->renderTemplate(
                '_components/rail',
                ['items' => $items],
                View::TEMPLATE_MODE_SITE,
            );
        } catch (\Throwable $e) {
            Craft::error('[jonson] rail render: ' . $e->getMessage(), __METHOD__);
            return null;
        }
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
     * The find_context tool definition sent to Claude.
     */
    private static function tools(): array
    {
        return [
            [
                'name' => 'find_context',
                'description' => "Surface real personal photos to the visitor alongside your reply. "
                    . "Call this only when you mention specific places you've been or lived, or themes "
                    . "you likely have images of (travel, street photography). This shows personal "
                    . "photography, NOT work — never call it for projects, case studies, clients, or "
                    . "career history. Pass the places/themes you're talking about. Keep writing "
                    . "naturally — the photos render on their own. Never claim to show something the "
                    . "tool didn't return.",
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => [
                            'type' => 'string',
                            'description' => 'Places or photography themes being discussed, e.g. "jersey france street photography".',
                        ],
                    ],
                    'required' => ['query'],
                ],
            ],
        ];
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
