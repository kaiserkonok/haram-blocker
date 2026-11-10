#!/bin/sh
# Chrome starts this (native messaging). Runs the helper with its own Python.
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/.venv/bin/python" -u "$HERE/host.py" "$@" 2>>"${HOME}/.local/state/haram-blocker/helper.stderr.log"
