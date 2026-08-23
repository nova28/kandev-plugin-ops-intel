#!/usr/bin/env bash
#
# The unattended wrapper around refresh.sh — what launchd runs every hour so the snapshot is
# fresh whenever someone opens the tab, instead of being as old as the last time somebody
# remembered to re-extract.
#
# WHY A WRAPPER AND NOT refresh.sh IN THE PLIST. refresh.sh is the interactive verb: it always
# extracts, always restarts Rill, and always prints. Run from a timer that is exactly wrong —
# it would restart Rill at 04:00 on a machine nobody is using, and again ten minutes later if
# the Mac woke, slept and woke. Everything that makes an hourly run *safe* rather than merely
# periodic lives here:
#
#   * a working-hours window, because a restart outside it serves nobody
#   * a "Rill is already running" gate, so this refreshes what is in use and never starts a
#     server the operator did not ask for (see README: the plugin does not start Rill)
#   * a minimum interval, because launchd fires StartInterval jobs on wake as well as on time,
#     and two extracts four minutes apart are two 25 MB writes for one answer
#   * a lock, because an extract that overruns the hour must not meet the next one
#
# Every skip is logged with its reason. A refresher that goes quiet is indistinguishable from
# one that is working, which is the failure mode this whole project keeps arguing against.
#
#   ./auto-refresh.sh              refresh if the gates allow it
#   ./auto-refresh.sh --force      ignore window, Rill gate and interval (still locks)
#   ./auto-refresh.sh --self-test  assert the window arithmetic, touch nothing
#
# Configuration, all environment variables (set them in the plist, not here):
#
#   OPS_INTEL_REFRESH_WINDOW        "08:00-23:00" — local time, inclusive of both ends.
#                                    A window whose end is before its start spans midnight.
#   OPS_INTEL_REFRESH_MIN_GAP_MIN   50 — minimum minutes between two refreshes.
#   OPS_INTEL_REFRESH_TIMEOUT_MIN   10 — a refresh past this is killed, so it cannot hold the lock
#                                    across the following hours. Anything named rill is spared.
#   OPS_INTEL_REFRESH_REQUIRE_RILL  1 — refresh only while Rill is listening. 0 refreshes (and
#                                    therefore starts Rill) regardless.
#   OPS_INTEL_REFRESH_LOG           ~/Library/Logs/kandev-ops-intel-refresh.log
#
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# launchd hands a job PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else, so `rill` — a
# Homebrew install — is not found and the restart half of the refresh fails while the extract
# half succeeds: a snapshot on disk that the running Rill never reads. The plist sets PATH too;
# this line is the belt to that braces, because the same class of omission took Kandev's own
# GitHub integration down on 2026-08-15 (see ../../o/CLAUDE.md).
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

WINDOW="${OPS_INTEL_REFRESH_WINDOW:-08:00-23:00}"
MIN_GAP_MIN="${OPS_INTEL_REFRESH_MIN_GAP_MIN:-50}"
# 10 minutes, measured rather than guessed: a healthy full refresh on a ~700 MB store is 35
# seconds end to end (6s snapshot, then the SQL, the Rill restart and check.sh). A deadline is
# for a genuinely stuck run, and at this ratio ten minutes is already twenty times the real
# thing — long enough that a slow disk or a cold Rill start is never mistaken for a stall.
#
# This was 40 minutes while extract.sh still snapshotted with `.backup`, which restarts its page
# copy on every write to the source and did not converge at all under a running Kandev. That is
# fixed at the source (see extract.sh); the deadline no longer has to accommodate it.
TIMEOUT_MIN="${OPS_INTEL_REFRESH_TIMEOUT_MIN:-10}"
REQUIRE_RILL="${OPS_INTEL_REFRESH_REQUIRE_RILL:-1}"
LOG="${OPS_INTEL_REFRESH_LOG:-$HOME/Library/Logs/kandev-ops-intel-refresh.log}"
RILL_ORIGIN="${RILL_ORIGIN:-http://localhost:9009}"

