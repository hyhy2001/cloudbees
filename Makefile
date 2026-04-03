.DEFAULT_GOAL := help

SHELL    := /bin/bash
PYTHON   := python3
DEPS     := textual rich
ABS_PATH := $(shell pwd)
BIN_DIR  := $(HOME)/.local/bin

help:
	@echo ""
	@echo "  bee - CloudBees CLI"
	@echo ""
	@echo "    make init        Setup bee securely in current directory (.venv)"
	@echo "    make install     Install local dependencies (run once)"
	@echo "    make uninstall   Remove bee"
	@echo "    make run         make run ARGS='job list'"
	@echo "    make ui          Launch TUI"
	@echo ""

install:
	@echo "Creating virtual environment and installing..."
	@python3 -m venv .venv
	@./.venv/bin/pip install .
	@source .venv/bin/activate

init:
	@if [ ! -d ".venv" ]; then \
		$(MAKE) install; \
	else \
		source .venv/bin/activate; \
	fi
	@echo ""
	@echo "  [OK] bee installed securely in ./.venv/bin/bee"
	@echo ""
	@echo "  To use the 'bee' command directly, activate the virtual environment:"
	@echo "    bash/zsh : source .venv/bin/activate"
	@echo "    csh/tcsh : source .venv/bin/activate.csh"
	@echo ""

uninstall:
	@rm -rf .venv
	@echo "  [OK] Removed virtual environment and dependencies"

run:
	@if [ -z "$(ARGS)" ]; then \
		echo "💡 Hint: You can also run 'source .venv/bin/activate' to use 'bee' directly."; \
	fi
	source .venv/bin/activate && bee $(ARGS)

ui:
	source .venv/bin/activate && bee --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

.PHONY: help init install uninstall run ui clean
