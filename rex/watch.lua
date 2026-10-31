-- codex-voice: prints a session's id whenever its layout or focus changes in any session (rex do --all), so the
-- server can tell which session the user is working in. Runs until the server stops it.
-- ponytail: "last session whose view changed" stands in for "the session on screen"; Rex doesn't report the latter.
rex.on("session_view_changed", function(ev)
  io.stdout:write((ev.session_id or rex.session_id or "") .. "\n")
  io.stdout:flush()
end)
