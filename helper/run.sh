#!/bin/sh
# Chrome starts this (native messaging). Runs the helper with its own Python.
# The model is downloaded by install.sh; never contact the internet at startup.
export HF_HUB_OFFLINE=1
# One CPU thread: the GPU does the work; more threads just spin.
export OMP_NUM_THREADS=1
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/.venv/bin/python" -u "$HERE/host.py" "$@" 2>>"${HOME}/.local/state/haram-blocker/helper.stderr.log"
