#!/usr/bin/env python3
"""Read JSON from stdin, extract a key. Usage:
  echo '{"a":1}' | python3 jq.py a          -> 1
  echo '{}' | python3 jq.py a --default '-' -> -
"""
import json, sys

args = sys.argv[1:]
if not args:
    sys.exit("usage: jq.py <key> [--default <val>]")
key = args[0]
default = "-"
if len(args) >= 3 and args[1] == "--default":
    default = args[2]

try:
    d = json.load(sys.stdin)
except json.JSONDecodeError:
    print(default)
    sys.exit(0)

v = d.get(key)
if v is None or v == "":
    print(default)
else:
    print(v)
