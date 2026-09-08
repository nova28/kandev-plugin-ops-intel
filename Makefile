# Kandev's module needs Go 1.26; GOTOOLCHAIN lets an older system Go fetch it rather than
# failing with a version error that reads like a broken dependency.
GO ?= GOTOOLCHAIN=go1.26.0 go

KANDEV   ?= ../o/kandev
KANDEV_URL ?= http://localhost:8817
VERSION  := $(shell awk '/^version:/ {gsub(/"/,"",$$2); print $$2}' manifest.yaml)
PKG      := .build/kandev-plugin-ops-intel-$(VERSION).tar.gz
STAGE    := .build/pkg

NODE ?= node

# The platform this checkout is being built ON. `make package` bakes it into the staged
# manifest.yaml (see below) rather than the matrix of everyone's platforms, so every developer
# who clones this repo installs a binary that actually matches their own machine.
GOOS     := $(shell $(GO) env GOOS)
GOARCH   := $(shell $(GO) env GOARCH)
PLATFORM := $(GOOS)-$(GOARCH)

# The snapshot refresh (see rill/auto-refresh.sh). REFRESH_WINDOW is local time, both ends
# inclusive; override any of these at install time, e.g. `make refresh-agent-install
# REFRESH_WINDOW=07:00-23:00 REFRESH_POLL_SECONDS=30 REFRESH_TIMEOUT_MIN=45`.
REFRESH_LABEL  := com.kandev-plugin-ops-intel.refresh
REFRESH_PLIST  := $(HOME)/Library/LaunchAgents/$(REFRESH_LABEL).plist
REFRESH_LOG    := $(HOME)/Library/Logs/kandev-ops-intel-refresh.log
# The window exists for FRESHNESS, not to spare the machine load (the agent is already
# ProcessType Background / LowPriorityIO / Nice 5, gated by REFRESH_MIN_GAP_MIN) — so it should
# cover every hour the dashboard is actually read, and no more.
#
# 08:00-06:00 rather than the old 08:00-23:00. The end-at-23:00 version assumed work stops in
# the evening. Measured 2026-08-31/09-01 on this install, agent activity ran 14:00 through 05:00
# with the heaviest hour at 23:00 (33 cost events, $240) — entirely outside the window. Two
# refreshes failed at 22:46 and 22:57, the window shut at 23:00, and auto-refresh.sh then logged
# `skip: outside working hours` every 60s for six hours while $1,478 of spend accumulated
# invisibly. An overnight-spanning end is supported (an end before the start crosses midnight);
# 06:00-08:00 stays quiet so the knob still means something. Set 00:00-23:59 for a true 24h.
REFRESH_WINDOW ?= 08:00-06:00
# How often launchd wakes auto-refresh.sh to CHECK, not how often it actually refreshes — most
# wake-ups just read the signal file and go back to sleep (see auto-refresh.sh's SIGNAL-DRIVEN
# FAST PATH). 60s keeps event-driven latency low without noticeable overhead; it does not need
# to be anywhere near QUIET_SECONDS/MAX_WAIT_SECONDS, which live in Settings > Plugins > Ops
# Intel (config_schema), not here.
REFRESH_POLL_SECONDS ?= 60

# Hard cap on ONE refresh, covering the whole chain — VACUUM INTO snapshot, then the CSV
# extract, then the Rill restart — not just the snapshot. It exists so a wedged run cannot hold
# the lock forever, so it has to clear the slowest legitimate run rather than the typical one.
#
# 30 rather than 10, because the 10 was set when kandev.db was small. Measured 2026-09-01: a
# 1.5 GB kandev.db vacuums at ~2.9 MB/s (disk at 100% capacity, agents writing concurrently),
# so the snapshot ALONE needs ~9 min, before 130 MB of CSVs and a ~20s Rill restart. Both runs
# on 2026-08-31 died at exactly 10m00s part-way through, so nothing was ever stamped and the
# dashboard silently served a 12-hour-old snapshot. Raise this again if the DB keeps growing.
REFRESH_TIMEOUT_MIN ?= 30

