#!/usr/bin/env node
// Agent Standup: turns Claude Code session transcripts into a replayable "team call" timeline.
// No dependencies. Run: node server.js  → http://localhost:4747
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const kokoro = require('./kokoro.js');   // natural voices, installed on demand (see kokoro.js)
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT || 4747;
// Same place Claude Code writes to: honours CLAUDE_CONFIG_DIR (custom config dirs are common on Linux); AGENT_STANDUP_PROJECTS overrides it.
const ROOT = process.env.AGENT_STANDUP_PROJECTS || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const PUBLIC = path.join(__dirname, 'public');
// Other agent tools: one small adapter each, turning its own store into the same sessions, board rows and timeline (see adapters/). The
// proj value the page already passes around picks the source: "_codex" and "_hermes[-profile]" are reserved like "_demo"; anything else is Claude Code.
const codex = require('./adapters/codex.js'), hermes = require('./adapters/hermes.js'), peers = require('./adapters/peers.js'), project = require('./adapters/project.js');
const SOURCES = [codex, hermes], SRC_NAME = new Map([[codex, 'Codex'], [hermes, 'Hermes']]), sourceOf = (proj) => (proj === '_codex' ? codex : /^_hermes(-|$)/.test(proj) ? hermes : null);

const blocks = (rec) => {
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
};
const clip = (x, n = 700) => String(x == null ? '' : x).slice(0, n);
// What each tool call looks like on a screen ("d"), plus its id/timestamp so the result can be matched later.
const toolLabel = (b, ts) => {
  const i = b.input || {};
  const q0 = Array.isArray(i.questions) && i.questions[0] ? i.questions[0] : null, mcp = /^mcp__/.test(b.name) ? b.name.split('__') : null, firstStr = mcp ? Object.values(i).find((v) => typeof v === 'string') : '';
  const arg = i.file_path || i.notebook_path || i.path || i.pattern || i.command || i.url || i.query || i.skill || (q0 && q0.question) || i.description || firstStr || '';
  const out = { id: b.id, ts, name: b.name, arg: String(arg).slice(0, 90) };
  switch (b.name) {
    case 'Bash': out.d = { kind: 'cmd', text: clip(i.command, 1200), note: clip(i.description, 140) }; break;
    case 'Read': out.d = { kind: 'read', file: i.file_path, offset: i.offset, limit: i.limit }; break;
    case 'Edit': case 'MultiEdit': { const e = i.edits ? i.edits[0] || {} : i; out.d = { kind: 'edit', file: i.file_path, old: clip(e.old_string, 500), new: clip(e.new_string, 500) }; break; }
    case 'Write': out.d = { kind: 'write', file: i.file_path, text: clip(i.content, 800) }; break;
    case 'Grep': out.d = { kind: 'grep', pattern: clip(i.pattern, 100), path: i.path, glob: i.glob }; break;
    case 'Glob': out.d = { kind: 'glob', pattern: clip(i.pattern, 100), path: i.path }; break;
    case 'TodoWrite': out.d = { kind: 'todo', items: (i.todos || []).slice(0, 20).map((x) => ({ c: clip(x.content, 120), s: x.status })) }; break;
    case 'WebFetch': out.d = { kind: 'web', url: i.url }; break;
    case 'WebSearch': out.d = { kind: 'web', query: i.query }; break;
    case 'NotebookEdit': out.d = { kind: 'edit', file: i.notebook_path, old: '', new: clip(i.new_source, 500) }; break;
    case 'AskUserQuestion': out.d = { kind: 'text', what: 'question', text: clip((q0 ? q0.question + '\n' + (q0.options || []).map((o) => '• ' + (o.label || '')).join('\n') : ''), 500) }; break;
    case 'Skill': out.d = { kind: 'text', what: 'skill', v: i.skill, text: clip(i.skill + (i.args ? ' ' + i.args : ''), 200) }; break;
    case 'ToolSearch': out.d = { kind: 'text', what: 'toolsearch', text: clip(i.query, 200) }; break;
    default: out.d = mcp ? { kind: 'text', what: 'mcp', v: (mcp[1] || '') + ' ' + (mcp.slice(2).join('__') || ''), text: clip(JSON.stringify(i), 400) } : { kind: 'text', text: clip(JSON.stringify(i), 300) };
  }
  return out;
};
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '');
// Pictures a tool returned (a screenshot, an image file that was read). They are served from the transcript itself, so nothing outside the session files is ever read, and only bitmap types are sent.
const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), mediaMemo = new Map();
const isImg = (x) => !!x && x.type === 'image' && !!x.source && x.source.type === 'base64' && typeof x.source.data === 'string' && IMG_TYPES.has(x.source.media_type);
const resultImages = (c) => (Array.isArray(c) ? c.filter(isImg) : []);
function mediaFile(proj, sid, agent) {
  if (agent === 'main') return path.join(ROOT, proj, sid + '.jsonl');
  const dir = path.join(ROOT, proj, sid, 'subagents'); let hit = null;
  try { hit = fs.readdirSync(dir).find((x) => x.endsWith('.jsonl') && x.replace(/^agent-/, '').replace(/\.jsonl$/, '').replace(/[^\w.-]/g, '_') === agent); } catch {}
  return hit ? path.join(dir, hit) : null;
}
function toolImage(file, toolId, n) {   // looks for the tool's result line in the transcript, 8 MB at a time; the few pictures asked last are kept in memory
  const key = file + '|' + toolId + '|' + n; if (mediaMemo.has(key)) return mediaMemo.get(key);
  const needle = Buffer.from(toolId), mark = Buffer.from('"image"'); let fd, found = null, carry = Buffer.alloc(0), pos = 0;
  try {
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    while (pos < size && !found) {
      const buf = Buffer.alloc(Math.min(8 * 1024 * 1024, size - pos)); fs.readSync(fd, buf, 0, buf.length, pos); pos += buf.length;
      const all = carry.length ? Buffer.concat([carry, buf]) : buf; let from = 0;
      for (let hit; !found && (hit = all.indexOf(needle, from)) >= 0;) {
        const a = all.lastIndexOf(10, hit) + 1, b = all.indexOf(10, hit); if (b < 0) break;   // the line goes on in the next chunk
        from = b + 1; const m = all.indexOf(mark, a); if (m < 0 || m > b) continue;
        let r; try { r = JSON.parse(all.subarray(a, b).toString('utf8')); } catch { continue; }
        for (const blk of blocks(r)) if (blk.type === 'tool_result' && blk.tool_use_id === toolId) { const im = resultImages(blk.content)[n]; if (im) found = { type: im.source.media_type, buf: Buffer.from(im.source.data, 'base64') }; }
      }
      carry = all.subarray(all.lastIndexOf(10) + 1);
    }
  } catch {} finally { if (fd != null) fs.closeSync(fd); }
  if (found) { mediaMemo.set(key, found); if (mediaMemo.size > 12) mediaMemo.delete(mediaMemo.keys().next().value); }
  return found;
}
const RESULT_MAX = { AskUserQuestion: 900, Skill: 300, ToolSearch: 500, Read: 1900, Bash: 1300, Grep: 900, Glob: 800, WebFetch: 800, WebSearch: 800, Edit: 200, MultiEdit: 200, Write: 200 };
const NO_RESULT = new Set(['Agent', 'Task', 'SendMessage', 'TodoWrite']);   // internal bookkeeping, nothing to show
const HARNESS = /<(system-reminder|browser_instruction|ide_selection|ide_opened_file|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>\s*/g;   // blocks the harness wraps around what the human typed


let sessionsMemo = { at: 0, rows: [] };
function listSessions() {
  if (Date.now() - sessionsMemo.at < 2000) return sessionsMemo.rows;
  const out = listSessions0(); sessionsMemo = { at: Date.now(), rows: out }; return out;
}
function listSessions0() {
  const rows = [];
  for (const proj of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {   // no Claude Code folder is fine: the other sources still list
    const dir = path.join(ROOT, proj);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      const st = fs.statSync(path.join(dir, f));
      const subDir = path.join(dir, id, 'subagents');
      const agents = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl')).length : 0;
      rows.push({ proj, id, mtime: st.mtimeMs, size: st.size, agents });
    }
  }
  for (const src of SOURCES) { try { rows.push(...src.list()); peers.problem(SRC_NAME.get(src) + ' list', null); } catch (e) { peers.problem(SRC_NAME.get(src) + ' list', e); } }   // Codex and Hermes sessions, titles included
  rows.sort((a, b) => b.mtime - a.mtime);
  const top = rows.slice(0, 60);
  for (const r of top) {   // titles come from the cached tail read (custom title, then AI title, then first prompt): no whole-file reads
    if (r.source) continue;
    let t = null, cwd = ''; try { const f = path.join(ROOT, r.proj, r.id + '.jsonl'), p = parseTail(f, fs.statSync(f)); t = p.title; cwd = p.cwd; } catch {}
    r.title = t || r.id; r.project = r.proj.replace(/^-Users-[^-]+-/, '').replace(/-/g, '/'); r.source = 'claude'; r.group = project.groupOf(cwd);
  }
  return top;
}

function stamp(proj, id) {
  const src = sourceOf(proj); if (src) return src.stamp(proj, id);
  const base = path.join(ROOT, proj); let n = 0;
  const add = (f) => { try { const s = fs.statSync(f); n += s.mtimeMs + s.size; } catch {} };
  add(path.join(base, id + '.jsonl'));
  const sd = path.join(base, id, 'subagents');
  if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) add(path.join(sd, f));
  return n;
}
const tlCache = new Map();   // "proj/id" → { st (file stamp), tl, at, ms, files[], json?, gz? }
const MAX_CACHED_SESSIONS = 3, MAX_CACHE_BYTES = () => (+process.env.AGENT_STANDUP_CACHE_MB || 200) * 1048576;   // at most 3 sessions, and their served JSON within the byte budget (the newest is always kept)
const entryBytes = (e) => e.bytes || e.tl.events.length * 600;   // before its first response, an estimate from its events
function timelineEntry(proj, id) {
  const key = proj + '/' + id, st = stamp(proj, id), hit = tlCache.get(key), now = Date.now();
  const fresh = (h) => { tlCache.delete(key); tlCache.set(key, h); return h; };   // the most recently used goes last: eviction takes the oldest
  if (hit && hit.st === st && !(hit.recentUntil && now > hit.recentUntil)) return fresh(hit);   // a sub-agent's 4-minute silence rule can flip without any file change
  if (hit && now - hit.at < Math.max(250, hit.ms * 2)) return fresh(hit);   // very big sessions: don't rebuild on every poll
  const src = sourceOf(proj), t0 = Date.now(), tl = src ? src.timeline(proj, id) : buildTimeline(proj, id), base = path.join(ROOT, proj), sd = path.join(base, id, 'subagents');
  const files = src ? [] : [path.join(base, id + '.jsonl')]; if (!src) try { for (const f of fs.readdirSync(sd)) files.push(path.join(sd, f)); } catch {}
  // rev changes when events already sent to the page got reordered or inserted before (a sub-agent file that appeared late): the page then reloads instead of appending
  const rev = hit ? hit.rev + (samePrefix(hit.tl.events, tl.events) ? 0 : 1) : 1;
  const entry = { st, tl, at: Date.now(), ms: Date.now() - t0, files, recentUntil: tl.recentUntil || 0, rev, forget: src && src.forget ? () => src.forget(proj, id) : null };
  tlCache.delete(key); tlCache.set(key, entry);
  trimCache(); return entry;
}
function trimCache() {
  let total = 0; for (const e of tlCache.values()) total += entryBytes(e);
  while (tlCache.size > MAX_CACHED_SESSIONS || (tlCache.size > 1 && total > MAX_CACHE_BYTES())) {   // free the memory of sessions nobody is looking at any more
    const [oldKey, old] = tlCache.entries().next().value; tlCache.delete(oldKey); total -= entryBytes(old);
    for (const f of old.files) fileStates.delete(f);
    if (old.forget) old.forget();
  }
}
// The events already sent must be unchanged for the page to keep appending: same place, and same content for what can grow or flip (a tool beat, a message's state, usage).
const evSig = (e) => (e.kind === 'tools' ? e.tools.length : e.kind === 'msg' ? e.state + '|' + e.to : e.kind === 'usage' ? e.u.i + e.u.o + e.u.r + e.u.w : e.kind === 'results' ? e.items.length : 0);
const samePrefix = (a, b) => a.length <= b.length && a.every((e, i) => e.ts === b[i].ts && e.kind === b[i].kind && e.agent === b[i].agent && (i === a.length - 1 && e.kind === 'tools' ? e.tools.length <= b[i].tools.length : evSig(e) === evSig(b[i])));   // the last beat may still be growing: the page patches that one
const timeline = (proj, id) => timelineEntry(proj, id).tl;

