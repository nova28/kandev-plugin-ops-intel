#!/usr/bin/env bash
#
# The unattended wrapper around refresh.sh — what launchd runs, on a short poll interval, so the
# snapshot reacts to real activity instead of being as old as the last time somebody remembered
# to re-extract.
#
# WHY A WRAPPER AND NOT refresh.sh IN THE PLIST. refresh.sh is the interactive verb: it always
# extracts, always restarts Rill, and always prints. Run from a timer that is exactly wrong —
# it would restart Rill at 04:00 on a machine nobody is using, and firing this script every
# poll would mean Rill restarting every poll too. Everything that makes a run *safe* rather than
# merely frequent lives here:
#
#   * a working-hours window, because a restart outside it serves nobody
#   * a "Rill is already running" gate, so this refreshes what is in use and never starts a
#     server the operator did not ask for (see README: the plugin does not start Rill)
#   * SIGNAL-DRIVEN FAST PATH: main.go subscribes to Kandev's task.moved bus event
#     (capabilities.events in manifest.yaml — see its comment for why task.moved and not a
#     direct cost event) and, on every delivery, rewrites $SIGNAL. This script — a separate
#     process with no Kandev API access of its own — polls that file rather than the bus
#     directly. A burst of moves (every step advance on a busy workflow publishes one) collapses
#     into ONE refresh: wait for QUIET_SECONDS since the last move, or MAX_WAIT_SECONDS since the
#     first pending one, whichever comes first. Triggering per event instead would mean
#     overlapping extracts and Rill restarting every few seconds instead of on real settle.
#   * FIXED-TIME MODE: the operator can turn "React to task moves" off in Settings > Plugins >
#     Ops Intel (config_schema.event_driven), which makes $SIGNAL carry event_driven=0. This
#     script then ignores first_seen/last_seen entirely and refreshes on a plain interval
#     (config_schema.fixed_interval_minutes) instead — e.g. to cap this at once an hour
#     regardless of how often cards move, same cadence as before this whole mechanism existed.
#   * BACKSTOP: if $SIGNAL doesn't exist at all — the event capability declined at install, an
#     older Kandev, or the plugin hasn't synced yet — this falls back to the old periodic
#     cadence (MIN_GAP_MIN), so a refresh still happens even if nothing has ever signaled.
#   * a lock, because an extract can outlast the poll interval and must not meet the next one
#
# Every skip is logged with its reason. A refresher that goes quiet is indistinguishable from
# one that is working, which is the failure mode this whole project keeps arguing against.
#
#   ./auto-refresh.sh              refresh if the gates allow it
#   ./auto-refresh.sh --force      ignore window, Rill gate, signal and interval (still locks)
#   ./auto-refresh.sh --self-test  assert the window arithmetic, touch nothing
#
# Configuration, all environment variables (set them in the plist, not here):
#
#   OPS_INTEL_REFRESH_WINDOW              "08:00-23:00" — local time, inclusive of both ends.
#                                          A window whose end is before its start spans midnight.
#   OPS_INTEL_REFRESH_MIN_GAP_MIN         50 — BACKSTOP minutes between refreshes when nothing
#                                          is signaling a pending change.
#   OPS_INTEL_REFRESH_QUIET_MINUTES       2 — fallback quiet window, used only until the first
#                                          event ever writes its own value into $SIGNAL. The
#                                          operator's real value lives in Settings > Plugins >
#                                          Ops Intel (config_schema.quiet_minutes) and travels
#                                          through $SIGNAL, not through this env var.
#   OPS_INTEL_REFRESH_MAX_WAIT_MINUTES    5 — fallback max-wait, same caveat as above.
#   OPS_INTEL_REFRESH_FIXED_INTERVAL_MINUTES  60 — fallback fixed-mode interval, same caveat
#                                          (config_schema.fixed_interval_minutes).
#   OPS_INTEL_REFRESH_TIMEOUT_MIN         10 — a refresh past this is killed, so it cannot hold
#                                          the lock into the next several polls. Anything named
#                                          rill is spared.
#   OPS_INTEL_REFRESH_REQUIRE_RILL        1 — refresh only while Rill is listening. 0 refreshes
#                                          (and therefore starts Rill) regardless.
#   OPS_INTEL_REFRESH_LOG                 ~/Library/Logs/kandev-ops-intel-refresh.log
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
# In minutes on the env var, like config_schema — converted to seconds once here since
# signal_should_refresh compares against $SIGNAL's second-precision timestamps.
QUIET_SECONDS_DEFAULT=$(( ${OPS_INTEL_REFRESH_QUIET_MINUTES:-2} * 60 ))
MAX_WAIT_SECONDS_DEFAULT=$(( ${OPS_INTEL_REFRESH_MAX_WAIT_MINUTES:-5} * 60 ))
FIXED_INTERVAL_SECONDS_DEFAULT=$(( ${OPS_INTEL_REFRESH_FIXED_INTERVAL_MINUTES:-60} * 60 ))
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

