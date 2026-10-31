-- codex-voice: every terminal in every Rex session with its title and program status, as one JSON list.
-- server.mjs polls it with `rex do` so the poll is one process, not one per pane.
local T = "com.superlogical.terminal"
local out = {}
for _, s in ipairs((rex.call("session.list") or {}).sessions or {}) do
  if rex.session.attach{ session_id = s.session_id } then
    for _, b in ipairs((rex.session.list_blocks{ session_id = s.session_id } or {}).blocks or {}) do
      if b.creator_name == T then
        local st = rex.block.call(T, "program_status", { block_id = b.block_id }) or {}
        local root = nil
        for _, r in ipairs(st.records or {}) do if not r.id then root = r end end
        table.insert(out, {
          session_id = s.session_id, session = s.label, block_id = b.block_id, label = b.label,
          title = (rex.block.call(T, "title", { block_id = b.block_id }) or {}).title,
          app = root and root.app, state = root and root.state, msg = root and root.msg,
        })
      end
    end
  end
end
return out