// ---- Board: one cheap row per recent session (state from the tail of its transcript), so many parallel sessions can be watched at once.
const readTail = (file, bytes) => { const fd = fs.openSync(file, 'r'); try { const sz = fs.fstatSync(fd).size, n = Math.min(bytes, sz), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, sz - n); return { text: buf.toString('utf8'), cut: sz > bytes }; } finally { fs.closeSync(fd); } };
const readHead = (file, bytes) => { const fd = fs.openSync(file, 'r'); try { const n = Math.min(bytes, fs.fstatSync(fd).size), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, 0); return buf.toString('utf8'); } finally { fs.closeSync(fd); } };
const APPROVAL = /^(Edit|Write|MultiEdit|NotebookEdit)/, ASKS = /^(AskUserQuestion|ExitPlanMode)/, SUBTOOL = /^(Task|Agent)$/;
const boardCache = new Map();   // file → { sig, parsed, title }
let boardMemo = { at: 0, rows: [] };
function parseTail(file, st) {
  const sig = st.mtimeMs + ':' + st.size, hit = boardCache.get(file); if (hit && hit.sig === sig) return hit;
  const { text, cut } = readTail(file, 192 * 1024), lines = text.split('\n'); if (cut) lines.shift();
  const pend = new Map(); let lastType = null, lastTool = false, lastTs = 0, lastCall = null;
  for (const l of lines) {
    if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    const t = Date.parse(r.timestamp) || 0, bl = blocks(r);
    if (r.type === 'assistant' || r.type === 'user') { lastType = r.type; lastTool = bl.some((b) => b.type === 'tool_use'); if (t) lastTs = t; }
    for (const b of bl) { if (b.type === 'tool_use') pend.set(b.id, (lastCall = { name: b.name, ts: t, arg: toolLabel(b, t).arg })); else if (b.type === 'tool_result') pend.delete(b.tool_use_id); }
  }
  let title = hit && hit.title, tried = hit && hit.tried;
  if (!title && !tried) {
    const big = readTail(file, 256 * 1024).text, mc = [...big.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)].pop(), m = mc || [...big.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)].pop();   // a title the person typed wins over the generated one
    if (m) { try { title = JSON.parse('"' + m[1] + '"'); } catch {} }
    if (!title) { const hd = readHead(file, 64 * 1024), u2 = hd.match(/"type":"user"[\s\S]{0,3000}?"type":"text","text":"(?!<)((?:[^"\\]|\\.)*)"/); if (u2) { try { title = JSON.parse('"' + u2[1] + '"').replace(/\s+/g, ' ').slice(0, 90); } catch {} } }
    if (!title) { const u = readHead(file, 64 * 1024).match(/"role":"user","content":"((?:[^"\\]|\\.)*)"/); if (u) { try { title = JSON.parse('"' + u[1] + '"').replace(/\s+/g, ' ').slice(0, 90); } catch {} } }
  }
  const cwd = (hit && hit.cwd) || ((/"cwd":"((?:[^"\\]|\\.)*)"/.exec(text) || [])[1] || '');   // the folder the session runs in: its project
  const out = { sig, title: title || null, tried: true, lastType, lastTool, lastTs, pending: [...pend.values()], lastCall, talks: peers.tailPeers(text), cwd, msgIds: [...new Set([...text.matchAll(/\\*"msg_id\\*":\s*\\*"([0-9a-f-]{36})/g)].map((m) => m[1]))] };   // talks: the peers messaged in this tail
  boardCache.set(file, out); if (boardCache.size > 200) boardCache.delete(boardCache.keys().next().value); return out;
}
function boardRows() {
  if (Date.now() - boardMemo.at < 1200) return boardMemo.rows;   // several windows polling at once share one scan
  const out = boardRows0(); boardMemo = { at: Date.now(), rows: out }; return out;
}
function boardRows0() {
  const now = Date.now(), rows = [];
  for (const proj of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    const dir = path.join(ROOT, proj); let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) { try { const st = fs.statSync(path.join(dir, f)); if (now - st.mtimeMs < 12 * 3600e3) rows.push({ proj, id: f.slice(0, -6), st }); } catch {} }
  }
  rows.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const others = []; for (const src of SOURCES) { try { others.push(...src.board(now)); peers.problem(SRC_NAME.get(src) + ' board', null); } catch (e) { peers.problem(SRC_NAME.get(src) + ' board', e); } }   // an adapter that fails says so on the board
  peers.rememberLive(); const live = peers.liveClaude();
  return others.concat(rows.slice(0, 80).map(({ proj, id, st }) => {
    const file = path.join(ROOT, proj, id + '.jsonl'); let p; try { p = parseTail(file, st); } catch { p = { pending: [] }; }
    const age = now - st.mtimeMs, lp = (p.pending || [])[(p.pending || []).length - 1]; let state = 'idle', tool = '', ageMs = age;
    if (age < 30 * 60e3) {
      if (lp) { ageMs = now - (lp.ts || st.mtimeMs); tool = lp.name;
        state = SUBTOOL.test(lp.name) ? 'waiting' : (ASKS.test(lp.name) && ageMs > 4000) || (APPROVAL.test(lp.name) && ageMs > 15000) ? 'blocked' : 'working'; }
      else if (p.lastType === 'assistant' && !p.lastTool) state = 'turn';
      else { state = age < 10 * 60e3 ? 'working' : 'idle'; if (state === 'working' && p.lastCall) tool = p.lastCall.name; }   // between two calls: the last thing it ran
    }
    const stopped = !!(live && live.size && !live.has(id)); if (stopped && /^(working|waiting|blocked)$/.test(state)) { state = 'idle'; tool = ''; }   // stopped: no Claude process runs it any more, whatever its last record says
    let subActive = 0, subTotal = 0; const sd = path.join(ROOT, proj, id, 'subagents'), active = [];
    try { for (const x of fs.readdirSync(sd)) if (x.endsWith('.jsonl')) { subTotal++; if (now - fs.statSync(path.join(sd, x)).mtimeMs < 90e3) { subActive++; if (active.length < 4) { const d = readMeta(path.join(sd, x.replace(/\.jsonl$/, '.meta.json'))).description; if (d) active.push(peers.label(d, 32)); } } } } catch {}
    const group = project.groupOf(p.cwd); if (p.msgIds && p.msgIds.length) peers.indexMessages(p.msgIds, { proj, id, cwd: p.cwd, group });   // so a message id in another runtime's log finds this session even after its pid is gone
    return { proj, id, title: p.title || id, mtime: st.mtimeMs, state, tool, arg: lp ? lp.arg || '' : tool && p.lastCall ? p.lastCall.arg || '' : '', ageMs, subActive, subTotal, active, stopped, source: 'claude', ...((tk) => ({ peers: tk.names, msgs: tk.n }))(peers.talksNow(p.talks)), group };
  })).map((r) => (r.oneshot && r.state === 'turn' ? { ...r, state: 'done' } : r)).sort((a, b) => boardRank(a) - boardRank(b) || b.mtime - a.mtime).slice(0, BOARD_MAX);   // a one-shot that answered is done, not "your turn": nobody is waiting for the human there
}
// The board with its placement check: every row derives its project from its own log (a git root from the cwd, a Hermes thread); a session the
// server could not place has no group. `npm run check:placement` fails when a busy one is unplaced.
function placement() {
  const rows = boardRows(), unplacedRows = rows.filter((r) => !r.group), busy = unplacedRows.filter((r) => /^(working|waiting|blocked)$/.test(r.state));
  return { rows, unplaced: unplacedRows.length, busyUnplaced: busy.map((r) => ({ source: r.source, proj: r.proj, id: r.id, state: r.state, title: r.title })), groups: new Set(rows.filter((r) => r.group && !r.group.other).map((r) => r.group.key)).size, errors: peers.problems() };
}
// What the board keeps when there are more sessions than rows: whoever needs the human, then whoever is busy, then finished turns, then idle;
// a scheduled job (Hermes cron) or a finished one-shot run ranks behind a conversation in the same state, so they never crowd out the live ones.
const BOARD_MAX = 60, RANK = { blocked: 0, stalled: 0, working: 1, waiting: 1, turn: 2, done: 3, idle: 3 };
const boardRank = (r) => (RANK[r.state] == null ? 3 : RANK[r.state]) * 2 + (r.oneshot && r.state !== 'working' && r.state !== 'waiting' ? 1 : 0);
// Settings live in a file, not only in the page's localStorage: the port changes between VS Code windows and reloads, and localStorage is per origin (port included).
const PREFS = process.env.AGENT_STANDUP_PREFS || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'agent-standup', 'prefs.json') : path.join(os.homedir(), '.config', 'agent-standup', 'prefs.json'));
function readPrefs() { try { const v = JSON.parse(fs.readFileSync(PREFS, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }
function writePrefs(v) { fs.mkdirSync(path.dirname(PREFS), { recursive: true }); const tmp = PREFS + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, PREFS); }
// Most recently active session (optionally limited to one project dir) — drives the live feed.
const STICK_MS = 90000;   // a session written to in the last 90 s keeps the call, so another session writing elsewhere does not steal it mid-line
function sessionMtime(proj, id) {
  const src = sourceOf(proj); if (src) { try { return src.mtime(proj, id); } catch { return 0; } }
  try { let m = fs.statSync(path.join(ROOT, proj, id + '.jsonl')).mtimeMs; const sd = path.join(ROOT, proj, id, 'subagents'); if (fs.existsSync(sd)) for (const x of fs.readdirSync(sd)) m = Math.max(m, fs.statSync(path.join(sd, x)).mtimeMs); return m; } catch { return 0; }
}
function currentSession(projFilter, idFilter, stick) {
  const safe = (x) => typeof x === 'string' && /^[\w.\-]+$/.test(x) && x !== '..';
  if (stick && safe(stick.id) && safe(stick.proj) && (!projFilter || stick.proj === projFilter || stick.proj.startsWith(projFilter + '-')) && Date.now() - sessionMtime(stick.proj, stick.id) < STICK_MS) return { proj: stick.proj, id: stick.id, mtime: sessionMtime(stick.proj, stick.id) };
  if (idFilter && projFilter && projFilter !== '..' && idFilter !== '..' && /^[\w.\-]+$/.test(idFilter) && /^[\w.\-]+$/.test(projFilter) && (sourceOf(projFilter) ? sourceOf(projFilter).exists(projFilter, idFilter) : fs.existsSync(path.join(ROOT, projFilter, idFilter + '.jsonl')))) return { proj: projFilter, id: idFilter, mtime: Date.now() };   // pinned from the board
  const memoKey = projFilter || '*', hit = latestMemo.get(memoKey); if (hit && Date.now() - hit.at < 2000) return hit.v;   // the full scan stats every session file: once per 2 s at most, like the listings
  const v = latestScan(projFilter, stick); latestMemo.set(memoKey, { at: Date.now(), v }); if (latestMemo.size > 50) latestMemo.delete(latestMemo.keys().next().value); return v;
}
const latestMemo = new Map();
function latestScan(projFilter, stick) {
  let best = null;
  const consider = (proj, id, m) => { if (!best || m > best.mtime) best = { proj, id, mtime: m }; };
  for (const src of SOURCES) { try { for (const r of src.list()) if (!projFilter || r.proj === projFilter || r.proj.startsWith(projFilter + '-')) consider(r.proj, r.id, r.mtime); } catch {} }
  if (!fs.existsSync(ROOT)) return best || {};
  for (const proj of fs.readdirSync(ROOT)) {
    if (projFilter && proj !== projFilter && !proj.startsWith(projFilter + '-')) continue;   // the folder itself, or a folder inside it
    const dir = path.join(ROOT, proj); let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6); let m = fs.statSync(path.join(dir, f)).mtimeMs;
      const sd = path.join(dir, id, 'subagents');
      if (fs.existsSync(sd)) for (const x of fs.readdirSync(sd)) m = Math.max(m, fs.statSync(path.join(sd, x)).mtimeMs);
      consider(proj, id, m);
    }
  }
  if (!best && projFilter) return currentSession('', '', stick);
  return best || {};
}

// ---- Incremental transcript reader: each .jsonl is parsed once, then only the bytes appended since are read.
// A session is merged from its main file and one file per sub-agent; the per-file results are cached and re-assembled cheaply.
const fileStates = new Map();   // path → { agent, offset, tail, raw[], toolName{}, msgUsage Map }
function readNew(file, agent, budget = peers.maxFileBytes()) {
  let size; try { size = fs.statSync(file).size; } catch { fileStates.delete(file); return null; }
  let st = fileStates.get(file);
  if (!st || size < st.offset) { st = { agent, offset: 0, tail: Buffer.alloc(0), raw: [], toolName: {}, msgUsage: new Map() }; if (size > budget) { st.offset = size - budget; st.cutStart = true; st.truncated = true; } fileStates.set(file, st); }   // a huge file: only its end
  while (size > st.offset) {   // read in chunks of at most 16 MB so a huge transcript never needs one giant buffer
    const fd = fs.openSync(file, 'r'); let buf;
    try { buf = Buffer.alloc(Math.min(16 * 1024 * 1024, size - st.offset)); fs.readSync(fd, buf, 0, buf.length, st.offset); } finally { fs.closeSync(fd); }
    st.offset += buf.length;
    const all = st.tail.length ? Buffer.concat([st.tail, buf]) : buf, cut = all.lastIndexOf(10);   // only complete lines; a half-written last line waits for the next read
    if (cut < 0) { st.tail = all; continue; }
    st.tail = all.subarray(cut + 1);
    const lines = all.subarray(0, cut).toString('utf8').split('\n'); if (st.cutStart) { lines.shift(); st.cutStart = false; }   // the first line of a cut read is a piece of one
    for (const line of lines) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      try { parseRecord(st, r); } catch {}   // one odd record must not take the whole timeline down
    }
  }
  return st;
}
function parseRecord(st, r) {
  const agent = st.agent, ts = Date.parse(r.timestamp) || 0;
  if (r.type === 'system' && r.subtype === 'compact_boundary') { st.raw.push({ ts, agent, kind: 'compact' }); return; }   // Claude Code compacted the conversation
  if (r.type === 'queue-operation' && typeof r.content === 'string' && r.content.includes('<task-notification>')) {   // how Claude Code reports that a background sub-agent has stopped
    const id = (r.content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/) || [])[1], status = (r.content.match(/<status>([^<]+)<\/status>/) || [])[1];
    if (id && status && status !== 'running') st.raw.push({ ts, agent, kind: 'agentdone', toolId: id });
    return;
  }
  const arrival = (text, o) => {   // a message from another agent session (agent-peers), framed by Claude Code; once, however it was recorded
    const inc = peers.incoming(text); if (!inc) return; const id = o.msg_id || inc.msgId || ''; st.seenMsg = st.seenMsg || new Set(); if (id && st.seenMsg.has(id)) return; if (id) st.seenMsg.add(id);
    st.raw.push({ ts, agent, kind: 'msg', dir: 'in', from: o.from || inc.addr, name: o.name || inc.name, msgId: id, text: clip(inc.text, 2000) });
  };
  if (r.type === 'attachment' && r.attachment && r.attachment.type === 'queued_command' && typeof r.attachment.prompt === 'string') return arrival(r.attachment.prompt, r.attachment.origin || {});   // one that arrived while the session was busy
  if (r.type === 'user') {
    if (r.isMeta && typeof (r.message && r.message.content) === 'string') return arrival(r.message.content, r.origin || {});
    const items = [];   // tool results: the real output that appeared on the agent's screen
    for (const b of blocks(r)) if (b.type === 'tool_result' && st.toolName[b.tool_use_id] === 'SendMessage' && st.sends && st.sends[b.tool_use_id]) {   // the send's result says whether the inbox took it
      const s = st.sends[b.tool_use_id], txt = resultText(b.content); let j = null; try { j = JSON.parse(txt); } catch {}
      st.raw.push({ ts, agent, kind: 'msg', dir: 'out', to: s.to, text: s.text, msgId: (j && j.msg_id) || '', state: b.is_error || (j && j.success === false) ? 'failed' : 'accepted', detail: clip((j && j.message) || txt, 200) });
    }
    for (const b of blocks(r)) if (b.type === 'tool_result' && (st.toolName[b.tool_use_id] === 'Agent' || st.toolName[b.tool_use_id] === 'Task') && !(st.bg && st.bg[b.tool_use_id]) && !/^\s*Async agent launched/i.test(resultText(b.content))) st.raw.push({ ts, agent, kind: 'agentdone', toolId: b.tool_use_id });   // a synchronous call: the lead got the sub-agent's answer back, so it has finished (async launches answer immediately and are not a completion)
    for (const b of blocks(r)) if (b.type === 'tool_result' && st.toolName[b.tool_use_id] && !NO_RESULT.has(st.toolName[b.tool_use_id])) {
      const n = st.toolName[b.tool_use_id], img = resultImages(b.content).length;
      items.push({ id: b.tool_use_id, err: !!b.is_error, out: clip(resultText(b.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trimEnd(), RESULT_MAX[n] || (/^mcp__/.test(n) ? 900 : 600)), ...(img ? { img } : {}) });   // img: how many pictures came back; the page fetches them from /api/media
    }
    if (items.length) st.raw.push({ ts, agent, kind: 'results', items });
    if (agent !== 'main') return;   // a sub-agent's first user message is the order, emitted from the parent's side
    const txt = blocks(r).filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(HARNESS, '').replace(/^\s*\[Request interrupted[^\]]*\]\s*/i, '').trim();   // what the human typed, without the blocks the harness wraps around it
    if (txt && !/^<(system-reminder|command-|local-command|task-notification)/.test(txt) && !r.isMeta) st.raw.push({ ts, agent: 'user', kind: 'user', text: txt });
  } else if (r.type === 'assistant') {
    const m = r.message || {};
    if (m.id && m.usage) {   // the same message is repeated once per content block with identical numbers: keep one per message id
      const u = m.usage, prev = st.msgUsage.get(m.id);
      st.msgUsage.set(m.id, { ts: prev ? prev.ts : ts, u: { i: u.input_tokens || 0, o: u.output_tokens || 0, r: u.cache_read_input_tokens || 0, w: u.cache_creation_input_tokens || 0 }, model: m.model });
    }
    for (const b of blocks(r)) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) st.raw.push({ ts, agent, kind: 'say', text: b.text.trim() });
      else if (b.type === 'tool_use') {
        st.toolName[b.id] = b.name; if (b.input && b.input.run_in_background) (st.bg = st.bg || {})[b.id] = true;
        if (b.name === 'SendMessage') (st.sends = st.sends || {})[b.id] = { to: String((b.input && b.input.to) || ''), text: clip(b.input && b.input.message, 2000) };   // shown as a message once its result lands, not as a tool
        else if (b.name === 'Agent' || b.name === 'Task') st.raw.push({ ts, agent, kind: 'agentcall', toolId: b.id, bg: !!(b.input && b.input.run_in_background), text: (b.input && b.input.prompt) || '', title: (b.input && b.input.description) || '' });
        else st.raw.push({ ts, agent, kind: 'tool', tool: toolLabel(b, ts) });
      }
    }
  }
}
const metaCache = new Map();   // meta file path → { mtime, value }
function readMeta(f) {
  try { const mt = fs.statSync(f).mtimeMs, c = metaCache.get(f); if (c && c.mtime === mt) return c.value; const v = JSON.parse(fs.readFileSync(f, 'utf8')); metaCache.set(f, { mtime: mt, value: v }); peers.capped(metaCache, 4000); return v; } catch { return {}; }
}

