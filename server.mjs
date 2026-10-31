// Herdr or Rex voice on a ChatGPT/Codex subscription. The realtime voice hands every request to a headless
// Claude Code "operator" that drives the multiplexer (panes, tabs, agents) and answers in a sentence or two.
// Voice protocol taken from TermRover's voice bridge 0.3.6. Private endpoints: may break on any Codex/OpenAI update.
// Usage: node server.mjs [port]
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { backend } from "./backends.mjs";

const exec = promisify(execFile);
const PORT = Number(process.argv[2] || process.env.CODEX_VOICE_PORT || 8765);
const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const LIVE_URL = "wss://api.openai.com/v1/live/";

const VOICE_INSTRUCTIONS = `You are the voice of a ${backend.name} terminal workspace full of coding agents.
Talk briefly and naturally. Delegate to the client every request to do, check, open, switch, start, or ask anything
about the workspace, its panes, tabs, agents, or code; pass the user's request in their own words, including any
agent or pane names they said. While a request runs, keep chatting or wait quietly.
When results or agent updates arrive, say them in one or two sentences: never read code, paths, URLs or diffs aloud.`;
// Dictation calls only want the user's transcript; the page also mutes the voice in case it talks anyway.
const DICTATE_INSTRUCTIONS = `You are a dictation microphone. Never speak, answer, or delegate. Stay silent at all times.`;

const OPERATOR_PROMPT = `You are the operator behind a voice assistant for ${backend.name}. Each user message is a spoken request,
transcribed, so expect loose wording and misheard names: match agents, panes, tabs and workspaces by meaning.
${backend.howto}
Never do coding work yourself: hand it to the agent the user named and say you handed it over; the voice is told when that agent finishes. If no agent was named and it is ambiguous, ask.
A request may start with a [Where the user is as the call starts] or [Focus changed …] note: that pane (and any
browser page listed) is what the user is looking at, so "this agent", "this page", "here" or an unnamed agent means it; mention the switch briefly in your reply when it matters.
Do not close panes or tabs that run an agent, or approve an agent's permission prompt, unless the user said so explicitly.
Your final reply is spoken aloud: one or two plain sentences, no code, paths, URLs or markdown.`;

// ---- Claude operator: one long-lived headless session, replies come back on stdout as stream-json.
let operator = null;
const waiting = []; // delegation ids answered by the next operator result
const watched = new Map(); // agent target -> last status, for agents the operator prompted this call

function startOperator() {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", process.env.OPERATOR_MODEL || "sonnet",
    "--append-system-prompt", OPERATOR_PROMPT,
    "--allowedTools", ...backend.tools,
  ], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...backend.env } });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "assistant") for (const part of ev.message?.content || []) {
      const cmd = part.type === "tool_use" ? part.input?.command : null;
      if (cmd) console.log(`  $ ${cmd.slice(0, 160)}`);
      const target = cmd && backend.promptTarget(cmd);
      // "prompted", not "working": only a status seen as working first counts as finishing, so the agent's
      // idle status from before it read the prompt isn't taken for "finished".
      if (target) watched.set(target, "prompted");
    }
    if (ev.type === "result") {
      const text = (ev.result || (ev.is_error ? "The operator hit an error." : "Done.")).trim();
      console.log(`operator: ${text}`);
      // Queued requests can be merged into one turn: the newest delegation carries the answer, older ones just close.
      const ids = waiting.splice(0);
      ids.slice(0, -1).forEach((id) => reply(id, "Handled together with the next request.", "commentary"));
      if (ids.length) reply(ids.at(-1), text);
      else context(text);
    }
  });
  child.on("exit", (code) => { console.error(`operator exited (${code})`); operator = null; });
  return child;
}

// Focus seen at the previous request, kept in a file so it survives restarts.
const FOCUS_FILE = join(homedir(), ".local/state/codex-voice/focus.json");

/** The focused pane, its workspace, tab and agent; null if the multiplexer can't say. Saved as the last seen focus. */
async function focusNow() {
  const now = await backend.focus();
  if (!now) return null;
  try { mkdirSync(dirname(FOCUS_FILE), { recursive: true }); writeFileSync(FOCUS_FILE, JSON.stringify(now)); } catch {}
  return now;
}
const where = (f) => `pane ${f.pane} in workspace "${f.workspace}", tab "${f.tab}", running ${
  f.agent ? `${f.agent}${f.title ? ` ("${f.title}")` : ""}` : `no agent (a plain terminal${f.program ? ` running ${f.program}` : ""})`}`;

