// The multiplexer side of codex-voice: Herdr or Rex. server.mjs only talks to the one picked here.
// Each backend: focus(), paste(text), agents(), tail(agent), matches(agent, target), and the operator's tools and how-to.
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const exec = promisify(execFile);
const json = async (bin, args, opts = {}) => JSON.parse((await exec(bin, args, { maxBuffer: 16 << 20, ...opts })).stdout);

// ---- Herdr
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const HERDR_UI = "/Applications/Herdr.app/Contents/MacOS/Herdr";

const herdr = {
  name: "Herdr",
  /** The focused pane: {pane, workspace, tab, agent, title}; null if Herdr can't say. */
  async focus() {
    let snap;
    try { snap = (await json(HERDR, ["api", "snapshot"])).result.snapshot; } catch { return null; }
    const pane = snap.panes?.find((p) => p.pane_id === snap.focused_pane_id);
    if (!pane) return null;
    const agent = snap.agents?.find((a) => a.pane_id === pane.pane_id);
    return {
      pane: pane.pane_id,
      workspace: snap.workspaces?.find((w) => w.workspace_id === pane.workspace_id)?.label ?? pane.workspace_id,
      tab: snap.tabs?.find((t) => t.tab_id === pane.tab_id)?.label ?? pane.tab_id,
      agent: agent?.name ?? pane.agent ?? null,
      title: pane.terminal_title_stripped || null,
    };
  },
  async paste(text) {
    const pane = (await json(HERDR, ["api", "snapshot"])).result.snapshot.focused_pane_id;
    await exec(HERDR, ["pane", "send-text", pane, text]);
    return pane;
  },
  async enter() {
    const pane = (await json(HERDR, ["api", "snapshot"])).result.snapshot.focused_pane_id;
    await exec(HERDR, ["pane", "send-keys", pane, "enter"]);
    return pane;
  },
  /** [{id, name, title, status: working | idle | done | blocked}] */
  async agents() {
    return (await json(HERDR, ["agent", "list"])).result.agents.map((a) => ({
      id: a.pane_id, name: a.name, title: a.terminal_title_stripped, status: a.agent_status,
    }));
  },
  async tail(a) {
    return (await exec(HERDR, ["agent", "read", a.id, "--source", "recent-unwrapped", "--lines", "40"], { maxBuffer: 4 << 20 })).stdout;
  },
  matches: (a, target) => a.id === target || a.name === target || a.title === target,
  /** The pane an operator command handed work to, if it did. */
  promptTarget: (cmd) => cmd.match(/herdr agent prompt\s+("[^"]+"|'[^']+'|\S+)/)?.[1]?.replace(/^["']|["']$/g, ""),
  tools: ["Bash(herdr:*)", `Bash(${HERDR_UI}:*)`, "Skill"],
  env: { HERDR_ENV: "1" },
  howto: `Act through the herdr CLI (see the herdr skill): focus or switch workspaces, tabs, panes and agents; open, split, zoom
and close panes and tabs; start agents; prompt agents; read panes; list and invoke plugin actions
(herdr plugin action). Open web pages with ${HERDR_UI} browser open.
Hand coding work to an agent with herdr agent prompt TARGET TEXT, without --wait.`,
};

// ---- Rex
const LUA = (f) => new URL(`./rex/${f}`, import.meta.url).pathname;
// The session the user last acted in. Rex doesn't say which session is on screen, so rex/watch.lua reports every
// session whose layout or focus changes, and the voice actions pass the session they were pressed in.
let rexSession = process.env.REX_SESSION || null;

const rex = {
  name: "Rex",
  setSession(id) { if (/^session:[\w-]+$/.test(id || "")) rexSession = id; },
  watch() {
    const child = spawn("rex", ["do", "--all", LUA("watch.lua")], { stdio: ["ignore", "pipe", "ignore"] });
    createInterface({ input: child.stdout }).on("line", (l) => rex.setSession(l.trim()));
    child.on("error", () => {});
    return child;
  },
  /** The focused pane of the session the user is in: {pane, session_id, workspace, tab, agent, title, program}. */
  async focus() {
    let f;
    try { f = await json("rex", ["do", ...(rexSession ? ["-s", rexSession] : []), LUA("focus.lua")]); } catch { return null; }
    if (!f?.block_id) return null;
    return {
      pane: f.block_id, session_id: f.session_id, workspace: f.session, tab: f.tab,
      agent: f.app ?? null, title: f.title || null, program: f.program?.replace(/^-/, "") ?? null,
    };
  },
  async paste(text) {
    const f = await rex.focus();
    if (!f) throw new Error("no focused Rex pane");
    await exec("rex", ["send", "-s", f.session_id, "-b", f.pane, text]);
    return f.pane;
  },
  async enter() {
    const f = await rex.focus();
    if (!f) throw new Error("no focused Rex pane");
    await exec("rex", ["send-key", "-s", f.session_id, "-b", f.pane, "enter"]);
    return f.pane;
  },
  async agents() {
    return (await json("rex", ["do", LUA("agents.lua")])).filter((b) => b.app).map((b) => ({
      id: b.block_id, session_id: b.session_id, name: b.label !== "shell" ? b.label : null, title: b.title,
      // Codex doesn't report "blocked" as program status yet; its title says "Action Required" instead.
      status: b.state === "blocked" || /action required/i.test(b.title || "") ? "blocked"
        : b.state === "error" ? "done" : b.state,
    }));
  },
  async tail(a) {
    const out = (await exec("rex", ["capture", "-s", a.session_id, "-b", a.id, "--trim", "--unwrap"], { maxBuffer: 64 << 20 })).stdout;
    return out.split("\n").slice(-40).join("\n");
  },
  matches: (a, target) => a.id === target || a.id.endsWith(target) || a.name === target || a.title === target,
  promptTarget: (cmd) => /^\s*rex\s+send\s/.test(cmd) ? cmd.match(/(?:-b|--block)[ =]("[^"]+"|'[^']+'|\S+)/)?.[1]?.replace(/^["']|["']$/g, "") : undefined,
  tools: ["Bash(rex:*)", "Skill"],
  // Not the server pane's own ids: "here" for the operator is the focused pane the notes name.
  env: { REX_BLOCK: undefined, REX_SESSION: undefined },
  howto: `Act through the rex CLI (see the rex skill): list sessions, tabs (windows) and panes (blocks); focus, open, split,
zoom, move and close them; read panes (rex capture); run commands in new tabs or splits. Always pass -s SESSION and
-b BLOCK with full ids. A pane's agent shows in rex block call -s SESSION -b BLOCK program_status (app, state) and title.
Hand coding work to an agent by typing into its pane: rex send -s SESSION -b BLOCK 'TEXT' then
rex send-key -s SESSION -b BLOCK enter.`,
};

/** CODEX_VOICE_BACKEND=herdr|rex, else Rex inside a Rex terminal and Herdr otherwise. */
export const backend = (process.env.CODEX_VOICE_BACKEND || (process.env.REX_SESSION && !process.env.HERDR_ENV ? "rex" : "herdr")) === "rex" ? rex : herdr;
