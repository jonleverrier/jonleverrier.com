# Jonson surfacing suite

The acceptance suite for everything Jonson places around an answer: the photo
rail, case studies, clients, sectors, method, testimonial, contact CTA, music strip
and the suggestion chips. It exists because every one of those grew its own
incident-shaped rule, and each fix broke a neighbour. **No surfacing change ships
without a full run before and after.** A single-case fix is not a fix.

| file | what |
|---|---|
| `suite.json` | The scenarios. One or more turns in one fresh conversation, each naming the surfaces it expects and forbids. Expectations are **product intent**, never a description of current behaviour. |
| `run.mjs` | The runner. Fresh cookie jar and cid per run, CSRF from `/actions/users/session-info`, reads the SSE stream, reports pass rate per scenario and missed/leaked per surface, writes the full record to `results/`. Exit 1 on any failure. |
| `results/` | Runs. `baseline-2026-09-07.txt` is the pre-redesign run and `after-redesign-*.txt` the iterations that followed; keep them. Per-run JSON holds every turn's events, the markers the model wrote, photo and chip counts, and the full raw answer. |
| `inline-markdown.test.mjs` | Unit test for `inlineMarkdown()` in jonson-ask.js — the **link allowlist** above all. It lifts the real function out of the module and asserts that tel:, mailto: and same-site paths become anchors while javascript:, data:, external http(s), protocol-relative `//host` and attribute break-outs stay literal text. No API calls, runs in a second: `node tools/jonson/inline-markdown.test.mjs`. Run it after any edit to that function. |
| `backup-2026-09-07/` | The four files as they were before the redesign, for rollback — this project has no version control. |

```sh
node tools/jonson/run.mjs               # 6 runs each, 4 in parallel
node tools/jonson/run.mjs 6 4 rail      # only scenarios whose id contains "rail"
JONSON_BASE=https://staging.example node tools/jonson/run.mjs
```

Each call is a Claude call. A full run is about 150 calls and ten minutes.

## The rule the suite guards

The model decides what belongs, by placing a `[[marker]]` in the sentence that
introduces the thing. Code decides only what is allowed: grounding (the surface or
photo handle exists, and a photo handle's paragraph names its label), framing (prose
comes before the marker), budget (once per conversation; each photo once) and declared
exclusions (no photo rail beside a work surface). That's the whole of the resolver in
`AskController::actionStream()`, driven by `surfaceRegistry()`. When the model's
judgement is wrong, the fix is the directive's "What you can show" section — never a
keyword list, a text scan or a classifier in the loop. Those were tried, one per
incident, and each broke a neighbour.

## Reading a result

- **missing X (unmarked by model)** — the model didn't write the marker. A directive
  problem: say more clearly when the thing belongs, or put the reminder nearer the
  data it reads while answering (the photo list, the music list).
- **missing X (marked, dropped by server)** — the model asked and code refused. Either
  a real violation (a photo handle on a paragraph that never names the place) or a
  code rule stricter than the contract. Look at the raw answer before touching anything.
- **showed X** — a surface leaked onto an answer it doesn't belong on. With no guessing
  in the loop, that is the model over-placing: a directive fix, checked against the
  decoys.
- Six runs is the floor for anything that depends on the model. Two runs proved
  a rule once that six runs then disproved. The per-run JSON keeps every raw answer
  with its markers, so a failure can be read rather than guessed at.

## Adding a scenario

Add a decoy for every surface you add: a question that mentions its subject in
passing and must NOT show it. The rail's decoy is "Do you like Japan?"; the
method's is "How do we start working together?". The suite is only as honest as
its decoys.