.PHONY: build bundle test package install reinstall uninstall clean \
	refresh refresh-agent-install refresh-agent-uninstall refresh-agent-status

# The builder's own platform only — see README. Cross-compiling the full matrix would ship
# binaries nobody on this checkout can verify, for platforms nobody here is running.
build:
	@mkdir -p server
	$(GO) build -o server/plugin-$(PLATFORM) .

# ui/bundle.js is GENERATED from ui/src/*.mjs. It stays committed because it is what ships,
# but editing it directly is a mistake the next build silently undoes — so every path that
# packages the bundle rebuilds it first.
bundle:
	$(NODE) ui/build.mjs

# The Rill ledger's pure formatting and attribution assembly are dependency-free
# Node tests; no running Kandev or Rill server is required.
#
# Glob the files rather than passing the directory: under Node 22 `--test test/` resolves the
# argument as a MODULE and dies with "Cannot find module .../test", which reads like a broken
# import inside a test and is actually the runner never starting. Every test silently stopped
# running the day the pinned Node moved.
#
# NOTE: this covers the pure JS only. Step attribution lives in SQL and is asserted by
# rill/check.sh against a running Rill — see the step-attribution block there.
test:
	$(NODE) --test test/*.test.mjs

# plugin-pack walks EVERY file under -dir with no ignore mechanism, so packing the repo root
# would ship whatever happens to be lying in it: the Rill project (25 MB of extracted CSV and
# DuckDB scratch), the Go sources, and — because .build/ is walked too — a copy of the previous
# tarball nested inside the new one. Stage the three things an install actually needs instead.
package: build bundle test
	@rm -rf $(STAGE)
	@mkdir -p $(STAGE)/server $(STAGE)/ui
	@sed 's/@@PLATFORM@@/$(PLATFORM)/g' manifest.yaml > $(STAGE)/manifest.yaml
	@cp README.md $(STAGE)/
	@cp server/plugin-$(PLATFORM) $(STAGE)/server/
	@cp ui/bundle.js $(STAGE)/ui/
	# GOOS/GOARCH=GOHOSTOS/GOHOSTARCH here, deliberately overriding whatever cross-compile
	# target is set for `build` above (e.g. from a CI release matrix). `go run` compiles AND
	# executes plugin-pack immediately — unlike `go build`, it can't just cross-compile and
	# save the binary for later. Left inheriting a cross GOOS/GOARCH, the tool itself gets
	# built for the TARGET platform and then fails to execute on the machine building it
	# ("exec format error"), even though the plugin binary it's packaging cross-compiled fine.
	#
	# No -platform-only: that flag filters server/ executables against runtime.GOOS/GOARCH —
	# compile-time constants of the plugin-pack BINARY, which the line above just pinned to
	# the native host, not the target. It would filter for the wrong platform on every
	# cross-compiled build and reject the very executable `build` just produced. Harmless to
	# drop: $(STAGE)/server/ only ever holds the one binary matching $(PLATFORM) above, so
	# there is never a second platform's executable for it to filter out.
	cd $(KANDEV)/apps/backend && GOOS=$$($(GO) env GOHOSTOS) GOARCH=$$($(GO) env GOHOSTARCH) \
		$(GO) run ./cmd/plugin-pack -dir $(CURDIR)/$(STAGE) -out $(CURDIR)/$(PKG)

# Piping curl into `head` used to mask the exit status, so a 409 ("version already installed")
# printed nothing and reported success — leaving the old bundle serving while it looked like the
# new one had shipped. Check the status explicitly.
install: package
	@resp=$$(curl -s -w '\n%{http_code}' -X POST $(KANDEV_URL)/api/plugins/install \
		-F "package=@$(PKG)"); \
	code=$$(printf '%s' "$$resp" | tail -1); \
	printf '%s' "$$resp" | sed '$$d' | head -c 400; echo; \
	case "$$code" in \
		200|201) echo "installed $(VERSION)" ;; \
		409) echo "install failed (HTTP 409): $(VERSION) is already installed — run 'make reinstall'"; exit 1 ;; \
		*) echo "install failed (HTTP $$code)"; exit 1 ;; \
	esac

# Kandev refuses to install over an existing version, and the frontend cache-busts the UI bundle
# on `?v=<version>` — so iterating on ui/bundle.js without bumping the version means replacing
# the install outright. This is the normal dev loop for UI changes.
reinstall:
	$(MAKE) uninstall
	$(MAKE) install

uninstall:
	curl -sf -X DELETE $(KANDEV_URL)/api/plugins/kandev-plugin-ops-intel; echo

clean:
	rm -rf .build
	rm -rf server

# ---------------------------------------------------------------- snapshot refresh
#
# Rill serves a point-in-time extract and does not hot-reload it, so every number in the tab
# and in the task panel is exactly as old as the last refresh. Doing that by hand means the
# answer to "what did this card cost" is routinely "re-run three commands first" — which is how
# the panel ended up with a copyable command in its empty state. The agent removes the chore
# rather than making it easier to type.

# One refresh now, gates and all. `make refresh FORCE=1` ignores the window, the Rill gate and
# the minimum interval — the verb to use when you want the snapshot current this second.
refresh:
	rill/auto-refresh.sh $(if $(FORCE),--force,)

# Absolute paths are substituted in because a plist cannot carry a relative one, and this
# checkout lives wherever it was cloned.
refresh-agent-install:
	@rill/auto-refresh.sh --self-test
	@mkdir -p $(HOME)/Library/LaunchAgents
	@sed -e 's|@@LABEL@@|$(REFRESH_LABEL)|g' \
	     -e 's|@@SCRIPT@@|$(CURDIR)/rill/auto-refresh.sh|g' \
	     -e 's|@@RILL_DIR@@|$(CURDIR)/rill|g' \
	     -e 's|@@LOG@@|$(REFRESH_LOG)|g' \
	     -e 's|@@HOME@@|$(HOME)|g' \
	     -e 's|@@WINDOW@@|$(REFRESH_WINDOW)|g' \
	     -e 's|@@POLL_SECONDS@@|$(REFRESH_POLL_SECONDS)|g' \
	     -e 's|@@TIMEOUT_MIN@@|$(REFRESH_TIMEOUT_MIN)|g' \
	     rill/launchd/$(REFRESH_LABEL).plist.template > $(REFRESH_PLIST)
	@plutil -lint $(REFRESH_PLIST)
	@launchctl bootout gui/$$(id -u)/$(REFRESH_LABEL) 2>/dev/null || true
	launchctl bootstrap gui/$$(id -u) $(REFRESH_PLIST)
	@echo "installed $(REFRESH_LABEL): checks every $(REFRESH_POLL_SECONDS)s within $(REFRESH_WINDOW), $(REFRESH_TIMEOUT_MIN)m timeout per refresh (refreshes only on a signal or the backstop gap), log $(REFRESH_LOG)"

refresh-agent-uninstall:
	@launchctl bootout gui/$$(id -u)/$(REFRESH_LABEL) 2>/dev/null || true
	@rm -f $(REFRESH_PLIST)
	@echo "removed $(REFRESH_LABEL)"

# What launchd thinks, then what the job actually did. The second half is the one that matters:
# a loaded agent whose every run skipped is indistinguishable from a working one until you read
# the reasons.
refresh-agent-status:
	@launchctl print gui/$$(id -u)/$(REFRESH_LABEL) 2>/dev/null \
		| grep -E 'state|last exit|runs|pid' || echo "not loaded"
	@echo
	@tail -n 15 $(REFRESH_LOG) 2>/dev/null || echo "no log at $(REFRESH_LOG) yet"
