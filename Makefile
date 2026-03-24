.DEFAULT_GOAL := help

PYTHON  := python3
DEPS    := click httpx cryptography

help:
	@echo ""
	@echo "  CloudBees CLI"
	@echo ""
	@echo "    make install       Install dependencies (first time setup)"
	@echo "    make run           Run: make run ARGS='job list'"
	@echo "    make ui            Launch TUI"
	@echo "    make clean         Remove cache files"
	@echo ""

install:
	$(PYTHON) -m pip install --target=./lib $(DEPS) -q
	@echo "[OK] Ready. Run: $(PYTHON) run.py --help"

run:
	$(PYTHON) run.py $(ARGS)

ui:
	$(PYTHON) run.py --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

.PHONY: help install run ui clean
