// adapters/timeline.js — turns the raw events of one session (lead, sub-agents, peers) into the event list the page plays:
// the same assembly server.js does for Claude Code, shared by the Codex and Hermes adapters.
//   raw kinds: user, say, tool, results, agentcall {toolId, title, text, bg}, agentdone {toolId | child}, usage, compact,
//              msg {dir:'out', to|target, name, text, state, msgId} / {dir:'in', from, name, text, msgId}
const peers = require('./peers.js');

function assemble({ id, proj, agents, states, childByTool = {}, childByPath = {}, pathOf = {}, finishedIds = [], own = () => '', now = Date.now() }) {   // own(address or name): the agent of this session it belongs to, if any
  const finished = new Set(finishedIds);
  const doneTs = {};
  for (const st of states) for (const e of st.raw) if (e.kind === 'agentdone') { const to = e.child || childByTool[e.toolId]; if (to && agents[to]) { finished.add(to); doneTs[to] = Math.max(doneTs[to] || 0, e.ts || 0); } }
  for (const st of states) if (doneTs[st.agent] && agents[st.agent].mtime && now - agents[st.agent].mtime <= 240000 && st.raw.some((e) => (e.ts || 0) > doneTs[st.agent])) finished.delete(st.agent);   // done once, then given more work and busy again: not finished
  let recentUntil = 0;
  for (const a of Object.values(agents)) if (a.id !== 'main' && a.type !== 'peer') { if (a.mtime && now - a.mtime <= 240000) recentUntil = Math.max(recentUntil, a.mtime + 241000); else if (a.mtime && now - a.mtime > 240000) finished.add(a.id); }   // silent for 4 min counts as finished
  const events = [], parent = {}, doneSeen = new Set(), book = peers.nameBook(states);
  const target = (st, e) => {   // a native message between agents of this session: a thread id, an absolute agent path, or a name relative to the sender (its child, its sibling, or under the lead)
    const t = String(e.target || ''); if (!t || t === '/root' || t === 'main') return 'main';
    if (agents[t]) return t;
    const mine = pathOf[st.agent] || '/root', up = mine.replace(/\/[^/]+$/, '') || '/root';
    for (const p of [t, mine + '/' + t, up + '/' + t, '/root/' + t]) if (childByPath[p]) return childByPath[p];
    const stray = 'x_' + t.replace(/[^\w-]/g, '_'), short = t.replace(/^.*\//, '');   // an agent this session's files do not show (not listed, or beyond the cap): still an edge, to a placeholder
    if (!agents[stray]) agents[stray] = { id: stray, name: /^[0-9a-f-]{32,}$/i.test(short) || /^APP[0-9a-f-]{20,}$/.test(short) ? 'agent ' + short.slice(-4) : short, role: 'not in view', type: 'peer' };
    return stray;
  };
  for (const st of states) {
    let lastSay = -1;
    if (st.agent !== 'main' && finished.has(st.agent)) for (let i = st.raw.length - 1; i >= 0; i--) if (st.raw[i].kind === 'say') { lastSay = i; break; }
    st.raw.forEach((e, i) => {
      if (e.kind === 'agentdone') { const to = e.child || childByTool[e.toolId]; if (to && agents[to] && !doneSeen.has(to)) { doneSeen.add(to); events.push({ ts: e.ts, agent: to, kind: 'finish', to: e.agent }); } }
      else if (e.kind === 'agentcall') { const to = childByTool[e.toolId]; if (to && agents[to]) { parent[to] = e.agent; events.push({ ts: e.ts, agent: e.agent, to, kind: 'order', toolId: e.toolId, bg: !!e.bg, text: e.text || '', title: e.title || '', ...(e.atype ? { atype: e.atype } : {}) }); } }
      else if (e.kind === 'msg') {
        if (e.native) { events.push({ ts: e.ts, agent: e.agent, kind: 'msg', to: target(st, e), text: e.text || '', state: e.state || 'accepted', native: true }); return; }
        const mine = own(e.dir === 'out' ? e.to : e.from) || own(e.name);   // a send_peer between two agents of this very session is not another session
        if (mine) { if (e.dir === 'out' && mine !== e.agent) events.push({ ts: e.ts, agent: e.agent, kind: 'msg', to: mine, text: e.text || '', state: e.state || 'accepted', msgId: e.msgId || '' }); return; }   // its arrival is the same message, seen from the other end
        const pa = peers.peerAgent(e.dir === 'out' ? e.to : e.from, e.name, book); if (!agents[pa.id]) agents[pa.id] = pa; else if (e.name && !agents[pa.id].named) { agents[pa.id].name = e.name; agents[pa.id].named = true; }
        if (e.dir === 'out') events.push({ ts: e.ts, agent: e.agent, kind: 'msg', to: pa.id, text: e.text || '', state: e.state || 'accepted', msgId: e.msgId || '', detail: e.detail || '' });
        else events.push({ ts: e.ts, agent: pa.id, kind: 'msg', to: e.agent, text: e.text || '', state: 'received', msgId: e.msgId || '' });
      }
      else if (i === lastSay) events.push({ ...e, kind: 'report', to: null });
      else events.push(e);
    });
  }
  for (const e of events) if (e.kind === 'report' && e.to === null) e.to = parent[e.agent] || 'main';
  events.sort((a, b) => a.ts - b.ts);
  const merged = []; let lastReal = -1;   // consecutive tool calls of one agent become one activity beat
  for (const e of events) {
    const p = lastReal >= 0 ? merged[lastReal] : null;
    if (e.kind === 'usage' || e.kind === 'finish' || e.kind === 'compact') { merged.push(e); continue; }
    if (e.kind === 'tool' && p && p.kind === 'tools' && p.agent === e.agent) p.tools.push(e.tool);
    else { merged.push(e.kind === 'tool' ? { ts: e.ts, agent: e.agent, kind: 'tools', tools: [e.tool] } : e); lastReal = merged.length - 1; }
  }
  const real = merged.find((e) => e.kind !== 'usage' && e.kind !== 'finish' && e.kind !== 'compact'), first = real ? real.ts : 0, last = merged.length ? merged[merged.length - 1].ts : 0;
  return { id, proj, agents: Object.values(agents), events: merged.map((e) => ({ ...e, t: Math.max(0, e.ts - first) })), durationMs: last - first, recentUntil };
}
module.exports = { assemble };
