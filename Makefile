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
# inclusive; override either at install time, e.g. `make refresh-agent-install
# REFRESH_WINDOW=07:00-23:00 REFRESH_POLL_SECONDS=30`.
REFRESH_LABEL  := com.kandev-plugin-ops-intel.refresh
REFRESH_PLIST  := $(HOME)/Library/LaunchAgents/$(REFRESH_LABEL).plist
REFRESH_LOG    := $(HOME)/Library/Logs/kandev-ops-intel-refresh.log
# 08:00-23:00 rather than a 9-to-5: the work this measures routinely runs into the evening, and
# a window that closes at 22:00 leaves the snapshot stalest exactly when it is being read.
REFRESH_WINDOW ?= 08:00-23:00
# How often launchd wakes auto-refresh.sh to CHECK, not how often it actually refreshes — most
# wake-ups just read the signal file and go back to sleep (see auto-refresh.sh's SIGNAL-DRIVEN
# FAST PATH). 60s keeps event-driven latency low without noticeable overhead; it does not need
# to be anywhere near QUIET_SECONDS/MAX_WAIT_SECONDS, which live in Settings > Plugins > Ops
# Intel (config_schema), not here.
REFRESH_POLL_SECONDS ?= 60

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
	cd $(KANDEV)/apps/backend && $(GO) run ./cmd/plugin-pack \
		-dir $(CURDIR)/$(STAGE) -out $(CURDIR)/$(PKG) -platform-only

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
	     rill/launchd/$(REFRESH_LABEL).plist.template > $(REFRESH_PLIST)
	@plutil -lint $(REFRESH_PLIST)
	@launchctl bootout gui/$$(id -u)/$(REFRESH_LABEL) 2>/dev/null || true
	launchctl bootstrap gui/$$(id -u) $(REFRESH_PLIST)
	@echo "installed $(REFRESH_LABEL): checks every $(REFRESH_POLL_SECONDS)s within $(REFRESH_WINDOW) (refreshes only on a signal or the backstop gap), log $(REFRESH_LOG)"

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
