-- codex-voice: the focused pane of the session this script runs against (rex do -s SESSION), as JSON.
local T = "com.superlogical.terminal"
local view = rex.session.view{} or {}
local win
for _, w in ipairs(view.windows or {}) do if w.window_id == view.active_window_id then win = w end end
if not win or not win.focused_block_id then return nil end
local id = win.focused_block_id
local root
for _, r in ipairs((rex.block.call(T, "program_status", { block_id = id }) or {}).records or {}) do if not r.id then root = r end end
local p = (rex.block.call(T, "process", { block_id = id }) or {}).foreground or {}
return {
  session_id = view.session_id, session = view.label, window_id = win.window_id, tab = win.label, block_id = id,
  title = (rex.block.call(T, "title", { block_id = id }) or {}).title,
  app = root and root.app, state = root and root.state, program = p.argv0 or p.name, cwd = p.cwd,
}