STATE_DIR="$HOME/Library/Caches/kandev-ops-intel"
STAMP="$STATE_DIR/last-refresh"
LOCK="$STATE_DIR/refresh.lock"

# ---------------------------------------------------------------- window arithmetic

# Minutes since midnight for "HH:MM", or empty for anything else. Rejecting rather than
# defaulting matters: a typo'd window that silently became 00:00 would refresh all night.
to_minutes() {
    local hhmm="$1"
    [[ "$hhmm" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || return 1
    # 10# on every use, including the range check. Without it `08` and `09` are invalid octal
    # and every morning window is rejected as unparseable — which is what the self-test found.
    local h=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[2]}))
    ((h >= 0 && h <= 23 && m >= 0 && m <= 59)) || return 1
    echo $((h * 60 + m))
}

# within_window <now-minutes> <window>. A window whose end precedes its start spans midnight
# (22:00-02:00 is four hours, not twenty).
within_window() {
    local now="$1" spec="$2" start end
    start="$(to_minutes "${spec%%-*}")" || return 2
    end="$(to_minutes "${spec##*-}")" || return 2
    if ((start <= end)); then
        ((now >= start && now <= end))
    else
        ((now >= start || now <= end))
    fi
}

if [[ "${1:-}" == "--self-test" ]]; then
    fails=0
    t() { # t <expect 0|1> <now> <window>
        local want="$1" now="$2" spec="$3" got=0
        within_window "$now" "$spec" || got=$?
        if [[ "$got" != "$want" ]]; then
            echo "  FAIL  within_window $now '$spec' -> $got, want $want"; fails=1
        else
            echo "  PASS  within_window $now '$spec' -> $got"
        fi
    }
    t 0 $((8 * 60)) "08:00-22:00"       # inclusive start
    t 0 $((22 * 60)) "08:00-22:00"      # inclusive end
    t 1 $((7 * 60 + 59)) "08:00-22:00"  # a minute early
    t 1 $((22 * 60 + 1)) "08:00-22:00"  # a minute late
    t 0 $((13 * 60)) "08:00-22:00"      # the middle of the day
    t 0 $((23 * 60)) "22:00-02:00"      # overnight, before midnight
    t 0 $((1 * 60)) "22:00-02:00"       # overnight, after midnight
    t 1 $((12 * 60)) "22:00-02:00"      # overnight, outside
    t 2 $((12 * 60)) "8am-10pm"         # unparseable is a refusal, not a default
    t 2 $((12 * 60)) "08:00-25:00"      # out-of-range hour likewise
    [[ $fails -eq 0 ]] && echo "self-test ok" || { echo "SELF-TEST FAILED"; exit 1; }
    exit 0
fi

# ---------------------------------------------------------------- logging

mkdir -p "$(dirname "$LOG")" "$STATE_DIR"

# launchd never rotates a log. refresh.sh's own output is verbose (eleven CSV row counts plus a
# baseline table per run), so an hourly job left alone for a year is a large file nobody reads
# the top of. Keep the tail.
if [[ -f "$LOG" ]] && (($(wc -c < "$LOG") > 4194304)); then
    tail -n 2000 "$LOG" > "$LOG.trimmed" && mv "$LOG.trimmed" "$LOG"
fi

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
skip() { log "skip: $*"; exit 0; }

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# ---------------------------------------------------------------- gates

if [[ $FORCE -eq 0 ]]; then
    now_min=$((10#$(date '+%H') * 60 + 10#$(date '+%M')))
    # Captured through `|| rc=$?`, not from inside an `if !` block: negation rewrites `$?` to 0
    # and the unparseable-window case would read as a plain "outside hours" skip.
    window_rc=0
    within_window "$now_min" "$WINDOW" || window_rc=$?
    # An unparseable window is a configuration error, not a quiet no-op. Say so every hour until
    # it is fixed — a refresher that never runs and never complains is the worst outcome here.
    ((window_rc == 2)) && {
        log "error: OPS_INTEL_REFRESH_WINDOW='$WINDOW' is not HH:MM-HH:MM — not refreshing"
        exit 1
    }
    ((window_rc == 0)) || skip "outside working hours ($WINDOW)"

    if [[ "$REQUIRE_RILL" == "1" ]]; then
        # Ask whether Rill answers rather than whether a process matches: a `rill start` that is
        # wedged mid-reconcile is a process, and restarting it is precisely what we want. curl
        # against the port is the same question the plugin's own probe asks.
        #
        # THIS GATE CANNOT RESTART RILL, ONLY DECLINE TO WORK WITHOUT IT — so anything that
        # leaves Rill dead makes the schedule permanently inert. That happened: refresh.sh
        # pkill'd Rill and could not exec the replacement, and from the next hour on this gate
        # skipped every run with exit 0, which reads as healthy in `launchctl print` and hides
        # the outage better than the failure did. refresh.sh now resolves `rill` BEFORE killing
        # anything, so the loop cannot be entered; recovery from an existing one is a single
        # `make refresh FORCE=1`, which bypasses this gate and starts Rill.
        curl -s -o /dev/null --max-time 4 "$RILL_ORIGIN/" \
            || skip "Rill is not running on $RILL_ORIGIN (nothing is reading the snapshot)"
    fi

    if [[ -f "$STAMP" ]]; then
        age_min=$((($(date +%s) - $(stat -f %m "$STAMP")) / 60))
        ((age_min < MIN_GAP_MIN)) \
            && skip "last refresh was ${age_min}m ago (minimum gap ${MIN_GAP_MIN}m)"
    fi
fi

# mkdir is the atomic test-and-set every shell has. A refresh takes a couple of minutes and
# launchd will happily start a second copy on wake while the first is mid-extract.
if ! mkdir "$LOCK" 2>/dev/null; then
    lock_age_min=$((($(date +%s) - $(stat -f %m "$LOCK")) / 60))
    # A crashed run leaves the directory behind forever. Two hours is far longer than any real
    # refresh and short enough that a stuck refresher heals the same working day.
    if ((lock_age_min > 120)); then
        log "warning: stealing a ${lock_age_min}m-old lock — a previous run died"
        rmdir "$LOCK" 2>/dev/null || true
        mkdir "$LOCK" 2>/dev/null || skip "could not take the lock"
    else
        skip "another refresh has been running for ${lock_age_min}m"
    fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------- the refresh

log "refresh starting (window $WINDOW, force=$FORCE)"
started=$(date +%s)

# A DEADLINE, because an unattended job that hangs holds the lock past the next firings and
# never says why. A run by hand is one you watch; this one nobody is watching. Cap it.
#
# Killing spares anything named rill: by the time the refresh has started a replacement server,
# the remaining work is a health poll and check.sh, and taking the new Rill down with the
# watchdog would leave the operator with no server at all — a worse outcome than a stale one.
run_with_deadline() {
    local limit=$((TIMEOUT_MIN * 60)) child pid cmd
    ./refresh.sh >> "$LOG" 2>&1 &
    child=$!
    while kill -0 "$child" 2>/dev/null; do
        if (($(date +%s) - started > limit)); then
            log "refresh TIMED OUT after ${TIMEOUT_MIN}m — terminating (a live-writer .backup can starve)"
            for pid in $(pgrep -P "$child" 2>/dev/null || true); do
                cmd="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
                case "$cmd" in *rill*) continue ;; esac
                kill -TERM "$pid" 2>/dev/null || true
            done
            kill -TERM "$child" 2>/dev/null || true
            wait "$child" 2>/dev/null || true
            return 124
        fi
        sleep 5
    done
    wait "$child"
}

if run_with_deadline; then
    touch "$STAMP"
    elapsed=$(($(date +%s) - started))
    log "refresh ok in $((elapsed / 60))m$((elapsed % 60))s"
else
    rc=$?
    # refresh.sh ends in check.sh, whose integrity assertions can fail on a snapshot that
    # extracted perfectly well — so the exit status alone does not say whether the data is
    # usable. Do not stamp: another attempt next hour is cheap, and a stamped failure would
    # suppress it.
    log "refresh FAILED (exit $rc) — see the output above; not stamping, will retry next hour"
    exit "$rc"
fi
