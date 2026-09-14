# Standing up a new server

Written while moving jonleverrier.com to a UK Forge box on 14 September 2026. Every
step below is one that actually had to be taken, in the order it had to be taken, and
most of them record something that was not obvious until it went wrong.

Read alongside `README.md`, which explains the deploy script itself.

## The layout this site expects

```
/home/forge/jonleverrier.com/
    current/     the repository — a REAL directory, not a symlink
    shared/      .env and assets, surviving every deploy
```

`current/` and `shared/` as siblings is deliberate. It is what lets generated image
transforms outlive a deploy, and it is why `public/assets` and `craft/.env` are
symlinks rather than files.

Forge does not build this shape on its own. Its "Zero Downtime Deployment" option
produces something similar — `releases/` plus a `current` symlink — but that brings a
`releases/` directory we do not want, and a symlinked `current` breaks the critical-CSS
step (see README). So the shape is made by hand, once, at step 4.

## 1. Provision the server — as root

Forge's provisioning script must run as root. Running it as `forge`/`ubuntu` fails
immediately with a wall of permission errors ending `This script must be run as root.`

```bash
sudo -i
# then paste the whole command Forge gives you (wget … ; bash forge.sh)
```

Some providers (AWS, Oracle) disable root SSH and drop you in as a normal user, which
is where this bites; Hetzner and DigitalOcean log you straight in as root and it never
comes up.

If provisioning fails *later* than the first few lines, destroy the server in Forge and
start from a fresh image. The script is not idempotent once it is into packages.

## 2. Let the server talk to GitHub

Forge shows `git@github.com: Permission denied (publickey)` when the new server's key
is unknown to GitHub. GitHub authorises the **key**, not the repository, so the old
server's access counts for nothing here.

Take the new server's public key (Forge → Server → Meta → SSH Keys, or
`cat ~/.ssh/id_rsa.pub` as `forge`) and add it to GitHub.

**"Key is already in use" is not an error to fight.** It means that key is already
registered — most usefully, on your GitHub *account*, which already grants access to
every repository you own. Check before generating anything new:

```bash
ssh -T git@github.com
```

`Hi <you>!` means an account key and you are done. `Hi <you>/<repo>!` means a deploy
key on that repo. Either is fine. Note it exits 1 even on success — read the words, not
the exit code.

## 3. Install the repository

Expect this to report failure the first time with:

```
Composer could not find a composer.json file in /home/forge/jonleverrier.com
```

That is Forge's optional **Install Composer dependencies** step, which looks in the
repository root. This project keeps Composer in `craft/`, so there is nothing there to
find. Untick that option on the install screen — it is install-time only and does not
appear afterwards.

**The clone itself succeeds regardless.** Check before re-running, because a re-run
starts with `rm -rf` on the site directory:

```bash
cd ~/jonleverrier.com && git log --oneline -1
```

## 4. Build the current/ + shared/ layout

Forge clones flat, into the site directory itself. Reshape it:

```bash
cd /home/forge

# refuse unless this is exactly the fresh clone
[ -d jonleverrier.com/.git ] || { echo "ABORT: no .git at site root"; exit 1; }
[ -e jonleverrier.com/current ] && { echo "ABORT: current/ exists"; exit 1; }

# a directory cannot be moved inside itself, so build alongside and swap
mkdir site-restructure-tmp
mv jonleverrier.com site-restructure-tmp/current
mkdir site-restructure-tmp/shared
mv site-restructure-tmp jonleverrier.com
```

Then in Forge set **Web directory** to `/current/public`. Leave **Root directory** as
`/` — that field means "where the app lives inside the repo", for monorepos, and this
repo has no `current` folder in it. Setting it there points nginx at a path that never
exists.

Confirm nginx followed:

```bash
grep root /etc/nginx/sites-available/jonleverrier.com
# → root /home/forge/jonleverrier.com/current/public;
```

## 5. The .env, and the hyphen trap

