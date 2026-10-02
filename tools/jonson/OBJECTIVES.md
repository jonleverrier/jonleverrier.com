# What Jonson is for

The objectives Jonson is held to, each paired with the check that proves it. This is
the spec: when behaviour and this file disagree, one of them is wrong — change the code
or change this file, never neither. A new objective isn't done until it has a check.

**Purpose.** A portfolio exists to bring in work. Jonson gets a visitor to an answer
faster than browsing would, then turns it into **the work** (case studies) or **a
conversation** (contact). It is not a general chatbot.

## Everyone

| # | Objective | Proven by |
|---|---|---|
| 1 | **Answer directly**, in Jon's voice, first person, always in character | `run.mjs` scenarios (`intro`, `based`, …) |
| 2 | **Chat → case study.** When work is relevant, the cards are *every* study the answer describes and only those; a client's studies come as a set; a study named by title in the question comes alone | `run.mjs` on every turn with cards: **obeyed** (cards = the ids Jonson listed, plus siblings / named work) and **judged** (`judge.mjs`: the studies the prose describes, each backed by a verbatim quote); `selection.php` (free replay) |
| 3 | **Chat → CTA.** When someone's ready (price, availability, how to start), offer the ways in | `run.mjs` (`signoff`, `contact`) |
| 4 | **Show, don't tell** — photos, clients, sectors, method, testimonials, music when the answer earns them, never when it doesn't | `run.mjs` per-surface expect / forbid, decoys |
| 5 | **Steer to the work**, not endless chat; chips lead somewhere | `run.mjs` (`work-chip-loop`), `depth.mjs` |
| 6 | **Never invent** who Jon has worked with — no made-up clients, no sector turned into a kind of client ("regulators"), no one client made plural ("estate agents"), no quantity inflated ("some" → "many"). **Zero tolerance: one invented client in any run fails the run** (Jon, 2026-10-02) | **Guarded live:** every answer passes `ClaimCheck` before it's shown (no API call); a wrong one is rewritten, or its sentence cut. `claims.php` (free): self-tests + replay of every stored answer; `claims-rewrite.php` (cents): the rewrite path. Plus `run.mjs` on **every answer**: Sonnet judge vs the CMS facts (`facts.php`), two reads, agreed findings only |
| 7 | **Never screen anyone out** — fit is worked out together, not decided up front | `run.mjs` `notScreened` scenarios (`no-screen-*`), judged |
| 8 | **Be quick** — the answer shows as soon as it's written | production analytics (`ttftMs`); the suite doesn't time |

## VIPs (came through `/vip/…`) — everything above, plus

| # | Objective | Proven by |
|---|---|---|
| 9 | **Recognise them** — greeted by name, the VIP strip all visit | `run.mjs` (`vip-intro-subject`) |
| 10 | **Use the note privately** — it shapes answers, is never recited, and never credits them with Jon's work ("since we worked together") | `run.mjs` `forbidText` |
| 11 | **Their work leads** — the study that fits them comes first (Allan → Urban) | `run.mjs` (`vip-sector-match`: `expectStudies`, `leadStudy`) |
| 12 | **The closest proof first** — the testimonial nearest their world | `run.mjs` (`vip-quote-order`) |
| 13 | **Contact routes fit the door's purpose** (job / partnership / win work; none = an ordinary visitor) | `vip.mjs` (free): every purpose's `/contact` routes vs each CTA's purposes in the CMS |
| 14 | **Only people count as visits** — link previews and prefetches don't; a real visit counts once; a preview gets the door's own card | `vip.mjs` (free); logged-in visits not counting is not automated (needs a CP session) |

## Running the checks

```sh
node tools/jonson/vip.mjs                   # objectives 13–14 — free, seconds
ddev exec "php tools/jonson/selection.php"  # objective 2's picker — free, seconds
ddev exec "php tools/jonson/claims.php"     # objective 6's live guard — free, seconds
node tools/jonson/run.mjs                   # everything else — ~€10–15, ~15 min
```