/** A note for the operator when the focused pane changed since the last request, else "". */
async function focusNote() {
  let before = null;
  try { before = JSON.parse(readFileSync(FOCUS_FILE, "utf8")); } catch {}
  const now = await focusNow();
  if (!now || before?.pane === now.pane) return "";
  return `[Focus changed since the last request: the user is now looking at ${where(now)}.]\n`;
}

/** Pages open in browsers beside the terminals: the active tab of each terminal-browser, and Herdr UI's
 *  browser tabs when the app runs. [{title, url, pane?}] */
async function openPages() {
  const pages = [];
  try {
    const { browsers = [] } = JSON.parse((await exec("terminal-browser", ["ls", "--all", "--json"], { timeout: 3000 })).stdout);
    for (const b of browsers) for (const t of b.tabs ?? []) if (t.active && t.url) pages.push({ title: t.title, url: t.url, pane: b.pane?.pane });
  } catch {}
  if (backend.name === "Herdr") try {
    // ponytail: Herdr UI's list shape isn't documented here; take any entry with a url that is active or focused.
    const list = JSON.parse((await exec("/Applications/Herdr.app/Contents/MacOS/Herdr", ["browser", "list", "--json"], { timeout: 3000 })).stdout);
    const walk = (v) => Array.isArray(v) ? v.forEach(walk) : v && typeof v === "object" && (
      typeof v.url === "string" && (v.active || v.focused || v.selected) ? pages.push({ title: v.title, url: v.url }) : Object.values(v).forEach(walk));
    walk(list);
  } catch {}
  return pages.filter((p) => !/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?(\?float)?$/.test(p.url)); // not our own page
}

/** Where the user is as a call starts, for the voice and the operator; "" if nothing is known. */
async function callContext() {
  const [focus, pages] = await Promise.all([focusNow(), openPages()]);
  const lines = [];
  if (focus) lines.push(`Focused: ${where(focus)}.`);
  for (const p of pages.slice(0, 3)) lines.push(`Browser page open${p.pane === focus?.pane ? " in the focused pane" : ""}: "${p.title || p.url}" ${p.url}`);
  return lines.length ? `[Where the user is as the call starts]\n${lines.join("\n")}\n` : "";
}
let callNote = ""; // sent with the call's first request, then the focus notes take over

// Requests go to the operator in order, each after its focus check.
let queue = Promise.resolve();
function ask(id, text) {
  console.log(`you → operator: ${text}`);
  operator ??= startOperator();
  waiting.push(id);
  queue = queue.then(async () => {
    const note = callNote + await focusNote();
    callNote = "";
    if (note) console.log(`  ${note.trim()}`);
    operator?.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: note + text } }) + "\n");
  });
}

// ---- Tell the voice when an agent the operator handed work to finishes or needs approval, and flag any agent
// waiting for approval so the ring turns amber, call or not.
// ponytail: 3 s poll of every agent (one herdr or rex process); switch to events if polling shows up in CPU.
let approval = false;
setInterval(async () => {
  let agents;
  try { agents = await backend.agents(); } catch { return; }
  approval = agents.some((a) => a.status === "blocked");
  if (!control) return;
  for (const [target, last] of watched) {
    const a = agents.find((x) => backend.matches(x, target));
    if (!a) continue;
    const status = a.status;
    if (status === last) continue;
    watched.set(target, status);
    if (!["idle", "done", "blocked"].includes(status) || last !== "working") continue;
    if (status !== "blocked") watched.delete(target);
    let tail = "";
    try { tail = (await backend.tail(a)).trim().slice(-1200); } catch {}
    const what = status === "blocked" ? "is waiting for approval" : "finished";
    console.log(`← ${a.title || a.name || a.id} ${what}`);
    context(`Agent "${a.title || a.name || a.id}" ${what}. Tell the user briefly. Its screen ends with:\n${tail}`);
  }
}, 3000).unref();

