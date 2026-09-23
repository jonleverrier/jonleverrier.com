<?php

namespace modules\leadgenerator\audit\services;

use Craft;
use craft\elements\Asset;
use craft\elements\Entry;
use craft\helpers\Assets as AssetsHelper;
use craft\helpers\FileHelper;
use craft\helpers\UrlHelper;
use modules\leadgenerator\controllers\ReportController;
use yii\base\Component;

/**
 * AUDIT
 *
 * Runs the tool in tools/audit against a URL and puts the result on an entry.
 *
 * A THIN WRAPPER OVER THE CLIs ON PURPOSE. Everything that decides anything — where the
 * blocks are, what a category means, what counts as unmeasured — lives in Node, has 459
 * tests, and is exercised by a person running it against real sites. Reimplementing any of
 * that here would give the same answers a second way and let the two drift. This starts
 * processes, reads what they wrote, and moves a status.
 *
 * THE WORK DIRECTORY HAS TO BE INSIDE THE PROJECT. In development the tool runs inside
 * ddev, where only the project is mounted: /tmp in the container is not /tmp on the host,
 * so a scratch directory anywhere else is invisible to the very process that has to write
 * to it. craft/storage is gitignored, writable and present in both places.
 *
 * IT IS ALSO THE ARCHIVE. Everything in there is reproducible from a fresh capture except
 * vision.json — the model's answer, non-deterministic and the only part that cost money.
 * Re-running a six-month-old audit gives a different answer about a page that has itself
 * moved, so what was actually sent to somebody is worth keeping.
 *
 * NOTHING HERE THROWS AT THE QUEUE. Every failure is a returned reason, because a failed
 * audit is a state a human looks at rather than an exception in a log nobody reads.
 */
class Audit extends Component
{
    /** Where the tool's own page lives, so the report can borrow its name. */
    private const TOOL_SECTION = 'tools';
    private const TOOL_TYPE = 'audit';

    /** The volume subpath the field already points at. */
    public string $reportSubpath = 'lead-generator/audit';

    /**
     * How long the whole thing may take. The capture has its own three-minute budget and
     * the model call is usually under two; this is the outer bound for all of it.
     */
    public int $timeoutSeconds = 600;

    /**
     * The project root — the directory `tools/` lives in — found by looking for it.
     *
     * NOT AN ALIAS, because the obvious one is wrong here and wrong in a way that reads as
     * right. `@root` is the Craft base path, which in this project is `craft/`, so
     * `@root . '/tools/audit/capture.mjs'` resolves to a file that has never existed and
     * node reports it as a missing module. Counting `dirname()` calls would work until the
     * layout moved.
     *
     * Walking up from this file until `tools/audit` appears is self-locating: it is correct
     * now, correct if the module moves, and it fails by saying which directories it looked
     * in rather than by handing node a path to not find.
     */
    public function projectRoot(): string
    {
        $dir = __DIR__;
        for ($up = 0; $up < 8; $up++) {
            if (is_file($dir . '/tools/audit/capture.mjs')) {
                return $dir;
            }
            $parent = dirname($dir);
            if ($parent === $dir) {
                break;
            }
            $dir = $parent;
        }

        throw new \RuntimeException('could not find tools/audit above ' . __DIR__);
    }

    /**
     * The signed URL Playwright prints. See controllers/ReportController.
     *
     * THE SITE'S OWN URL, UNTOUCHED. This used to rewrite the host to `http://localhost`,
     * on the grounds that the browser doing the printing sits beside the web server and a
     * public hostname would go out to DNS for a page a socket away. That is true in ddev,
     * where nginx answers on localhost. It is not true on Forge, where nginx has a server
     * block for the site and none for `localhost` — measured on the box, `curl
     * http://localhost/` answers 000 — so every audit died with
     *
     *   report: pdf failed: page.goto: net::ERR_EMPTY_RESPONSE at http://localhost/...
     *
     * and a real lead got nothing. It worked in development for the same reason it could
     * not work in production.
     *
     * THE ROUND TRIP IT WAS AVOIDING DOES NOT HAPPEN EITHER WAY. Production carries
     * `127.0.0.1 jonleverrier.com` in /etc/hosts, so the site name resolves to the loopback
     * and the request never leaves the machine; in ddev the container resolves its own
     * hostname. Both measured at 200.
     *
     * SO THAT HOSTS ENTRY IS NOW LOAD-BEARING TWICE. It was added for the critical CSS
     * crawl, which without it meets Cloudflare, is served a bot challenge, and inlines it
     * silently (see vite.config.js). This has the same failure mode with a worse ending: a
     * report printed from a challenge page, attached to an email, sent to a prospect.
     *
     * AND NOT `127.0.0.1`, which was tried and printed the SITE HOMEPAGE into the report:
     * the address does not match a Craft site, so the action route never resolves and Craft
     * serves the default site instead. It fails silently and looks like a template bug. If
     * this ever has to change, print one and look at it.
     */
    public function reportUrl(int $entryId): string
    {
        return UrlHelper::actionUrl('leadgenerator/report/view', [
            'entry' => $entryId,
            't' => ReportController::token($entryId),
        ]);
    }

