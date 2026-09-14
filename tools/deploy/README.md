# Production deploy

Standing up a **new server** from scratch is a different job with its own traps —
see `NEW-SERVER.md` beside this file.

`forge-deploy.sh` is the canonical copy of the script that lives in **Laravel Forge →
Site → Deploy Script**. Nothing runs it from the repo. Edit it here, commit, then
select-all in the Forge textarea and paste the whole file over the top.

Keeping a copy here is the point: the deploy script is otherwise invisible to anyone
reading the codebase, and every fact below was learned the hard way rather than
derived from anything in the repo.

## Why each unobvious line exists

**`FPM` and `BRANCH` are defaulted, not bare.** Under `set -u`, a bare
`"$FORGE_PHP_FPM"` aborts the script the moment Forge stops exporting it — which it
does if the site's PHP version is ever changed. Everything above the reload has run
by then, so the deploy *looks* complete and only the last step is missing.

**`SKIP_CRITICAL=1` must not be left in the script.** It was set for the server
migration, while jonleverrier.com still resolved to the old box and the critical step
would have measured the wrong site. It then stayed set, and it was the single most
expensive thing on the site. Without critical CSS the stylesheet is loaded async
(`media="print" onload="this.media='all'"`), so the page paints unstyled and re-lays
out when it arrives: measured on prod 2026-09-15, the front door jumped 133px to 789px
at ~2.1s on a throttled phone, giving **CLS 0.446** (0.409 of it that one reflow) and
**LCP 4.1s**. Locally the homepage inlines 22kB of critical CSS; prod was sending 2.2kB
with no `.c-frontdoor` or `.b-header` rules in it at all.

If it ever has to come back (Chrome crashing in the build, a page erroring under the
crawler), set it for ONE deploy to get a release out, then remove it and deploy again.

Check it is working from outside: `curl -s https://jonleverrier.com/` and look for a
~20kB inline `<style>` containing `c-frontdoor`. Note the critical CSS is only inlined
on a visitor's FIRST load — there is a `criticalcss` cookie (see
`modules/frontend/variables/FrontEndVariable.php`), so test with a clean jar.

**`URL=` on the build is not optional.** The build defaults to the local hostname, and
the critical-CSS step renders that URL in headless Chrome to work out what is above
the fold. Pointed at localhost it silently produces nothing useful.

This works only because `current/` is a real directory that we pull in place, so the
site is genuinely live while the build runs. **If zero-downtime deploys are ever
turned back on, this must become `SKIP_CRITICAL=1`** — otherwise critical CSS is
generated against the *previous* release and is quietly wrong.

Escape hatch: if the build fails for reasons unrelated to the code (Chrome crash, a
page erroring under the crawler), run it once with `SKIP_CRITICAL=1 npm run build` to
get a release out, then regenerate.

**`APP` and `SHARED` are pinned, not derived from `FORGE_SITE_PATH`.** Forge exports
that variable as the *site* directory — `/home/forge/jonleverrier.com` — while the code
lives one level down in `current/`, with `shared/` as its sibling. An earlier version
derived `APP` from it and every deploy on a rebuilt server died immediately with
`No app at /home/forge/jonleverrier.com`. The guard did its job; the path was simply
wrong. Pinning both to `$HOME/jonleverrier.com` removes the guesswork, at the cost of
the script no longer being portable to a differently-named site — which it never was.

**The queue daemon is restarted at the end.** It is a Forge daemon (server → Daemons)
running `craft/craft queue/listen`, and it holds PHP in memory — so it keeps executing
the code it started with, and a deploy that changes a job would not take effect until
something happened to restart it. `forge` has passwordless sudo for
`supervisorctl restart *`, so this needs nothing extra.

`runQueueAutomatically` is left ON, at its default. It was briefly turned off here on
the reasoning that web requests should not run queued work — which is wrong: Craft only
runs the queue automatically **on control panel visits**, never on front-end requests.
Disabling it saved visitors nothing and removed the one backstop there was, since
opening the CP will drain a queue the daemon has stopped consuming. The two together
are belt and braces, and Craft's queue reserves rows, so nothing runs twice.

**No `craft up`.** Composer's own post-install hooks already run `clear-caches/all`,
`migrate/all` and `project-config/apply`. Adding one would do the same work twice.

**The FPM reload is required, not cosmetic.** FPM runs
`opcache.validate_timestamps = 0` (`/etc/php/8.4/fpm/php.ini`), so PHP never notices a
changed file on its own. Skip it and modified PHP keeps serving old bytecode to
visitors *while the CLI reads the new code* — so a fix works from the command line and
not on the website. Newly **added** files are unaffected, which is what makes it so
convincing: a deploy looks perfect and only the changed PHP is silently old.

Do not diagnose this with `php -i` over SSH. That reads the **CLI** config, where
`validate_timestamps` is `On`. Read `/etc/php/8.4/fpm/php.ini`.

`sudo -n` so a missing sudoers rule fails loudly instead of hanging on a password
prompt. It works unprompted for the `forge` user.

**The `==>` markers** exist because a Forge deploy log otherwise gives no way to see
how far a run got. A clean run prints all four and ends with `Deploy complete`.

## The failure that cost an evening (2026-09-13)

Three deploys failed with errors that made no sense:

    syntax error near unexpected token `('
    Generating: command not found
    ✨: command not found

Every one of those is a line of **build output**, not script:

    (!) Some chunks are larger than 500 kB after minification
    Generating critical CSS from https://…
    ✨ [vite-plugin-compression]:algorithm=gzip

Deploy log text had been pasted into the Forge deploy-script field, and bash was
executing it. The errors moved around (line 60, 83, 122) because the pasted text
moved. It also explains why the reload had stopped running: bash choked on the log
before ever reaching the last line.

**If a deploy fails with a "command not found" for something that is obviously
output**, check the script field for pasted log text before believing anything else.
After pasting, `forge-deploy.sh` should be 53 lines ending in `echo "Deploy
complete"`.

## If the tail keeps getting skipped

If the reload is ever silently skipped again and the script field is clean, move the
reload out of the script and into a Forge **deploy hook**. Hooks run as separate
steps, so nothing the main script does can swallow them, and a failure is reported on
its own instead of failing the whole deploy.