// ---- Voice call on the Codex subscription. The token comes from Codex's own login and never leaves this process.
async function credentials(refresh = false) {
  const child = spawn("codex", ["app-server", "-c", 'model_provider="openai"'], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "codex_voice", title: "codex-voice", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const status = await request("getAuthStatus", { includeToken: true, refreshToken: refresh });
    if (status?.authMethod !== "chatgpt" || !status.authToken) throw new Error("Codex is not logged in with ChatGPT (run `codex login`).");
    const claims = JSON.parse(Buffer.from(status.authToken.split(".")[1], "base64url"));
    const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountId) throw new Error("No ChatGPT account id in the Codex token.");
    return { token: status.authToken, accountId };
  } finally {
    child.kill();
  }
}

const headersFor = ({ token, accountId }) => ({
  authorization: `Bearer ${token}`,
  "ChatGPT-Account-ID": accountId,
  "openai-alpha": "quicksilver=v2",
  originator: "codex_voice",
});

let control = null;
const send = (msg) => control?.readyState === WebSocket.OPEN && control.send(JSON.stringify(msg));
// The protocol caps each appended chunk at 500 bytes.
const chunks = (text) => text.match(/[\s\S]{1,400}/g) || [];
const reply = (id, text, channel = "speakable") => chunks(text).forEach((t) =>
  send({ type: "delegation.context.append", delegation_item_id: id, channel, content: [{ type: "input_text", text: t }] }));
const context = (text, channel = "speakable") => chunks(text).forEach((t) =>
  send({ type: "session.context.append", channel, content: [{ type: "input_text", text: t }] }));

// Dictation: each finished utterance is typed into the focused pane, without Enter. An utterance that is only
// "send" (or "send it") presses Enter instead.
const SEND = /^\W*send( it)?\W*$/i;
async function paste(text) {
  try {
    if (SEND.test(text)) return console.log(`sent (Enter) in ${await backend.enter()}`);
    const pane = await backend.paste(text + " ");
    console.log(`dictated into ${pane}: ${text}`);
  } catch (e) { console.error("dictation paste failed:", e.message); }
}

async function startCall(sdp, dictate = false) {
  // The voice and the operator both learn where the user is, so "this agent" or "this page" needs no guessing.
  const [c, here] = await Promise.all([credentials(), dictate ? "" : callContext()]);
  let creds = c;
  callNote = here;
  if (here) console.log(here.trim());
  const body = JSON.stringify({ sdp, session: {
    model: "gpt-live-1-codex",
    audio: { output: { voice: process.env.VOICE || "cove" } },
    delegation: { type: "client" },
    instructions: dictate ? DICTATE_INSTRUCTIONS : here ? `${VOICE_INSTRUCTIONS}\n\n${here}` : VOICE_INSTRUCTIONS,
  } });
  const post = (c) => fetch(CALL_URL, { method: "POST", redirect: "error", headers: { ...headersFor(c), "content-type": "application/json" }, body });
  let res = await post(creds);
  if (res.status === 401) res = await post(creds = await credentials(true));
  const answer = await res.text();
  if (!res.ok || !answer.startsWith("v=0")) throw new Error(`Call refused (HTTP ${res.status}): ${answer.slice(0, 300)}`);
  const id = res.headers.get("location")?.split("?")[0].split("/").findLast((p) => /^rtc_[\w-]+$/.test(p) || /^[0-9a-f-]{36}$/i.test(p));
  if (!id) throw new Error("No call id in the answer.");

  control?.close();
  if (!dictate) operator ??= startOperator(); // warm it up while the call connects
  const socket = control = new WebSocket(LIVE_URL + encodeURIComponent(id), { headers: headersFor(creds) });
  let said = ""; // this utterance's transcript so far
  socket.onopen = () => console.log(`call ${id} connected`);
  // Still the current socket means nobody hung up (POST /stop clears it first): the call dropped.
  socket.onclose = (e) => {
    console.log(`call closed (${e.code})`);
    if (control === socket) { control = null; dropped = true; console.log("call dropped: the page hangs up and the ring flashes red"); }
  };
  socket.onmessage = ({ data }) => {
    let ev; try { ev = JSON.parse(data); } catch { return; }
    if (ev.type === "error") console.error("voice error:", JSON.stringify(ev.error));
    const item = ev.item;
    if (dictate) {
      if (ev.type === "input_transcript.added") said += item?.text || "";
      if (ev.type === "turn.done" && ev.turn?.role === "user") {
        const text = (ev.turn.transcript || said).trim();
        said = "";
        if (text) paste(text);
      }
      return;
    }
    if (ev.type === "delegation.created" && item?.type === "delegation" && item.target === "client") {
      ask(item.id, (item.content || []).filter((p) => p.type === "input_text").map((p) => p.text).join(""));
    }
  };
  return answer;
}