function buildTimeline(proj, id) {
  const base = path.join(ROOT, proj), mainFile = path.join(base, id + '.jsonl');
  if (!fs.existsSync(mainFile)) throw new Error('session not found');
  const agents = { main: { id: 'main', role: 'Lead', type: 'main' } };
  const states = [readNew(mainFile, 'main')]; if (states[0] && states[0].truncated) agents.main.truncated = true;
  const subDir = path.join(base, id, 'subagents');
  if (fs.existsSync(subDir)) {
    const subs = fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl')), share = peers.readBudget(false, subs.length);
    for (const f of subs) {
      const aid = f.replace(/^agent-/, '').replace(/\.jsonl$/, '').replace(/[^\w.-]/g, '_'), m = readMeta(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')));
      agents[aid] = { id: aid, name: m.description ? peers.label(m.description, 40) : '', role: m.agentType || 'Agent', type: m.agentType || 'agent', toolUseId: m.toolUseId };   // the task it was given is its name; a nameless one gets an invented one on the page
      try { agents[aid].mtime = fs.statSync(path.join(subDir, f)).mtimeMs; } catch {}
      const st = readNew(path.join(subDir, f), aid, share); if (st) { states.push(st); if (st.truncated) agents[aid].truncated = true; }
    }
  }
  const childByTool = {};   // Agent tool_use id → the sub-agent it created, so we know who ordered whom
  for (const a of Object.values(agents)) if (a.toolUseId) childByTool[a.toolUseId] = a.id;

  const finished = new Set(), now0 = Date.now(); for (const st of states) if (st) for (const e of st.raw) if (e.kind === 'agentdone' && childByTool[e.toolId]) finished.add(childByTool[e.toolId]);
  let recentUntil = 0; for (const a of Object.values(agents)) if (a.id !== 'main' && a.mtime && now0 - a.mtime <= 240000) recentUntil = Math.max(recentUntil, a.mtime + 241000);
  for (const a of Object.values(agents)) if (a.id !== 'main' && a.type !== 'peer' && now0 - (a.mtime || 0) > 240000) finished.add(a.id);   // old transcripts without a completion record: silent for 4 min counts as finished
  const events = [], parent = {}, doneSeen = new Set(), book = peers.nameBook(states);
  for (const st of states) {
    if (!st) continue;
    let lastSay = -1;   // the last thing a sub-agent says is its report back to the lead
    if (st.agent !== 'main' && finished.has(st.agent)) for (let i = st.raw.length - 1; i >= 0; i--) if (st.raw[i].kind === 'say') { lastSay = i; break; }
    st.raw.forEach((e, i) => {
      if (e.kind === 'agentdone') { const to = childByTool[e.toolId]; if (to && !doneSeen.has(to)) { doneSeen.add(to); events.push({ ts: e.ts, agent: to, kind: 'finish', to: e.agent }); } }
      else if (e.kind === 'agentcall') { const to = childByTool[e.toolId]; if (to) { parent[to] = e.agent; events.push({ ts: e.ts, agent: e.agent, to, kind: 'order', toolId: e.toolId, bg: e.bg, text: e.text, title: e.title }); } }
      else if (e.kind === 'msg' && e.dir === 'out' && agents[e.to]) events.push({ ts: e.ts, agent: e.agent, kind: 'msg', to: e.to, text: e.text, state: e.state, native: true });   // to one of this session's own agents (a background sub-agent, or "main" from one)
      else if (e.kind === 'msg' && e.dir === 'in' && agents[e.from]) events.push({ ts: e.ts, agent: e.from, kind: 'msg', to: e.agent, text: e.text, state: 'received', native: true });   // from one of them (a background sub-agent handing its result back)
      else if (e.kind === 'msg') {   // a message to or from another session: the peer joins the call as its own participant, linked to its session when the address resolves
        const gone = e.dir === 'out' && e.state === 'failed' && !peers.parseAddress(e.to) && !book.has(peers.cleanName(e.to)) && !/^codex:/.test(peers.cleanName(e.to));   // a name that answers to nobody: a failed edge to a placeholder, not a peer of this call
        const lost = e.dir === 'out' && /^a[0-9a-f]{16}$/.test(e.to) && !agents[e.to], pa = lost ? peers.ghost(e.to, 'not in view') : gone ? peers.ghost(e.to) : peers.peerAgent(e.dir === 'out' ? e.to : e.from, e.name, book, { msgId: e.msgId, not: { proj, id } }); if (!agents[pa.id]) agents[pa.id] = pa; else if (e.name && !agents[pa.id].named) { agents[pa.id].name = peers.cleanName(e.name); agents[pa.id].named = true; }
        events.push(e.dir === 'out' ? { ts: e.ts, agent: e.agent, kind: 'msg', to: pa.id, text: e.text, state: e.state, msgId: e.msgId, detail: e.detail } : { ts: e.ts, agent: pa.id, kind: 'msg', to: e.agent, text: e.text, state: 'received', msgId: e.msgId });
      }
      else if (i === lastSay) events.push({ ...e, kind: 'report', to: null });   // `to` filled below, once every order is known
      else events.push(e);
    });
    for (const [, mu] of st.msgUsage) events.push({ ts: mu.ts, agent: st.agent, kind: 'usage', u: mu.u, model: mu.model });
    if (st.agent !== 'main' && finished.has(st.agent) && lastSay < 0 && !doneSeen.has(st.agent) && agents[st.agent]) { const lastTs = st.raw.length ? st.raw[st.raw.length - 1].ts : agents[st.agent].mtime || 0; doneSeen.add(st.agent); events.push({ ts: lastTs, agent: st.agent, kind: 'finish', to: 'main' }); }   // finished by silence, its completion record not read (older history cut, or never written): done, not working forever
  }
  for (const e of events) if (e.kind === 'report' && e.to === null) e.to = parent[e.agent] || 'main';

  events.sort((a, b) => a.ts - b.ts);
  const merged = []; let lastReal = -1;   // consecutive tool calls of one agent become one activity beat; usage events are transparent to that rule
  for (const e of events) {
    const p = lastReal >= 0 ? merged[lastReal] : null;
    if (e.kind === 'usage' || e.kind === 'finish' || e.kind === 'compact') { merged.push(e); continue; }
    if (e.kind === 'tool' && p && p.kind === 'tools' && p.agent === e.agent) p.tools.push(e.tool);
    else { merged.push(e.kind === 'tool' ? { ts: e.ts, agent: e.agent, kind: 'tools', tools: [e.tool] } : e); lastReal = merged.length - 1; }
  }
  const real = merged.find((e) => e.kind !== 'usage' && e.kind !== 'finish' && e.kind !== 'compact'), first = real ? real.ts : 0, last = merged.length ? merged[merged.length - 1].ts : 0;   // time zero = the first thing said or done
  let tail = {}; try { tail = parseTail(mainFile, fs.statSync(mainFile)); } catch {}
  return { id, proj, agents: Object.values(agents), events: merged.map((e) => ({ ...e, t: Math.max(0, e.ts - first) })), durationMs: last - first, recentUntil, group: project.groupOf(tail.cwd), title: tail.title || '' };
}

// Ask the local `claude` CLI (uses the user's existing login) to map a JSON array of strings to another array. Cached.
const { spawn } = require('child_process');
const cache = new Map();   // translations: capped, the oldest goes first
const cacheSet = (k, v) => { cache.set(k, v); peers.capped(cache, 5000); };
// Find a usable `claude` binary: explicit setting → PATH → usual install spots → the one bundled with the VS Code Claude Code extension.
let lastTrError = '', claudeCache = null;
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
function bundledClaude() {
  const home = os.homedir(); let best = null;
  for (const dir of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss']) {
    let names; try { names = fs.readdirSync(path.join(home, dir, 'extensions')); } catch { continue; }
    for (const d of names.filter((x) => x.startsWith('anthropic.claude-code-')))
      for (const n of ['claude', 'claude.exe']) { const f = path.join(home, dir, 'extensions', d, 'resources', 'native-binary', n); if (exists(f) && (!best || d.localeCompare(best.d, undefined, { numeric: true }) > 0)) best = { d, f }; }
  }
  return best && best.f;
}
function findClaude() {
  if (claudeCache && exists(claudeCache)) return claudeCache;
  const home = os.homedir(), win = process.platform === 'win32', names = win ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'], cands = [];
  if (process.env.AGENT_STANDUP_CLAUDE) cands.push(process.env.AGENT_STANDUP_CLAUDE);
  for (const d of (process.env.PATH || '').split(path.delimiter)) for (const n of names) cands.push(path.join(d, n));
  const dirs = win ? [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(process.env.APPDATA || '', 'npm'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.claude/local'), path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, '.bun/bin'), path.join(home, '.volta/bin')];
  try { const nvm = path.join(home, '.nvm', 'versions', 'node'); for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, 'bin')); } catch {}
  for (const d of dirs) for (const n of names) cands.push(path.join(d, n));
  const found = cands.find(exists) || bundledClaude() || null;
  return (claudeCache = found);
}
function spawnClaude(args, opts) {
  const bin = findClaude(); if (!bin) { lastTrError = 'not-found'; return null; }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return spawn('"' + bin + '"', args, { ...opts, shell: true, windowsHide: true });   // npm's Windows shims need a shell
  return spawn(bin, args, { ...opts, windowsHide: true });
}
let running = 0; const queue = [];
const pump = () => { while (running < 3 && queue.length) { running++; queue.shift()(); } };
const schedule = (fn) => new Promise((res, rej) => { queue.push(() => fn().then(res, rej).finally(() => { running--; pump(); })); pump(); });
// Fast path (~1-2 s instead of ~6 s): if the user has an Anthropic API key in the environment, call the API directly.
async function apiMap(prompt, need) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('no key');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json(); const out = j.content[0].text, arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
  if (arr.length !== need.length) throw new Error('bad length'); return arr;
}
function claudeMap(kind, instruction, texts) {
  const need = [...new Set(texts.filter((t) => !cache.has(kind + '|' + t)))];
  const done = (ok) => ({ texts: texts.map((t) => cache.get(kind + '|' + t) || t), ok });
  if (!need.length) return Promise.resolve(done(true));
  const prompt = instruction + ' Output ONLY a JSON array of strings, same length and order, no markdown.\n' + JSON.stringify(need);
  return apiMap(prompt, need).then((arr) => { need.forEach((t, i) => cacheSet(kind + '|' + t, String(arr[i]))); return done(true); }).catch(() => schedule(() => new Promise((resolve) => {
    const p = spawnClaude(['-p', '--model', 'haiku', '--no-session-persistence', '--tools', ''], { cwd: os.tmpdir() }); if (!p) return resolve(done(false));
    let out = ''; const timer = setTimeout(() => p.kill(), 60000);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(done(false)));
    p.on('close', () => {
      clearTimeout(timer);
      let ok = false;
      try {
        const arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
        if (arr.length === need.length) { need.forEach((t, i) => cacheSet(kind + '|' + t, String(arr[i]))); ok = true; }
      } catch {}
      resolve(done(ok));
    });
    p.stdin.end(prompt);
  })));
}
const translate = (texts) => translateFast(texts);