# $STATE_DIR must match main.go's stateDir() exactly — it is the one location both the Go
# plugin process and this shell script can compute identically, from $HOME alone. See that
# function's comment for why it is not KANDEV_PLUGIN_DATA_DIR.
STATE_DIR="$HOME/Library/Caches/kandev-ops-intel"
STAMP="$STATE_DIR/last-refresh"
LOCK="$STATE_DIR/refresh.lock"
SIGNAL="$STATE_DIR/refresh-signal"

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

# ---------------------------------------------------------------- signal debounce arithmetic

# signal_should_refresh <now> <first_seen> <last_seen> <quiet_s> <max_wait_s>. True (0) once a
# pending change has either gone quiet or waited long enough; false (1) otherwise. Pure
# arithmetic — no file I/O — so --self-test can exercise it directly.
signal_should_refresh() {
    local now="$1" first_seen="$2" last_seen="$3" quiet_s="$4" max_wait_s="$5"
    local since_last_move=$((now - last_seen)) since_first_pending=$((now - first_seen))
    ((since_last_move >= quiet_s || since_first_pending >= max_wait_s))
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

    d() { # d <expect 0|1> <now> <first_seen> <last_seen> <quiet_s> <max_wait_s>
        local want="$1" now="$2" first="$3" last="$4" quiet="$5" maxw="$6" got=0
        signal_should_refresh "$now" "$first" "$last" "$quiet" "$maxw" || got=1
        if [[ "$got" != "$want" ]]; then
            echo "  FAIL  signal_should_refresh now=$now first=$first last=$last quiet=$quiet max=$maxw -> $got, want $want"
            fails=1
        else
            echo "  PASS  signal_should_refresh now=$now first=$first last=$last quiet=$quiet max=$maxw -> $got"
        fi
    }
    # A single fresh event: not yet quiet, nowhere near max wait.
    d 1 100 100 100 60 300
    # Quiet window exactly satisfied (>=, not >): last move 60s ago, quiet=60.
    d 0 160 100 100 60 300
    d 1 159 100 100 60 300
    # Still within quiet after a burst refreshed last_seen, but first_seen is old: max wait
    # forces a refresh even though moves keep arriving and quiet never settles.
    d 0 500 100 490 60 300  # since_first=400>=300 even though since_last=10<60
    d 1 350 100 340 60 300  # since_first=250<300, since_last=10<60 — still waiting
    # first_seen == last_seen (the very first event of a burst): neither threshold met yet.
    d 1 100 100 100 60 300
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

    if [[ -f "$SIGNAL" ]]; then
        # first_seen last_seen quiet_seconds max_wait_seconds event_driven fixed_interval_seconds
        # — written by main.go's syncSignal, on every task.moved delivery AND on every plugin
        # restart (which Kandev triggers on any Settings > Plugins > Ops Intel config change).
        # A malformed or short line (partial write outrun by an atomic rename, or the 4-field
        # format from before the event_driven toggle existed) falls back to the env-var
        # defaults and today's timestamp — wait one more quiet window rather than crash or
        # refresh blindly.
        read -r first_seen last_seen quiet_s max_wait_s event_driven_s fixed_interval_s \
            < "$SIGNAL" 2>/dev/null || true
        now_epoch=$(date +%s)
        [[ "${first_seen:-}" =~ ^[0-9]+$ ]] || first_seen=$now_epoch
        [[ "${last_seen:-}" =~ ^[0-9]+$ ]] || last_seen=$now_epoch
        [[ "${quiet_s:-}" =~ ^[0-9]+$ ]] || quiet_s=$QUIET_SECONDS_DEFAULT
        [[ "${max_wait_s:-}" =~ ^[0-9]+$ ]] || max_wait_s=$MAX_WAIT_SECONDS_DEFAULT
        [[ "${event_driven_s:-}" =~ ^[01]$ ]] || event_driven_s=1
        [[ "${fixed_interval_s:-}" =~ ^[0-9]+$ ]] || fixed_interval_s=$FIXED_INTERVAL_SECONDS_DEFAULT

        if [[ "$event_driven_s" == "1" ]]; then
            signal_should_refresh "$now_epoch" "$first_seen" "$last_seen" "$quiet_s" "$max_wait_s" || \
                skip "pending change $((now_epoch - last_seen))s since last move (quiet ${quiet_s}s) / $((now_epoch - first_seen))s since first pending (max wait ${max_wait_s}s)"
            # Falls through to the lock/refresh below — a pending change has settled or waited
            # long enough. MIN_GAP_MIN does NOT gate this path: quiet_s already spaces
            # successive event-driven refreshes, since $SIGNAL is only cleared on success.
        else
            # FIXED-TIME MODE: the operator turned "React to task moves" off in Settings.
            # Ignore first_seen/last_seen entirely and use $STAMP against the operator's own
            # fixed_interval_minutes, same shape as the BACKSTOP below but their configured
            # value instead of the env-var default — this is what makes "keep it at an hour
            # regardless of task.moved" an actual, reachable setting rather than just a hope.
            if [[ -f "$STAMP" ]]; then
                age_s=$((now_epoch - $(stat -f %m "$STAMP")))
                ((age_s < fixed_interval_s)) \
                    && skip "fixed-interval mode; last refresh $((age_s / 60))m ago (interval $((fixed_interval_s / 60))m)"
            fi
        fi
    elif [[ -f "$STAMP" ]]; then
        # TRUE BACKSTOP: no signal has EVER been written — the event capability is missing,
        # declined, or the plugin hasn't synced yet (e.g. right after install, before its first
        # task.moved or its SetHost callback). Falls back to the env-var default, since there is
        # no operator config to read here at all.
        age_min=$((($(date +%s) - $(stat -f %m "$STAMP")) / 60))
        ((age_min < MIN_GAP_MIN)) \
            && skip "no pending change; last refresh was ${age_min}m ago (backstop gap ${MIN_GAP_MIN}m)"
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
    # Clear $SIGNAL on success, but ONLY in event-driven mode. There it holds transient
    # per-burst state (first_seen/last_seen) that must reset so the next task.moved starts a
    # fresh debounce window — main.go's OnEvent recreates it from scratch on delivery, so a
    # move that arrives mid-refresh (or in the few seconds right after this rm) just starts a
    # fresh window rather than being lost. In FIXED-TIME mode $SIGNAL instead holds persistent
    # operator config (event_driven=0, fixed_interval_seconds); removing it here would silently
    # fall back to the env-var backstop default (OPS_INTEL_REFRESH_MIN_GAP_MIN, not the
    # operator's chosen interval) until the next task.moved happened to resync it — which could
    # be a long wait in fixed-time mode by definition. Re-read rather than reuse the gate
    # section's variables: this branch also runs under --force, which skips that section
    # entirely, and re-reading a possibly-absent file is cheap and always correct either way.
    signal_mode=1
    [[ -f "$SIGNAL" ]] && { read -r _ _ _ _ signal_mode _ < "$SIGNAL" 2>/dev/null || signal_mode=1; }
    [[ "$signal_mode" == "1" ]] && rm -f "$SIGNAL"
    elapsed=$(($(date +%s) - started))
    log "refresh ok in $((elapsed / 60))m$((elapsed % 60))s"
else
    rc=$?
    # refresh.sh ends in check.sh, whose integrity assertions can fail on a snapshot that
    # extracted perfectly well — so the exit status alone does not say whether the data is
    # usable. Do not stamp and do not clear $SIGNAL: the next poll (event-driven or backstop)
    # retries, and a stamped/cleared failure would suppress that.
    log "refresh FAILED (exit $rc) — see the output above; not stamping, will retry"
    exit "$rc"
fi
