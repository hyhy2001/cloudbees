.DEFAULT_GOAL := help

SHELL        := /bin/bash
WRAPPER_CSH  := $(CURDIR)/bee.csh
WRAPPER_LINK := $(CURDIR)/bee

# --- Local bun toolchain (self-contained, no system bun) -------------------
# bun is installed into ./.bun inside the repo so builds don't depend on a
# system-wide bun. Override BUN_VERSION to pin (e.g. BUN_VERSION=bun-v1.1.38);
# default "latest" tracks the newest release.
BUN_VERSION  ?= latest
BUN_INSTALL  := $(CURDIR)/.bun
BUN          := $(BUN_INSTALL)/bin/bun

# Keep bun's temp + package cache on the SAME filesystem as the project
# (inside ./.bun), and disable hardlink/clonefile installs. On hosts where
# the global cache (~/.bun) and the project live on different devices/layers
# (overlayfs, panel jails, per-user quotas), the default hardlink backend
# fails with a misleading "EDQUOT: disk quota exceeded" while creating a
# temporary directory. copyfile + a co-located cache/tmp avoids that.
BUN_TMP      := $(BUN_INSTALL)/tmp
BUN_CACHE    := $(BUN_INSTALL)/cache
# Prefix applied to every bun invocation that writes to disk.
BUN_ENV      := TMPDIR="$(BUN_TMP)" BUN_INSTALL_CACHE_DIR="$(BUN_CACHE)"

help:
	@echo ""
	@echo "  bee - CloudBees CLI (TypeScript/Bun)"
	@echo ""
	@echo "    make init        Install local bun + deps + build binary"
	@echo "    make bun         Install bun locally into ./.bun (if missing)"
	@echo "    make install     Install deps + build binary + create bee.csh wrapper"
	@echo "    make build       Compile binary → dist/bee"
	@echo "    make deps        Install dependencies only (bun install)"
	@echo "    make dev         Run from source: make dev ARGS='job list'"
	@echo "    make run         Run the built binary: make run ARGS='job list'"
	@echo "    make typecheck   Type-check the project (tsc --noEmit)"
	@echo "    make test        Run test suite"
	@echo "    make clean       Remove dist/ and node_modules/"
	@echo "    make distclean   Also remove the local ./.bun toolchain"
	@echo ""

# Download bun into ./.bun only when the binary isn't already there.
$(BUN):
	@echo "  Installing bun ($(BUN_VERSION)) locally → $(BUN_INSTALL)"
	@curl -fsSL https://bun.sh/install | BUN_INSTALL="$(BUN_INSTALL)" bash $(if $(filter-out latest,$(BUN_VERSION)),-s "$(BUN_VERSION)",)
	@echo "  [OK] $$($(BUN) --version) at $(BUN)"

bun: $(BUN)

deps: $(BUN)
	@mkdir -p "$(BUN_TMP)" "$(BUN_CACHE)"
	@$(BUN_ENV) $(BUN) install --backend=copyfile

install: deps
	@$(MAKE) build
	@printf '#!/usr/bin/env csh\nexec "%s/dist/bee" $$*\n' "$(CURDIR)" > "$(WRAPPER_CSH)"
	@chmod +x "$(WRAPPER_CSH)"
	@ln -sf "$(WRAPPER_CSH)" "$(WRAPPER_LINK)"
	@echo "  [OK] wrapper: $(WRAPPER_CSH)"
	@echo "  [OK] symlink: $(WRAPPER_LINK) -> $(WRAPPER_CSH)"

build: deps
	@$(BUN_ENV) $(BUN) run build.ts

init: build
	@echo ""
	@echo "  [OK] bee binary built at ./dist/bee"
	@echo "  Run: ./dist/bee --help"
	@echo ""

dev: $(BUN)
	@$(BUN_ENV) $(BUN) run src/main.ts $(ARGS)

run:
	@./dist/bee $(ARGS)

typecheck: $(BUN)
	@$(BUN_ENV) $(BUN) x tsc --noEmit -p tsconfig.json && echo "  [OK] No type errors"

test: $(BUN)
	@$(BUN_ENV) $(BUN) test

clean:
	@rm -rf dist node_modules

distclean: clean
	@rm -rf $(BUN_INSTALL)

.PHONY: help init bun deps install build dev test clean distclean run typecheck
