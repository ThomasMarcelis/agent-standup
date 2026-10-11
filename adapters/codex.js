// adapters/codex.js — Codex CLI sessions, read from its rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl.
// One file per thread; a native sub-agent is its own thread whose first record (session_meta) names its parent. Nothing is ever written.
//   proj: "_codex" · id: the thread id (the uuid in the file name)
// Contract shared with server.js: list(), board(now), exists(proj, id), mtime(proj, id), stamp(proj, id), timeline(proj, id), forget(proj, id).
const fs = require('fs');
const path = require('path');
const os = require('os');
const peers = require('./peers.js');
const project = require('./project.js');
const { assemble } = require('./timeline.js');

const clip = peers.clip;
const HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESS = () => process.env.AGENT_STANDUP_CODEX || path.join(HOME(), 'sessions');
const DAYS = Math.max(1, +process.env.AGENT_STANDUP_CODEX_DAYS || 7);   // how far back the day folders are listed; older ancestors are fetched by id
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, FILE = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;
const pad = (n) => String(n).padStart(2, '0');

// ---- index: line 1 of each rollout (its session_meta) says which thread it is, where it runs and who spawned it
const metaCache = new Map();   // file → meta (line 1 never changes)
function firstLine(file, max = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try { const sz = Math.min(max, fs.fstatSync(fd).size), buf = Buffer.alloc(sz); fs.readSync(fd, buf, 0, sz, 0); const nl = buf.indexOf(10); return buf.subarray(0, nl < 0 ? sz : nl).toString('utf8'); } finally { fs.closeSync(fd); }
}
function metaOf(file) {
  const hit = metaCache.get(file); if (hit) return hit;
  let m = null;
  try {
    const r = JSON.parse(firstLine(file)), p = r && r.type === 'session_meta' && r.payload;
    if (p && typeof p.id === 'string') {
      const sp = (p.source && typeof p.source === 'object' && p.source.subagent && p.source.subagent.thread_spawn) || {};
      m = { id: p.id, file, parent: p.parent_thread_id || sp.parent_thread_id || null, root: p.session_id || p.id, child: p.thread_source === 'subagent' || !!(p.parent_thread_id || sp.parent_thread_id), depth: sp.depth || 0,
        agentPath: p.agent_path || sp.agent_path || '', nickname: p.agent_nickname || sp.agent_nickname || '', role: p.agent_role || sp.agent_role || '', cwd: p.cwd || '', start: Date.parse(p.timestamp) || Date.parse(r.timestamp) || 0, histStart: p.subagent_history_start_ordinal || 0, originator: p.originator || '' };
    }
  } catch {}
  if (m) { metaCache.set(file, m); peers.capped(metaCache, 4000); } return m;
}
let idx = { at: 0, byId: new Map(), stats: new Map() };
function scan() {
  if (Date.now() - idx.at < 2000) return idx;
  const root = SESS(), byId = new Map(), stats = new Map(), now = new Date(); let files = 0;
  for (let d = 0; d <= DAYS; d++) {
    const t = new Date(now.getTime() - d * 864e5), dir = path.join(root, String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate()));
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!FILE.test(n)) continue; const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch { continue; }
      files++; const m = metaOf(f); if (!m) continue; byId.set(m.id, m); stats.set(m.id, { mtime: st.mtimeMs, size: st.size });
    }
  }
  peers.problem('Codex rollouts', files && !byId.size ? 'none of the ' + files + ' rollouts in ' + root + ' could be read (a format change?)' : null);   // every file refused: the format changed, not the days
  idx = { at: Date.now(), byId, stats }; return idx;
}
const fileMemo = new Map();   // id → { file|null, at }: the parent of a recent child can be older than the listed days
const safeDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
function fileOf(id) {
  if (!UUID.test(id)) return null;
  const m = scan().byId.get(id); if (m) return m.file;
  const hit = fileMemo.get(id); if (hit && (hit.file || Date.now() - hit.at < 10000)) return hit.file;
  let found = null; const root = SESS();
  for (const y of safeDir(root)) for (const mo of safeDir(path.join(root, y))) for (const d of safeDir(path.join(root, y, mo))) { for (const n of safeDir(path.join(root, y, mo, d))) if (n.endsWith('-' + id + '.jsonl')) { found = path.join(root, y, mo, d, n); break; } if (found) break; }
  fileMemo.set(id, { file: found, at: Date.now() }); peers.capped(fileMemo, 2000); return found;
}
const metaById = (id) => scan().byId.get(id) || (fileOf(id) ? metaOf(fileOf(id)) : null);
const statOf = (m) => { const s = scan().stats.get(m.id); if (s) return s; try { const st = fs.statSync(m.file); return { mtime: st.mtimeMs, size: st.size }; } catch { return null; } };
function tree() {   // root threads and their descendants among the listed files
  const { byId } = scan(), kids = new Map(), roots = new Map();
  for (const m of byId.values()) { if (m.parent) { if (!kids.has(m.parent)) kids.set(m.parent, []); kids.get(m.parent).push(m); } if (!m.child) roots.set(m.id, m); }
  for (const m of byId.values()) if (m.child && m.root && !roots.has(m.root) && !byId.has(m.root)) { const r = metaById(m.root); if (r) roots.set(r.id, r); }   // a root older than the window still shows while its agents work
  return { roots, kids };
}
const MAX_AGENTS = 150;   // sub-agent rollouts read per session, listing and timeline alike (a Codex tree can have dozens of agents, nested)
function descendants(id, kids, cap = MAX_AGENTS) { const out = []; const walk = (x) => { for (const c of kids.get(x) || []) { if (out.length >= cap) return; out.push(c); walk(c.id); } }; walk(id); return out; }
function sessionRows() {
  const { roots, kids } = tree(), rows = [];
  for (const r of roots.values()) { const all = [r, ...descendants(r.id, kids)]; let mtime = 0, size = 0; for (const m of all) { const s = statOf(m); if (!s) continue; mtime = Math.max(mtime, s.mtime); size += s.size; } rows.push({ meta: r, all, mtime, size }); }
  rows.sort((a, b) => b.mtime - a.mtime); return rows;
}