    /**
     * The directory this entry's artefacts live in, made if it is not there.
     *
     * Craft's own storage path rather than an alias: it is the one Craft itself writes to,
     * so it is right in ddev, right on Forge, and right if either ever moves.
     */
    public function workDir(int $entryId, string $which = ''): string
    {
        $dir = Craft::$app->getPath()->getStoragePath() . '/audits/' . $entryId
            . ($which !== '' ? '/' . $which : '');
        FileHelper::createDirectory($dir);

        return $dir;
    }

    /**
     * Capture, analyse and print. Returns `['ok' => bool, 'why' => ?string, 'pdf' => ?string]`.
     *
     * THREE PROCESSES AND NOT ONE, because they fail differently and the reason has to
     * survive to the entry. A 403 is a capture failure and there is nothing to analyse; a
     * model that cannot read the image is an analysis failure with a capture worth keeping;
     * a PDF that will not render is neither, and leaves a measurement that could still be
     * sent by hand.
     *
     * `$which` NAMES A SUBDIRECTORY, so the same pipeline can measure a second site for the
     * same lead without either capture landing on the other. The competitor's artefacts go
     * to audits/<id>/competitor; the lead's own stay where they have always been, because
     * moving them would orphan every report already on disk.
     */
    public function run(string $url, int $entryId, string $which = ''): array
    {
        $measured = $this->measure($url, $entryId, $which);

        return $measured['ok'] ? $this->print($entryId) : $measured;
    }

    /**
     * Capture, analyse, and write the record a template reads. No PDF.
     *
     * SEPARATE FROM PRINTING, because a lead who names a competitor is measured twice and
     * printed once: both sites have to be on disk before the document that compares them
     * can be rendered. Run them the other way round and the competitor's pages would be
     * missing from the PDF that was printed before they existed.
     */
    public function measure(string $url, int $entryId, string $which = ''): array
    {
        $dir = $this->workDir($entryId, $which);

        foreach ([
            ['capture', ['tools/audit/capture.mjs', $url, $dir]],
            ['analyse', ['tools/audit/analyse.mjs', $dir]],
            // report.json before the two steps that patch it, because the Twig template
            // reads it and nothing in PHP may recompute a percentage — see
            // tools/audit/data.mjs.
            ['data', ['tools/audit/data.mjs', $dir]],
            // What the page says it is for, per site: a lead whose purpose differs from
            // their competitor's is the case where comparing segment shares misleads, and
            // the report can only say so if it asked both. One text-only request.
            ['purpose', ['tools/audit/purpose.mjs', $dir]],
        ] as [$step, $args]) {
            $result = $this->node($args);
            if (!$result['ok']) {
                $step = $which !== '' ? $which . ' ' . $step : $step;

                return ['ok' => false, 'why' => $step . ': ' . $result['why'], 'pdf' => null];
            }
        }

        return ['ok' => true, 'why' => null, 'pdf' => null];
    }

    /**
     * Choose the cover's findings, once every site has been measured.
     *
     * SEPARATE FROM `measure`, WHICH RUNS PER SITE. The lead is measured before the
     * competitor exists, so a comparison written there would be a comparison against
     * nothing. This runs when both are on disk and patches the answer into the lead's
     * report.json — see tools/audit/summary.mjs.
     *
     * A FAILURE HERE IS NOT FATAL and the caller is expected to step over it. The cover
     * carried four fixed slots for months; a cover with none of them is a worse report
     * than one with the old four, and neither is worth losing the whole document over.
     */
    public function summarise(int $entryId): array
    {
        return $this->node(['tools/audit/summary.mjs', $this->workDir($entryId)]);
    }

    /**
     * The document, printed from Craft's own template.
     *
     * WITHOUT `--url` THIS FALLS BACK TO THE STUB in lib/pdf.mjs, which is what it did for
     * months: every design change in _views/report/audit.twig showed up in the preview and
     * none of it reached the PDF a lead was sent. The token is the same one the preview
     * uses — the page sits beside a stranger's email address and is not public.
     *
     * It prints into the lead's own directory whatever else was measured, because there is
     * one document per lead however many sites it covers.
     */
    public function print(int $entryId): array
    {
        $dir = $this->workDir($entryId);
        $result = $this->node([
            'tools/audit/pdf.mjs', $dir,
            '--url=' . $this->reportUrl($entryId),
            '--from=' . rtrim(Craft::$app->getSites()->getPrimarySite()->getBaseUrl() ?? '', '/'),
            '--logo=' . __DIR__ . '/../assets/mark.svg',
        ]);

        if (!$result['ok']) {
            return ['ok' => false, 'why' => 'report: ' . $result['why'], 'pdf' => null];
        }

        $pdf = $dir . '/report.pdf';

        return file_exists($pdf)
            ? ['ok' => true, 'why' => null, 'pdf' => $pdf]
            : ['ok' => false, 'why' => 'report: the PDF was not written', 'pdf' => null];
    }

