#!/bin/bash
set -u
export MAIN_SESSION=2026-09-27T10-54-26-510Z_01a0e130-e01b-7941-95da-1931cf45f94f.jsonl
export OMO_STATE=/home/jm/.local/state/omonyang
export OMO_DB=/home/jm/.omo/omonyang/durable/inbox.sqlite
export HERDR_BIN=/home/jm/.local/bin/herdr
mkdir -p "$OMO_STATE"
exec /usr/bin/python3 /home/jm/.local/lib/omonyang/slack-inbox-pump.py
