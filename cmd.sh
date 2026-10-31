#!/bin/sh
# Voice actions: send call | dictate | ring to the running server, or start the voice pane if it isn't up.
# Herdr plugin actions call it with one argument; Rex init.lua actions add the session the key was pressed in.
curl -fs -X POST "http://127.0.0.1:${CODEX_VOICE_PORT:-8765}/cmd/$1${2:+?session=$2}" && exit
if [ -n "$HERDR_BIN_PATH" ]; then
  exec "$HERDR_BIN_PATH" plugin pane open --plugin dorofeev.codex-voice --entrypoint voice
fi
dir=$(cd "$(dirname "$0")" && pwd)
# Rex runs init.lua actions without its own CLI on PATH.
rex=$(command -v rex || echo "$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex")
exec "$rex" window new ${2:+-s "$2"} codex-voice -c "$dir" --focus=false -- env CODEX_VOICE_BACKEND=rex node server.mjs