Copy `shared/.env` from the old server. Then **check the database name and user against
what Forge actually created**, because Forge silently converts hyphens to underscores:

| asked for | Forge created |
|---|---|
| `jl-db-prod` | `jl_db_prod` |
| `jl-dbuser-prod` | `jl_dbuser_prod` |

An `.env` copied from a server built before that conversion gives
`ERROR 1045 (28000): Access denied`, which reads exactly like a wrong password and sends
you looking in the wrong place for an hour.

The quick discriminator: connect **without naming a database**. Still 1045 means the
credentials themselves are being rejected (wrong name or password); 1044 instead would
mean the user is fine but lacks rights on that database.

```bash
cd ~/jonleverrier.com/shared
grep -E '^CRAFT_DB_(SERVER|DATABASE|USER)=' .env
```

## 6. Move the database

Dump **without** `--databases`, so no `CREATE DATABASE`/`USE` is baked in and the dump
can land in a differently named database:

```bash
# on the old server
mysqldump -h 127.0.0.1 -u "$U" -p"$P" \
  --single-transaction --quick --no-tablespaces --routines --triggers \
  --default-character-set=utf8mb4 "$OLD_DB" | gzip -6 > /tmp/db.sql.gz

# on the new server
gunzip -c db.sql.gz | mysql -h 127.0.0.1 -u "$U" -p"$P" --default-character-set=utf8mb4 "$NEW_DB"
```

`--no-tablespaces` matters: without it a non-root dump fails on missing PROCESS
privilege.

## 7. Move the assets

~300MB. Copy server-to-server rather than via a laptop — it took 14 seconds at 21MB/s
between two Forge boxes, against the better part of an hour over a home connection.

The two servers do not trust each other by default. Grant it temporarily, in the
direction that points at the **new** box, so the live server is never the one accepting
a new key:

```bash
# from your machine: old server's public key -> new server's authorized_keys
ssh $OLD_USER@$OLD_HOST 'cat ~/.ssh/id_rsa.pub' | ssh $NEW_USER@$NEW_HOST 'cat >> ~/.ssh/authorized_keys'

# then, on the old server
rsync -az --stats -e 'ssh -o StrictHostKeyChecking=accept-new' \
  ~/jonleverrier.com/shared/assets/ $NEW_USER@$NEW_HOST:~/jonleverrier.com/shared/assets/
```

Verify by bytes, not by eye:

```bash
cd ~/jonleverrier.com/shared/assets && echo "$(find . -type f | wc -l) files, $(du -sb . | cut -f1) bytes"
```

**Then withdraw the key.** On the new server, filter it back out of
`~/.ssh/authorized_keys` and confirm the old server is refused again.

## 8. The deploy script

Paste `forge-deploy.sh` into Forge → Site → Deploy Script, replacing everything.

Two things that will otherwise waste an evening:

**`APP` and `SHARED` are pinned, not taken from `FORGE_SITE_PATH`.** Forge exports that
as the *site* directory — `/home/forge/jonleverrier.com` — one level above `current/`.
A script that derives `APP` from it aborts with `No app at /home/forge/jonleverrier.com`
before doing anything.

**Set `SKIP_CRITICAL=1` until DNS points here.** The critical-CSS step renders the live
URL in headless Chrome; before cutover that URL is still the *old* server, so it would
measure the wrong site. Deploy with it set, cut DNS over, remove it, deploy again.

## 9. Headless Chrome for critical CSS

The build renders pages in Chrome, so the server needs Chromium's shared libraries.
Ubuntu 26.04 as provisioned by Forge already had all of them; older images may not.

Do not trust a list — ask the binary:

```bash
cd ~/jonleverrier.com/current && npm ci --no-audit --no-fund
find ~/.cache/puppeteer -name chrome -type f | head -1 | xargs ldd | grep 'not found'
```

Empty output means nothing is missing. Anything listed names exactly what to install.
`sudo npx playwright install-deps chromium` resolves the right package names for the
release, which matters because 24.04 renamed many of them (`libasound2` →
`libasound2t64`, and so on) and a list copied from a 22.04 guide half-fails silently.

