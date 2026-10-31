---
name: codex-voice
description: Control the codex-voice ring (voice call, dictation, show/hide) through its local server. Use when the user asks to start or end a voice call, switch to or stop dictation, or show or hide the voice ring.
---

# codex-voice

The codex-voice server listens on `http://127.0.0.1:8765` (`CODEX_VOICE_PORT` overrides the port). Each command
is one POST; the ring picks it up within half a second. A `204` means it was queued.

| User says | Run |
|---|---|
| "start a call", "call", "hang up", "end the call" | `curl -fsS -X POST http://127.0.0.1:8765/cmd/call` |
| "switch to dictate", "dictate", "stop dictating" | `curl -fsS -X POST http://127.0.0.1:8765/cmd/dictate` |
| "show / hide / toggle the ring" | `curl -fsS -X POST http://127.0.0.1:8765/cmd/ring` |

- Each command is a toggle: `call` in a call hangs up, `dictate` while dictating stops.
- Switching needs one command: `dictate` during a call ends the call and starts dictation, and `call` during
  dictation does the reverse. Don't hang up first.
- Send one command at a time: a second POST within half a second replaces the first.
- Don't GET `/state` to check: reading it consumes a queued command. It can't tell you whether a call is on anyway.
- Hiding the ring hangs up any call.
- If curl can't connect, the server isn't running. Tell the user to start it (Herdr: **Start voice**; Rex: any
  voice key) rather than starting it yourself.
