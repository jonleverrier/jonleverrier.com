# Production deploy

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
After pasting, `forge-deploy.sh` should be 36 lines ending in `echo "Deploy
complete"`.

## If the tail keeps getting skipped

If the reload is ever silently skipped again and the script field is clean, move the
reload out of the script and into a Forge **deploy hook**. Hooks run as separate
steps, so nothing the main script does can swallow them, and a failure is reported on
its own instead of failing the whole deploy.
