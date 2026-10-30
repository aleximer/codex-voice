#!/bin/sh
# Plugin actions: send call | dictate | ring to the running server, or start the voice pane if it isn't up.
curl -fs -X POST "http://127.0.0.1:${CODEX_VOICE_PORT:-8765}/cmd/$1" ||
  exec "$HERDR_BIN_PATH" plugin pane open --plugin dorofeev.codex-voice --entrypoint voice
