// Herdr voice on a ChatGPT/Codex subscription. The realtime voice hands every request to a headless
// Claude Code "operator" that drives Herdr (panes, tabs, agents, plugins) and answers in a sentence or two.
// Voice protocol taken from TermRover's voice bridge 0.3.6. Private endpoints: may break on any Codex/OpenAI update.
// Usage: node server.mjs [port]
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PORT = Number(process.argv[2] || process.env.CODEX_VOICE_PORT || 8765);
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const LIVE_URL = "wss://api.openai.com/v1/live/";

const VOICE_INSTRUCTIONS = `You are the voice of a Herdr terminal workspace full of coding agents.
Talk briefly and naturally. Delegate to the client every request to do, check, open, switch, start, or ask anything
about the workspace, its panes, tabs, agents, or code; pass the user's request in their own words, including any
agent or pane names they said. While a request runs, keep chatting or wait quietly.
When results or agent updates arrive, say them in one or two sentences: never read code, paths, URLs or diffs aloud.`;

const OPERATOR_PROMPT = `You are the operator behind a voice assistant for Herdr. Each user message is a spoken request,
transcribed, so expect loose wording and misheard names: match agents, panes, tabs and workspaces by meaning.
Act through the herdr CLI (see the herdr skill): focus or switch workspaces, tabs, panes and agents; open, split, zoom
and close panes and tabs; start agents; prompt agents; read panes; list and invoke plugin actions
(herdr plugin action). Open web pages with /Applications/Herdr.app/Contents/MacOS/Herdr browser open.
Never do coding work yourself: hand it to the agent the user named (herdr agent prompt TARGET TEXT, without --wait)
and say you handed it over; the voice is told when that agent finishes. If no agent was named and it is ambiguous, ask.
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
    "--allowedTools", "Bash(herdr:*)", "Bash(/Applications/Herdr.app/Contents/MacOS/Herdr:*)", "Skill",
  ], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, HERDR_ENV: "1" } });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "assistant") for (const part of ev.message?.content || []) {
      const cmd = part.type === "tool_use" ? part.input?.command : null;
      if (cmd) console.log(`  $ ${cmd.slice(0, 160)}`);
      const target = cmd?.match(/herdr agent prompt\s+("[^"]+"|'[^']+'|\S+)/)?.[1]?.replace(/^["']|["']$/g, "");
      if (target) watched.set(target, "working");
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

function ask(id, text) {
  console.log(`you → operator: ${text}`);
  operator ??= startOperator();
  waiting.push(id);
  operator.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
}

// ---- Tell the voice when an agent the operator handed work to finishes or needs approval, and flag any agent
// waiting for approval so the ring turns amber, call or not.
// ponytail: 3 s poll of `herdr agent list`; switch to `herdr agent wait` per target if polling shows up in CPU.
let approval = false;
setInterval(async () => {
  let agents;
  try { agents = JSON.parse((await exec(HERDR, ["agent", "list"], { maxBuffer: 8 << 20 })).stdout).result.agents; } catch { return; }
  approval = agents.some((a) => a.agent_status === "blocked");
  if (!control) return;
  for (const [target, last] of watched) {
    const a = agents.find((x) => x.pane_id === target || x.name === target || x.terminal_title_stripped === target);
    if (!a) continue;
    const status = a.agent_status;
    if (status === last) continue;
    watched.set(target, status);
    if (!["idle", "done", "blocked"].includes(status) || last !== "working") continue;
    if (status !== "blocked") watched.delete(target);
    let tail = "";
    try { tail = (await exec(HERDR, ["agent", "read", a.pane_id, "--source", "recent-unwrapped", "--lines", "40"], { maxBuffer: 4 << 20 })).stdout.trim().slice(-1200); } catch {}
    const what = status === "blocked" ? "is waiting for approval" : "finished";
    console.log(`← ${a.terminal_title_stripped || a.pane_id} ${what}`);
    context(`Agent "${a.terminal_title_stripped || a.pane_id}" ${what}. Tell the user briefly. Its screen ends with:\n${tail}`);
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

async function startCall(sdp) {
  let creds = await credentials();
  const body = JSON.stringify({ sdp, session: {
    model: "gpt-live-1-codex",
    audio: { output: { voice: process.env.VOICE || "cove" } },
    delegation: { type: "client" },
    instructions: VOICE_INSTRUCTIONS,
  } });
  const post = (c) => fetch(CALL_URL, { method: "POST", redirect: "error", headers: { ...headersFor(c), "content-type": "application/json" }, body });
  let res = await post(creds);
  if (res.status === 401) res = await post(creds = await credentials(true));
  const answer = await res.text();
  if (!res.ok || !answer.startsWith("v=0")) throw new Error(`Call refused (HTTP ${res.status}): ${answer.slice(0, 300)}`);
  const id = res.headers.get("location")?.split("?")[0].split("/").findLast((p) => /^rtc_[\w-]+$/.test(p) || /^[0-9a-f-]{36}$/i.test(p));
  if (!id) throw new Error("No call id in the answer.");

  control?.close();
  operator ??= startOperator(); // warm it up while the call connects
  const socket = control = new WebSocket(LIVE_URL + encodeURIComponent(id), { headers: headersFor(creds) });
  socket.onopen = () => console.log(`call ${id} connected`);
  socket.onclose = (e) => { console.log(`call closed (${e.code})`); if (control === socket) control = null; };
  socket.onmessage = ({ data }) => {
    let ev; try { ev = JSON.parse(data); } catch { return; }
    if (ev.type === "error") console.error("voice error:", JSON.stringify(ev.error));
    const item = ev.item;
    if (ev.type === "delegation.created" && item?.type === "delegation" && item.target === "client") {
      ask(item.id, (item.content || []).filter((p) => p.type === "input_text").map((p) => p.text).join(""));
    }
  };
  return answer;
}

// ---- Page: mic + WebRTC audio. Local only.
const page = readFileSync(new URL("./index.html", import.meta.url));
createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/?float")) return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (req.method === "GET" && req.url === "/state") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ busy: waiting.length > 0, approval }));
  if (req.method === "POST" && req.url === "/offer") {
    let sdp = "";
    for await (const c of req) { sdp += c; if (sdp.length > 262144) return res.writeHead(413).end(); }
    try { const answer = await startCall(sdp); res.writeHead(200, { "content-type": "application/sdp" }).end(answer); }
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
  console.log(`codex-voice on ${url}`);
  // Default: the floating ring window (macOS, built by ring/build.sh). CODEX_VOICE_BROWSER=1 opens a browser tab instead.
  if (process.env.CODEX_VOICE_BROWSER !== "1" && existsSync(RING)) {
    // The real path, not the symlink: VoiceRingKit finds its shader bundle next to the executable.
    ring = spawn(realpathSync(RING), [`${url}/?float`], { stdio: ["ignore", "ignore", "inherit"] });
    ring.on("error", () => { ring = null; openBrowser(url); });
    ring.on("exit", (code) => { if (ring) console.log(`ring window closed (${code ?? "signal"})`); ring = null; });
    return console.log("floating ring is up: click it to call, drag to move, right-click to quit");
  }
  openBrowser(url);
});

const RING = new URL("./ring/codex-voice-ring", import.meta.url).pathname;
let ring = null;

function openBrowser(url) {
  // Prefer a Herdr UI tab beside this pane, then terminal-browser (needs "media" in its GRANTED permissions);
  // otherwise the user opens the URL in a browser that allows the mic.
  execFile("/Applications/Herdr.app/Contents/MacOS/Herdr", ["browser", "open", url, "--beside", "--no-focus"], (err) => {
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
process.on("exit", () => { operator?.kill(); ring?.kill(); });
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
