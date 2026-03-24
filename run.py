#!/usr/bin/env python3
"""
cb — CloudBees CLI launcher.

This script auto-adds ./lib to sys.path so that dependencies
installed via 'pip install --target=./lib ...' are found
without needing a virtualenv or system-wide install.

Usage:
    python3 run.py [cb commands]
    ./run.py --help
    ./run.py job list
    ./run.py --ui
"""
import sys
import os
from pathlib import Path

# Add ./lib to path if it exists (local deps installed via --target)
_lib = Path(__file__).parent / "lib"
if _lib.exists() and str(_lib) not in sys.path:
    sys.path.insert(0, str(_lib))

# Add project root to path
_root = Path(__file__).parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from cb.main import cli

if __name__ == "__main__":
    cli()