// ---- what the human typed, without the wrappers Codex puts around it (AGENTS.md, the environment, skills, peer messages)
const WRAP = /^\s*(# AGENTS\.md instructions|<environment_context>|<skill>|<turn_aborted>|<send_user_message_question_reply>|<image name=|Another agent session \()/;
const texts = (p) => (Array.isArray(p.content) ? p.content : []).filter((c) => c && (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string').map((c) => c.text);
const isSummary = (p) => (((p.internal_chat_message_metadata_passthrough || {}).content_item_kinds) || []).includes('compaction.summary');
// A thread started by another Codex thread (codex_tui's send_message_to_thread) gets its task as a function_call_output with no call: the text inside <input>.
const delegated = (p) => (p.type === 'function_call_output' && !p.call_id && p.name === 'send_message_to_thread' && typeof p.output === 'string' ? ((/<input>([\s\S]*?)<\/input>/.exec(p.output) || [])[1] || '').trim() : '');
const readHead = (file, bytes) => { const fd = fs.openSync(file, 'r'); try { const n = Math.min(bytes, fs.fstatSync(fd).size), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, 0); return buf.toString('utf8'); } finally { fs.closeSync(fd); } };
// A first prompt as a title: its first meaningful sentence, without the model/effort boilerplate ("GPT-6-Astra at ultra/max", "inheriting Astra ultra"), cut at a word.
const EFFORT = /\b(?:use\s+)?(?:at\s+)?(?:inherit(?:ed|ing)\s+|retain(?:ed|ing)\s+)?(?:(?:gpt-[\w.-]+|astra)\s*(?:at\s+)?)?(?:ultra|max|xhigh)(?:\s*\/\s*(?:ultra|max|xhigh))*(?:\s+reasoning)?(?:\s+(?:inherited|retained))?\b|\b(?:gpt-[\w.-]+|astra)\b(?=\s*,)/gi;
const NOISE = /^(?:maximum reasoning|inherit|retain|you are\s*$|in this own-[\w-]+ fork$|(?:gpt-[\w.-]+|astra)$)|inherit\w*\s*(?:astra|ultra)|astra\s*ultra|reasoning\s+ultra/i;
function tidyTitle(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  for (const sentence of s.split(/(?<=[.!?])\s+/)) {
    const kept = sentence.replace(/:?\s*\bexecute\b.*$/i, '').replace(/[.!?]+$/, '').split(/\s*[,;(]\s*|\)\s*/).map((c) => c.replace(EFFORT, ' ').replace(/\s+/g, ' ').trim()).filter((c) => c && !NOISE.test(c) && /[a-z]{2}/i.test(c));
    let t = kept.join(', ').replace(/^(?:you are|you're)\s+(?:the |a |an )?(?:only |fresh |new |explicit |dedicated )*/i, '').replace(/[\s,:–—-]+$/, '').replace(/^[\s,:–—-]+/, '');
    if (t.replace(/\W/g, '').length < 6) continue;
    t = t[0].toUpperCase() + t.slice(1);
    return peers.label(t, max);
  }
  return peers.label(s, max);
}
const titleCache = new Map();   // file → { size, title }
function titleOf(m) {
  const named = m.agentPath ? '' : threadName(m.id); if (named) return named;   // the name the person gave the thread beats its first prompt
  const hit = titleCache.get(m.file); if (hit && (hit.title || hit.size === (statOf(m) || {}).size)) return hit.title || fallbackTitle(m);
  let title = null;
  try {
    for (const line of readHead(m.file, 192 * 1024).split('\n')) {
      if (!line.includes('"role":"user"') && !line.includes('send_message_to_thread')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; } const p = r.payload || {}; if (r.type !== 'response_item' || (m.histStart && r.ordinal < m.histStart)) continue;
      const t = p.type === 'message' && p.role === 'user' && !isSummary(p) ? texts(p).find((x) => x.trim() && !WRAP.test(x)) : delegated(p);
      if (t) { title = tidyTitle(t); break; }
    }
  } catch {}
  titleCache.set(m.file, { size: (statOf(m) || {}).size, title }); peers.capped(titleCache, 4000); return title || fallbackTitle(m);
}
const fallbackTitle = (m) => (m.agentPath ? human(m.agentPath.split('/').pop()) : threadName(m.id) || 'Codex session from ' + (m.start ? new Date(m.start).toTimeString().slice(0, 5) : m.id.slice(-4)) + ', no prompt yet');
// Functional names: the thread name the person gave (session_index.jsonl), and for a sub-agent the last segment of its agent path, as words.
const human = (seg) => String(seg || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
let names = { at: 0, sig: '', map: new Map() };
function threadName(id) {
  const f = path.join(HOME(), 'session_index.jsonl'); let st; try { st = fs.statSync(f); } catch { return ''; }
  const sig = st.mtimeMs + ':' + st.size;
  if (sig !== names.sig) { const map = new Map(); try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r && typeof r.id === 'string' && typeof r.thread_name === 'string' && r.thread_name.trim()) map.set(r.id, r.thread_name.trim()); } catch {} } } catch {} names = { at: Date.now(), sig, map }; }   // last line per id wins (renames append)
  return names.map.get(id) || '';
}
function list(limit = 60) { return sessionRows().slice(0, limit).map(({ meta, all, mtime, size }) => ({ proj: '_codex', id: meta.id, mtime, size, agents: all.length - 1, title: titleOf(meta), project: meta.cwd, group: project.groupOf(meta.cwd), source: 'codex' })); }

// ---- the transcript: each rollout is parsed once, then only the bytes appended since (same incremental reader as the Claude Code path)
const fileStates = new Map();
function readNew(file, agent, meta, budget = peers.maxFileBytes()) {
  let size; try { size = fs.statSync(file).size; } catch { fileStates.delete(file); return null; }
  let st = fileStates.get(file);
  if (!st || size < st.offset) { st = { agent, offset: 0, tail: Buffer.alloc(0), raw: [], pending: new Map(), childByCall: {}, seen: new Set(), model: '', exec: null, histStart: meta.histStart || 0 }; if (size > budget) { st.offset = size - budget; st.cutStart = true; st.truncated = true; } fileStates.set(file, st); }   // a huge file: only its end
  while (size > st.offset) {
    const fd = fs.openSync(file, 'r'); let buf;
    try { buf = Buffer.alloc(Math.min(16 * 1024 * 1024, size - st.offset)); fs.readSync(fd, buf, 0, buf.length, st.offset); } finally { fs.closeSync(fd); }
    st.offset += buf.length;
    const all = st.tail.length ? Buffer.concat([st.tail, buf]) : buf, cut = all.lastIndexOf(10);
    if (cut < 0) { st.tail = all; continue; }
    st.tail = all.subarray(cut + 1);
    const lines = all.subarray(0, cut).toString('utf8').split('\n'); if (st.cutStart) { lines.shift(); st.cutStart = false; }   // the first line of a cut read is a piece of one
    for (const line of lines) {
      if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      try { parseRecord(st, r); } catch {}
    }
  }
  return st;
}
// The shell commands inside an exec script (tools.exec_command({cmd: "…"})), so the screen shows commands rather than JavaScript.
function cmdsIn(js) {
  const out = []; for (const m of String(js).matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) { const s = m[1]; let v; if (s[0] === '"') { try { v = JSON.parse(s); } catch { v = s.slice(1, -1); } } else v = s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'); out.push(v); } return out;
}
const firstTool = (js) => (/\btools\.(\w+)\s*\(/.exec(String(js)) || [])[1] || '';
const segs = (output) => (Array.isArray(output) ? output.slice(1).filter((x) => x && typeof x.text === 'string').map((x) => { const j = /^\s*\{/.test(x.text) ? (() => { try { return JSON.parse(x.text); } catch { return null; } })() : null; return j && typeof j.output === 'string' ? j.output : x.text; }).join('\n') : String(output || ''));
const head = (output) => (Array.isArray(output) ? (output[0] && output[0].text) || '' : String(output || ''));
const mcpText = (res) => (res && Array.isArray(res.content) ? res.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n') : typeof res === 'string' ? res : res && res.error ? String(res.error.message || res.error) : '');
const firstStr = (a) => (a && typeof a === 'object' ? Object.values(a).find((v) => typeof v === 'string') || '' : '');
const fileOfUrl = (u) => String(u || '').replace(/^file:\/\//, '');
const qText = (a) => (Array.isArray(a.questions) ? a.questions : []).map((x) => (x.title || x.question || '') + '\n' + (Array.isArray(x.options) ? x.options : []).map((o) => '• ' + (o && (o.label || o.title) || o)).join('\n')).join('\n');
const diffSide = (diff, sign) => String(diff).split('\n').filter((l) => l[0] === sign && !/^(\+\+\+|---)/.test(l)).map((l) => l.slice(1)).join('\n');
function parseRecord(st, r) {
  if (st.histStart && r.ordinal < st.histStart) return;   // a forked sub-agent replays its parent's history first: that is the parent's, shown there
  const ts = Date.parse(r.timestamp) || 0, p = r.payload || {}, agent = st.agent;
  if (r.type === 'turn_context') { if (p.model) st.model = p.model; return; }
  if (r.type === 'event_msg' && p.type === 'task_complete' && typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) { st.answer = { ts, text: p.last_agent_message.trim() }; }   // the agent's report, in plain text
  if (r.type === 'compacted') { st.raw.push({ ts, agent, kind: 'compact' }); return; }
  if (r.type === 'token_usage_record') {   // one per API response; the same response can be recorded again on resume
    const u = p.usage; if (!u || (p.response_id && st.seen.has(p.response_id))) return; if (p.response_id) st.seen.add(p.response_id);
    st.raw.push({ ts, agent, kind: 'usage', u: { i: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), o: u.output_tokens || 0, r: u.cached_input_tokens || 0, w: u.cache_write_input_tokens || 0 }, model: st.model }); return;
  }
  if (r.type === 'event_msg') { if (p.type === 'item_completed') item(st, p.item, ts); return; }
  if (r.type !== 'response_item') return;
  switch (p.type) {
    case 'message': {
      if (p.role === 'assistant') { const t = texts(p).join('\n').trim(); if (t) st.raw.push({ ts, agent, kind: 'say', text: t }); break; }
      if (p.role !== 'user' || isSummary(p)) break;
      for (const t of texts(p)) {
        const inc = peers.incoming(t); if (inc) { st.raw.push({ ts, agent, kind: 'msg', dir: 'in', from: inc.addr, name: inc.name, msgId: inc.msgId, text: clip(inc.text, 2000) }); continue; }
        const s = t.trim(); if (s && !WRAP.test(s)) { if (agent === 'main') st.raw.push({ ts, agent: 'user', kind: 'user', text: s }); else (st.briefs = st.briefs || []).push({ ts, text: s }); }   // a sub-agent's own user messages: its brief, in plain text
      }
      break;
    }
    case 'custom_tool_call': {   // in current Codex everything runs through one `exec` script tool; its commands come back as CommandExecution items (below)
      const cmds = p.name === 'exec' ? cmdsIn(p.input) : [], name = p.name === 'exec' ? (firstTool(p.input) || 'exec') : p.name, text = cmds.length ? cmds.join('\n') : String(p.input || '');
      st.pending.set(p.call_id, { name: 'exec', outs: [] }); st.exec = p.call_id;
      st.raw.push({ ts, agent, kind: 'tool', tool: { id: p.call_id, ts, name, arg: clip(cmds[0] || text, 90), d: name === 'apply_patch' && !cmds.length ? { kind: 'write', file: '', text: clip(text, 800) } : { kind: 'cmd', text: clip(text, 1200) } } });
      break;
    }
    case 'custom_tool_call_output': {
      const pd = st.pending.get(p.call_id); if (!pd) break; st.pending.delete(p.call_id); if (st.exec === p.call_id) st.exec = null;
      const failed = /^Script failed/.test(head(p.output)) || pd.outs.some((o) => o.err), out = pd.outs.length ? pd.outs.map((o) => o.text).join('\n') : segs(p.output);
      st.raw.push({ ts, agent, kind: 'results', items: [{ id: p.call_id, err: failed, out: clip(out, 1300) }] }); break;
    }
    case 'function_call': {
      let a = {}; try { a = JSON.parse(p.arguments || '{}'); } catch {}
      const pd = { name: p.name, outs: [] }; st.pending.set(p.call_id, pd);
      if (p.name === 'spawn_agent') st.raw.push({ ts, agent, kind: 'agentcall', toolId: p.call_id, bg: true, title: a.task_name || '', text: '', atype: a.agent_type || '' });   // the task text itself is encrypted in the rollout
      else if (p.name === 'send_message' || p.name === 'followup_task') pd.msg = { ts, agent, kind: 'msg', dir: 'out', native: true, target: a.target || '', text: '', verb: p.name };   // so is the message: shown as an edge, emitted once the call answers
      else if (/^request_user_input/.test(p.name)) st.raw.push({ ts, agent, kind: 'tool', tool: { id: p.call_id, ts, name: p.name, arg: clip(qText(a), 90), d: { kind: 'text', what: 'question', text: clip(qText(a), 500) } } });
      else st.raw.push({ ts, agent, kind: 'tool', tool: { id: p.call_id, ts, name: p.name, arg: clip(firstStr(a), 90), d: { kind: 'text', text: clip(JSON.stringify(a), 300) } } });
      break;
    }
    case 'function_call_output': {
      const task = delegated(p); if (task) {   // another Codex thread's message (codex_tui send_message_to_thread): from that thread, not from the person
        const src = (/<source_thread_id>([0-9a-f-]{32,})<\/source_thread_id>/.exec(p.output) || [])[1];
        if (src) st.raw.push({ ts, agent, kind: 'msg', dir: 'in', from: 'uds:codex-' + src.replace(/-/g, '').slice(-16) + '.sock', name: '', text: clip(task, 4000) });
        else if (agent === 'main') st.raw.push({ ts, agent: 'user', kind: 'user', text: clip(task, 4000) });
        break;
      }
      const pd = st.pending.get(p.call_id); if (!pd) break; st.pending.delete(p.call_id);
      const out = typeof p.output === 'string' ? p.output : segs(p.output);
      if (pd.msg) { st.raw.push({ ...pd.msg, ts, sent: pd.msg.ts, state: out.trim() && !/^\s*\{/.test(out) ? 'failed' : 'accepted', detail: clip(out, 200) }); break; }
      if (pd.name === 'spawn_agent') break;
      st.raw.push({ ts, agent, kind: 'results', items: [{ id: p.call_id, err: /not found|error/i.test(out) && !/^\s*\{/.test(out), out: clip(out, 600) }] }); break;
    }
  }
}
function item(st, it, ts) {   // the structured record of each thing a script did: a command, a patch, an MCP call, a sub-agent start
  if (!it || typeof it !== 'object') return; const agent = st.agent, exec = st.exec ? st.pending.get(st.exec) : null;
  switch (it.type) {
    case 'CommandExecution': {
      const c = Array.isArray(it.command) ? (it.command.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(it.command[0]) && /^-l?c$/.test(it.command[1]) ? it.command[2] : it.command.join(' ')) : String(it.command || '');
      const err = it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0), text = '$ ' + clip(c, 300) + '\n' + clip(it.aggregated_output, 1200) + (err ? `\n[exit ${it.exit_code}]` : '');
      if (exec) exec.outs.push({ text, err });
      else st.raw.push({ ts, agent, kind: 'tool', tool: { id: it.id, ts, name: 'exec_command', arg: clip(c, 90), d: { kind: 'cmd', text: clip(c, 1200) } } }, { ts, agent, kind: 'results', items: [{ id: it.id, err, out: clip(it.aggregated_output, 1300) }] });
      break;
    }
    case 'FileChange': {
      for (const [f, c] of Object.entries(it.changes || {})) {
        const diff = (c && c.unified_diff) || '', id = it.id + ':' + f, d = c && c.type === 'add' ? { kind: 'write', file: f, text: clip(c.content, 800) } : { kind: 'edit', file: f, old: clip(diffSide(diff, '-'), 500), new: clip(diffSide(diff, '+'), 500) };
        st.raw.push({ ts, agent, kind: 'tool', tool: { id, ts, name: 'apply_patch', arg: clip(f, 90), d } }, { ts, agent, kind: 'results', items: [{ id, err: it.status === 'failed', out: clip(it.stdout || it.stderr || '', 200) }] });
      }
      break;
    }
    case 'McpToolCall': {
      const text = mcpText(it.result), err = it.status === 'failed' || !!(it.result && it.result.isError), a = it.arguments || {};
      if (it.server === 'agent-peers' && it.tool === 'send_peer') { const sc = (it.result && it.result.structuredContent) || {}; st.raw.push({ ts, agent, kind: 'msg', dir: 'out', to: sc.to || a.to || '', name: sc.name || '', text: clip(a.message, 2000), msgId: sc.message_id || '', state: sc.receipt === 'held' ? 'held' : peers.sendState(text, err), detail: clip(text, 200) }); break; }
      const name = 'mcp__' + (it.server || '') + '__' + (it.tool || '');
      st.raw.push({ ts, agent, kind: 'tool', tool: { id: it.id, ts, name, arg: clip(firstStr(a), 90), d: { kind: 'text', what: 'mcp', v: (it.server || '') + ' ' + (it.tool || ''), text: clip(JSON.stringify(a), 400) } } }, { ts, agent, kind: 'results', items: [{ id: it.id, err, out: clip(text, 900) }] });
      break;
    }
    case 'ImageView': st.raw.push({ ts, agent, kind: 'tool', tool: { id: it.id, ts, name: 'view_image', arg: clip(fileOfUrl(it.path), 90), d: { kind: 'read', file: fileOfUrl(it.path) } } }); break;
    case 'SubAgentActivity':
      if (it.kind === 'started' && it.agent_thread_id) st.childByCall[it.id] = it.agent_thread_id;
      else if (it.kind === 'completed' && it.agent_thread_id) st.raw.push({ ts, agent, kind: 'agentdone', child: it.agent_thread_id });
      break;
  }
}
function timeline(proj, id) {
  const root = metaById(id); if (!root) throw new Error('session not found');
  const { kids } = tree(), all = [root, ...descendants(root.id, kids)];
  const agents = { main: { id: 'main', role: 'Lead', type: 'main', name: 'Codex' } }, states = [], childByTool = {}, childByPath = { '/root': 'main' }, pathOf = { main: '/root' };
  for (const m of all) {
    const aid = m === root ? 'main' : m.id;
    if (aid !== 'main') {   // the functional name: the last segment of its path as words; its kind (worker, explorer) as the role; its full path and the nickname Codex invented only in the detail header
      const segs = (m.agentPath || '').split('/').filter(Boolean), leaf = segs.pop() || '';
      agents[aid] = { id: aid, name: peers.label(human(leaf).replace(/ (?:ultra|max|xhigh)$/i, '') || m.nickname || 'sub-agent', 40), role: m.role && !/^(default|agent)$/.test(m.role) ? m.role : 'sub-agent', nick: [m.agentPath, m.nickname].filter(Boolean).join(', '), type: m.role || 'agent', mtime: (statOf(m) || {}).mtime };
      if (m.agentPath) { childByPath[m.agentPath] = aid; pathOf[aid] = m.agentPath; }
    }
    const st = readNew(m.file, aid, m, peers.readBudget(m === root, all.length - 1)); if (!st) continue; states.push(st); Object.assign(childByTool, st.childByCall); if (st.truncated && agents[aid]) agents[aid].truncated = true;
  }
  // this session's own agent-peers addresses and names: codex-<last 16 hex>, codex:<slug>-<last 4 hex>, codex:<nickname>
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''), byKey = {}, byName = {}, byTail = {};
  for (const m of all) { const aid = m === root ? 'main' : m.id, hex = m.id.replace(/-/g, ''); byKey['codex-' + hex.slice(-16)] = aid; byTail[hex.slice(-4)] = aid; if (m.nickname) byName[norm('codex:' + m.nickname)] = aid; }
  const own = (x) => { const a = peers.parseAddress(x); if (a) return byKey[a.key] || ''; const s = String(x || ''); if (!s.startsWith('codex:')) return ''; const t = /-([0-9a-f]{4})$/.exec(s); return byName[norm(s)] || (t && byTail[t[1]]) || ''; };
  const tl = assemble({ id, proj, agents, states, childByTool, childByPath, pathOf, own });
  readable(tl, states, agents); return { ...tl, group: project.groupOf(root.cwd), title: titleOf(root) };
}
// Codex encrypts what agents send each other, but the plain text around a message says what it was: a sub-agent's own brief and report are in its rollout.
// Each edge gets the best summary available (the brief as the child received it, the child's last words, or the verb, target and count) and a note that the body itself is not readable.
const NOTE = 'body not readable, Codex encrypts it', line1 = (s, n = 180) => clip(String(s || '').split('\n').find((l) => l.trim()) || '', n);
function readable(tl, states, agents) {
  const by = new Map(states.map((st) => [st.agent, st])), counts = {};
  const near = (list, ts, after, span = 180000) => (list || []).find((x) => (after ? x.ts >= ts && x.ts - ts <= span : x.ts <= ts && ts - x.ts <= span));
  const says = (aid) => (by.get(aid) ? by.get(aid).raw.filter((e) => e.kind === 'say') : []).slice().reverse();   // latest first, for "before" lookups
  for (const e of tl.events) {
    if (e.kind === 'order' && !e.text) { const st = by.get(e.to), b = st && st.briefs && st.briefs[0]; e.text = b ? line1(b.text, 300) : `task "${e.title || (agents[e.to] || {}).name || e.to}"${e.atype ? ' (' + e.atype + ')' : ''}`; e.note = b ? '' : NOTE; if (!b) e.label = true; }   // label: shown, never read aloud
    else if (e.kind === 'msg' && e.native && !e.text) {
      const k = e.agent + '>' + e.to, n = (counts[k] = (counts[k] || 0) + 1), nm = (id) => (agents[id] || {}).name || id;
      let got = null;
      if (e.to !== 'main' && by.get(e.to)) got = near((by.get(e.to) || {}).briefs, e.sent || e.ts, true);   // to a sub-agent: what it received next, in its own words
      else if (e.agent !== 'main' && by.get(e.agent)) { const st = by.get(e.agent); got = near(says(e.agent), e.sent || e.ts, false) || (st.answer && Math.abs(st.answer.ts - e.ts) < 180000 ? st.answer : null); }   // from a sub-agent: what it had just said, or its report
      e.text = got ? line1(got.text) : `${e.verb === 'followup_task' ? 'follow-up to' : 'message to'} ${nm(e.to)} (#${n})`; e.note = NOTE; if (!got) e.label = true;
    }
  }
}

// ---- board, liveness, cache keys
const tailCache = new Map();   // file → { sig, pending, lastTask, lastTs, peers }
function tail(file) {
  let st; try { st = fs.statSync(file); } catch { return { pending: [], lastTask: '', lastTs: 0, peers: { hits: [] } }; }
  const sig = st.mtimeMs + ':' + st.size, hit = tailCache.get(file); if (hit && hit.sig === sig) return hit;
  const fd = fs.openSync(file, 'r'); let text;
  try { const n = Math.min(192 * 1024, st.size), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, st.size - n); text = buf.toString('utf8'); if (st.size > n) text = text.slice(text.indexOf('\n') + 1); } finally { fs.closeSync(fd); }
  const pend = new Map(); let lastTask = '', lastTs = 0, last = null;
  for (const l of text.split('\n')) {
    if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; } const p = r.payload || {}, t = Date.parse(r.timestamp) || 0; if (t) lastTs = t;
    if (r.type === 'event_msg') { if (p.type === 'task_started') lastTask = 'started'; else if (p.type === 'task_complete') lastTask = 'complete'; else if (p.type === 'turn_aborted') lastTask = 'aborted'; }
    else if (r.type === 'response_item') {
      if (p.type === 'custom_tool_call') pend.set(p.call_id, (last = { name: firstTool(p.input) || p.name, ts: t, arg: clip(cmdsIn(p.input)[0] || String(p.input || ''), 90) }));
      else if (p.type === 'function_call') { let a = {}; try { a = JSON.parse(p.arguments || '{}'); } catch {} pend.set(p.call_id, (last = { name: p.name, ts: t, arg: clip(a.task_name || a.target || firstStr(a), 90) })); }
      else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') pend.delete(p.call_id);
    }
  }
  const out = { sig, pending: [...pend.values()], last, lastTask, lastTs, peers: peers.tailPeers(text) };
  tailCache.set(file, out); if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value); return out;
}
const isOpen = (id) => fs.existsSync(path.join(HOME(), 'thread-writer-locks', id + '.lock'));   // Codex holds a lock file while a thread is loaded
function board(now = Date.now()) {
  return sessionRows().filter((r) => now - r.mtime < 12 * 3600e3).slice(0, 80).map(({ meta, all, mtime }) => {
    const t = tail(meta.file), age = now - mtime; let state = 'idle', tool = '', arg = '', ageMs = age;
    if (age < 30 * 60e3) {
      const lp = t.pending[t.pending.length - 1];
      if (lp) { tool = lp.name; arg = lp.arg || ''; ageMs = now - (lp.ts || mtime); state = /^(spawn_agent|wait_agent|wait)$/.test(lp.name) ? 'waiting' : /^request_user_input/.test(lp.name) && ageMs > 4000 ? 'blocked' : 'working'; }
      else if (t.lastTask === 'complete' || t.lastTask === 'aborted') state = isOpen(meta.id) ? 'turn' : 'idle';
      else { state = age < 10 * 60e3 ? 'working' : 'idle'; if (state === 'working' && t.last) { tool = t.last.name; arg = t.last.arg || ''; } }   // between two calls: the last thing it ran
    }
    let subActive = 0; const active = []; for (const m of all.slice(1)) { const s = statOf(m); if (s && now - s.mtime < 90e3) { subActive++; if (active.length < 4) active.push(peers.label(human(String(m.agentPath || '').split('/').pop() || m.nickname || 'sub-agent').replace(/ (?:ultra|max|xhigh)$/i, ''), 32)); } }
    return { proj: '_codex', id: meta.id, title: titleOf(meta), mtime, state, tool, arg, ageMs, subActive, active, subTotal: all.length - 1, source: 'codex', project: meta.cwd, group: project.groupOf(meta.cwd), ...((tk) => ({ peers: tk.names, msgs: tk.n }))(peers.talksNow(t.peers, now)), oneshot: meta.originator === 'codex_exec' && all.length === 1 };   // a `codex exec` run with no agents of its own: a one-shot job
  });
}
const exists = (proj, id) => !!fileOf(id);
function treeOf(id) { const m = metaById(id); if (!m) return []; return [m, ...descendants(id, tree().kids)]; }
const mtime = (proj, id) => treeOf(id).reduce((n, m) => { const s = statOf(m); return s ? Math.max(n, s.mtime) : n; }, 0);
const stamp = (proj, id) => treeOf(id).reduce((n, m) => { const s = statOf(m); return s ? n + s.mtime + s.size : n; }, 0);
function forget(proj, id) { for (const m of treeOf(id)) fileStates.delete(m.file); }
// A Codex inbox address is the thread id: codex-<last 16 hex of the id without dashes>.
const registryName = (id) => { try { const d = process.env.AGENT_PEERS_HOME || path.join(os.homedir(), '.agent-peers'); const j = JSON.parse(fs.readFileSync(path.join(d, 'codex-' + id + '.json'), 'utf8')); return typeof j.name === 'string' ? j.name : ''; } catch { return ''; } };
peers.register('codex', (key) => {
  const hex = key.replace(/^codex-/, ''); let m = null;
  for (const x of scan().byId.values()) if (x.id.replace(/-/g, '').endsWith(hex)) { m = x; break; }
  if (!m) return null; const root = m.child ? metaById(m.root) || m : m;
  return { source: 'codex', proj: '_codex', id: root.id, name: registryName(m.id) || 'codex:' + path.basename(m.cwd || '') + '-' + hex.slice(-4), cwd: m.cwd, group: project.groupOf(m.cwd) };
});
module.exports = { list, board, exists, mtime, stamp, timeline, forget, tidyTitle };
