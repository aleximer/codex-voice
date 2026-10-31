# codex-voice

Talk to your [Herdr](https://herdr.dev) workspace. A Herdr plugin that puts a floating voice ring on your screen:
click it and speak, and a headless Claude Code operator switches panes and tabs, opens things, runs plugin
actions and hands work to your agents. When an agent it prompted finishes, the voice tells you.

- **Voice:** Codex realtime voice on your ChatGPT subscription (the same backend as TermRover's "call my agent").
- **Operator:** `claude -p` on your Claude subscription, allowed to run only `herdr` commands.
- **Dictation:** a second mode that types what you say into the focused pane, without pressing Enter.

## Requirements

- macOS (Linux works with the browser page instead of the ring; untested)
- Node.js 22+
- [Codex CLI](https://github.com/openai/codex), signed in with ChatGPT (`codex login`)
- [Claude Code](https://claude.com/claude-code), signed in
- Herdr 0.9+
- Optional, for the floating ring: Xcode (VoiceRingKit's Metal shader needs it). Without Xcode the voice opens
  in a browser tab instead.

## Install

```sh
git clone https://github.com/aleximer/codex-voice ~/Herd/codex-voice
herdr plugin link ~/Herd/codex-voice   # builds the ring with ring/build.sh
```

Start it from Herdr's plugin actions (**Start voice**), or run `node server.mjs` in a pane. The pane shows the
live log: what you said, the operator's commands, and its replies. Closing the pane ends everything.

## Rex

The same server drives [Rex](https://www.superlogical.com/rex) instead of Herdr: it picks Rex when started in a
Rex terminal (or set `CODEX_VOICE_BACKEND=rex`). Rex has no plugin UI, so the ring stays a floating window.

```sh
git clone https://github.com/aleximer/codex-voice ~/Herd/codex-voice
sh ~/Herd/codex-voice/ring/build.sh
```

Add the actions to Rex's `init.lua`; each one starts the voice in a background tab if it isn't running:

```lua
local voice = os.getenv("HOME") .. "/Herd/codex-voice/cmd.sh"
for _, a in ipairs({ { "call", "Voice: Call / hang up" }, { "dictate", "Voice: Dictate / stop" }, { "ring", "Voice: Show / hide ring" } }) do
  rex.action{ name = "voice_" .. a[1], title = a[2], run = function(ctx)
    rex.exec({ "sh", voice, a[1], ctx.session_id or "" })
  end }
end
rex.bind("ctrl+alt+a", "voice_call")
rex.bind("ctrl+alt+d", "voice_dictate")
```

What differs from Herdr:

- **Agents** are found by their program status (Claude Code reports it; Codex's "Action Required" title also
  counts as waiting for approval). The operator prompts an agent by typing into its pane.
- **Focus:** Rex doesn't say which session is on screen. The voice uses the session you last pressed a voice key
  in or changed the layout or focus of, and that session's focused pane.
- No Herdr UI browser: pages are read from terminal-browser only.

## Use

| Do | How |
|---|---|
| Call / hang up | Click the ring, or the `call` action |
| Dictate into the focused pane / stop | Right-click the ring, or the `dictate` action (in the browser page: `D`) |
| Submit what you dictated | Say just "send" (or "send it") as its own phrase: it presses Enter |
| Mute / unmute | Right-click the ring (browser page: `M`) |
| Show / hide the ring | The `ring` action; hiding hangs up, and it relaunches the ring after Quit |
| Move the ring | Drag it; the position is kept across restarts |

The call action during dictation switches straight to a call. A call hangs up by itself after two minutes of
silence.

Bind the actions in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+a"
type = "plugin_action"
command = "dorofeev.codex-voice.call"

[[keys.command]]
key = "prefix+alt+d"
type = "plugin_action"
command = "dorofeev.codex-voice.dictate"

[[keys.command]]
key = "prefix+alt+shift+c"
type = "plugin_action"
command = "dorofeev.codex-voice.ring"
```

### What the ring shows

| Ring | Meaning |
|---|---|
| Teal | No call |
| Its own colours, phone icon | In a call |
| Green, microphone icon | Dictating |
| Grey, dim | Muted |
| Amber | An agent in Herdr waits for approval (call or not) |
| Red flash | The call dropped or failed |

### Context the operator gets

At call start the voice and the operator are told which pane is focused (workspace, tab, agent) and which
page is open in terminal-browser or Herdr UI, so "this agent" or "this page" works. When focus moves
during a call, the next request says so.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `CODEX_VOICE_PORT` | `8765` | Local port of the server and page |
| `VOICE` | `cove` | Codex voice |
| `CODEX_VOICE_IDLE_SECONDS` | `120` | Hang up after this long without speech; `0` = never |
| `CODEX_VOICE_BROWSER` | | `1`: open the page in a browser tab instead of the ring |
| `CODEX_VOICE_RING_SIZE` | `100` | Ring diameter in points |
| `CODEX_VOICE_RING_GLOW` | `2` | Stacked copies of the ring; more is brighter |
| `CODEX_VOICE_RING_IDLE_COLOR` | teal | `#rrggbb` tint with no call |
| `CODEX_VOICE_RING_CALL_COLOR` | white | Tint in a call; white keeps the ring's colours |
| `CODEX_VOICE_RING_DICTATE_COLOR` | green | Tint while dictating |
| `CODEX_VOICE_RING_APPROVAL_COLOR` | amber | Tint while an agent waits for approval |
| `CODEX_VOICE_XCODE` | first `/Applications/Xcode*.app` | Xcode used to build the ring |

## How it works

`server.mjs` (Node, no dependencies) serves the page and runs the call:

1. The page (in the ring's hidden web view, or a browser tab) opens the mic and makes a WebRTC offer.
2. The server gets a token from `codex app-server` and posts the offer to the Codex realtime endpoint, then
   opens the call's control socket.
3. When the voice delegates a request, the server passes it to the Claude operator (with a focus note) and
   speaks the operator's reply back through the call.
4. Every 3 s it polls the agents (`herdr agent list`, or `rex/agents.lua` in Rex): agents waiting for approval turn the ring amber, and when an agent
   the operator prompted finishes, the voice is told.

`ring/` is the native window (Swift, [VoiceRingKit](https://github.com/Jakubantalik/Libraries.dev)): the page
reports its state each frame and the ring draws it.

## Caveats

- The Codex realtime endpoint is the one Codex and TermRover use; it isn't a documented public API and may
  change.
- The operator can run any `herdr` command. It is told not to close agent panes or approve permission
  prompts unless you say so explicitly, but that's an instruction, not a hard limit.
- terminal-browser denies microphone access by default; the ring doesn't need it.