**Do not** set `PUPPETEER_EXECUTABLE_PATH` or `PUPPETEER_SKIP_DOWNLOAD` on the server.
Those exist in `.ddev/config.yaml` only because Chrome for Testing has no linux-arm64
build and cannot exec on Apple Silicon. An x86 server downloads its own Chrome happily.

## 10. PHP tuning

Forge's defaults are not what this site runs on. As root:

```bash
V=8.4

cat > /etc/php/$V/fpm/conf.d/99-tuning.ini <<'EOF'
memory_limit = 256M
opcache.memory_consumption = 256
opcache.max_accelerated_files = 20000
opcache.interned_strings_buffer = 16
opcache.validate_timestamps = 0
realpath_cache_ttl = 600
EOF

sed -i 's/^max_execution_time = .*/max_execution_time = 60/' /etc/php/$V/fpm/php.ini

W=/etc/php/$V/fpm/pool.d/www.conf
cp $W $W.pre-tuning
sed -i 's/^pm.max_children = .*/pm.max_children = 30/;
        s/^pm.start_servers = .*/pm.start_servers = 6/;
        s/^pm.min_spare_servers = .*/pm.min_spare_servers = 4/;
        s/^pm.max_spare_servers = .*/pm.max_spare_servers = 12/' $W
grep -q '^pm.max_requests' $W || echo 'pm.max_requests = 500' >> $W

php-fpm$V -t && service php$V-fpm reload
```

`php-fpm -t` validates before reloading, so a typo cannot take FPM down.

### Why these numbers

Measured on a 6-core / 11.6GB box with ~10GB free:

- **`pm.max_children = 30`** — higher than the usual "cores × 2–4" because Jonson's
  requests are not CPU-bound. A turn holds a worker for a **median 6.5 seconds**
  (70 logged turns: min 422ms, max 10.8s), almost all of it blocked on the Anthropic
  API using no CPU. Sizing by cores undercounts a streaming endpoint badly.
  Real cost at full pool is 30 × 100MB observed peak = ~3GB. Busiest minute ever
  recorded was 3 turns, so this is roughly ten times the worst real load.
- **`opcache.max_accelerated_files = 20000`** — the app is **8,783 PHP files**. The
  default 10000 covers that with almost no room for another plugin.
- **`opcache.memory_consumption = 256`** — the 128MB default thrashes on a codebase
  that size.
- **`opcache.validate_timestamps = 0`** — PHP then never notices changed files, which
  is exactly why the deploy script's FPM reload is load-bearing rather than tidy. Skip
  the reload and modified PHP keeps serving old bytecode to visitors while the CLI
  reads the new code. Newly *added* files are unaffected, which is what makes it so
  convincing a failure.
- **`max_execution_time = 60`** — generous against a 10.8s worst case, and it is CP
  work like image transforms that would ever need it, not Jonson.

## 11. Verify before cutting DNS

The site can be tested on the new box without moving DNS:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "Host: jonleverrier.com" http://127.0.0.1/
```

And the two servers compared directly — same commit, same row counts, same bytes:

```bash
cd ~/jonleverrier.com/current && git rev-parse --short HEAD
# elements / entries / jonson_turns counts, and:
find ~/jonleverrier.com/shared/assets -type f | wc -l
du -sb ~/jonleverrier.com/shared/assets | cut -f1
```

## 12. After DNS moves

1. Remove `SKIP_CRITICAL=1` from the deploy script and deploy again, so critical CSS is
   generated against the real site.
2. Re-run the database and asset copies if anything was written on the old server in the
   meantime — entries edited in the CP, and every Jonson conversation, live there until
   the moment DNS moves.
3. Check Cloudflare's caching level is **Standard**. "Ignore query string" would defeat
   `revAssetUrls()` and serve stale images for the full 30-day max-age; "No query
   string" would make every revved asset uncacheable.