// Warm `claude` workers: after a slow first call each translation takes ~2-3 s (a cold `claude -p` costs ~6 s).
const TR_INSTR = 'Translate each string of this JSON array into natural spoken French, as a teammate would say it in a meeting. Keep code identifiers, file paths, library names and numbers unchanged.';
const TR_SYS = 'You are a translation engine. Translate the user message into natural spoken French, as a colleague would say it in a meeting. Keep code identifiers, file paths, library names and numbers unchanged. Reply with ONLY the translation, nothing else.';
class TrWorker {
  constructor() { this.q = []; this.busy = false; this.n = 0; this.p = null; this.cur = null; this.buf = ''; }
  start() {
    const p = spawnClaude(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--system-prompt', TR_SYS], { cwd: os.tmpdir() });
    if (!p) return;
    this.p = p; this.buf = ''; this.n = 0;
    p.stderr.on('data', (d) => { lastTrError = String(d).slice(-300); });
    p.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        try { const m = JSON.parse(l); if (m.type === 'result' && this.cur) { if (m.is_error) lastTrError = String(m.result || '').slice(0, 200); else lastTrError = ''; this.finish(m.is_error ? null : String(m.result || '').trim()); } } catch {}
      }
    });
    const dead = () => { if (this.p !== p) return; this.p = null; this.finish(null); };
    p.on('close', dead); p.on('error', dead);
  }
  finish(res) { const c = this.cur; this.cur = null; this.busy = false; if (c) { clearTimeout(c.timer); c.res(res); } this.pump(); }
  ask(text) { return new Promise((res) => { this.q.push({ text, res }); this.pump(); }); }
  kill() { clearTimeout(this.idle); if (this.p) { const p = this.p; this.p = null; try { p.kill(); } catch {} } }
  pump() {
    if (this.busy || !this.q.length) return;
    if (!this.p || this.n >= 30) { if (this.p) { const old = this.p; this.p = null; old.kill(); } this.start(); if (!this.p) { while (this.q.length) this.q.shift().res(null); return; } }   // restart now and then: the conversation context grows
    clearTimeout(this.idle); this.idle = setTimeout(() => { if (!this.busy && !this.q.length) this.kill(); }, 10 * 60 * 1000);   // free the process when nothing was translated for 10 min
    const job = this.q.shift(); this.busy = true; this.n++; this.cur = job;
    job.timer = setTimeout(() => { if (this.cur === job && this.p) this.p.kill(); }, 45000);
    this.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: job.text } }) + '\n');
  }
}
const trWorkers = [new TrWorker(), new TrWorker()];
// Spoken summaries: a long line is read as one short sentence of what it says, written by a small fast model (gpt-6-luna) through the local codex-lb proxy.
// Asked only for lines about to be spoken; cached by text; nothing comes back when the proxy is not there (the page then reads whole first sentences).
const SUMMARY_URL = 'http://127.0.0.1:2455/backend-api/codex/responses', SUMMARY_MODEL = 'gpt-6-luna', LUNA_EFFORT = process.env.AGENT_STANDUP_LUNA_EFFORT || 'medium';   // pinned on every call (the model's own default may change); low gave Tom bad summaries
const SUMMARY_SYS = 'Rewrite the message as one short spoken sentence of at most 22 words that keeps what matters: the result, the decision, the problem or the request. Same language as the message. Content only: no names, no greetings, no "the agent says", no labels, no markdown, no paths or ids. Write it as a neutral line about the work, never as the agent speaking: no I, we or you (\"Pushing to production is waiting for approval\", not \"May I push to production?\"). Reply with the sentence only.';
// One call to the model through codex-lb (Responses API, streamed); the text it wrote, or JSON when a schema is given.
async function luna(instructions, text, schema, ms = 15000) {
  const body = { model: SUMMARY_MODEL, instructions, input: [{ role: 'user', content: [{ type: 'input_text', text }] }], stream: true, store: false, reasoning: { effort: LUNA_EFFORT } };
  if (schema) body.text = { format: { type: 'json_schema', name: 'triage', strict: true, schema } };
  const r = await fetch(SUMMARY_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('luna ' + r.status);
  let out = ''; for (const l of (await r.text()).split('\n')) if (l.startsWith('data: ')) { try { const j = JSON.parse(l.slice(6)); if (j.type === 'response.output_text.delta') out += j.delta; } catch {} }
  return schema ? JSON.parse(out) : out.replace(/\s+/g, ' ').trim();
}
// Live speech triage: the lines waiting to be heard go in one batch, the model says which to drop and writes at most two short sentences to say
// (it may merge related items). The page keeps the last word: it never drops a needs-you item, never sends a stale one, and has its own policy when this fails.
const TRIAGE_SYS = 'You choose what Tom hears from a live feed of his AI agents at work. What matters to him, in order: anything that needs him (needs_you), results and reports, decisions and blockers, messages between agents; routine progress is low value, and the session he is viewing matters more than others. Each item has an id, its age in seconds, a kind (needs_you, report, message, order), its project, the agent (lead or sub-agent, and its role) and its text. You also get what was already said in the last minutes: do not repeat it. Tom wants everything narrated: cover every item, merging related ones; drop an item only when it repeats what was already said, or when the queue is longer than two lines can carry (then keep the most important). Return JSON: "drop" lists the ids left out; "say" has at most 2 lines, most important first, each ONE short spoken sentence of at most 22 words in the language of the items, content only: no names, no greetings, no "the agent says", no labels, no markdown, no paths or ids. The one exception: a message item between agents has a route (2 to 4 words, project and role); a line about such a message starts with that route exactly as given, a colon, then the content ("To gladiator Hermes: the armour numbers are in."), and says no other name, title or session name. Write it as a neutral line about the work, never as the agent speaking: no I, we or you (\"Pushing to production is waiting for approval\", not \"May I push to production?\"). A line may merge related items: list all their ids. Never drop a needs_you item. When something must go, results, decisions, problems and requests go before progress; newer before older.';
const TRIAGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['drop', 'say'], properties: { drop: { type: 'array', items: { type: 'integer' } }, say: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ids', 'line'], properties: { ids: { type: 'array', items: { type: 'integer' } }, line: { type: 'string' } } } } } };
function triageInput({ items, said, viewing } = {}) {   // the text the model gets: what Tom is viewing, what was already said, the queue ('' when empty)
  const one = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const list = (Array.isArray(items) ? items : []).slice(0, 20).map((it) => `${+it.id || 0} (${Math.round(+it.age || 0)} s, ${one(it.kind, 12) || 'message'}, project ${one(it.project, 60) || '?'}, ${it.lead ? 'lead' : 'sub-agent'} ${one(it.role, 60)}${it.route ? ', route "' + one(it.route, 60) + '"' : ''}): ${one(it.text, 1500)}`);
  return list.length ? `Tom is viewing: ${one(viewing, 120) || '?'}\nAlready said (oldest first):\n${(Array.isArray(said) ? said : []).slice(-12).map((x) => '- ' + one(x, 200)).join('\n') || '- nothing yet'}\n\nQueue:\n` + list.join('\n') : '';
}
function triage(req) { const text = triageInput(req); return text ? luna(TRIAGE_SYS, text, TRIAGE_SCHEMA, 20000) : Promise.resolve({ drop: [], say: [] }); }
const summaries = new Map();   // text → Promise<string>
let sumActive = 0; const sumWait = [];   // at most 3 calls at once: a burst queues instead of firing dozens
const sumSlot = () => (sumActive < 3 ? (sumActive++, Promise.resolve()) : new Promise((r) => sumWait.push(r))), sumFree = () => { const n = sumWait.shift(); if (n) n(); else sumActive--; };
function summary(text) {
  text = String(text).slice(0, 4000); if (summaries.has(text)) return summaries.get(text);
  const job = (async () => { await sumSlot(); try { return await luna(SUMMARY_SYS, text); } finally { sumFree(); } })().catch(() => { summaries.delete(text); return ''; });   // a failure is not cached: the next time it is asked again
  summaries.set(text, job); if (summaries.size > 2000) summaries.delete(summaries.keys().next().value); return job;
}
const shutdown = () => { trWorkers.forEach((w) => w.kill()); kokoro.shutdown(); };
process.on('exit', shutdown);
const pickWorker = () => trWorkers.reduce((a, b) => (a.q.length + a.busy <= b.q.length + b.busy ? a : b));
async function translateFast(texts) {
  const need = [...new Set(texts.filter((t) => !cache.has('fr|' + t)))];
  if (need.length && need.length <= 3 && !process.env.ANTHROPIC_API_KEY) {   // a few lines: warm workers in parallel; many lines: one batched call
    await Promise.all(need.map(async (t) => { const r = await pickWorker().ask(t); if (r) cacheSet('fr|' + t, r); }));
    return { texts: texts.map((t) => cache.get('fr|' + t) || t), ok: texts.every((t) => cache.has('fr|' + t)) };
  }
  return claudeMap('fr', TR_INSTR, texts);
}
const quips = (texts, lang) => claudeMap('q' + lang, `Each string is a work report from a software agent. For each, write ONE short, deadpan, funny reaction (max 12 words) from a grumpy teammate in a South Park-style cartoon meeting, in ${lang === 'fr' ? 'French' : 'English'}. No emojis.`, texts);

// ---- text-to-speech, generated on the machine and cached as wav:
//      macOS → `say`, Windows → System.Speech (SAPI voices) through PowerShell, Linux → espeak-ng.
let sayVoices = null;
const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
function listVoices() {
  if (sayVoices) return sayVoices;
  const voices = [];
  try {
    if (MAC) {
      const out = execFileSync('say', ['-v', '?'], { encoding: 'utf8', timeout: 5000 });
      for (const line of out.split('\n')) { const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/); if (m) voices.push({ name: m[1].trim(), locale: m[2] }); }
    } else if (WIN) {
      const out = execFileSync('powershell.exe', [...PS, "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }"], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) { const [name, loc] = line.trim().split('|'); if (name && loc) voices.push({ name, locale: loc.replace('-', '_') }); }
    } else {
      const out = execFileSync('espeak-ng', ['--voices'], { encoding: 'utf8', timeout: 5000 });
      for (const line of out.split('\n').slice(1)) { const c = line.trim().split(/\s+/); if (c[1] && /^(fr|en)/.test(c[1])) voices.push({ name: c[1], locale: c[1].replace('-', '_').replace(/^(\w{2})$/, (m) => m + '_' + m.toUpperCase()) }); }
    }
  } catch {}
  return (sayVoices = { available: voices.length > 0, voices, platform: process.platform });
}
const ttsDir = path.join(os.tmpdir(), 'agent-standup-tts-' + (process.getuid ? process.getuid() : 'user'));
try { fs.mkdirSync(ttsDir, { recursive: true, mode: 0o700 }); } catch {}
const ttsJobs = new Map();
const isWav = (f) => { try { const fd = fs.openSync(f, 'r'), b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString() === 'RIFF'; } catch { return false; } };
try { for (const f of fs.readdirSync(ttsDir)) { const p = path.join(ttsDir, f); if (Date.now() - fs.statSync(p).mtimeMs > 864e5 || (f.endsWith('.mp3') && isWav(p))) fs.unlinkSync(p); } } catch {}   // drop cached audio older than a day, and a system voice an older version kept under an ElevenLabs name
function synthesize(voice, wpm, text, out) {
  return new Promise((resolve, reject) => {
    let p;
    if (MAC) p = spawn('say', ['-v', voice, '-r', String(wpm), '--data-format=LEI16@22050', '-o', out, '--', text]);
    else if (WIN) {
      const rate = Math.max(-6, Math.min(8, Math.round((wpm - 175) / 12)));   // SAPI rate: -10..10
      p = spawn('powershell.exe', [...PS, '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice($env:AS_VOICE); $s.Rate = [int]$env:AS_RATE; $s.SetOutputToWaveFile($env:AS_OUT); $s.Speak($env:AS_TEXT); $s.Dispose()'],
        { env: { ...process.env, AS_VOICE: voice, AS_RATE: String(rate), AS_OUT: out, AS_TEXT: text }, windowsHide: true });
    } else p = spawn('espeak-ng', ['-v', voice, '-s', String(wpm), '-w', out, '--', text]);
    p.on('error', reject); p.on('close', (code) => (code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('tts failed'))));
  });
}
// ---- ElevenLabs voices, set up exactly like Hermes: the key is ELEVENLABS_API_KEY in the Hermes profile's .env, the model and the lead's voice are
// tts.elevenlabs.model_id / voice_id in its config.yaml (HERMES_HOME names the profile folder; the gaming profile otherwise). The key never leaves this process.
// The audio is cached on disk by voice and text, so a line is paid for once.
const HERMES_PROFILE = () => process.env.HERMES_HOME || path.join(os.homedir(), '.hermes', 'profiles', 'gaming'), ELEVEN_MAX = 600;   // characters per line: a spoken line is short, and this bounds the cost of any one request
function envFileValue(file, name) { try { const m = new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*=\\s*(.*?)\\s*$', 'm').exec(fs.readFileSync(file, 'utf8')); return m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : ''; } catch { return ''; } }
const elevenKey = () => envFileValue(path.join(HERMES_PROFILE(), '.env'), 'ELEVENLABS_API_KEY');
function elevenSetup() {   // model and lead voice from the Hermes config (tts: elevenlabs: model_id / voice_id)
  let y = ''; try { y = fs.readFileSync(path.join(HERMES_PROFILE(), 'config.yaml'), 'utf8'); } catch {}
  const tts = (/^tts:\n((?:[ \t]+[^\n]*\n?)*)/m.exec(y) || [])[1] || '', el = (/^[ \t]+elevenlabs:\n((?:[ \t]{3,}[^\n]*\n?)*)/m.exec(tts) || [])[1] || '', get = (k) => ((new RegExp('^[ \\t]+' + k + ':[ \\t]*["\']?([\\w.-]+)', 'm').exec(el) || [])[1] || '');
  return { model: get('model_id') || 'eleven_flash_v2_5', lead: get('voice_id') || 'pNInz6obpgDQGcFmaJgB' };
}
let elevenVoices = { at: 0, list: [], error: '' }; const elevenStats = { requests: 0, chars: 0, hits: 0, failed: 0, retried: 0, lastError: '' };
// eleven_v4_turbo takes about 1 s per line (flash: 0.25 s). At most ELEVEN_PARALLEL requests are in flight (a plan's concurrency limit answers 429 beyond it), a request gives up after
// ELEVEN_TIMEOUT (5 times a normal line), and a 429 is retried once. What still fails is not made by another voice: the error says why (no key, quota, 401, 429, timeout),
// the page skips that line and says so. Tom would rather miss a line than hear it in the system voice he did not choose. No audio tags, no expressive settings: the text as it is.
const ELEVEN_PARALLEL = 2, ELEVEN_TIMEOUT = () => +process.env.AGENT_STANDUP_ELEVEN_TIMEOUT_MS || 5000, ELEVEN_RETRY_MS = () => +process.env.AGENT_STANDUP_ELEVEN_RETRY_MS || 700;
const ELEVEN_BUDGET = () => +process.env.AGENT_STANDUP_ELEVEN_BUDGET_MS || 8000;   // a whole line, its wait for a slot and a retry included: the page waits a little longer (TTS_WAIT)
let elevenBusy = 0; const elevenWait = [];
const elevenSlot = (ms) => new Promise((go, no) => {   // a slot, or a timeout once the line's time is up (its place in the queue is given back)
  if (elevenBusy < ELEVEN_PARALLEL) { elevenBusy++; return go(); }
  const take = () => { clearTimeout(t); go(); }, t = setTimeout(() => { const i = elevenWait.indexOf(take); if (i >= 0) elevenWait.splice(i, 1); no(new Error('elevenlabs timeout')); }, Math.max(0, ms)); elevenWait.push(take);
});
const elevenFree = () => { const next = elevenWait.shift(); if (next) next(); else elevenBusy--; };
async function listElevenVoices() {   // the account's voices, cached for an hour; the lead's voice first
  const key = elevenKey(), setup = elevenSetup(); if (!key) return { available: false, voices: [], model: setup.model, error: 'no ELEVENLABS_API_KEY in ' + path.join(HERMES_PROFILE(), '.env') };
  if (Date.now() - elevenVoices.at > 3600e3) {
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error('voices ' + r.status);
      const vs = ((await r.json()).voices || []).filter((v) => v && typeof v.voice_id === 'string' && /^[A-Za-z0-9]{10,40}$/.test(v.voice_id) && (!v.category || v.category === 'premade' || v.category === 'professional' || v.category === 'cloned'));
      vs.sort((a, b) => (a.voice_id === setup.lead ? -1 : b.voice_id === setup.lead ? 1 : 0));
      elevenVoices = { at: Date.now(), list: vs.map((v) => ({ name: v.voice_id, label: String(v.name || v.voice_id).slice(0, 40), locale: 'xx' })), error: '' };
    } catch (e) { elevenVoices = { at: Date.now() - 3300e3, list: elevenVoices.list, error: String(e.message || e).slice(0, 80) }; }   // retry in 5 min, keep what we had
  }
  return { available: elevenVoices.list.length > 0, voices: elevenVoices.list, model: setup.model, lead: setup.lead, error: elevenVoices.error, stats: elevenStats };
}
async function elevenSynth(text, voice, out) {
  const until = Date.now() + ELEVEN_BUDGET(), left = () => until - Date.now();
  const key = elevenKey(); if (!key) throw new Error('elevenlabs no key');
  const vs = await listElevenVoices(); if (!vs.voices.some((v) => v.name === voice)) throw new Error(vs.error ? 'elevenlabs ' + vs.error : 'unknown voice');
  try { await elevenSlot(left()); } catch (e) { elevenStats.failed++; elevenStats.lastError = e.message; throw e; }
  try {
    for (let attempt = 0; ; attempt++) {
      if (left() <= 0) throw new Error('elevenlabs timeout');
      elevenStats.requests++;
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_22050_32`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: vs.model }), signal: AbortSignal.timeout(Math.min(ELEVEN_TIMEOUT(), left())) });
      if (r.status === 429 && attempt === 0 && left() > ELEVEN_RETRY_MS() + 100) { elevenStats.retried++; await new Promise((ok) => setTimeout(ok, ELEVEN_RETRY_MS())); continue; }   // over the concurrency limit: once more if there is time, then the line is skipped
      if (!r.ok) { let why = ''; try { const d = (await r.json()).detail; why = String((d && (d.status || (typeof d === 'string' && d))) || '').slice(0, 40); } catch {} throw new Error(`elevenlabs ${r.status}${why ? ' ' + why : ''}`); }   // "elevenlabs 401 quota_exceeded"
      elevenStats.chars += text.length; fs.writeFileSync(out, Buffer.from(await r.arrayBuffer())); elevenStats.lastError = ''; return;
    }
  } catch (e) {
    const err = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? new Error('elevenlabs timeout') : /^elevenlabs /.test(e && e.message) ? e : new Error('elevenlabs ' + String((e && e.message) || e).slice(0, 60));   // a refused connection too
    elevenStats.failed++; elevenStats.lastError = err.message; throw err;
  } finally { elevenFree(); }
}
function tts(text, voice, rate, engine) {
  const kk = engine === 'kokoro', el = engine === 'elevenlabs';
  if (kk) { if (!kokoro.hasVoice(voice)) return Promise.reject(new Error('unknown voice')); }
  else if (el) { if (!/^[A-Za-z0-9]{10,40}$/.test(String(voice))) return Promise.reject(new Error('unknown voice')); }
  else { const vs = listVoices(); if (!vs.available || !vs.voices.some((v) => v.name === voice)) return Promise.reject(new Error('unknown voice')); }
  text = String(text).slice(0, kk ? 1500 : el ? ELEVEN_MAX : 700); rate = Math.max(90, Math.min(360, Math.round(+rate || 180)));
  const ext = el ? '.mp3' : '.wav', key = crypto.createHash('sha1').update([kk ? 'kokoro' : el ? 'elevenlabs|' + elevenSetup().model : 'system', voice, el ? '' : rate, text].join('|')).digest('hex'), file = path.join(ttsDir, key + ext);   // ElevenLabs: one file per line and voice whatever the pace, so a line is never paid twice
  if (fs.existsSync(file)) { if (el) elevenStats.hits++; return Promise.resolve(file); }
  if (ttsJobs.has(key)) return ttsJobs.get(key);
  fs.mkdirSync(ttsDir, { recursive: true });
  const tmp = file + '.part' + ext;
  const fallback = (e) => { const vs = listVoices(), v = vs.voices.find((x) => x.locale.startsWith((voice.startsWith('ff_') ? 'fr' : 'en') + '_')); if (!v) throw e; return synthesize(v.name, rate, text, tmp); };   // Kokoro, installed on this machine: a line it cannot make goes to a system voice
  const made = () => { fs.renameSync(tmp, file); return file; };
  const job = (el ? elevenSynth(text, voice, tmp) : kk ? kokoro.synth(text, voice, kokoro.speedFor(rate), tmp).catch(fallback) : synthesize(voice, rate, text, tmp)).then(made).finally(() => ttsJobs.delete(key));   // ElevenLabs has no stand-in: a line it cannot make fails, and is asked again next time
  ttsJobs.set(key, job); return job;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

// ---- Custom characters: the person's own pixel art replaces the drawn characters. Plain image files in one folder, nothing else is ever served from it.
//   lead.png / claude.png → the lead · you.png → the human · any other image → a pool for the sub-agents · name-talk.png → optional open-mouth frame of name.png
const CHAR_NAME = /^[\w][\w .()\-]{0,78}\.(png|gif|webp|jpe?g)$/i, CHAR_MAX = 300 * 1024, CHAR_TYPES = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const charactersDir = () => process.env.AGENT_STANDUP_CHARACTERS || path.join(os.homedir(), '.agent-standup', 'characters');
// lstat, not stat: a symlink is not a regular file, so it is skipped and never served
function listCharacters() {
  const dir = charactersDir(); let names = []; try { names = fs.readdirSync(dir); } catch {}
  const ok = names.filter((f) => CHAR_NAME.test(f)).filter((f) => { try { const st = fs.lstatSync(path.join(dir, f)); return st.isFile() && st.size <= CHAR_MAX; } catch { return false; } }).slice(0, 80);
  const stem = (f) => f.replace(/\.[^.]+$/, ''), by = new Map(ok.map((f) => [stem(f).toLowerCase(), f]));
  const chars = ok.filter((f) => !/-talk$/i.test(stem(f))).map((f) => { const st = stem(f), l = st.toLowerCase();
    return { stem: st, file: f, talk: by.get(l + '-talk') || null, role: /^(lead|claude)$/.test(l) ? 'lead' : /^(you|human|user)$/.test(l) ? 'you' : 'agent' }; }).sort((a, b) => a.stem.localeCompare(b.stem));
  return { dir, max: CHAR_MAX, chars };
}
let audioOwner = { id: null, seen: 0 };
function start(port = PORT) {
  return http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Only the local machine may talk to this server: blocks other websites (cross-site requests) and DNS-rebinding attempts.
  const local = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h || '');
  let originOk = true; try { originOk = !req.headers.origin || local(new URL(req.headers.origin).host); } catch { originOk = false; }
  if (!local(req.headers.host) || !originOk) { res.writeHead(403); return res.end('forbidden'); }
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  // Endpoints with side effects (they spawn programs or claim the sound), and the one that serves pictures from a session, refuse requests that a browser marks as coming from another site, e.g. an <img> on a web page.
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none' && (req.method !== 'GET' || ['/api/translate', '/api/summary', '/api/triage', '/api/quips', '/api/warm', '/api/audio', '/api/tts', '/api/prefs', '/api/voices', '/api/kokoro', '/api/kokoro/install', '/api/media'].includes(url.pathname))) { res.writeHead(403); return res.end('forbidden'); }
  const readBody = (cb) => {   // request bodies are small JSON: stop reading beyond 256 KB and give up after 10 s
    const chunks = []; let size = 0, over = false; req.setTimeout(10000, () => req.destroy());
    if (+req.headers['content-length'] > 262144) { res.writeHead(413); res.end('too large'); return req.destroy(); }
    req.on('data', (d) => { if (over) return; size += d.length; if (size > 262144) { over = true; res.writeHead(413); res.end('too large'); req.destroy(); } else chunks.push(d); });   // bytes, not characters
    req.on('end', () => { if (!over) cb(Buffer.concat(chunks).toString('utf8')); });
  };
  const textList = (x) => (Array.isArray(x) ? x : []).slice(0, 200).map((t) => String(t).slice(0, 2000));
  try {
    if (url.pathname === '/api/translate' && req.method === 'POST') return readBody(async (body) => { try { json(await translate(textList(JSON.parse(body).texts))); } catch (e) { json({ error: String(e) }, 400); } });
    if (url.pathname === '/api/triage' && req.method === 'POST') return readBody(async (body) => { try { json(await triage(JSON.parse(body))); } catch (e) { json({ error: String(e && e.message || e) }); } });
    if (url.pathname === '/api/summary' && req.method === 'POST') return readBody(async (body) => { try { json({ summary: await summary(String(JSON.parse(body).text || '')) }); } catch (e) { json({ error: String(e) }, 400); } });
    if (url.pathname === '/api/quips' && req.method === 'POST') return readBody(async (body) => { try { const b = JSON.parse(body); json(await quips(textList(b.texts), b.lang === 'fr' ? 'fr' : 'en')); } catch (e) { json({ error: String(e) }, 400); } });
    if (url.pathname === '/api/sessions') return json(listSessions());
    if (url.pathname === '/api/projects') {   // projects (working folders) ordered by latest activity — lets the live view follow one of them
      const m = new Map(); for (const r of listSessions()) { const p = m.get(r.proj) || { proj: r.proj, mtime: 0, sessions: 0, name: r.group && !r.group.other ? r.group.name : '' }; p.mtime = Math.max(p.mtime, r.mtime); p.sessions++; m.set(r.proj, p); }
      return json([...m.values()].sort((a, b) => b.mtime - a.mtime));
    }
    if (url.pathname === '/api/audio') {   // only one window at a time plays sound: the last one that claimed it (expires if that window stops answering)
      const cid = url.searchParams.get('cid') || '', ok = /^[\w-]{4,40}$/.test(cid);
      if (ok && url.searchParams.get('claim')) audioOwner = { id: cid, seen: Date.now() };
      else if (ok && audioOwner.id === cid) audioOwner.seen = Date.now();
      if (audioOwner.id && Date.now() - audioOwner.seen > 6000) audioOwner = { id: null, seen: 0 };
      return json({ owner: audioOwner.id });
    }
    if (url.pathname === '/api/health') return json({ claude: findClaude(), apiKey: !!process.env.ANTHROPIC_API_KEY, trError: lastTrError, platform: process.platform });
    if (url.pathname === '/api/warm') { trWorkers.forEach((w) => { if (!w.p) w.start(); }); return json({ ok: true }); }
    if (url.pathname === '/api/voices') {
      if (url.searchParams.get('engine') === 'kokoro') { const st = kokoro.status(); if (st.installed && !st.gaveUp) kokoro.warm(); return json({ available: st.installed && !st.gaveUp, ready: st.ready, voices: kokoro.voices(), platform: process.platform, engine: 'kokoro' }); }
      if (url.searchParams.get('engine') === 'elevenlabs') return listElevenVoices().then((v) => json({ ...v, platform: process.platform, engine: 'elevenlabs' }));
      return json(listVoices());
    }
    if (url.pathname === '/api/kokoro/install' && req.method === 'POST') return json(kokoro.install());
    if (url.pathname === '/api/kokoro') return json(kokoro.status());
    if (url.pathname === '/api/tts') {
      return tts(url.searchParams.get('text') || '', url.searchParams.get('voice'), url.searchParams.get('rate'), url.searchParams.get('engine'))
        .then((f) => { res.writeHead(200, { 'content-type': f.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', 'cache-control': 'max-age=86400' }); fs.createReadStream(f).pipe(res); })
        .catch((e) => { if (!/^elevenlabs /.test(e.message)) return json({ error: String(e.message) }, 400); res.writeHead(204, { 'x-tts-error': e.message.replace(/[^\x20-\x7e]/g, ''), 'cache-control': 'no-store' }); res.end(); });   // no audio, and why: the page skips the line and says so (a 204, so the console stays clean)
    }
    if (url.pathname === '/api/prefs.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); return res.end('window.SAVED_PREFS = ' + JSON.stringify(readPrefs()).replace(/</g, '\\u003c') + ';window.SERVER_VOICES = ' + JSON.stringify({ elevenlabs: !!elevenKey() }) + ';'); }   // whether a key exists, never the key: the page picks its default voice from it
    if (url.pathname === '/api/prefs' && req.method === 'PUT') return readBody((body) => { try { const v = JSON.parse(body); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('prefs must be an object'); writePrefs(v); json({ ok: true }); } catch (e) { json({ error: String(e.message || e) }, 400); } });
    if (url.pathname === '/api/prefs') return json(readPrefs() || {});
    if (url.pathname === '/api/current') return json(currentSession(url.searchParams.get('proj') || '', url.searchParams.get('id') || '', { proj: url.searchParams.get('sproj') || '', id: url.searchParams.get('sid') || '' }));
    if (url.pathname === '/api/board') return json(url.searchParams.get('meta') ? placement() : boardRows());
    if (url.pathname === '/api/characters') return json(listCharacters());
    if (url.pathname === '/api/media') {
      const q = (k) => url.searchParams.get(k) || '', SAFE = /^[\w.\-]+$/, n = +q('n') || 0, bad = [q('proj'), q('id'), q('agent'), q('tool')].some((v) => !SAFE.test(v) || v === '..' || v.length > 200);
      const file = bad || !Number.isInteger(n) || n < 0 || n > 9 ? null : mediaFile(q('proj'), q('id'), q('agent')), im = file && toolImage(file, q('tool'), n);
      if (!im) { res.writeHead(bad ? 400 : 404); return res.end(bad ? 'bad request' : 'not found'); }
      res.writeHead(200, { 'content-type': im.type, 'content-length': im.buf.length, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }); return res.end(im.buf);
    }
    if (url.pathname === '/api/session') {
      const proj = url.searchParams.get('proj') || '', sid = url.searchParams.get('id') || '', SAFE = /^[\w.\-]+$/;
      if (!SAFE.test(proj) || !SAFE.test(sid) || proj === '..' || sid === '..' || proj.length > 200 || sid.length > 200) { res.writeHead(400); return res.end('bad request'); }
      const src = sourceOf(proj);
      if (proj !== '_demo' && !(src ? src.exists(proj, sid) : fs.existsSync(path.join(ROOT, proj, sid + '.jsonl')))) return json({ error: 'session not found' }, 404);
      const entry = proj === '_demo' ? { tl: require('./demo.js')(), rev: 1 } : timelineEntry(proj, sid), tl = entry.tl;   // built-in fictional session
      const after = url.searchParams.get('after');
      if (after == null) {   // the whole timeline: serialize once per version, send gzip-compressed when the browser allows it (12 MB → ~1.5 MB)
        const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        if (gz ? !entry.gz : !entry.json) { const j = JSON.stringify({ ...tl, rev: entry.rev }); if (gz) entry.gz = zlib.gzipSync(j, { level: 5 }); else entry.json = j; entry.bytes = j.length; trimCache(); }   // keep only the encoding that is served; its size counts against the budget
        res.writeHead(200, { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}), vary: 'accept-encoding' });
        return res.end(gz ? entry.gz : entry.json);
      }
      return json({ id: tl.id, agents: tl.agents, group: tl.group, title: tl.title, total: tl.events.length, rev: entry.rev, events: tl.events.slice(+after), last: +after > 0 ? tl.events[+after - 1] : null });   // last: the event before `after` as it is now, in case the beat grew
    }
    if (url.pathname.startsWith('/characters/')) {   // only plain image files of the characters folder, by exact name
      let f = ''; try { f = decodeURIComponent(url.pathname.slice('/characters/'.length)); } catch {}
      const dir = charactersDir(), fp = path.join(dir, f);
      try { const ls = fs.lstatSync(fp); if (!CHAR_NAME.test(f) || !fp.startsWith(dir + path.sep) || !ls.isFile() || ls.size > CHAR_MAX) throw 0; } catch { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': CHAR_TYPES[f.split('.').pop().toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' }); return fs.createReadStream(fp).pipe(res);
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    let fst = null; try { fst = fs.statSync(file); } catch {}
    if (!file.startsWith(PUBLIC + path.sep) || !fst || !fst.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch (e) { if (res.headersSent) return res.destroy(); json({ error: String(e.message || e) }, 500); }
  }).listen(port, '127.0.0.1', function () { console.log(`Agent Standup → http://localhost:${this.address().port}`); });
}
module.exports = { tts, elevenStats, start, currentSession, shutdown, findClaude, bundledClaude, boardRows, placement, charactersDir, listCharacters, triageInput, TRIAGE_SYS, TRIAGE_SCHEMA, SUMMARY_URL, SUMMARY_MODEL };   // the triage pieces: for the offline evaluation of thinking levels
if (require.main === module) {
  start().on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (maybe Agent Standup is already running, e.g. inside VS Code). Try: PORT=4790 node server.js` : String(e));
    process.exit(1);
  });
}