// ---- Page: mic + WebRTC audio. Local only.
const page = readFileSync(new URL("./index.html", import.meta.url));
let cmd = null; // call | dictate | ring, for the page to run
let dropped = false; // the voice service closed the call; told to the page once
// Seconds without speech before the page hangs up (0: never), so a forgotten call stops using the quota.
const IDLE_SECONDS = Number(process.env.CODEX_VOICE_IDLE_SECONDS ?? 120);
createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/?float")) return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ busy: waiting.length > 0, approval, cmd, dropped, idleSeconds: IDLE_SECONDS }));
    cmd = null;
    dropped = false;
    return;
  }
  // Plugin actions (Herdr keybindings, Rex init.lua actions): the page picks the command up with its next /state poll.
  // Rex actions pass ?session=ID, the session the key was pressed in.
  const m = req.method === "POST" && req.url.match(/^\/cmd\/(call|dictate|ring)(?:\?session=([\w:%-]+))?$/);
  if (m) {
    if (m[2]) backend.setSession?.(decodeURIComponent(m[2]));
    // After Quit ring, show/hide starts it again rather than toggling a window that is gone.
    if (m[1] === "ring" && !ring && process.env.CODEX_VOICE_BROWSER !== "1" && existsSync(RING)) launchRing();
    else cmd = m[1];
    return res.writeHead(204).end();
  }
  if (req.method === "POST" && (req.url === "/offer" || req.url === "/offer?dictate")) {
    let sdp = "";
    for await (const c of req) { sdp += c; if (sdp.length > 262144) return res.writeHead(413).end(); }
    try { const answer = await startCall(sdp, req.url.endsWith("?dictate")); res.writeHead(200, { "content-type": "application/sdp" }).end(answer); }
    catch (e) { console.error(e.message); res.writeHead(502).end(e.message); }
    return;
  }
  if (req.method === "POST" && req.url === "/stop") {
    send({ type: "session.close" }); control?.close(); control = null; watched.clear();
    return res.writeHead(204).end();
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`codex-voice on ${url} (${backend.name})`);
  watcher = backend.watch?.();
  // Default: the floating ring window (macOS, built by ring/build.sh). CODEX_VOICE_BROWSER=1 opens a browser tab instead.
  if (process.env.CODEX_VOICE_BROWSER !== "1" && existsSync(RING)) return launchRing();
  openBrowser(url);
});

function launchRing() {
  const url = `http://localhost:${PORT}`;
  // The real path, not the symlink: VoiceRingKit finds its shader bundle next to the executable.
  ring = spawn(realpathSync(RING), [`${url}/?float`], { stdio: ["ignore", "ignore", "inherit"] });
  ring.on("error", () => { ring = null; openBrowser(url); });
  ring.on("exit", (code) => { if (ring) console.log(`ring window closed (${code ?? "signal"}); the show/hide ring action brings it back`); ring = null; });
  console.log("floating ring is up: click it to call, drag to move, right-click for more");
}

const RING = new URL("./ring/codex-voice-ring", import.meta.url).pathname;
let ring = null;

function openBrowser(url) {
  // Prefer a Herdr UI tab beside this pane, then terminal-browser (needs "media" in its GRANTED permissions);
  // otherwise the user opens the URL in a browser that allows the mic.
  const herdrUI = (cb) => backend.name === "Herdr"
    ? execFile("/Applications/Herdr.app/Contents/MacOS/Herdr", ["browser", "open", url, "--beside", "--no-focus"], cb) : cb(true);
  herdrUI((err) => {
    if (!err) return;
    // A restarted server would otherwise open a second split next to the one already showing the page.
    execFile("terminal-browser", ["ls", "--all"], (_, list = "") => {
      if (list.includes(url)) return console.log(`page already open in terminal-browser; reload it there`);
      execFile("terminal-browser", ["open", url, "--split", "right", "--size", "0.35"], (err2) => {
        if (err2) console.log(`open ${url} in your browser`);
      });
    });
  });
}
let watcher = null;
process.on("exit", () => { operator?.kill(); ring?.kill(); watcher?.kill(); });
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
