.DEFAULT_GOAL := help

SHELL := /bin/bash

help:
	@echo ""
	@echo "  bee - CloudBees CLI (TypeScript/Bun)"
	@echo ""
	@echo "    make init        Install deps + build binary"
	@echo "    make install     Install dependencies (bun install)"
	@echo "    make build       Compile binary → dist/bee"
	@echo "    make dev         Run from source: make dev ARGS='job list'"
	@echo "    make run         Run the built binary: make run ARGS='job list'"
	@echo "    make typecheck   Type-check the project (tsc --noEmit)"
	@echo "    make test        Run test suite"
	@echo "    make clean       Remove dist/ and node_modules/"
	@echo ""

install:
	@bun install

build: install
	@bun run build.ts

init: build
	@echo ""
	@echo "  [OK] bee binary built at ./dist/bee"
	@echo "  Run: ./dist/bee --help"
	@echo ""

dev:
	@bun run src/main.ts $(ARGS)

run:
	@./dist/bee $(ARGS)

typecheck:
	@bunx tsc --noEmit -p tsconfig.json && echo "  [OK] No type errors"

test:
	@bun test

clean:
	@rm -rf dist node_modules

.PHONY: help init install build dev test clean run typecheck
