# Changelog

## Unreleased

- A dropped or failed call hangs up the page and flashes the ring red, instead of looking connected.
- Calls hang up after two minutes without speech (`CODEX_VOICE_IDLE_SECONDS`, `0` = never).
- README.

- Herdr shortcuts: plugin actions `call`, `dictate` and `ring` (bind them under `[[keys.command]]`).
  Each starts the voice pane if it isn't running.
- The call shortcut during dictation switches straight to a call.
- Show/hide ring hangs up any call when hiding, and relaunches the ring after Quit ring.
- The ring remembers its position across restarts, pulled back onto a visible screen.
- Small glowing icon inside the ring during a call: phone for a call, microphone for dictation.
- Calls start with context: the focused pane's workspace, tab and agent, and the page open in
  terminal-browser (or Herdr UI), for both the voice and the operator.

## 2026-10-30

- Dictation mode: speech is typed into the focused Herdr pane, no Enter; green ring
  (`CODEX_VOICE_RING_DICTATE_COLOR`).
- Ring colours: teal with no call, its own colours in a call, amber while an agent waits for
  approval, grey when muted; tints configurable via env.
- Ring right-click shows the ring's menu (mute, dictate, quit) instead of WebKit's.
- The operator is told when Herdr's focused pane changed since the last request.
- Floating VoiceRing window (native Swift) instead of a browser tab; brighter glow
  (`CODEX_VOICE_RING_GLOW`), size via `CODEX_VOICE_RING_SIZE`.
- Initial version: Codex realtime voice on the ChatGPT subscription, with a headless Claude Code
  operator that drives Herdr.
