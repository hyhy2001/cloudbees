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
	@echo "Installing cloudbees-cli locally..."
	@pip3 install --user .

init:
	@$(MAKE) install
	@echo ""
	@echo "  [OK] bee installed via pip"
	@echo ""
	@echo "  If 'bee' is not found, verify ~/.local/bin is in your PATH."
	@echo ""

uninstall:
	@pip3 uninstall bee-cloudbees-cli -y && echo "[OK] Removed bee"
	@rm -rf ./lib && echo "[OK] Removed old local dependencies if any"

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
