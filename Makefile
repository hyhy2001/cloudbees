.DEFAULT_GOAL := help

PYTHON   := python3
DEPS     := textual rich
ABS_PATH := $(shell pwd)
BIN_DIR  := $(HOME)/.local/bin

help:
	@echo ""
	@echo "  bee - CloudBees CLI"
	@echo ""
	@echo "    make init        Setup bee and add to bin dir (checks deps)"
	@echo "    make install     Install local dependencies (run once)"
	@echo "    make uninstall   Remove bee"
	@echo "    make run         make run ARGS='job list'"
	@echo "    make ui          Launch TUI"
	@echo ""

install:
	@echo "Installing dependencies..."
	@mkdir -p ./lib
	@pip3 install --target=./lib $(DEPS) -q 2>/dev/null || \
	 echo "[WARN] pip3 failed — run: pip3 install --target=./lib $(DEPS)"

init:
	@if [ ! -d "./lib" ] || [ -z "$$(ls -A ./lib 2>/dev/null)" ]; then \
		$(MAKE) install; \
	else \
		echo "Dependencies already installed in ./lib, skipping install."; \
	fi
	@mkdir -p $(BIN_DIR)
	@printf '#!/bin/sh\n$(PYTHON) $(ABS_PATH)/run.py "$$@"\n' > $(BIN_DIR)/bee
	@chmod +x $(BIN_DIR)/bee
	@echo ""
	@echo "  [OK] bee installed to $(BIN_DIR)/bee"
	@echo ""
	@echo "  If 'bee' is not found, add to PATH:"
	@echo "    bash/zsh : export PATH=\"$(BIN_DIR):\$$PATH\""
	@echo "    csh/tcsh : setenv PATH $(BIN_DIR):\$$PATH"
	@echo ""

uninstall:
	@rm -f $(BIN_DIR)/bee && echo "[OK] Removed bee"
	@rm -rf ./lib && echo "[OK] Removed local dependencies (./lib)"

run:
	@if [ -z "$(ARGS)" ]; then \
		echo "💡 Hint: Provide commands via ARGS (e.g., make run ARGS='job list')"; \
	fi
	$(BIN_DIR)/bee $(ARGS)

ui:
	$(BIN_DIR)/bee --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

.PHONY: help init install uninstall run ui clean
