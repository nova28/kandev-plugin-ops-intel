// The managed executable is intentionally inert on Kandev's own data — it declares no
// api_read/api_write capability and never calls a Host data method. It exists to be a
// supervised process (Kandev requires one even for UI-only plugins) and, since
// capabilities.events, to bridge exactly one signal to the local filesystem: OnEvent below is
// the only thing in this repo that can see Kandev's task.moved bus event, and
// rill/auto-refresh.sh (a plain shell script with no Kandev API access at all) needs to know
// when it fires. See manifest.yaml's capabilities block for why task.moved and not a direct
// cost event, and rill/auto-refresh.sh's SIGNAL-DRIVEN FAST PATH for the debounce this feeds.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

const taskMovedEvent = "task.moved"

// Defaults mirror config_schema's own defaults in manifest.yaml (in minutes — see its comment
// for why). Used only when Host.GetConfig is unreachable (no Host injected yet, or the RPC
// failed) — the operator's actual Settings > Plugins > Ops Intel values always win when
// available.
const (
	defaultEventDriven          = true
	defaultQuietMinutes         = 2
	defaultMaxWaitMinutes       = 5
	defaultFixedIntervalMinutes = 60
	// minConfigMinutes is a floor applied to whatever GetConfig returns, not just the default:
	// config_schema validates required/type/enum/format/secret but not a numeric minimum, so a
	// 0 or negative value typed into the Settings form would otherwise mean "always due" and
	// defeat debouncing (or the fixed interval) entirely.
	minConfigMinutes = 1
)

type opsIntelPlugin struct{ pluginsdk.UnimplementedPlugin }

func main() {
	pluginsdk.Serve(&opsIntelPlugin{})
}

// SetHost overrides UnimplementedPlugin's store-only version to also push a fresh config
// snapshot to the signal file the moment a Host becomes available. This matters because Kandev
// restarts the plugin on ANY config change (per Host.GetConfig's own doc comment), but OnEvent
// only fires on a real task.moved delivery — without this, flipping event_driven off, or
// changing fixed_interval_minutes, would leave rill/auto-refresh.sh reading a stale value until
// the next card happens to move, which could be a long wait right after the operator
// deliberately asked for less frequent refreshing. Best-effort: nothing meaningful to do with
// an error here, since nothing calls SetHost expecting a result.
func (p *opsIntelPlugin) SetHost(h pluginsdk.Host) {
	p.UnimplementedPlugin.SetHost(h)
	_ = syncSignal(context.Background(), h, false)
}

// OnEvent fires on every task.moved delivery and rewrites the signal file
// rill/auto-refresh.sh polls. It never touches Rill, the extract, or the snapshot itself —
// that stays entirely in the shell script, which already owns locking, the working-hours
// window, and the "Rill must already be running" gate. This only says something changed.
//
// Delivery is sequential per plugin (see pluginsdk.Plugin's doc comment), so the file's own
// read-modify-write here needs no mutex against a concurrent OnEvent call — only against a
// stale read racing the shell script's own read, which the atomic rename in writeSignal
// prevents.
func (p *opsIntelPlugin) OnEvent(ctx context.Context, e *pluginsdk.Event) error {
	if e.EventType != taskMovedEvent {
		return nil
	}
	return syncSignal(ctx, p.Host(), true)
}

// syncSignal rewrites the signal file: always with the current config, and — only when
// recordMove is true, i.e. called from a real OnEvent delivery rather than SetHost's
// config-only sync — with first_seen/last_seen updated to record that a move just happened.
// SetHost must NOT set recordMove, or every plugin restart (which happens on every config
// change) would fabricate a task move that never occurred.
func syncSignal(ctx context.Context, host pluginsdk.Host, recordMove bool) error {
	dir, err := stateDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "refresh-signal")

	// Zero value (all fields 0/false) if none exists yet or it's unreadable — fine either way:
	// recordMove below treats lastSeen==0 as "no burst pending yet", and a config-only sync
	// just carries the zeroes forward until a real move arrives to start one.
	s, _ := readSignal(path)

	if recordMove {
		now := time.Now().Unix()
		if s.lastSeen == 0 {
			s.firstSeen = now // the first move of a new pending burst
		}
		s.lastSeen = now
	}

	cfg := map[string]any{}
	if host != nil {
		if c, err := host.GetConfig(ctx); err == nil {
			cfg = c
		}
	}
	s.eventDriven = configBool(cfg, "event_driven", defaultEventDriven)
	s.quietSeconds = max(configInt(cfg, "quiet_minutes", defaultQuietMinutes), minConfigMinutes) * 60
	s.maxWaitSeconds = max(configInt(cfg, "max_wait_minutes", defaultMaxWaitMinutes), minConfigMinutes) * 60
	s.fixedIntervalSeconds = max(configInt(cfg, "fixed_interval_minutes", defaultFixedIntervalMinutes), minConfigMinutes) * 60

	return writeSignal(dir, path, s)
}

type signal struct {
	firstSeen, lastSeen          int64
	quietSeconds, maxWaitSeconds int
	eventDriven                  bool
	fixedIntervalSeconds         int
}

// readSignal returns the previously written signal, or the zero value if none exists yet or
// it's unreadable/malformed (including a shorter, pre-toggle format from an older version of
// this plugin).
func readSignal(path string) (signal, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return signal{}, false
	}
	var s signal
	var driven int
	n, err := fmt.Sscanf(string(data), "%d %d %d %d %d %d",
		&s.firstSeen, &s.lastSeen, &s.quietSeconds, &s.maxWaitSeconds, &driven, &s.fixedIntervalSeconds)
	if err != nil || n != 6 {
		return signal{}, false
	}
	s.eventDriven = driven != 0
	return s, true
}

// writeSignal writes via a temp file plus rename (atomic on the same filesystem) so
// auto-refresh.sh — polling this file on an unrelated timer — never reads a half-written line.
func writeSignal(dir, path string, s signal) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("ops-intel: state dir: %w", err)
	}
	driven := 0
	if s.eventDriven {
		driven = 1
	}
	tmp := path + ".tmp"
	line := fmt.Sprintf("%d %d %d %d %d %d\n",
		s.firstSeen, s.lastSeen, s.quietSeconds, s.maxWaitSeconds, driven, s.fixedIntervalSeconds)
	if err := os.WriteFile(tmp, []byte(line), 0o644); err != nil {
		return fmt.Errorf("ops-intel: write signal: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("ops-intel: rename signal: %w", err)
	}
	return nil
}

// stateDir is deliberately NOT KANDEV_PLUGIN_DATA_DIR: that directory is injected only into
// this Go process's own environment, and rill/auto-refresh.sh — a separate process with no
// Kandev API access — has no way to discover its resolved path. $HOME is the one thing both
// sides can compute identically, so this reuses auto-refresh.sh's own existing STATE_DIR
// ($HOME/Library/Caches/kandev-ops-intel), not the officially-managed plugin data directory.
func stateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("ops-intel: resolve home dir: %w", err)
	}
	return filepath.Join(home, "Library", "Caches", "kandev-ops-intel"), nil
}

// configInt reads an integer-ish config value. GetConfig's map[string]any decodes JSON numbers
// as float64, so that's the primary case; int/int64 are handled too in case that ever changes.
func configInt(cfg map[string]any, key string, fallback int) int {
	switch v := cfg[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	default:
		return fallback
	}
}

func configBool(cfg map[string]any, key string, fallback bool) bool {
	if v, ok := cfg[key].(bool); ok {
		return v
	}
	return fallback
}
