.DEFAULT_GOAL := help

PYTHON   := python3
DEPS     := click httpx cryptography
ABS_PATH := $(shell pwd)
BIN_DIR  := $(HOME)/.local/bin

help:
	@echo ""
	@echo "  CloudBees CLI (bee) 🐝"
	@echo ""
	@echo "    make install       First time setup"
	@echo "    make uninstall     Remove bee command"
	@echo "    make run           make run ARGS='job list'"
	@echo "    make ui            Launch TUI"
	@echo "    make clean         Remove cache files"
	@echo ""

# ── First-time setup ──────────────────────────────────────────────────────────
install:
	@echo ""
	@echo "  Installing CloudBees CLI (bee) 🐝"
	@echo "  ────────────────────────────────────"
	@echo ""
	@$(MAKE) -s _deps
	@$(MAKE) -s _cmd
	@$(MAKE) -s _path
	@echo ""
	@echo "  ✓ Done!  Open a new terminal and run:  bee --help"
	@echo ""

_deps:
	@echo "  [1/3] Installing dependencies to ./lib/ ..."
	@pip install --target=./lib $(DEPS) -q 2>/dev/null || \
	 pip3 install --target=./lib $(DEPS) -q 2>/dev/null || \
	 $(PYTHON) -m pip install --target=./lib $(DEPS) -q 2>/dev/null || \
	 echo "        [WARN] pip failed. Run manually: pip install --target=./lib $(DEPS)"

_cmd:
	@echo "  [2/3] Creating bee command ..."
	@mkdir -p $(BIN_DIR)
	@printf '#!/bin/sh\n$(PYTHON) $(ABS_PATH)/run.py "$$@"\n' > beewrap
	@chmod +x beewrap
	@cp beewrap $(BIN_DIR)/bee

_path:
	@echo "  [3/3] Adding $(BIN_DIR) to PATH ..."
	@if echo ":$$PATH:" | grep -q ":$(BIN_DIR):"; then \
		echo "        Already in PATH — nothing to do."; \
	else \
		SHELL_RC=""; \
		if [ -f "$(HOME)/.bashrc" ]; then SHELL_RC="$(HOME)/.bashrc"; \
		elif [ -f "$(HOME)/.zshrc" ]; then SHELL_RC="$(HOME)/.zshrc"; \
		elif [ -f "$(HOME)/.cshrc" ]; then SHELL_RC="$(HOME)/.cshrc"; \
		elif [ -f "$(HOME)/.tcshrc" ]; then SHELL_RC="$(HOME)/.tcshrc"; \
		fi; \
		if [ -n "$$SHELL_RC" ]; then \
			EXPORT_LINE='export PATH="$(BIN_DIR):$$PATH"'; \
			grep -qF "$(BIN_DIR)" "$$SHELL_RC" || echo "$$EXPORT_LINE" >> "$$SHELL_RC"; \
			echo "        Added to $$SHELL_RC"; \
			echo "        Run: source $$SHELL_RC"; \
		else \
			echo "        Could not detect shell RC. Add manually:"; \
			echo "          export PATH=\"$(BIN_DIR):\$$PATH\""; \
		fi \
	fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
uninstall:
	@rm -f $(BIN_DIR)/bee beewrap
	@echo "  [OK] Removed bee"

# ── Dev shortcuts ─────────────────────────────────────────────────────────────
run:
	$(PYTHON) run.py $(ARGS)

ui:
	$(PYTHON) run.py --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

.PHONY: help install _deps _cmd _path uninstall run ui clean
