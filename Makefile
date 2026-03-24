.DEFAULT_GOAL := help

# ── Config ────────────────────────────────────────────────────
PYTHON  := python3
DEPS    := click httpx cryptography
LIB_DIR := ./lib

# ── Help ──────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  CloudBees CLI — available commands"
	@echo ""
	@echo "  Setup:"
	@echo "    make install       Install deps to ./lib/ (recommended)"
	@echo "    make dev           Install for development (pip editable)"
	@echo ""
	@echo "  Run:"
	@echo "    make run ARGS='job list'    Run a command"
	@echo "    make ui                     Launch TUI"
	@echo ""
	@echo "  Dev:"
	@echo "    make test          Run unit tests"
	@echo "    make lint          Lint code"
	@echo "    make format        Format code"
	@echo "    make clean         Remove build artifacts"
	@echo ""

# ── Setup ─────────────────────────────────────────────────────
install:
	@echo ">> Installing dependencies to $(LIB_DIR)/ ..."
	$(PYTHON) -m pip install --target=$(LIB_DIR) $(DEPS) -q
	@echo ""
	@echo "  [OK] Done! Run the tool with:"
	@echo "       $(PYTHON) run.py --help"
	@echo "       $(PYTHON) run.py login"
	@echo ""

dev:
	@echo ">> Installing in editable mode (development) ..."
	pip install -e ".[dev]"
	@echo "  [OK] Done! Run: cb --help"

# ── Run ───────────────────────────────────────────────────────
run:
	$(PYTHON) run.py $(ARGS)

ui:
	$(PYTHON) run.py --ui

# ── Dev tooling ───────────────────────────────────────────────
test:
	$(PYTHON) -m pytest tests/unit/ -v

lint:
	ruff check cb/ tests/

format:
	ruff format cb/ tests/

typecheck:
	mypy cb/

# ── Clean ─────────────────────────────────────────────────────
clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

clean-all: clean
	rm -rf lib/ data/ .venv/ *.egg-info/

.PHONY: help install dev run ui test lint format typecheck clean clean-all
