# Kandev's module needs Go 1.26; GOTOOLCHAIN lets an older system Go fetch it rather than
# failing with a version error that reads like a broken dependency.
GO ?= GOTOOLCHAIN=go1.26.0 go

KANDEV   ?= ../o/kandev
KANDEV_URL ?= http://localhost:8817
VERSION  := $(shell awk '/^version:/ {gsub(/"/,"",$$2); print $$2}' manifest.yaml)
PKG      := .build/kandev-plugin-opscost-$(VERSION).tar.gz
STAGE    := .build/pkg

NODE ?= node

.PHONY: build bundle test package install reinstall uninstall clean

# Host platform only — see README. Rebuilding for the full matrix would ship ~95 MB of
# binaries that will never run on this machine.
build:
	$(GO) build -o server/plugin-darwin-arm64 .

# ui/bundle.js is GENERATED from ui/src/*.mjs. It stays committed because it is what ships,
# but editing it directly is a mistake the next build silently undoes — so every path that
# packages the bundle rebuilds it first.
bundle:
	$(NODE) ui/build.mjs

# The pure halves — format.mjs and ledger.mjs — with no browser, no React and no Rill.
# Deliberately dependency-free: node's own test runner, nothing installed.
test:
	$(NODE) --test test/

# plugin-pack walks EVERY file under -dir with no ignore mechanism, so packing the repo root
# would ship whatever happens to be lying in it: the Rill project (25 MB of extracted CSV and
# DuckDB scratch), the Go sources, and — because .build/ is walked too — a copy of the previous
# tarball nested inside the new one. Stage the three things an install actually needs instead.
package: build bundle test
	@rm -rf $(STAGE)
	@mkdir -p $(STAGE)/server $(STAGE)/ui
	@cp manifest.yaml README.md $(STAGE)/
	@cp server/plugin-darwin-arm64 $(STAGE)/server/
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
	curl -sf -X DELETE $(KANDEV_URL)/api/plugins/kandev-plugin-opscost; echo

clean:
	rm -rf .build server
