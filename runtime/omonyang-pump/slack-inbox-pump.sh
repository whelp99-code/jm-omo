#!/bin/bash
set -u
export OMO_STATE=/home/jm/.local/state/omonyang
export OMO_DB=/home/jm/.omo/omonyang/durable/inbox.sqlite
export HERDR_BIN=/home/jm/.local/bin/herdr
mkdir -p "$OMO_STATE"
exec /usr/bin/python3 /home/jm/.local/lib/omonyang/slack-inbox-pump.py
