install:
	pip install -e ".[dev]"

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

.PHONY: install test lint format typecheck clean
