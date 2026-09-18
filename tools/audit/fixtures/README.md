# Fixtures

Committed captures the segmentation tests run against. **Full-page, not viewport-sized** —
these are `fullpage.png` from a real capture, at the natural height of each page.

| file | from | captured | size | why this one |
|---|---|---|---|---|
| `jonleverrier.png` | https://jonleverrier.com | 2026-09-18 | 1440×1296, 158K | Text-led, clear column structure, no consent banner. The easy case. |
| `retail.png` | https://www.marksandspencer.com | 2026-09-18 | 1440×3752, 2.0M | Product grid, consent banner, lazy images, a blurred full-bleed hero video. Five tiles tall. The case that breaks things. |

**They were viewport-sized (1440×900) until 2026-09-18, and that was a mistake worth
recording.** Viewport crops keep the repo light, and nothing under `tools/` is gitignored,
so the trade looked obvious. But `segmentTall` — the whole tall-page tiling path — never
sees a second tile on a 900px image, so it was covered only by a synthetic edge map while
every real-page test silently exercised plain `segment()`. The tiling defects found at the
first review gate had never met a real page. 2MB is the price of testing the code that
actually runs; pay it.

The corollary: **`retail.png` must stay several tiles tall.** If it is ever recaptured
shorter than ~1900px, the tiling path loses its only real-content coverage and the suite
will not tell you.

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
