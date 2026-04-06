.DEFAULT_GOAL := help

SHELL    := /bin/bash

export LANG := en_US.UTF-8
export LC_ALL := en_US.UTF-8

# User Configuration File
-include makefile_vars

export VERSION
export RIDE_ROOT
export LD_LIBRARY_PATH := /usr/local/gcc-9.2.0/lib64:$(RIDE_ROOT)/local/openssl/lib64:$(RIDE_ROOT)/local/serf-1.3.10/lib:$(RIDE_ROOT)/local/svn/lib:$(RIDE_ROOT)/local/Python-3.10.0/lib
export PATH            := $(shell pwd)/.venv/bin:$(RIDE_ROOT)/local/Python-3.10.0/bin:$(RIDE_ROOT)/local/openssl/bin:$(RIDE_ROOT)/local/svn/bin:$(RIDE_ROOT)/local/sqlite/bin:$(PATH)

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
	@{ \
		echo "export LANG=en_US.UTF-8"; \
		echo "export LC_ALL=en_US.UTF-8"; \
		echo "export VERSION=\"$(VERSION)\""; \
		echo "export RIDE_ROOT=\"$(RIDE_ROOT)\""; \
		echo "export LD_LIBRARY_PATH=\"$(LD_LIBRARY_PATH)\""; \
	} >> .venv/bin/activate
	@{ \
		echo "setenv LANG en_US.UTF-8"; \
		echo "setenv LC_ALL en_US.UTF-8"; \
		echo "setenv VERSION \"$(VERSION)\""; \
		echo "setenv RIDE_ROOT \"$(RIDE_ROOT)\""; \
		echo "setenv LD_LIBRARY_PATH \"$(LD_LIBRARY_PATH)\""; \
	} >> .venv/bin/activate.csh
	@./.venv/bin/pip install --upgrade pip setuptools wheel
	@./.venv/bin/pip install .

init:
	@if [ ! -d ".venv" ]; then \
		$(MAKE) install; \
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
		echo "  [Hint] You can also run 'source .venv/bin/activate' to use 'bee' directly."; \
	fi
	bee $(ARGS)

ui:
	bee --ui

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

.PHONY: help init install uninstall run ui clean
