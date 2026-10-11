// adapters/hermes.js — Hermes Agent sessions, read from each profile's SQLite store: ~/.hermes/state.db (default profile) and
// ~/.hermes/profiles/<name>/state.db. Hermes keeps writing (WAL), so every database is opened read-only and never locked or written.
//   proj: "_hermes" (default profile) or "_hermes-<profile>" · id: sessions.id
// Contract shared with server.js: list(), board(now), exists(proj, id), mtime(proj, id), stamp(proj, id), timeline(proj, id).
const fs = require('fs');
const path = require('path');
const os = require('os');
const peers = require('./peers.js');
const { assemble } = require('./timeline.js');

const clip = peers.clip, SAFE = /^[\w.-]+$/;
const HOME = () => process.env.AGENT_STANDUP_HERMES || path.join(os.homedir(), '.hermes');   // the root: every profile lives under it (HERMES_HOME names one profile, so it is not used here)

let sqlite;   // node:sqlite (Node 22+), loaded on first use without its "experimental feature" warning
function lib() {
  if (sqlite !== undefined) return sqlite;
  const warn = process.emitWarning; process.emitWarning = (w, ...a) => { if (!/sqlite/i.test(String((w && w.message) || w))) return warn.call(process, w, ...a); };
  try { sqlite = require('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = warn; }
  return sqlite;
}
const dbs = new Map();   // file → { db, ino }: reopened if the file is replaced
function open(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const hit = dbs.get(file); if (hit && hit.ino === st.ino) return hit.db;
  if (hit) { try { hit.db.close(); } catch {} dbs.delete(file); }
  const L = lib(); if (!L) return null;
  try { const db = new L.DatabaseSync(file, { readOnly: true }); dbs.set(file, { db, ino: st.ino }); return db; } catch { return null; }
}
const stmts = new WeakMap();
function q(db, sql, ...args) { let m = stmts.get(db); if (!m) stmts.set(db, (m = new Map())); let s = m.get(sql); if (!s) m.set(sql, (s = db.prepare(sql))); return s.all(...args); }
function tryq(db, sqls, ...args) { let err; for (const sql of sqls) { try { return q(db, sql, ...args); } catch (e) { err = e; } } throw err; }   // older schemas lack some columns

let profMemo = { at: 0, list: [] };
function profiles() {
  if (Date.now() - profMemo.at < 5000) return profMemo.list;
  const home = HOME(), out = [], add = (name, dir) => { const db = path.join(dir, 'state.db'); if (fs.existsSync(db)) out.push({ name, proj: name === 'default' ? '_hermes' : '_hermes-' + name, dir, db }); };
  add('default', home);
  try { for (const n of fs.readdirSync(path.join(home, 'profiles'))) if (SAFE.test(n) && n !== 'default') add(n, path.join(home, 'profiles', n)); } catch {}
  profMemo = { at: Date.now(), list: out }; return out;
}
const profileOf = (proj) => profiles().find((p) => p.proj === proj) || null;
const dbOf = (proj) => { const p = profileOf(proj); return p ? open(p.db) : null; };

// ---- sessions
const COLS = 'id, source, title, started_at, ended_at, end_reason, last_activity_at, model, parent_session_id, display_name, cwd, message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens';
const COLS0 = COLS.replace('last_activity_at', 'null as last_activity_at').replace('display_name', 'null as display_name');
const NOT_KIDS = "source not in ('subagent', 'healthcheck')";
const recent = (db, since, limit) => tryq(db, [
  `select ${COLS} from sessions where hidden=0 and ${NOT_KIDS} and coalesce(last_activity_at, started_at) > ? order by coalesce(last_activity_at, started_at) desc limit ?`,
  `select ${COLS} from sessions where ${NOT_KIDS} and coalesce(last_activity_at, started_at) > ? order by coalesce(last_activity_at, started_at) desc limit ?`,
  `select ${COLS0} from sessions where ${NOT_KIDS} and started_at > ? order by started_at desc limit ?`], since, limit);
const one = (db, id) => tryq(db, [`select ${COLS} from sessions where id=?`, `select ${COLS0} from sessions where id=?`], id)[0] || null;
const children = (db, id) => tryq(db, [`select ${COLS} from sessions where parent_session_id=? and source='subagent' order by started_at, id`, `select ${COLS0} from sessions where parent_session_id=? and source='subagent' order by started_at, id`], id);
const mtimeOf = (s) => Math.round(Math.max(s.last_activity_at || 0, s.ended_at || 0, s.started_at || 0) * 1000);
const projectOf = (s) => s.cwd || (s.display_name ? String(s.display_name).split(' / ').slice(0, 2).join(' / ') : s.source || '');

// What the human typed, without what the gateway wraps around it: "[Name] " on shared chats, the origin preamble, the steering markers.
function cleanUser(t) {
  return String(t || '').replace(/^\[[^\]\n]{1,60}\]\s*/, '').replace(/^Gateway message origin[\s\S]*?\n\n/, '')
    .replace(/^\[(?:OUT-OF-BAND USER MESSAGE|EXTERNAL SESSION MESSAGE)[^\]]*\]\s*/, '').replace(/\s*\[\/(?:OUT-OF-BAND USER MESSAGE|EXTERNAL SESSION MESSAGE)\]\s*$/, '').trim();
}
function titleOf(db, s) {
  if (s.title) return s.title;
  if (s.parent_session_id && s.source !== 'subagent') { try { const p = one(db, s.parent_session_id); if (p && p.title) return p.title; } catch {} }   // a continuation after compaction keeps the conversation's title
  let rows = []; try { rows = q(db, "select content from messages where session_id=? and role='user' order by id limit 3", s.id); } catch {}
  for (const r of rows) { const t = cleanUser(r.content); if (t && !/^\[CONTEXT COMPACTION/.test(t) && !peers.incoming(t)) return t.replace(/\s+/g, ' ').slice(0, 90); }
  return s.id;
}
function list(limit = 60) {
  const out = [];
  for (const p of profiles()) {
    const db = open(p.db); if (!db) continue;
    let rows = []; try { rows = recent(db, Date.now() / 1000 - 30 * 86400, limit); } catch { continue; }
    for (const s of rows) { let kids = 0; try { kids = children(db, s.id).length; } catch {} out.push({ proj: p.proj, id: s.id, mtime: mtimeOf(s), size: s.message_count || 0, agents: kids, title: titleOf(db, s), project: projectOf(s), source: 'hermes' }); }
  }
  return out;
}

// ---- tool calls: the model's calls on assistant rows (OpenAI style; a "tool_call" batching wrapper holds several), their results on tool rows
function calls(r) {
  let arr; try { arr = JSON.parse(r.tool_calls || '[]'); } catch { return []; }
  const out = [];
  for (const c of Array.isArray(arr) ? arr : []) {
    const f = c.function || {}, callId = c.id || c.call_id || ''; let a = {}; try { a = typeof f.arguments === 'string' ? JSON.parse(f.arguments) : f.arguments || {}; } catch { a = { _raw: clip(f.arguments, 300) }; }
    if (f.name === 'tool_call') { const inner = Array.isArray(a.calls) ? a.calls : a.name ? [a] : []; for (const x of inner) out.push({ callId, name: x.name || 'tool_call', key: callId + '|' + (x.name || 'tool_call'), args: x.arguments || {} }); }
    else out.push({ callId, name: f.name || '?', key: callId + '|' + (f.name || '?'), args: a });
  }
  return out;
}
const MAX = { terminal: 1300, execute_code: 1300, read_file: 1900, search_files: 900, web_search: 800, web_extract: 800, patch: 200, write_file: 200 };
const jsonOf = (s) => { if (!/^\s*[[{]/.test(s)) return null; try { return JSON.parse(s); } catch { return null; } };
const unwrap = (j, s) => (j && typeof j === 'object' && !Array.isArray(j) && ['output', 'result', 'content', 'text', 'error'].map((k) => j[k]).find((v) => typeof v === 'string')) || s;
function label(name, a, ts, id) {   // what the call looks like on a screen: the same "d" shapes the page already draws for Claude Code
  const q0 = Array.isArray(a.questions) && a.questions[0] ? a.questions[0] : null;
  const out = { id, ts, name, arg: clip(a.command || a.path || a.pattern || a.query || a.url || (Array.isArray(a.urls) && a.urls[0]) || a.name || a.to || (q0 && q0.question) || '', 90) };
  switch (name) {
    case 'terminal': out.d = { kind: 'cmd', text: clip(a.command, 1200) }; break;
    case 'execute_code': out.d = { kind: 'cmd', text: clip(a.code, 1200), note: 'python' }; break;
    case 'read_file': out.d = { kind: 'read', file: a.path, offset: a.offset, limit: a.limit }; break;
    case 'patch': out.d = { kind: 'edit', file: a.path, old: clip(a.old_string, 500), new: clip(a.new_string, 500) }; break;
    case 'write_file': out.d = { kind: 'write', file: a.path, text: clip(a.content, 800) }; break;
    case 'search_files': out.d = { kind: 'grep', pattern: clip(a.pattern, 100), path: a.path || a.target, glob: a.file_glob }; break;
    case 'web_search': out.d = { kind: 'web', query: a.query }; break;
    case 'web_extract': case 'browser_navigate': out.d = { kind: 'web', url: a.url || (Array.isArray(a.urls) ? a.urls[0] : '') }; break;
    case 'todo': case 'todo_list': out.d = { kind: 'todo', items: (Array.isArray(a.todos) ? a.todos : []).slice(0, 20).map((x) => ({ c: clip(x.content || x.text || x.title, 120), s: x.status })) }; break;
    case 'clarify': out.d = { kind: 'text', what: 'question', text: clip((a.questions || []).map((x) => (x.question || '') + '\n' + (x.choices || []).map((c) => '• ' + c).join('\n')).join('\n'), 500) }; break;
    case 'skill_view': out.d = { kind: 'text', what: 'skill', v: a.name, text: clip(a.name, 200) }; break;
    default: out.d = /^mcp__/.test(name) ? { kind: 'text', what: 'mcp', v: name.split('__').slice(1).join(' · '), text: clip(JSON.stringify(a), 400) } : { kind: 'text', text: clip(JSON.stringify(a), 300) };
  }
  return out;
}
const ROWS = 'id, role, content, tool_call_id, tool_calls, tool_name, timestamp, display_kind, finish_reason, platform_message_id';
// Which sub-agent session ran which task of a delegation: the child's first user row is the task's goal, verbatim (children start within seconds of the call, but not in task order).
function childFor(db, kids, goal, used) {
  const g = String(goal || '').trim(); if (!g) return null;
  for (const k of kids) { if (used.has(k.id)) continue; let first = ''; try { first = cleanUser((q(db, "select content from messages where session_id=? and role='user' order by id limit 1", k.id)[0] || {}).content); } catch {} if (first && (first === g || first.startsWith(g.slice(0, 200)) || g.startsWith(first.slice(0, 200)))) { used.add(k.id); return k; } }
  return null;
}
function parseSession(db, s, agent, kids) {
  const st = { agent, raw: [], childByTool: {} }, pend = new Map(), used = new Set();
  const rows = tryq(db, [`select ${ROWS} from messages where session_id=? and (active=1 or compacted=1) order by id`, `select ${ROWS.replace('display_kind', 'null as display_kind').replace('platform_message_id', 'null as platform_message_id')} from messages where session_id=? order by id`], s.id);   // superseded copies (neither active nor compacted) are not part of the conversation
  for (const r of rows) {
    const ts = Math.round((r.timestamp || 0) * 1000);
    if (r.role === 'user') {
      const inc = peers.incoming(r.content || ''); if (inc) { st.raw.push({ ts, agent, kind: 'msg', dir: 'in', from: inc.addr, name: inc.name, msgId: inc.msgId || r.platform_message_id || '', text: clip(inc.text, 2000) }); continue; }
      if (r.display_kind === 'internal_notification') continue;   // background-process notices and the like
      const t = cleanUser(r.content); if (/^\[CONTEXT COMPACTION/.test(t)) { st.raw.push({ ts, agent, kind: 'compact' }); continue; }
      if (t && agent === 'main') st.raw.push({ ts, agent: 'user', kind: 'user', text: t });
    } else if (r.role === 'assistant') {
      const t = String(r.content || '').trim(); if (t) st.raw.push({ ts, agent, kind: 'say', text: t });
      for (const c of calls(r)) {
        pend.set(c.key, { ...c, ts });
        if (c.name === 'delegate_task') {   // one sub-agent session per task, matched by its goal; a task whose child is not found stays an order without a tile
          const tasks = Array.isArray(c.args.tasks) ? c.args.tasks : c.args.goal ? [c.args] : [];
          tasks.forEach((t, i) => { const toolId = c.key + '#' + i, child = childFor(db, kids, t.goal, used); if (child) st.childByTool[toolId] = child.id; st.raw.push({ ts, agent, kind: 'agentcall', toolId, bg: false, title: clip(t.goal, 90), text: clip(t.goal, 2000) + (t.context ? '\n\n' + clip(t.context, 1500) : '') }); });
        } else if (c.name !== 'send_peer' && c.name !== 'list_peers') st.raw.push({ ts, agent, kind: 'tool', tool: label(c.name, c.args, ts, c.key) });   // peer calls are emitted once their result says what happened
      }
    } else if (r.role === 'tool') {
      const name = r.tool_name || '', pd = pend.get(r.tool_call_id + '|' + name) || [...pend.values()].find((x) => x.callId === r.tool_call_id) || null; if (pd) pend.delete(pd.key);
      const content = String(r.content || ''), j = jsonOf(content), args = pd ? pd.args : {}, id = pd ? pd.key : r.tool_call_id + '|' + name;
      if (name === 'send_peer') { st.raw.push({ ts, agent, kind: 'msg', dir: 'out', to: args.to || '', text: clip(args.message, 2000), msgId: (j && j.message_id) || '', state: j && j.error ? 'failed' : j && j.status === 'held' ? 'held' : peers.sendState(content), detail: clip((j && (j.text || j.error)) || content, 200) }); continue; }
      if (name === 'list_peers') { st.raw.push({ ts, agent, kind: 'tool', tool: { id, ts: pd ? pd.ts : ts, name, arg: '', d: { kind: 'text', what: 'mcp', v: 'agent-peers · list_peers', text: '' } } }, { ts, agent, kind: 'results', items: [{ id, err: false, out: clip(content, 900) }] }); continue; }
      if (name === 'delegate_task') { const res = j && Array.isArray(j.results) ? j.results : null; st.raw.push({ ts, agent, kind: 'results', items: [{ id, err: !!(j && j.error), out: clip(res ? res.map((x, i) => `#${i + 1} ${x.status || ''}: ${x.summary || ''}`).join('\n') : content, 1300) }] }); continue; }
      st.raw.push({ ts, agent, kind: 'results', items: [{ id, err: !!(j && j.error), out: clip(unwrap(j, content), MAX[name] || (/^mcp__/.test(name) ? 900 : 600)) }] });
    }
  }
  const u = usageOf(db, s, agent); if (u) st.raw.push(u);
  return st;
}
function usageOf(db, s, agent) {   // Hermes keeps totals per session and model (a conversation can switch models), not per message: one event with the session's total
  let rows = []; try { rows = q(db, "select model, input_tokens i, output_tokens o, cache_read_tokens r, cache_write_tokens w from session_model_usage where session_id=? and task='' order by input_tokens + cache_read_tokens desc", s.id); } catch {}
  const u = rows.length ? rows.reduce((a, r) => ({ i: a.i + (r.i || 0), o: a.o + (r.o || 0), r: a.r + (r.r || 0), w: a.w + (r.w || 0) }), { i: 0, o: 0, r: 0, w: 0 }) : { i: s.input_tokens || 0, o: s.output_tokens || 0, r: s.cache_read_tokens || 0, w: s.cache_write_tokens || 0 };
  return u.i + u.o + u.r + u.w ? { ts: mtimeOf(s), agent, kind: 'usage', u, model: (rows[0] && rows[0].model) || s.model || '', total: true } : null;
}
function timeline(proj, id) {
  const db = dbOf(proj), s = db && SAFE.test(id) ? one(db, id) : null; if (!s) throw new Error('session not found');
  const agents = { main: { id: 'main', role: 'Lead', type: 'main', name: 'Hermes' } }, states = [], kids = children(db, id);
  const st = parseSession(db, s, 'main', kids); states.push(st);
  for (const k of kids) {
    agents[k.id] = { id: k.id, role: clip(titleOf(db, k), 60), type: 'subagent', mtime: mtimeOf(k) };
    const ks = parseSession(db, k, k.id, []); states.push(ks);
    if (k.ended_at) st.raw.push({ ts: mtimeOf(k), agent: 'main', kind: 'agentdone', child: k.id });
  }
  return assemble({ id, proj, agents, states, childByTool: st.childByTool });
}

// ---- board, liveness, cache keys
function board(now = Date.now()) {
  const out = [];
  for (const p of profiles()) {
    const db = open(p.db); if (!db) continue;
    let rows = []; try { rows = recent(db, now / 1000 - 12 * 3600, 40); } catch { continue; }
    for (const s of rows) { try { out.push(boardRow(db, p, s, now)); } catch {} }
  }
  return out;
}
function boardRow(db, p, s, now) {
  let kids = []; try { kids = children(db, s.id); } catch {}
  let tail = []; try { tail = q(db, `select ${ROWS} from messages where session_id=? order by id desc limit 24`, s.id).reverse(); } catch {}
  const last = tail[tail.length - 1], mtime = Math.max(mtimeOf(s), last ? Math.round(last.timestamp * 1000) : 0), age = now - mtime;
  let state = 'idle', tool = '', ageMs = age; const seen = peers.tailPeers(tail.map((r) => (r.content || '') + ' ' + (r.tool_calls || '')).join('\n'));
  if (age < 30 * 60e3 && !s.ended_at) {
    const pend = new Map();
    for (const r of tail) { if (r.role === 'assistant') for (const c of calls(r)) pend.set(c.key, { name: c.name, ts: r.timestamp * 1000 }); else if (r.role === 'tool') { pend.delete(r.tool_call_id + '|' + (r.tool_name || '')); for (const k of [...pend.keys()]) if (k.startsWith(r.tool_call_id + '|') && !r.tool_name) pend.delete(k); } }
    const lp = [...pend.values()].pop();
    if (lp) { tool = lp.name; ageMs = now - lp.ts; state = lp.name === 'delegate_task' ? 'waiting' : lp.name === 'clarify' && ageMs > 4000 ? 'blocked' : 'working'; }
    else if (last && last.role === 'assistant' && last.finish_reason === 'stop') state = 'turn';
    else state = age < 10 * 60e3 ? 'working' : 'idle';
  }
  return { proj: p.proj, id: s.id, title: titleOf(db, s), mtime, state, tool, ageMs, subActive: kids.filter((k) => !k.ended_at).length, subTotal: kids.length, source: 'hermes', project: projectOf(s), peers: seen.names, msgs: seen.n };
}
const exists = (proj, id) => { const db = dbOf(proj); if (!db || !SAFE.test(id)) return false; try { return !!one(db, id); } catch { return false; } };
function mtime(proj, id) {
  const db = dbOf(proj); if (!db || !SAFE.test(id)) return 0;
  try { const s = one(db, id); if (!s) return 0; let m = mtimeOf(s); const r = q(db, 'select max(timestamp) t from messages where session_id=?', id)[0]; if (r && r.t) m = Math.max(m, Math.round(r.t * 1000)); for (const k of children(db, id)) m = Math.max(m, mtimeOf(k)); return m; } catch { return 0; }
}
function stamp(proj, id) {   // changes when rows are added, when compression flips which rows count, when a session ends or its usage moves
  const db = dbOf(proj); if (!db || !SAFE.test(id)) return 0;
  try {
    const s = one(db, id); if (!s) return 0; const kids = children(db, id); let n = kids.length + (s.input_tokens || 0) + (s.output_tokens || 0) + (s.cache_read_tokens || 0);
    for (const x of [s, ...kids]) { const r = q(db, 'select count(*) n, max(id) m, sum(active) a, sum(compacted) c from messages where session_id=?', x.id)[0]; n += (r.n || 0) + (r.m || 0) * 3 + (r.a || 0) * 7 + (r.c || 0) * 11 + (x.ended_at || 0) + (x.last_activity_at || 0); }
    return n;
  } catch { return 0; }
}
// A Hermes inbox (hermes-<32 hex>) is only ever written in that conversation's own send_peer results: look it up among the recently active sessions of each profile.
let addrMemo = { at: 0, map: new Map() };
function addressMap() {
  if (Date.now() - addrMemo.at < 30000) return addrMemo.map;
  const map = new Map();
  for (const p of profiles()) {
    const db = open(p.db); if (!db) continue; let rows = []; try { rows = recent(db, Date.now() / 1000 - 30 * 86400, 80); } catch { continue; }
    for (const s of rows) { let rs = []; try { rs = q(db, "select content from messages where session_id=? and role='tool' and tool_name='send_peer'", s.id); } catch {} for (const r of rs) { const m = /hermes-([0-9a-f]{32})\.sock/.exec(r.content || ''); if (m) map.set('hermes-' + m[1], { source: 'hermes', proj: p.proj, id: s.id, name: 'hermes:' + p.name + ':' + s.id.slice(-8), cwd: projectOf(s) }); } }
  }
  addrMemo = { at: Date.now(), map }; return map;
}
peers.register('hermes', (key) => addressMap().get(key) || null);
module.exports = { list, board, exists, mtime, stamp, timeline, profiles, forget() {} };
