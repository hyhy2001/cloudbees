.DEFAULT_GOAL := help

PYTHON   := python3
DEPS     := click httpx cryptography
ABS_PATH := $(shell pwd)
BIN_DIR  := $(HOME)/.local/bin

help:
	@echo ""
	@echo "  bee 🐝 — CloudBees CLI"
	@echo ""
	@echo "    make install     Setup (run once)"
	@echo "    make uninstall   Remove bee"
	@echo "    make run         make run ARGS='job list'"
	@echo "    make ui          Launch TUI"
	@echo ""

install:
	@pip install --target=./lib $(DEPS) -q 2>/dev/null || \
	 pip3 install --target=./lib $(DEPS) -q 2>/dev/null || \
	 echo "[WARN] pip failed — run: pip install --target=./lib $(DEPS)"
	@mkdir -p $(BIN_DIR)
	@printf '#!/bin/sh\n$(PYTHON) $(ABS_PATH)/run.py "$$@"\n' > beewrap
	@chmod +x beewrap && cp beewrap $(BIN_DIR)/bee
	@echo ""
	@echo "  [OK] bee installed to $(BIN_DIR)/bee"
	@echo ""
	@echo "  If 'bee' is not found, add to PATH:"
	@echo "    export PATH=\"$(BIN_DIR):\$$PATH\""
	@echo ""

uninstall:
	@rm -f $(BIN_DIR)/bee beewrap && echo "[OK] Removed bee"

run:
	$(PYTHON) run.py $(ARGS)

ui:
	$(PYTHON) run.py --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

.PHONY: help install uninstall run ui clean