    /**
     * One node process, with the environment it needs and a bound on how long it may take.
     *
     * THE KEYS COME FROM THE ENVIRONMENT, not from the tool reading craft/.env itself. On
     * Forge the queue worker has them; a worktree does not have the file at all. See
     * lib/vision.mjs, which prefers the environment for exactly this reason.
     */
    private function node(array $args): array
    {
        $root = $this->projectRoot();
        $cmd = array_merge(['node'], $args);
        $env = [
            'KEY_ANTHROPIC_API' => Craft::parseEnv('$KEY_ANTHROPIC_API') ?: '',
            'GOOGLE_CLOUD_KEY' => Craft::parseEnv('$GOOGLE_CLOUD_KEY') ?: '',
            // Without a HOME the Playwright browser cache cannot be found, and the capture
            // fails with a message about a missing executable rather than a missing HOME.
            'HOME' => getenv('HOME') ?: '/home/forge',
            'PATH' => getenv('PATH') ?: '/usr/local/bin:/usr/bin:/bin',
        ];

        // ddev keeps the Playwright browsers on a volume that survives the container being
        // recreated, and says so through this variable; Forge leaves them under HOME and
        // does not set it. Passed through only when it holds something, because an empty
        // value is not "unset" to Playwright — it sends it looking in the filesystem root.
        $browsers = getenv('PLAYWRIGHT_BROWSERS_PATH');
        if ($browsers) {
            $env['PLAYWRIGHT_BROWSERS_PATH'] = $browsers;
        }

        $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $process = proc_open($cmd, $descriptors, $pipes, $root, $env);
        if (!is_resource($process)) {
            return ['ok' => false, 'why' => 'node could not be started'];
        }

        // Non-blocking, so a chatty step cannot fill a pipe and deadlock the worker while
        // we wait for an exit that will never come.
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $out = '';
        $err = '';
        $deadline = time() + $this->timeoutSeconds;
        while (true) {
            $out .= (string) stream_get_contents($pipes[1]);
            $err .= (string) stream_get_contents($pipes[2]);
            $status = proc_get_status($process);
            if (!$status['running']) {
                break;
            }
            if (time() > $deadline) {
                proc_terminate($process, 9);

                return ['ok' => false, 'why' => "gave up after {$this->timeoutSeconds}s"];
            }
            usleep(200000);
        }
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($process);

        if ($code !== 0) {
            // The CLIs put their reason on stderr and their numbers on stdout, so the
            // failure line is the one worth keeping — trimmed, because a stack trace in a
            // CP field helps nobody.
            $reason = trim($err) !== '' ? trim($err) : trim($out);

            return ['ok' => false, 'why' => $this->lastLine($reason)];
        }

        return ['ok' => true, 'why' => null, 'out' => $out];
    }

    /**
     * The line that says what went wrong.
     *
     * NOT SIMPLY THE LAST ONE, which is what this did first and it cost an afternoon. When
     * node itself crashes, the last line of its output is the version banner — so a real
     * module-resolution failure was written onto an entry as "Node.js v22.23.2", which is
     * true, useless, and looks like the tool working.
     *
     * The CLIs all say `<step> failed: <reason>` when they refuse, so that wins. Otherwise
     * the FIRST meaningful line is the error and everything after it is the trace.
     */
    private function lastLine(string $text): string
    {
        $lines = array_values(array_filter(array_map('trim', explode("\n", $text)), static fn ($l) => $l !== ''));
        if (!$lines) {
            return 'no reason given';
        }
        foreach ($lines as $line) {
            if (preg_match('/\b(failed|error|cannot|refus)/i', $line)) {
                return $this->tidy($line);
            }
        }

        return $this->tidy($lines[0]);
    }

    /**
     * A reason fit for a field a person reads.
     *
     * Playwright appends its own call log to a navigation failure — "Call log: navigating
     * to …, waiting until load" — which is the right thing in a terminal and noise beside
     * a lead. The sentence before it already says what happened.
     */
    private function tidy(string $line): string
    {
        $line = (string) preg_replace('/\s*Call log:.*$/s', '', $line);
        $line = (string) preg_replace('/\s+/', ' ', $line);

        return mb_substr(trim($line), 0, 500);
    }

