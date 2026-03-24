.DEFAULT_GOAL := help

PYTHON   := python3
DEPS     := click httpx cryptography
ABS_PATH := $(shell pwd)
BIN_DIR  := $(HOME)/.local/bin

help:
	@echo ""
	@echo "  CloudBees CLI (bee)"
	@echo ""
	@echo "    make install       First time setup (deps + bee command)"
	@echo "    make run           Run: make run ARGS='job list'"
	@echo "    make ui            Launch TUI"
	@echo "    make uninstall     Remove bee from PATH"
	@echo "    make clean         Remove cache files"
	@echo ""

install: _install_deps _install_cmd

_install_deps:
	@echo ">> Installing dependencies to ./lib/ ..."
	@pip install --target=./lib $(DEPS) -q 2>/dev/null || \
	 pip3 install --target=./lib $(DEPS) -q 2>/dev/null || \
	 $(PYTHON) -m pip install --target=./lib $(DEPS) -q 2>/dev/null || \
	 (echo "  [WARN] pip not found. Install manually:" && \
	  echo "         pip install --target=./lib $(DEPS)")
	@echo "  [OK] Dependencies ready"

_install_cmd:
	@echo ">> Setting up 'bee' command ..."
	@printf '#!/bin/sh\n$(PYTHON) $(ABS_PATH)/run.py "$$@"\n' > beewrap
	@chmod +x beewrap
	@mkdir -p $(BIN_DIR)
	@cp beewrap $(BIN_DIR)/bee
	@echo ""
	@echo "  [OK] Done!"
	@echo ""
	@if echo ":$$PATH:" | grep -q ":$(BIN_DIR):"; then \
		echo "  Type: bee --help"; \
	else \
		echo "  One-time PATH setup:"; \
		echo ""; \
		echo "    bash/zsh : export PATH=\"$(BIN_DIR):\$$PATH\""; \
		echo "    csh/tcsh : setenv PATH $(BIN_DIR):\$$PATH"; \
		echo ""; \
		echo "  Add it to ~/.bashrc or ~/.cshrc to make it permanent."; \
		echo "  Then run: bee --help"; \
	fi
	@echo ""

uninstall:
	@rm -f $(BIN_DIR)/bee beewrap
	@echo "[OK] Removed bee command"

run:
	$(PYTHON) run.py $(ARGS)

ui:
	$(PYTHON) run.py --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

.PHONY: help install _install_deps _install_cmd uninstall run ui clean
