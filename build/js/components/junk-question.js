/**
 * JUNK QUESTION
 *
 * Is this a question, or a keypress? The browser-side twin of
 * AskController::looksLikeJunk() — SAME THREE RULES, and they have to stay that way.
 *
 * This one is a courtesy: it stops the front door collapsing into a conversation
 * whose heading is "aaa", and shows the lost-for-words drawer instead. The server's
 * is the real gate, because anything here can be bypassed by posting the endpoint
 * directly — so a change to the rules belongs in BOTH files or neither.
 *
 * Deliberately not a keyboard-mash test. "asdfgh" is catchable, but every rule that
 * catches it also catches real short questions in other languages or with unusual
 * spelling, and a false positive tells a genuine visitor their question is nonsense.
 * These three are unambiguous; that is the whole bar.
 *
**/

export function looksLikeJunk(question) {
    const q = (question || '').trim();

    // Two characters, not three: "Hi" is a real opener the surfacing suite covers.
    // [...q] rather than q.length so an emoji counts as the one character it looks
    // like, matching PHP's mb_strlen.
    if ([...q].length < 2) {
        return true;
    }

    // Nothing to answer without a letter somewhere — "...", "123", "!!!".
    if (!/\p{L}/u.test(q)) {
        return true;
    }

    // One letter held down. Counted as DISTINCT letters rather than by looking for
    // runs, so "aaa", "aAaAa" and "a a a" all land here while "hi", "ok" and "hmm"
    // survive on two.
    const letters = q.toLowerCase().match(/\p{L}/gu) || [];

    return new Set(letters).size < 2;
}