    /**
     * The finished PDF, as an asset in the volume the field points at, related to the entry.
     *
     * THE FILENAME CARRIES A RANDOM SUFFIX AND THAT IS NOT DECORATION. The volume is public
     * and has to be — the email links to it, and a link behind auth breaks the moment a
     * prospect forwards the report to their boss, which is the best outcome available. What
     * a public URL must not be is GUESSABLE: `kohde-agency.pdf` lets anyone walk the list
     * of who has been audited, which publishes the lead list. Eight random characters make
     * the URL knowable only to somebody who was sent it.
     */
    public function attachReport(Entry $entry, string $pdfPath): ?Asset
    {
        $field = Craft::$app->getFields()->getFieldByHandle('auditReport');
        $volumeUid = $field?->getSettings()['defaultUploadLocationSource'] ?? '';
        $volume = Craft::$app->getVolumes()->getVolumeByUid((string) str_replace('volume:', '', $volumeUid));
        if (!$volume) {
            return null;
        }
        $folder = Craft::$app->getAssets()->ensureFolderByFullPathAndVolume($this->reportSubpath . '/', $volume);

        $asset = new Asset();
        $asset->tempFilePath = $pdfPath;
        $asset->setFilename(AssetsHelper::prepareAssetName($this->reportName($entry)));
        $asset->newFolderId = $folder->id;
        $asset->setVolumeId($volume->id);
        $asset->avoidFilenameConflicts = true;
        $asset->setScenario(Asset::SCENARIO_CREATE);

        if (!Craft::$app->getElements()->saveElement($asset)) {
            Craft::error('[leadgenerator] asset save failed: ' . json_encode($asset->getErrors()), __METHOD__);

            return null;
        }

        return $asset;
    }

    /**
     * What a report is allowed to know, as Node worked it out. Null when it has not run.
     *
     * READ, NEVER RECOMPUTED. The percentages come from lib/surface.mjs over a partition
     * that is asserted to tile the page exactly; adding the same areas up again in PHP
     * would be a second implementation of one number, and the first anyone would know it
     * had drifted is a prospect asking which of the two is right.
     */
    public function reportData(int $entryId, string $which = ''): ?array
    {
        $path = $this->workDir($entryId, $which) . '/report.json';
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($path), true);

        return is_array($data) ? $data : null;
    }

    /** A file from this entry's audit directory, or null. Used to serve the annotated page. */
    public function artefact(int $entryId, string $name, string $which = ''): ?string
    {
        // Name only — never a path. This is reached from a controller, and a request that
        // could ask for ../../.env would be asking the web server to hand over the keys.
        if (!preg_match('/^[a-z0-9._-]+$/i', $name) || str_contains($name, '..')) {
            return null;
        }
        // The subdirectory is named by the CALLER, never by the request: `$which` comes from
        // a constant in this module and the regex above still guards `$name`. A competitor's
        // annotated page has to be reachable too, and this is the only door to it.
        $path = $this->workDir($entryId, $which) . '/' . $name;

        return is_file($path) ? $path : null;
    }

    /**
     * `whitepaper-co-uk-homepage-analysis-4f9c2e11.pdf`.
     *
     * The site first, because that is what a reader is looking for in a downloads folder;
     * then what the document IS, because a lead may end up with more than one thing from
     * here; then eight bytes, because the file sits in a public volume and a guessable name
     * is somebody else's report one wrong URL away.
     */
    public function reportName(Entry $entry): string
    {
        $host = (string) parse_url((string) $entry->auditUrl, PHP_URL_HOST) ?: 'homepage';

        return $this->slug($host) . '-' . $this->slug($this->toolName())
            . '-' . bin2hex(random_bytes(4)) . '.pdf';
    }

    /**
     * What this tool is called, from the page that sells it.
     *
     * THE CMS OWNS THE NAME. The tool's own entry at /tools/{slug} is where "Homepage
     * Analysis" is written, and it is the name a lead has already read before they gave
     * their address — so the filename and the email subject should say the same words
     * rather than each keeping a copy in PHP. Rename it there and both follow.
     *
     * FOUND BY SECTION AND TYPE, not by slug or id: the slug is editable and the id differs
     * per environment, and the entry type is the one handle that identifies this tool.
     */
    public function toolName(): string
    {
        $tool = Entry::find()
            ->section(self::TOOL_SECTION)
            ->type(self::TOOL_TYPE)
            ->status(null)
            ->one();

        $name = trim((string) ($tool?->title ?? ''));

        return $name !== '' ? $name : 'Homepage Analysis';
    }

    /** Lowercase, hyphenated, nothing on either end. */
    private function slug(string $text): string
    {
        return trim(strtolower((string) preg_replace('/[^a-z0-9]+/i', '-', $text)), '-');
    }
}
