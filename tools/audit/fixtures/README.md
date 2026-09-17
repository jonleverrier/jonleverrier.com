# Fixtures

Committed captures the segmentation tests run against. Viewport-sized (1440×900), not
full-page — nothing under `tools/` is gitignored and a full-page capture is megabytes.

| file | from | captured | why this one |
|---|---|---|---|
| `jonleverrier.png` | https://jonleverrier.com | 2026-09-17 | Text-led, clear column structure, no consent banner. The easy case. |
| `retail.png` | https://www.marksandspencer.com | 2026-09-17 | Product grid, consent banner, lazy images. The case that breaks things. |

**Not John Lewis.** The brief suggested johnlewis.com; it refused the headless browser
outright (`net::ERR_HTTP2_PROTOCOL_ERROR` on every load attempt). next.co.uk was tried
next and loaded, but only ever served its "Oops, something went wrong" bot-block page
(fullHeight 900px, a handful of rects, no real content) — that capture was discarded.
marksandspencer.com loaded normally, dismissed its consent banner via the existing
`.cc-allow`-style selector list, and captured a real homepage with a 3752px full page
height. Same contrast the brief wanted — product grid, consent wall, lazy content —
just a different retailer.

Each has a `.rects.json` beside it — the DOM rects from the same capture, used to
check that a block boundary sits in a gap rather than through an element.

**Recapturing invalidates the tests.** The suite avoids golden values precisely so it
survives tuning, but the fixture-backed tests still assume these exact images. If you
recapture, rerun the whole suite and expect to revisit block counts.

**These are third-party pages.** They are here as test input, not as anything to
publish. If the audit ever ships screenshots in a customer-facing report, that is a
separate decision to think through.
