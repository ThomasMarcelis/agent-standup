// adapters/peers.js — messages between agent sessions (agent-peers): how each runtime records a send or an arrival,
// and who is behind an inbox address. An address is uds:<dir>/<name>.sock, where <name> is a Claude Code pid,
// codex-<last 16 hex of the Codex thread id> or hermes-<32 hex, one per Hermes conversation>.
const fs = require('fs');
const path = require('path');
const os = require('os');

const clip = (x, n) => String(x == null ? '' : x).slice(0, n);
// A transcript is read from at most its last AGENT_STANDUP_MAX_MB (24 MB): a 570 MB rollout is mostly tool output nobody scrolls back to, and reading all of it
// would block every client for seconds. The agent is flagged so the page can say its older history was not loaded.
const maxFileBytes = () => Math.floor(Math.max(1024, (+process.env.AGENT_STANDUP_MAX_MB || 24) * 1048576));
// A tree of 115 sub-agents can hold 570 MB in files of a few MB each: the sub-agents share AGENT_STANDUP_SESSION_MB (64 MB), at least 512 KB each; the lead gets the file budget.
const readBudget = (lead, others) => Math.floor(lead ? maxFileBytes() : Math.min(maxFileBytes(), Math.max(Math.min(524288, maxFileBytes()), (+process.env.AGENT_STANDUP_SESSION_MB || 64) * 1048576 / Math.max(1, others))));
// A name or title cut at a word with an ellipsis, never mid-word ("Research what real wounds…", not "Research what real wounds, blunt t").
const label = (x, n) => { const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const cut = s.lastIndexOf(' ', n - 1); return s.slice(0, cut > n * 0.5 ? cut : n - 1).replace(/[\s,;:/–—-]+$/, '') + '…'; };
const ADDR = /uds:(?:[^\s"'<>]*\/)?([\w.-]+)\.sock/;
const KIND = (key) => (/^\d+$/.test(key) ? 'claude' : /^codex-[0-9a-f]{16}$/.test(key) ? 'codex' : /^hermes-[0-9a-f]{32}$/.test(key) ? 'hermes' : 'other');
function parseAddress(a) { const m = ADDR.exec(String(a || '')); return m ? { addr: m[0], key: m[1], kind: KIND(m[1]) } : null; }
const peerId = (x) => 'p_' + String(x).replace(/[^\w-]/g, '_').slice(0, 80);   // a DOM-safe id for the peer's tile

// What arrives in a transcript. Claude Code wraps a peer message as <cross-session-message from="uds:…" from-name="…">;
// Codex and Hermes get the agent-peers frame <peer_message from="<name>" reply_to="uds:…" id="<msg id>">.
const CC_IN = /<cross-session-message from="([^"]*)"(?: from-name="([^"]*)")?(?: from-mode="[^"]*")?>\n?([\s\S]*?)(?:\n?<\/cross-session-message>|$)/;   // a store may have cut the end off: keep what is there
const PM_IN = /<peer_message from="([^"]*)" reply_to="([^"]*)"(?: id="([^"]*)")?>\n?([\s\S]*?)(?:\n?<\/peer_message>|$)/;
const TRAILER = /\s*\(From [^\n]*?, (?:an agent inside )?a (?:Codex CLI session|Hermes profile)[^)]*\)\s*$/;   // what the bridge appends so Claude knows what kind of peer wrote
function incoming(text) {
  if (typeof text !== 'string' || !/<(cross-session-message|peer_message) /.test(text)) return null;
  const a = CC_IN.exec(text), b = PM_IN.exec(text);   // the frame that comes first is the real one: a body may quote the other kind
  if (a && (!b || a.index <= b.index)) return { addr: a[1], name: a[2] || '', msgId: '', text: a[3].replace(TRAILER, '').trim() };
  if (b) return { addr: b[2], name: b[1], msgId: b[3] || '', text: b[4].replace(TRAILER, '').trim() };
  return null;
}
// The delivery state a Codex or Hermes send_peer result reports: a socket write that was accepted, held for the recipient's approval, or refused.
function sendState(text, isError) {
  const t = String(text || '');
  if (isError || /^Not delivered/.test(t) || /^\s*\{\s*"error"/.test(t)) return 'failed';
  if (/holding it for its user|"status":\s*"held"/.test(t)) return 'held';
  return 'accepted';
}

// ---- What could not be read: an adapter that fails (a locked or changed store) must not just vanish from the board. key → message; a later success clears it.
const bad = new Map();
function problem(key, err) {
  if (!err) { bad.delete(key); return; }
  const msg = clip(err && err.message ? err.message : err, 160), prev = bad.get(key);
  if (!prev || prev !== msg) console.error('agent-standup: ' + key + ' unreadable: ' + msg);   // once per distinct message, without any debug flag
  bad.set(key, msg);
}
const problems = () => Object.fromEntries(bad);

// ---- Address book: which session owns an address. Claude's live registry (~/.claude/sessions/<pid>.json) answers for running Claude sessions;
// the Codex and Hermes adapters register resolvers for theirs (a Codex address is the thread id, a Hermes address is only in that conversation's own store).
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => process.env.AGENT_STANDUP_PROJECTS || path.join(claudeDir(), 'projects');
const resolvers = {};
const register = (kind, fn) => { resolvers[kind] = fn; };
const memo = new Map(), pidSeen = new Map(), byMsg = new Map();
const capped = (map, n) => { if (map.size > n) map.delete(map.keys().next().value); };
// A Claude session's pid is in the live registry only while it runs, and a resumed session gets a new one. What was seen alive is remembered, and the wire
// message ids on the board's tails say which session wrote or received a message, so a dead pid in a Hermes or Codex log still has a session behind it.
function indexMessages(ids, who) { for (const id of ids) { const l = byMsg.get(id) || []; if (!l.some((x) => x.proj === who.proj && x.id === who.id)) { l.push(who); byMsg.set(id, l.slice(-2)); capped(byMsg, 8000); } } }
function resolve(addrOrKey, opt = {}) {
  const p = parseAddress(addrOrKey) || (typeof addrOrKey === 'string' && /^[\w.-]+$/.test(addrOrKey) ? { key: addrOrKey, kind: KIND(addrOrKey) } : null);
  if (!p) return null;
  const hit = memo.get(p.key); if (hit && Date.now() - hit.at < 10000 && (hit.v || !opt.msgId)) return hit.v;
  let v = null; try { v = p.kind === 'claude' ? resolveClaude(p.key) : resolvers[p.kind] ? resolvers[p.kind](p.key) : null; } catch {}
  if (p.kind === 'claude') {
    if (v) { pidSeen.set(p.key, v); capped(pidSeen, 500); }
    else if (pidSeen.has(p.key)) v = pidSeen.get(p.key);
    else if (opt.msgId) { const w = (byMsg.get(opt.msgId) || []).filter((x) => !(opt.not && x.proj === opt.not.proj && x.id === opt.not.id))[0]; if (w) { v = { source: 'claude', proj: w.proj, id: w.id, name: '', cwd: w.cwd || '', group: w.group || null }; pidSeen.set(p.key, v); capped(pidSeen, 500); } }
  }
  memo.set(p.key, { at: Date.now(), v }); capped(memo, 500);
  return v;
}
function resolveClaude(pid) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'sessions', pid + '.json'), 'utf8')); } catch { return null; }
  if (!j || typeof j.sessionId !== 'string' || !/^[\w.-]+$/.test(j.sessionId)) return null;
  let proj = null; try { for (const d of fs.readdirSync(projectsDir())) if (fs.existsSync(path.join(projectsDir(), d, j.sessionId + '.jsonl'))) { proj = d; break; } } catch {}
  return { source: 'claude', proj, id: j.sessionId, name: j.name ? String(j.name).replace(/^claude:/, '') : '', cwd: j.cwd || '', group: require('./project.js').groupOf(j.cwd || '') };   // a Claude session's peer name is bare in every frame
}
// The running Claude sessions, remembered before they end (the board calls this on every refresh; a registry file is a few hundred bytes).
function rememberLive() {
  let names; try { names = fs.readdirSync(path.join(claudeDir(), 'sessions')); } catch { return; }
  for (const n of names) { const m = /^(\d+)\.json$/.exec(n); if (m && !pidSeen.has(m[1])) { const v = resolveClaude(m[1]); if (v) { pidSeen.set(m[1], v); capped(pidSeen, 500); } } }
}
// The Claude sessions running now: a registry file whose process is alive (a crash can leave its file behind). null where there is no registry.
function liveClaude() {
  let names; try { names = fs.readdirSync(path.join(claudeDir(), 'sessions')); } catch { return null; }
  const ids = new Set();
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n); if (!m) continue;
    try { process.kill(+m[1], 0); } catch (e) { if (e.code !== 'EPERM') continue; }
    try { const j = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'sessions', n), 'utf8')); if (j && typeof j.sessionId === 'string') ids.add(j.sessionId); } catch {}
  }
  return ids;
}
// The agent entry for a peer in a session's timeline: its tile, its name, and a link to its own session when the address resolves.
const ROLE = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
// A send can name its target ("claude:gladiator-game-c3") instead of addressing it: the arrivals in the same session say which address that name writes from.
function nameBook(states) {
  const book = new Map();
  for (const st of states) if (st) for (const e of st.raw) if (e.kind === 'msg' && e.name && parseAddress(e.dir === 'in' ? e.from : e.to)) book.set(String(e.name).replace(/^claude:/, ''), parseAddress(e.dir === 'in' ? e.from : e.to).addr);
  return book;
}
function peerAgent(addrOrName, nameHint, book, opt) {
  if (book && !parseAddress(addrOrName)) {
    const n = String(addrOrName || '').replace(/^claude:/, ''), tail = (/^codex:.*-([0-9a-f]{4})$/.exec(n) || [])[1];   // a Codex name can change with its thread's title; its last 4 hex are the thread's
    const a = book.get(n) || (tail && [...book.values()].find((x) => x.endsWith(tail + '.sock')));
    if (a) { nameHint = nameHint || n; addrOrName = a; }
  }
  if (parseAddress(nameHint)) nameHint = '';   // an inbox address is not a name
  const p = parseAddress(addrOrName), r = p ? resolve(p.addr, opt) : null, key = p ? p.key : String(addrOrName || 'peer');
  let name = String(nameHint || (r && r.name) || (p && p.kind !== 'claude' ? key : '')).replace(/^claude:/, '');
  if (!NAME.test(name)) name = !p ? 'unknown peer' : p.kind === 'claude' ? (r ? 'Claude Code ' + key.slice(-6) : 'Claude session (ended)') : (ROLE[p.kind] || 'peer') + ' ' + key.slice(-6);   // a name is a name, not an ellipsis or a sentence; a pid means nothing to a person
  const hermesName = /^hermes:([\w.-]+)/.exec(name), group = (r && r.group) || (hermesName ? { key: 'hermes:' + hermesName[1], name: 'Hermes ' + hermesName[1], hermes: true } : null);   // the peer's project, so an edge reads project to project
  const runtime = ROLE[p ? p.kind : ''] || 'peer', role = group ? (group.hermes ? group.name : runtime + ', ' + group.name) : runtime;   // "Claude Code, gladiator-game", "Hermes gaming, <thread>"
  return { id: peerId(r && r.id ? r.source + ':' + r.id : key), name, role, type: 'peer', addr: p ? p.addr : '', link: r && r.proj ? { proj: r.proj, id: r.id } : null, cwd: r ? r.cwd : '', group };   // one tile per session, however many addresses it wrote from
}
// A name nobody answers to (a send that failed, "No agent named … is reachable"): an edge to a placeholder that is no guest and no session.
const cleanName = (x) => String(x == null ? '' : x).replace(/^claude:/, '');
const ghost = (name, role = 'not reachable') => ({ id: 'x_' + String(name).replace(/[^\w-]/g, '_').slice(0, 60), name: /^a[0-9a-f]{16}$/.test(name) ? 'agent ' + name.slice(-4) : label(cleanName(name), 40), role, type: 'peer', absent: true, addr: '', link: null, cwd: '', group: null });   // an agent id with no file here is a sub-agent not in view
// Who a session talked to, from the tail of its transcript (any runtime's wording): a short list for the board.
const NAME = /^[\w:.-]{1,80}$/;
function tailPeers(text) {   // every message in the tail, with its time when the record has one: { hits: [{ name, ts }] }
  const lines = String(text).split('\n'), byAddr = new Map(), hits = [], tsOf = (l) => Date.parse((/"timestamp":"([^"]+)"/.exec(l) || [])[1] || '') || 0;
  for (const line of lines) {   // arrivals: a name, and the address it writes from; one per record (a message queued while busy is also in the queue's own records: skipped)
    const m = line.includes('"type":"queue-operation"') ? null : /<(?:cross-session-message|peer_message) from=\\*"([^"\\]+)\\*"(?: (?:from-name|reply_to)=\\*"([^"\\]+)\\*")?/.exec(line); if (!m) continue;
    const a = parseAddress(m[1]) || parseAddress(m[2] || ''), nm = (parseAddress(m[1]) ? m[2] || '' : m[1]).replace(/^claude:/, '');
    const name = NAME.test(nm) ? nm : a ? peerAgent(a.addr).name : ''; if (!name) continue; hits.push({ name, ts: tsOf(line) }); if (a) byAddr.set(a.key, name);
  }
  // sends: Claude's SendMessage input and Codex's send_peer arguments are plain JSON, Hermes's arguments are a JSON string inside JSON (a list_peers listing is neither)
  // one record counts a target once (a Codex send_peer echoes its target in the result), and a list_peers listing names targets nobody was sent anything
  for (const line of lines) {
    if (/"tool":"list_peers"|"name":"(?:mcp__agent-peers__)?list_peers"/.test(line) || /^\s*bridge: send_peer \{/.test(line)) continue;   // the listing record itself, or a line of a listing; a message that only talks about list_peers still counts
    const seen = new Set();   // a Hermes tool_call batch carries several sends in one record, its arguments escaped inside a string
    for (const m of line.matchAll(/\\*"to\\*"\s*:\s*\\*"(uds:[^"\\]+)/g)) {
      const a = parseAddress(m[1]); if (!a || seen.has(a.key)) continue; seen.add(a.key);
      hits.push({ name: byAddr.get(a.key) || peerAgent(a.addr).name, ts: tsOf(line) });
    }
  }
  return { hits };
}
// Who a session is talking to now: the messages of the last TALK_MS (a record without a time counts as recent: its caller only passes recent rows). A tip
// asked hours ago is not "talking to"; the transcript and the detail panel keep the history.
const TALK_MS = 10 * 60e3;
function talksNow(t, now = Date.now()) { const h = ((t && t.hits) || []).filter((x) => !x.ts || now - x.ts <= TALK_MS); return { n: h.length, names: [...new Set(h.map((x) => x.name))].slice(0, 4) }; }
module.exports = { capped, parseAddress, peerId, incoming, sendState, resolve, register, indexMessages, rememberLive, liveClaude, ghost, cleanName, problem, problems, peerAgent, nameBook, tailPeers, talksNow, TALK_MS, clip, label, maxFileBytes, readBudget };
