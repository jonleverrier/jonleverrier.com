#!/usr/bin/env bash
#
# Shared plumbing for the four sync scripts in this directory.
#
# Sourced, never run. Everything here exists so the four scripts differ only in
# WHAT they move and in which direction — the credential handling, the backups
# and the confirmations are identical, and identical in one place.
#
# CREDENTIALS ARE NEVER STORED HERE. The SSH details come from craft/.env
# (PRODUCTION_SSH_*), which is gitignored; the production database password is
# read over SSH from the server's own shared/.env at the moment it is needed and
# never written to this machine. Nothing in this directory should ever hold a
# secret, because everything in this directory IS committed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/craft/.env"
BACKUP_DIR="$ROOT/.backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

die()  { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }
say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }

# envval KEY [file] — one value out of a .env, quotes and stray CR removed.
envval() {
    local key="$1" file="${2:-$ENV_FILE}"
    [ -f "$file" ] || die "no env file at $file"
    sed -n "s/^${key}=//p" "$file" | head -1 | tr -d '"' | tr -d '\r'
}

[ -f "$ENV_FILE" ] || die "craft/.env not found — run this from the project"

SSH_USER="$(envval PRODUCTION_SSH_USER)"
SSH_HOST="$(envval PRODUCTION_SSH_HOST)"
SSH_PATH="$(envval PRODUCTION_SSH_PATH)"
[ -n "$SSH_USER" ] && [ -n "$SSH_HOST" ] && [ -n "$SSH_PATH" ] \
    || die "PRODUCTION_SSH_USER / _HOST / _PATH must all be set in craft/.env"

REMOTE="$SSH_USER@$SSH_HOST"
REMOTE_ENV="$SSH_PATH/shared/.env"
REMOTE_ASSETS="$SSH_PATH/shared/assets"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

# sshx — the normal case, with -n. Without it ssh inherits this script's stdin
# and READS IT, swallowing whatever comes next; when a script is piped to bash
# rather than run as a file, that silently eats the rest of the script and the
# run simply stops with no error. Everything that doesn't deliberately feed ssh
# uses this.
sshx() { ssh -n "${SSH_OPTS[@]}" "$REMOTE" "$@"; }

# sshx_stdin — for the one case that MEANS it: piping a dump into a remote
# mysql. Named differently so the difference is a decision, not an omission.
sshx_stdin() { ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }

# remote_env KEY — a value out of the SERVER's shared/.env. Kept in a variable
# for the life of one command and never written to disk locally.
remote_env() {
    sshx "sed -n 's/^$1=//p' '$REMOTE_ENV' | head -1 | tr -d '\"' | tr -d '\r'"
}

require_ddev() {
    command -v ddev >/dev/null 2>&1 || die "ddev not on PATH"
    ddev describe >/dev/null 2>&1 || die "ddev isn't running — start it first"
}

require_ssh() {
    sshx true 2>/dev/null || die "can't reach $REMOTE over SSH"
}

# confirm WORD MESSAGE — a typed word, not y/N. These scripts overwrite whole
# databases; a reflexive Enter should not be able to do that, and the word names
# what is about to happen so a mis-run script cannot be confirmed out of habit.
confirm() {
    local want="$1"; shift
    printf '\n  %s\n\n  Type %s to continue: ' "$*" "$want"
    local got; read -r got
    [ "$got" = "$want" ] || die "cancelled"
}

# rsync flags. macOS now ships openrsync (protocol 29), NOT GNU rsync, and it
# rejects --info / --stats by printing its usage and exiting ZERO — which looks
# exactly like a transfer that worked and moved nothing. Only these plain flags
# are safe on both ends.
RSYNC_FLAGS=(-az)

mkdir -p "$BACKUP_DIR"
