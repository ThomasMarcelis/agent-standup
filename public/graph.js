// public/graph.js: the call as a graph of its workers. Every agent is a dot whose area is the tokens it has burnt, a thin line runs from the agent
// that gave it its task, and a line joins two agents that message each other, thicker the more they do; guests (other projects' sessions) sit small at the rim.
// One file for the page (a classic <script>: window.WorkerGraph) and for node:test (module.exports), the same API. Plain JS and SVG, no dependencies.
//   graphData({ agents, events, status, tokens, now, windowMs, labels?, models? }) → { nodes, edges }: pure, no DOM
//   createGraph(svg, { onClick(id), onHover?(id | null) }) → { update(data), destroy() }
(function (root) {
  'use strict';
  const RMIN = 5, RMAX = 34, TOK_MAX = 3e6, K = RMAX / Math.sqrt(TOK_MAX);   // area ∝ tokens: 3M tokens fills the biggest dot, a lead never dwarfs the room, an agent with none still shows one
  const W_MAX = 6, WINDOW_MS = 30 * 60e3, LABEL_MAX = 18, PULSE_MS = 1000;   // 32 messages or more: the thickest line; only the last half hour of talk counts
  const ALPHA_MIN = 0.005, DECAY = 0.03, REHEAT = 0.15, TICKS = 2, PAD = 8;   // the layout cools in about 2 s and then stops; a new agent warms it a little, never a reshuffle
  const STATUS = { working: 'working', blocked: 'needs', waiting: 'waiting', stalled: 'waiting' };   // the page's words; done, turn, idle, finished and unknown read as idle
  const statusOf = (s) => STATUS[s] || 'idle';
  const radiusOf = (tokens) => Math.min(RMAX, Math.max(RMIN, K * Math.sqrt(+tokens > 0 ? +tokens : 0)));
  const weightOf = (n) => Math.min(W_MAX, 1 + Math.log2(Math.max(1, n)));
  const words = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const clip = (t, n = LABEL_MAX) => { t = words(t); if (t.length <= n) return t; const c = t.lastIndexOf(' ', n - 1); return t.slice(0, c > n * 0.5 ? c : n - 1).replace(/[\s,;:/–—-]+$/, '') + '…'; };   // cut at a word when one ends past the middle
  const isLead = (a) => a.id === 'main' || String(a.id).endsWith('__main') || !!a.lead;   // the call's lead, or the lead of a session merged into it ("s0a56b7__main": no colon, it breaks CSS selectors)
  // A model as a person says it, the page's modelLabel: "Opus 5.5", "GPT-6 Astra xhigh"; '' when unknown. The page can pass its own words through `models`.
  function modelLabel(model, effort) {
    const m = String(model || '').trim().replace(/^[\w.-]+\//, '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, ''); if (!m || m === '<synthetic>') return '';
    const c = /^claude-(?:(\d+)-(\d+)-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?$/i.exec(m), cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    const out = c ? cap(c[3].toLowerCase()) + (c[4] ? ' ' + c[4] + (c[5] ? '.' + c[5] : '') : c[1] ? ' ' + c[1] + '.' + c[2] : '')
      : /^gpt-/i.test(m) ? ((p) => 'GPT-' + p[1] + (p.length > 2 ? ' ' + p.slice(2).map(cap).join(' ') : ''))(m.split('-'))
      : /^o\d/i.test(m) ? m : m.split(/[-_]+/).map(cap).join(' ');
    return effort ? out + ' ' + effort : out;
  }

  // ---------- the data: who is a dot, how big, who sent whom, who talks to whom ----------
  function graphData({ agents = [], events = [], status = {}, tokens = {}, now = Date.now(), windowMs = WINDOW_MS, labels = {}, models = {} } = {}) {
    const byId = new Map(); for (const a of agents || []) if (a && a.id != null && a.id !== 'user' && !byId.has(a.id)) byId.set(a.id, a);   // the person is not a worker
    status = status || {}; tokens = tokens || {}; labels = labels || {}; models = models || {};
    const guest = (id) => byId.get(id).type === 'peer', t0 = now - windowMs, order = {}, pairs = new Map(), talked = new Set(), counted = new Set();
    for (const e of events || []) {
      if (!e) continue;
      if (e.kind === 'order') { if (byId.has(e.to) && byId.has(e.agent) && e.agent !== e.to && !guest(e.agent) && (!order[e.to] || (e.ts || 0) >= order[e.to].ts)) order[e.to] = { by: e.agent, ts: e.ts || 0 }; continue; }   // the latest order names the parent
      if (e.kind !== 'msg' || e.state === 'failed' || !byId.has(e.agent) || !byId.has(e.to) || e.agent === e.to || !(e.ts >= t0 && e.ts <= now)) continue;   // a failed send never reached anyone; an id that is not an agent of the call is no edge
      if (e.msgId) { if (counted.has(e.msgId)) continue; counted.add(e.msgId); }   // the sender's and the receiver's copy of one message; without an id, each event is one
      const [a, b] = e.agent < e.to ? [e.agent, e.to] : [e.to, e.agent], k = a + '\n' + b;
      let p = pairs.get(k); if (!p) pairs.set(k, (p = { a, b, kind: 'msg', n: 0, w: 1, last: 0, from: e.agent }));
      p.n++; if (e.ts >= p.last) { p.last = e.ts; p.from = e.agent; }   // from: who sent the newest one, so the pulse runs the right way
      talked.add(e.agent); talked.add(e.to);
    }
    const kept = new Set(); for (const [id, a] of byId) if (a.type !== 'peer' || talked.has(id)) kept.add(id);   // a guest is on the graph only while it is in an exchange
    const leads = new Map(); for (const id of kept) { const a = byId.get(id); if (a.lead && a.team && a.team.id != null && !guest(id) && !leads.has(a.team.id)) leads.set(a.team.id, id); }   // a merged session's lead, by its team
    const leadOf = (id, a) => {   // no order seen: the lead of its own session (by team, else by the id's "s0a56b7__" prefix), else the call's lead; the opened session's own agents have no prefix
      const byTeam = a.team && a.team.id != null ? leads.get(a.team.id) : null; if (byTeam && byTeam !== id) return byTeam;
      const c = String(id).indexOf('__'), t = c > 0 ? String(id).slice(0, c + 2) + 'main' : ''; if (t && t !== id && kept.has(t) && !guest(t)) return t;
      return id !== 'main' && kept.has('main') ? 'main' : null;
    };
    const nodes = [], edges = [];
    for (const id of kept) {
      const a = byId.get(id), g = a.type === 'peer', o = order[id], name = words(a.name), role = words(a.role), model = words(models[id]) || modelLabel(a.model, a.effort);
      const parent = g ? null : o && kept.has(o.by) ? o.by : isLead(a) ? null : leadOf(id, a), label = words(labels[id]) || (isLead(a) ? name || role || 'Lead' : name || role || String(id));
      nodes.push({ id, label, title: [name || label, role !== (name || label) ? role : '', model].filter(Boolean).join('\n'), model, status: statusOf(status[id]), tokens: +tokens[id] > 0 ? +tokens[id] : 0, r: g ? RMIN : radiusOf(tokens[id]), guest: g, parent, team: a.team || null });
      if (parent) edges.push({ a: parent, b: id, kind: 'parent', w: 1 });
    }
    for (const p of pairs.values()) { p.w = weightOf(p.n); edges.push(p); }
    return { nodes, edges };
  }

  // ---------- the picture: a small force layout in SVG that settles and stops ----------
  const CSS = `
.wg { display:block; user-select:none; -webkit-user-select:none }
.wg-edge { fill:none; stroke-linecap:round } .wg-parent { stroke:var(--dim, #9aa0b6); stroke-opacity:.3; stroke-width:1.2 } .wg-msg { stroke:var(--accent, #7c9cff); stroke-opacity:.55 }
.wg-node { cursor:pointer } .wg-dot { fill:var(--dim, #9aa0b6); transition:fill .3s } .wg-working .wg-dot { fill:var(--ok, #58d68d) } .wg-needs .wg-dot { fill:var(--warn, #f0a020) } .wg-waiting .wg-dot { fill:var(--accent, #7c9cff) }
.wg-node:hover .wg-dot { stroke:var(--text, #e9eaf0); stroke-width:1.5 } .wg-node:hover .wg-label { fill:var(--text, #e9eaf0) }
.wg-label { fill:var(--dim, #9aa0b6); font-size:10.5px; text-anchor:middle; pointer-events:none; paint-order:stroke; stroke:var(--bg, #12131a); stroke-width:3px; stroke-linejoin:round }   /* a halo: a label stays legible over a line */
.wg-pulse { fill:var(--text, #e9eaf0); pointer-events:none }
.wg-in { animation:wg-in .4s cubic-bezier(.2,.8,.2,1) both } @keyframes wg-in { from { opacity:0; transform:scale(.3) } }
@media (prefers-reduced-motion:reduce) { .wg-in { animation:none } .wg-dot { transition:none } }`;
  const hash = (s) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };   // a stable angle per id: the same picture on every load
  const ekey = (e) => (e.kind === 'parent' ? 'p\n' + e.a + '\n' + e.b : 'm\n' + (e.a < e.b ? e.a + '\n' + e.b : e.b + '\n' + e.a));

  function createGraph(svg, { onClick, onHover } = {}) {
    const doc = svg && svg.ownerDocument, win = (doc && doc.defaultView) || null, NS = 'http://www.w3.org/2000/svg';
    if (!doc) return { update() {}, destroy() {} };
    const mk = (tag, cls) => { const e = doc.createElementNS(NS, tag); if (cls) e.setAttribute('class', cls); return e; };
    if (!doc.getElementById('wg-style')) { const s = doc.createElement('style'); s.id = 'wg-style'; s.textContent = CSS; (doc.head || doc.documentElement).appendChild(s); }   // once per page, however many graphs
    const raf = win && win.requestAnimationFrame ? (f) => win.requestAnimationFrame(f) : (f) => setTimeout(f, 16), caf = win && win.cancelAnimationFrame ? (h) => win.cancelAnimationFrame(h) : (h) => clearTimeout(h);
    const clock = () => (win && win.performance ? win.performance.now() : Date.now());
    const reduced = () => { try { return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } };
    const gEP = mk('g', 'wg-edges'), gEM = mk('g', 'wg-edges'), gP = mk('g', 'wg-pulses'), gN = mk('g', 'wg-nodes');   // parent lines under message lines under pulses under dots: a pulse leaves one dot and sinks into the other
    svg.classList.add('wg'); for (const g of [gEP, gEM, gP, gN]) svg.appendChild(g);
    const N = new Map(), E = new Map(), seen = new Map(), pulses = [];
    let data = { nodes: [], edges: [] }, list = [], links = [], W = 0, H = 0, fw = 0, fh = 0, alpha = 0, frame = 0, primed = false, dead = false, hovered = null;
    const measure = () => { let w = +svg.clientWidth || 0, h = +svg.clientHeight || 0; if ((!w || !h) && svg.getBoundingClientRect) { const b = svg.getBoundingClientRect() || {}; w = +b.width || 0; h = +b.height || 0; } return [w, h]; };
    const fit = () => { if (fw && (fw !== W || fh !== H)) { const dx = (W - fw) / 2, dy = (H - fh) / 2; for (const p of N.values()) if (p.x != null) { p.x += dx; p.y += dy; } alpha = Math.max(alpha, 0.1); } fw = W; fh = H; };   // a resized panel keeps its picture, re-centred
    function node(n) {
      const g = mk('g', 'wg-node'), body = mk('g', 'wg-body wg-in'), c = mk('circle', 'wg-dot'), t = mk('text', 'wg-label'), tt = mk('title');   // the scale-in lives on an inner group: CSS transform would override the outer one's translate
      g.setAttribute('data-id', n.id); g.appendChild(tt); body.appendChild(c); body.appendChild(t); g.appendChild(body); gN.appendChild(g);
      return { id: n.id, g, c, t, tt, x: null, y: null, vx: 0, vy: 0, r: n.r, dr: n.r, shown: -1, tr: '', cls: '', lb: null, ti: null };
    }
    function patch(p, n) {
      const cls = 'wg-node wg-' + n.status + (n.guest ? ' wg-guest' : ''), lb = clip(n.label);
      if (p.cls !== cls) p.g.setAttribute('class', (p.cls = cls)); if (p.lb !== lb) p.t.textContent = p.lb = lb; if (p.ti !== n.title) p.tt.textContent = p.ti = n.title;   // the model is in the hover text, not on the picture
      p.r = +n.r || RMIN; p.guest = !!n.guest; p.parent = n.parent;
    }
    function place(p, depth) {   // a new dot starts beside the one that sent it; a guest at the rim; a lead in the middle (a merged session's lead a little way off)
      if (p.x != null) return; const q = p.parent != null ? N.get(p.parent) : null, a = hash(p.id) * 2 * Math.PI, cx = W / 2, cy = H / 2;
      if (q && q !== p && depth < 40) { place(q, depth + 1); const d = q.r + p.r + 16; p.x = q.x + Math.cos(a) * d; p.y = q.y + Math.sin(a) * d; }
      else if (p.guest) { p.x = cx + Math.cos(a) * (W / 2 - 24); p.y = cy + Math.sin(a) * (H / 2 - 28); }
      else { const d = p.id === 'main' ? 0 : Math.min(W, H) / 4; p.x = cx + Math.cos(a) * d; p.y = cy + Math.sin(a) * d; }
      p.vx = p.vy = 0;
    }
    function tick() {
      const n = list.length, cx = W / 2, cy = H / 2, rx = Math.max(10, W / 2 - 24), ry = Math.max(10, H / 2 - 28), q = Math.min(140, Math.max(20, W * H / Math.max(1, n) / 50));   // the charge shrinks as the room fills: 150 dots still fit the panel
      for (let i = 0; i < n; i++) { const p = list[i]; for (let j = i + 1; j < n; j++) {   // O(n²): 11k pairs at 150 dots, well under a millisecond
        const o = list[j]; let dx = o.x - p.x, dy = o.y - p.y, d2 = dx * dx + dy * dy; if (d2 < 1) { dx = hash(p.id + '|' + o.id) - 0.5 || 0.1; dy = 0.5 - hash(o.id + '|' + p.id) || 0.1; d2 = dx * dx + dy * dy; }   // two dots on one spot part the same way every time
        const f = q * alpha / d2, min = p.r + o.r + PAD; p.vx -= dx * f; p.vy -= dy * f; o.vx += dx * f; o.vy += dy * f;
        if (d2 < min * min) { const d = Math.sqrt(d2), s = (min - d) / d * 0.35; p.vx -= dx * s; p.vy -= dy * s; o.vx += dx * s; o.vy += dy * s; } } }   // dots never overlap, however cool the layout
      for (const l of links) { const s = l.a, t = l.b, par = l.kind === 'parent'; let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy; const d = Math.sqrt(dx * dx + dy * dy) || 1, k = (d - ((par ? 24 : 70) + s.r + t.r)) / d * alpha * l.s * (par ? 0.7 : 0.08 + 0.04 * l.w); dx *= k; dy *= k; t.vx -= dx / 2; t.vy -= dy / 2; s.vx += dx / 2; s.vy += dy / 2; }   // a worker close to its parent; talkers drawn together, more the more they talk
      for (const p of list) {
        if (p.guest) { const dx = p.x - cx, dy = p.y - cy, e = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2) || 1; p.vx += (cx + dx / e - p.x) * 0.12 * alpha; p.vy += (cy + dy / e - p.y) * 0.12 * alpha; }   // guests drift to the rim: visitors, not crew
        else if (p.id === 'main') { p.x = cx; p.y = cy; p.vx = p.vy = 0; continue; }   // the call's lead holds the middle: the picture has an anchor, and its crew forms around it
        else { p.vx += (cx - p.x) * 0.03 * alpha; p.vy += (cy - p.y) * 0.03 * alpha; }
        p.vx *= 0.6; p.vy *= 0.6; p.x = Math.max(p.r + 2, Math.min(W - p.r - 2, p.x + p.vx)); p.y = Math.max(p.r + 2, Math.min(H - p.r - 16, p.y + p.vy));   // the label needs room below its dot
      }
      alpha -= alpha * DECAY;
    }
    function draw() {
      for (const p of list) { const tr = 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')'; if (tr !== p.tr) p.g.setAttribute('transform', (p.tr = tr)); if (p.dr !== p.shown) { p.shown = p.dr; p.c.setAttribute('r', p.dr.toFixed(1)); p.t.setAttribute('y', (p.dr + 11).toFixed(1)); } }
      for (const l of links) { l.el.setAttribute('x1', l.a.x.toFixed(1)); l.el.setAttribute('y1', l.a.y.toFixed(1)); l.el.setAttribute('x2', l.b.x.toFixed(1)); l.el.setAttribute('y2', l.b.y.toFixed(1)); }
    }
    function stepPulses(now) {
      for (let i = pulses.length - 1; i >= 0; i--) { const u = pulses[i], k = (now - u.t0) / PULSE_MS, s = N.get(u.from), e = N.get(u.to); if (k >= 1 || !s || !e) { u.el.remove(); pulses.splice(i, 1); continue; }
        const m = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k); u.el.setAttribute('cx', (s.x + (e.x - s.x) * m).toFixed(1)); u.el.setAttribute('cy', (s.y + (e.y - s.y) * m).toFixed(1)); }
      return pulses.length > 0;
    }
    function pulse(e) {   // one dot runs the line of a new message, sender to receiver, then goes
      const from = e.from === e.b ? e.b : e.a, s = N.get(from), el = mk('circle', 'wg-pulse'); el.setAttribute('r', '3'); if (s && s.x != null) { el.setAttribute('cx', s.x.toFixed(1)); el.setAttribute('cy', s.y.toFixed(1)); }
      gP.appendChild(el); pulses.push({ el, from, to: from === e.a ? e.b : e.a, t0: clock() });
    }
    function track(live) {   // a message line newer than the last one seen pulses; the first data only sets the mark, so a page load is quiet
      for (const e of data.edges) { if (e.kind !== 'msg') continue; const k = ekey(e), was = seen.get(k) || 0, last = +e.last || 0; if (last <= was) continue; seen.set(k, last); if (live && primed && pulses.length < 24 && N.has(e.a) && N.has(e.b)) pulse(e); }
      primed = true;
    }
    function loop() {
      frame = 0; if (dead || !W || !H) return; const t0 = clock();
      for (let i = 0; i < TICKS && alpha >= ALPHA_MIN && clock() - t0 < 10; i++) tick();   // a capped number of ticks per frame: no stutter at 150 dots
      let easing = false; for (const p of list) { if (Math.abs(p.dr - p.r) > 0.1) { p.dr += (p.r - p.dr) * 0.2; easing = true; } else p.dr = p.r; }   // a dot grows smoothly as its tokens climb
      draw(); const live = stepPulses(clock());
      if (alpha >= ALPHA_MIN || easing || live) frame = raf(loop);   // settled and quiet: the loop stops, nothing jiggles
    }
    const go = () => { if (!frame && !dead && W && H) frame = raf(loop); };
    const run = (until, ms) => { const t0 = clock(); for (let i = 0; i < 600 && alpha >= until && clock() - t0 < ms; i++) tick(); };
    function apply() {
      fit(); const first = !N.size, reduce = reduced(), ids = new Set(), fresh = []; let topo = false, grew = false;
      for (const n of data.nodes || []) { if (!n || n.id == null || ids.has(n.id)) continue; ids.add(n.id); let p = N.get(n.id); if (!p) { N.set(n.id, (p = node(n))); fresh.push(p); topo = true; } else if (Math.abs(p.r - n.r) > 0.5) grew = true; patch(p, n); }
      for (const [id, p] of N) if (!ids.has(id)) { p.g.remove(); N.delete(id); topo = true; if (hovered === id) hovered = null; }
      list = [...N.values()]; for (const p of fresh) place(p, 0);
      const keys = new Set();
      for (const e of data.edges || []) {
        if (!e || !N.has(e.a) || !N.has(e.b) || e.a === e.b) continue; const k = ekey(e); if (keys.has(k)) continue; keys.add(k); let l = E.get(k);
        if (!l) { const par = e.kind === 'parent'; l = { el: mk('line', 'wg-edge ' + (par ? 'wg-parent' : 'wg-msg')), kind: par ? 'parent' : 'msg', sw: '' }; (par ? gEP : gEM).appendChild(l.el); E.set(k, l); topo = true; }
        l.a = N.get(e.a); l.b = N.get(e.b); l.w = +e.w || 1; const sw = l.kind === 'msg' ? (l.w * 1.25).toFixed(2) : ''; if (sw && sw !== l.sw) l.el.setAttribute('stroke-width', (l.sw = sw));   // the line's width is how much they talk
      }
      for (const [k, l] of E) if (!keys.has(k)) { l.el.remove(); E.delete(k); topo = true; }
      links = [...E.values()]; const deg = new Map(); for (const l of links) for (const p of [l.a, l.b]) deg.set(p, (deg.get(p) || 0) + 1); for (const l of links) l.s = 1 / Math.min(deg.get(l.a), deg.get(l.b));   // a busy hub's springs share the pull
      track(!reduce);
      if (first) alpha = 1; else if (topo) alpha = Math.max(alpha, REHEAT); else if (grew) alpha = Math.max(alpha, 0.05);
      if (reduce) { run(ALPHA_MIN, 250); for (const p of list) p.dr = p.r; draw(); return; }   // reduced motion: the settled picture at once, no pulse
      if (first) run(0.2, 30);   // the first picture appears nearly in place and only finishes settling on screen
      draw(); go();   // drawn now, so a new dot never shows a frame at the corner
    }
    const resized = () => { if (dead) return; const [w, h] = measure(); if (w === W && h === H) return; W = w; H = h; if (W && H) apply(); };   // a hidden panel shown again lays out at once
    const ro = win && win.ResizeObserver ? new win.ResizeObserver(resized) : null; if (ro) ro.observe(svg);
    const idOf = (ev) => { const g = ev.target && ev.target.closest ? ev.target.closest('.wg-node') : null; return g ? g.getAttribute('data-id') : null; };
    const click = (ev) => { const id = idOf(ev); if (id != null && onClick) onClick(id); };
    const over = (ev) => { const id = idOf(ev); if (id !== hovered) { hovered = id; if (onHover) onHover(id); } };
    const leave = () => { if (hovered != null) { hovered = null; if (onHover) onHover(null); } };
    svg.addEventListener('click', click); svg.addEventListener('mouseover', over); svg.addEventListener('mouseleave', leave);
    return {
      update(d) { if (dead) return; data = d && Array.isArray(d.nodes) ? d : { nodes: [], edges: [] }; [W, H] = measure(); if (!W || !H) { track(false); return; } apply(); },   // zero size (a hidden panel): keep the data, lay out when it shows
      destroy() { dead = true; if (frame) caf(frame); frame = 0; if (ro) ro.disconnect(); svg.removeEventListener('click', click); svg.removeEventListener('mouseover', over); svg.removeEventListener('mouseleave', leave); for (const g of [gEP, gEM, gP, gN]) g.remove(); svg.classList.remove('wg'); N.clear(); E.clear(); pulses.length = 0; list = []; links = []; },
    };
  }

  const api = { graphData, createGraph, statusOf, radiusOf, weightOf, modelLabel, clip, RMIN, RMAX, TOK_MAX, K, W_MAX, WINDOW_MS, LABEL_MAX, PULSE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WorkerGraph = api;
})(this);
