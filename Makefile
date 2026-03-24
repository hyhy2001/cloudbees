install:
	pip install -e ".[dev]"

# Install dependencies into ./lib/ (no virtualenv, no sudo, no permission issues)
# After running this, use: python3 run.py [command]
install-local:
	pip install --target=./lib click httpx cryptography
	@echo ""
	@echo "[OK] Dependencies installed to ./lib/"
	@echo "     Run the tool with: python3 run.py --help"
	@echo "     Or:                python3 run.py job list"

test:
	pytest tests/ -v

lint:
	ruff check cb/ tests/
	ruff format --check cb/ tests/

format:
	ruff format cb/ tests/

typecheck:
	mypy cb/

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
	rm -rf lib/ data/ .venv/

.PHONY: install install-local test lint format typecheck clean
