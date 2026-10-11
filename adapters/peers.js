// adapters/peers.js — messages between agent sessions (agent-peers): how each runtime records a send or an arrival,
// and who is behind an inbox address. An address is uds:<dir>/<name>.sock, where <name> is a Claude Code pid,
// codex-<last 16 hex of the Codex thread id> or hermes-<32 hex, one per Hermes conversation>.
const fs = require('fs');
const path = require('path');
const os = require('os');

const clip = (x, n) => String(x == null ? '' : x).slice(0, n);
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
  let m = CC_IN.exec(text); if (m) return { addr: m[1], name: m[2] || '', msgId: '', text: m[3].replace(TRAILER, '').trim() };
  m = PM_IN.exec(text); if (m) return { addr: m[2], name: m[1], msgId: m[3] || '', text: m[4].replace(TRAILER, '').trim() };
  return null;
}
// The delivery state a Codex or Hermes send_peer result reports: a socket write that was accepted, held for the recipient's approval, or refused.
function sendState(text, isError) {
  const t = String(text || '');
  if (isError || /^Not delivered/.test(t) || /^\s*\{\s*"error"/.test(t)) return 'failed';
  if (/holding it for its user|"status":\s*"held"/.test(t)) return 'held';
  return 'accepted';
}

// ---- Address book: which session owns an address. Claude's live registry (~/.claude/sessions/<pid>.json) answers for running Claude sessions;
// the Codex and Hermes adapters register resolvers for theirs (a Codex address is the thread id, a Hermes address is only in that conversation's own store).
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => process.env.AGENT_STANDUP_PROJECTS || path.join(claudeDir(), 'projects');
const resolvers = {};
const register = (kind, fn) => { resolvers[kind] = fn; };
const memo = new Map();
function resolve(addrOrKey) {
  const p = parseAddress(addrOrKey) || (typeof addrOrKey === 'string' && /^[\w.-]+$/.test(addrOrKey) ? { key: addrOrKey, kind: KIND(addrOrKey) } : null);
  if (!p) return null;
  const hit = memo.get(p.key); if (hit && Date.now() - hit.at < 10000) return hit.v;
  let v = null; try { v = p.kind === 'claude' ? resolveClaude(p.key) : resolvers[p.kind] ? resolvers[p.kind](p.key) : null; } catch {}
  memo.set(p.key, { at: Date.now(), v }); if (memo.size > 500) memo.delete(memo.keys().next().value);
  return v;
}
function resolveClaude(pid) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'sessions', pid + '.json'), 'utf8')); } catch { return null; }
  if (!j || typeof j.sessionId !== 'string' || !/^[\w.-]+$/.test(j.sessionId)) return null;
  let proj = null; try { for (const d of fs.readdirSync(projectsDir())) if (fs.existsSync(path.join(projectsDir(), d, j.sessionId + '.jsonl'))) { proj = d; break; } } catch {}
  return { source: 'claude', proj, id: j.sessionId, name: j.name ? String(j.name).replace(/^claude:/, '') : '', cwd: j.cwd || '', group: require('./project.js').groupOf(j.cwd || '') };   // a Claude session's peer name is bare in every frame
}
// The agent entry for a peer in a session's timeline: its tile, its name, and a link to its own session when the address resolves.
const ROLE = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
// A send can name its target ("claude:gladiator-game-c3") instead of addressing it: the arrivals in the same session say which address that name writes from.
function nameBook(states) {
  const book = new Map();
  for (const st of states) if (st) for (const e of st.raw) if (e.kind === 'msg' && e.name && parseAddress(e.dir === 'in' ? e.from : e.to)) book.set(String(e.name).replace(/^claude:/, ''), parseAddress(e.dir === 'in' ? e.from : e.to).addr);
  return book;
}
function peerAgent(addrOrName, nameHint, book) {
  if (book && !parseAddress(addrOrName)) {
    const n = String(addrOrName || '').replace(/^claude:/, ''), tail = (/^codex:.*-([0-9a-f]{4})$/.exec(n) || [])[1];   // a Codex name can change with its thread's title; its last 4 hex are the thread's
    const a = book.get(n) || (tail && [...book.values()].find((x) => x.endsWith(tail + '.sock')));
    if (a) { nameHint = nameHint || n; addrOrName = a; }
  }
  const p = parseAddress(addrOrName), r = p ? resolve(p.addr) : null, key = p ? p.key : String(addrOrName || 'peer');
  let name = String(nameHint || (r && r.name) || (p ? (p.kind === 'claude' ? 'claude pid ' + key : key) : key)).replace(/^claude:/, ''); if (!NAME.test(name)) name = p ? (ROLE[p.kind] || 'peer') + ' ' + key.slice(-6) : 'unknown peer';   // a name is a name, not an ellipsis or a sentence
  const hermesName = /^hermes:([\w.-]+)/.exec(name), group = (r && r.group) || (hermesName ? { key: 'hermes:' + hermesName[1], name: 'Hermes · ' + hermesName[1], hermes: true } : null);   // the peer's project, so an edge reads project to project
  const runtime = ROLE[p ? p.kind : ''] || 'peer', role = group ? (group.hermes ? group.name : runtime + ' · ' + group.name) : runtime;   // "Claude Code · gladiator-game", "Hermes · gaming · <thread>"
  return { id: peerId(r && r.id ? r.source + ':' + r.id : key), name, role, type: 'peer', addr: p ? p.addr : '', link: r && r.proj ? { proj: r.proj, id: r.id } : null, cwd: r ? r.cwd : '', group };   // one tile per session, however many addresses it wrote from
}
// Who a session talked to, from the tail of its transcript (any runtime's wording): a short list for the board.
const NAME = /^[\w:.-]{1,80}$/;
function tailPeers(text) {
  const names = new Set(), byAddr = new Map(); let n = 0;
  for (const m of String(text).matchAll(/<(?:cross-session-message|peer_message) from=\\*"([^"\\]+)\\*"(?: (?:from-name|reply_to)=\\*"([^"\\]+)\\*")?/g)) {   // arrivals: a name, and the address it writes from
    n++; const a = parseAddress(m[1]) || parseAddress(m[2] || ''), nm = (parseAddress(m[1]) ? m[2] || '' : m[1]).replace(/^claude:/, '');
    const name = NAME.test(nm) ? nm : a ? peerAgent(a.addr).name : ''; if (!name) continue; names.add(name); if (a) byAddr.set(a.key, name);
  }
  // sends: Claude's SendMessage input and Codex's send_peer arguments are plain JSON, Hermes's arguments are a JSON string inside JSON (a list_peers listing is neither)
  // one record is one send at most (a Codex send_peer echoes its target in the result), and a list_peers listing names targets nobody was sent anything
  for (const line of String(text).split('\n')) {
    if (line.includes('list_peers') || line.includes('bridge: send_peer')) continue;
    const m = /"to":"(uds:[^"]+)"|\\"arguments\\":\{\\"to\\":\\"(uds:[^"\\]+)/.exec(line), a = m && parseAddress(m[1] || m[2]); if (!a) continue;
    n++; names.add(byAddr.get(a.key) || peerAgent(a.addr).name);
  }
  return { n, names: [...names].slice(0, 4) };
}
module.exports = { parseAddress, peerId, incoming, sendState, resolve, register, peerAgent, nameBook, tailPeers, clip, label };
