// test/graph.test.js: the worker graph's data (dot sizes from tokens, the page's status words, who sent whom, who talks to whom in the last half hour, guests)
// and a smoke run of the SVG picture against a tiny fake DOM: hidden panel, reduced motion, a pulse that comes and goes, a loop that stops.
const test = require('node:test'), assert = require('node:assert');
const G = require('../public/graph.js');
const NOW = Date.parse('2026-10-12T12:00:00Z'), ago = (min) => NOW - min * 60e3;
const byId = (d) => Object.fromEntries(d.nodes.map((n) => [n.id, n])), msgEdge = (d, a, b) => d.edges.find((e) => e.kind === 'msg' && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
const lead = { id: 'main', name: 'Codex', role: 'Lead', type: 'main', model: 'gpt-6-astra', effort: 'xhigh' }, rivet = { id: '01a1', name: 'rivet', role: 'worker', type: 'worker' }, bolt = { id: '01b2', name: 'bolt', role: 'explorer', type: 'explorer' };
const guest = { id: 'p_claude_x', name: 'marketsimulator-3e', role: 'Claude Code, MarketSimulator', type: 'peer', group: { key: '/w/MarketSimulator', name: 'MarketSimulator' } };

test('a dot\'s area is its tokens: r = K·√tokens, clamped to [RMIN, RMAX]; 3M tokens fills the biggest dot, none still shows one', () => {
  const { radiusOf, RMIN, RMAX, K, TOK_MAX } = G;
  assert.ok(RMIN >= 4 && RMIN <= 6 && RMAX >= 30 && RMAX <= 36, 'about 5 and 34 px'); assert.equal(TOK_MAX, 3e6); assert.ok(Math.abs(K * Math.sqrt(3e6) - RMAX) < 1e-9, 'K reaches RMAX at about 3M tokens');
  assert.ok(Math.abs(radiusOf(1.2e6) / radiusOf(300e3) - 2) < 1e-9, 'four times the tokens, twice the radius: four times the area');
  assert.ok(Math.abs(radiusOf(500e3) - K * Math.sqrt(500e3)) < 1e-9);
  for (const t of [0, 1, 100, 20e3, -5, undefined, null, NaN, 'x']) assert.equal(radiusOf(t), RMIN, `tokens ${t}: the smallest dot`);
  assert.equal(radiusOf(3e6), RMAX); assert.equal(radiusOf(50e6), RMAX, 'a 50M-token lead does not dwarf the room');
  const d = byId(G.graphData({ agents: [lead, rivet, bolt], tokens: { main: 3e6, '01a1': 20e3 }, now: NOW }));
  assert.ok(d.main.r > d['01a1'].r && d.main.r <= RMAX, 'the 3M-token lead is bigger than the 20k sub-agent, within RMAX'); assert.equal(d['01a1'].r, RMIN); assert.equal(d['01b2'].r, RMIN, 'no tokens: RMIN');
  assert.deepEqual([d.main.tokens, d['01a1'].tokens, d['01b2'].tokens], [3e6, 20e3, 0]);
});

test('status in the page\'s words: working, needs (blocked), waiting (waiting or stalled), idle for everything else', () => {
  const st = { working: 'working', blocked: 'needs', waiting: 'waiting', stalled: 'waiting', turn: 'idle', done: 'idle', idle: 'idle', finished: 'idle', peer: 'idle', undefined: 'idle' };
  for (const [k, v] of Object.entries(st)) assert.equal(G.statusOf(k === 'undefined' ? undefined : k), v, k);
  const agents = Object.keys(st).map((k, i) => ({ id: 'a' + i, name: k, type: 'worker' })), status = Object.fromEntries(Object.keys(st).map((k, i) => [agents[i].id, k === 'undefined' ? undefined : k]));
  assert.deepEqual(G.graphData({ agents, status, now: NOW }).nodes.map((n) => n.status), Object.values(st));
});

test('parent lines come from orders (the latest wins); without one, a sub-agent hangs off its own session\'s lead (by team, else "sXXXX__main"), else off the call\'s', () => {
  const T0 = { proj: '-w-x', id: 'own-session', title: 'This session', source: 'claude' }, T1 = { proj: '-w-x', id: 'ab0a56b7', title: 'Other session', source: 'claude' }, T2 = { proj: '-w-x', id: 'cd2b2b2b', title: 'Third', source: 'codex' };
  const agents = [{ ...lead, team: T0 }, { ...rivet, team: T0 }, bolt, { id: '01c3', name: 'nut', type: 'worker', team: T0 }, { id: 'user' },
    { id: 's0a56b7__main', name: 'Claude', role: 'Lead', type: 'main', lead: true, team: T1 }, { id: 's0a56b7__a77', name: 'Check the logs', role: 'general-purpose', type: 'general-purpose', team: T1 },   // the lead of its team
    { id: 'lead-of-t2', name: 'Codex', role: 'Lead', type: 'main', lead: true, team: T2 }, { id: 'odd-id', name: 'rivet two', type: 'worker', team: T2 },   // found by team.id even when the ids say nothing
    { id: 's4d4d4d__main', name: 'Hermes', type: 'main' }, { id: 's4d4d4d__k1', name: 'delegate', type: 'subagent' },   // no lead flag, no team: the id's prefix
    { id: 's9z9z9z__a88', name: 'orphan of a session whose lead is not here', type: 'worker', team: { proj: '-w-x', id: 'z9z9z9z' } }];
  const events = [{ ts: ago(50), agent: 'main', kind: 'order', to: '01a1' }, { ts: ago(40), agent: 'main', kind: 'order', to: '01b2' }, { ts: ago(30), agent: '01a1', kind: 'order', to: '01b2' },   // bolt re-tasked by rivet: rivet is its parent
    { ts: ago(20), agent: 'user', kind: 'order', to: '01c3' }];   // "user" is not an agent: no parent from that
  const d = G.graphData({ agents, events, now: NOW }), n = byId(d);
  assert.ok(!n.user, 'the person is not a worker dot');
  assert.deepEqual(Object.fromEntries(d.nodes.map((x) => [x.id, x.parent])), { main: null, '01a1': 'main', '01b2': '01a1', '01c3': 'main', 's0a56b7__main': null, 's0a56b7__a77': 's0a56b7__main', 'lead-of-t2': null, 'odd-id': 'lead-of-t2', 's4d4d4d__main': null, 's4d4d4d__k1': 's4d4d4d__main', 's9z9z9z__a88': 'main' });
  assert.deepEqual(d.edges.filter((e) => e.kind === 'parent').map((e) => [e.a, e.b, e.w]).sort(), [['01a1', '01b2', 1], ['lead-of-t2', 'odd-id', 1], ['main', '01a1', 1], ['main', '01c3', 1], ['main', 's9z9z9z__a88', 1], ['s0a56b7__main', 's0a56b7__a77', 1], ['s4d4d4d__main', 's4d4d4d__k1', 1]]);
  assert.deepEqual(n['s0a56b7__a77'].team, T1); assert.equal(n['01b2'].team, null);
  assert.equal(n['s0a56b7__main'].label, 'Claude', 'a merged lead is labelled by its name');
  const late = G.graphData({ agents, events: [{ ts: ago(30), agent: '01a1', kind: 'order', to: '01b2' }, { ts: ago(40), agent: 'main', kind: 'order', to: '01b2' }], now: NOW });
  assert.equal(byId(late)['01b2'].parent, '01a1', 'the latest order by its time, not by its place in the list');
  assert.equal(byId(G.graphData({ agents: [rivet], now: NOW }))['01a1'].parent, null, 'no lead in view: no parent line');
});

test('message lines: one per pair, distinct messages counted once (msgId), A→B and B→A merged, only the last 30 min, only between agents of the call', () => {
  const agents = [lead, rivet, bolt];
  const events = [
    { ts: ago(10), agent: 'main', kind: 'msg', to: '01a1', msgId: 'm1', state: 'accepted' }, { ts: ago(10) + 900, agent: 'main', kind: 'msg', to: '01a1', msgId: 'm1', state: 'received' },   // the sender's and the receiver's log
    { ts: ago(8), agent: '01a1', kind: 'msg', to: 'main', msgId: 'm2' }, { ts: ago(6), agent: '01a1', kind: 'msg', to: 'main' }, { ts: ago(5), agent: '01a1', kind: 'msg', to: 'main' },   // no msgId: each event is one
    { ts: ago(31), agent: 'main', kind: 'msg', to: '01b2', msgId: 'old' }, { ts: ago(45), agent: '01b2', kind: 'msg', to: 'main' },   // outside the window
    { ts: ago(3), agent: 'main', kind: 'msg', to: 'x_ghost', msgId: 'g1' }, { ts: ago(3), agent: 'nobody', kind: 'msg', to: 'main' },   // not agents of the call
    { ts: ago(2), agent: 'main', kind: 'msg', to: '01b2', state: 'failed' },   // never delivered
    { ts: ago(1), agent: '01b2', kind: 'msg', to: '01b2' },   // to itself
    { ts: NOW + 60e3, agent: 'main', kind: 'msg', to: '01b2' },   // after now
  ];
  const d = G.graphData({ agents, events, now: NOW }), e = msgEdge(d, 'main', '01a1');
  assert.equal(d.edges.filter((x) => x.kind === 'msg').length, 1, 'one line, for the one pair that talked in the window');
  assert.deepEqual([e.kind, e.n, e.last, e.from], ['msg', 4, ago(5), '01a1'], 'm1 once, m2, and the two without an id; the newest was sent by rivet');
  assert.equal(e.w, 1 + Math.log2(4)); assert.ok(e.a < e.b, 'an unordered pair has one spelling');
  assert.ok(!msgEdge(d, 'main', '01b2'), 'old, failed, self and future messages draw nothing');
  const w = (n) => msgEdge(G.graphData({ agents, events: Array.from({ length: n }, (_, i) => ({ ts: ago(1), agent: i % 2 ? 'main' : '01a1', kind: 'msg', to: i % 2 ? '01a1' : 'main', msgId: 'k' + i })), now: NOW }), 'main', '01a1').w;
  assert.deepEqual([w(1), w(2), w(8)], [1, 2, 4]); assert.equal(w(500), G.W_MAX, 'capped'); assert.ok(w(3) > w(2) && w(3) < w(4));
  const wide = G.graphData({ agents, events, now: NOW, windowMs: 60 * 60e3 }); assert.equal(msgEdge(wide, 'main', '01b2').n, 2, 'a wider window takes the older ones in');
});

test('guests: a session from another project is a small dot, only while it sent or received a message in the window', () => {
  const quiet = { id: 'p_hermes_q', name: 'hermes:gaming:cb05', role: 'Hermes gaming', type: 'peer' }, stale = { id: 'p_codex_s', name: 'codex-9f73', role: 'Codex', type: 'peer' };
  const events = [{ ts: ago(4), agent: 'p_claude_x', kind: 'msg', to: 'main', msgId: 'q1' }, { ts: ago(90), agent: 'main', kind: 'msg', to: 'p_codex_s', msgId: 'q2' }, { ts: ago(2), agent: 'p_hermes_q', kind: 'msg', to: 'x_unknown' }];
  const d = G.graphData({ agents: [lead, guest, quiet, stale], events, tokens: { p_claude_x: 2e6 }, status: { p_claude_x: 'peer' }, now: NOW }), n = byId(d);
  assert.deepEqual(Object.keys(n), ['main', 'p_claude_x'], 'the quiet guest, the stale one and the one that wrote to nobody here are not drawn');
  assert.deepEqual([n.p_claude_x.guest, n.p_claude_x.r, n.p_claude_x.parent, n.p_claude_x.status, n.p_claude_x.label], [true, G.RMIN, null, 'idle', 'marketsimulator-3e'], 'small whatever its tokens, no parent');
  assert.equal(n.main.guest, false); assert.equal(msgEdge(d, 'main', 'p_claude_x').n, 1);
});

test('labels and hover text: a lead by its name, a worker by its name or role; the hover has name, role and model', () => {
  const d = byId(G.graphData({ agents: [lead, rivet, { id: 'a3x', role: 'general-purpose', type: 'agent' }, { id: 's0a56b7__main', role: 'Lead', type: 'main', lead: true, model: 'claude-opus-5-5' }, { id: 'a9', name: '  Review   the plan  ', role: 'Agent', type: 'agent', model: 'claude-sonnet-5-5' }], now: NOW, models: { '01a1': 'GPT-6 Luna medium' }, labels: { a9: 'Reviewer' } }));
  assert.equal(d.main.label, 'Codex'); assert.equal(d.main.model, 'GPT-6 Astra xhigh'); assert.equal(d.main.title, 'Codex\nLead\nGPT-6 Astra xhigh');
  assert.equal(d['01a1'].label, 'rivet'); assert.equal(d['01a1'].title, 'rivet\nworker\nGPT-6 Luna medium', 'the page\'s own model words win');
  assert.equal(d.a3x.label, 'general-purpose'); assert.equal(d['s0a56b7__main'].label, 'Lead'); assert.equal(d['s0a56b7__main'].model, 'Opus 5.5'); assert.equal(d['s0a56b7__main'].title, 'Lead\nOpus 5.5', 'a nameless lead: its role once');
  assert.equal(d.a9.label, 'Reviewer'); assert.equal(d.a9.title, 'Review the plan\nAgent\nSonnet 5.5');
  assert.equal(G.clip('Codex rollout research and more'), 'Codex rollout…'); assert.equal(G.clip('short'), 'short'); assert.ok(G.clip('x'.repeat(40)).length <= G.LABEL_MAX);
});

// ---------- the picture, against a tiny fake DOM ----------
function fakeDom({ w = 800, h = 500, reduce = false } = {}) {
  let t = 0; const frames = [], styles = [];
  const el = (tag) => ({ tag, attrs: {}, children: [], parent: null, textContent: '', on: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { if (c.parent) c.remove(); c.parent = this; this.children.push(c); if (c.tag === 'style') styles.push(c); return c; },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    closest(sel) { for (let n = this; n; n = n.parent) if ((n.attrs.class || '').split(' ').includes(sel.slice(1))) return n; return null; },
    addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); }, removeEventListener(k, f) { this.on[k] = (this.on[k] || []).filter((x) => x !== f); },
    get classList() { const s = this; return { add: (c) => { s.attrs.class = ((s.attrs.class || '') + ' ' + c).trim(); }, remove: (c) => { s.attrs.class = (s.attrs.class || '').split(' ').filter((x) => x && x !== c).join(' '); } }; } });
  const win = { matchMedia: () => ({ matches: reduce }), performance: { now: () => t }, requestAnimationFrame: (f) => frames.push(f), cancelAnimationFrame: () => { frames.length = 0; } };
  const doc = { defaultView: win, head: el('head'), createElementNS: (ns, tag) => el(tag), createElement: el, getElementById: (id) => styles.find((s) => s.id === id) || null };
  const svg = Object.assign(el('svg'), { ownerDocument: doc, clientWidth: w, clientHeight: h });
  const all = (n = svg, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
  return { svg, doc, frames, styles, all, dots: () => all().filter((n) => (n.attrs.class || '').split(' ').includes('wg-node')), pulses: () => all().filter((n) => n.attrs.class === 'wg-pulse'),
    run: (ms = 16, max = 2000) => { let k = 0; while (frames.length && k++ < max) { t += ms; frames.splice(0).forEach((f) => f(t)); } return k; } };
}
const xy = (g) => (/translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.attrs.transform || '') || []).slice(1).map(Number);
const call = (msgs = []) => G.graphData({ agents: [lead, rivet, bolt, guest], events: [{ ts: ago(20), agent: 'main', kind: 'order', to: '01a1' }, { ts: ago(5), agent: 'p_claude_x', kind: 'msg', to: 'main', msgId: 'g1' }, ...msgs], tokens: { main: 3e6, '01a1': 400e3 }, status: { main: 'working', '01a1': 'blocked' }, now: NOW });

test('the picture: exports, a hidden panel, reduced motion settles at once, a new message pulses once, the loop stops, clicks report the id', () => {
  assert.equal(typeof G.createGraph, 'function'); assert.equal(typeof G.graphData, 'function');
  // hidden (zero size): keeps the data, draws nothing, throws nothing; shown, it lays out on the next update
  const f = fakeDom({ w: 0, h: 0 }), clicks = [], hovers = [], g = G.createGraph(f.svg, { onClick: (id) => clicks.push(id), onHover: (id) => hovers.push(id) });
  assert.doesNotThrow(() => g.update(call())); assert.equal(f.dots().length, 0); assert.equal(f.frames.length, 0);
  f.svg.clientWidth = 800; f.svg.clientHeight = 500; g.update(call()); assert.equal(f.dots().length, 4);
  assert.equal(f.styles.length, 1, 'the module\'s CSS, injected once'); assert.match(f.styles[0].textContent, /\.wg-working \.wg-dot \{ fill:var\(--ok/);
  const settled = f.run(); assert.ok(settled > 5 && settled < 400, `it settles and the loop stops (${settled} frames)`); assert.equal(f.frames.length, 0, 'no frame requested once settled: nothing jiggles');
  const dot = (id) => f.dots().find((n) => n.attrs['data-id'] === id);
  for (const n of f.dots()) { const [x, y] = xy(n); assert.ok(x > 0 && x < 800 && y > 0 && y < 500, `${n.attrs['data-id']} inside the panel`); }
  assert.deepEqual(xy(dot('main')), [400, 250], 'the call\'s lead holds the middle');
  assert.match(dot('main').attrs.class, /wg-working/); assert.match(dot('01a1').attrs.class, /wg-needs/); assert.match(dot('p_claude_x').attrs.class, /wg-guest/);
  assert.equal(dot('main').children[0].tag, 'title'); assert.match(dot('main').children[0].textContent, /GPT-6 Astra xhigh/, 'the model is in the hover text');
  assert.equal(dot('main').children[1].children[0].attrs.r, String(G.RMAX.toFixed(1)));
  const lines = f.all().filter((n) => n.tag === 'line'); assert.deepEqual(lines.map((n) => n.attrs.class).sort(), ['wg-edge wg-msg', 'wg-edge wg-parent', 'wg-edge wg-parent'], 'main to rivet (ordered) and to bolt (by default); the guest\'s message');
  // one more message on a known line, and a new worker: one pulse that is gone after about a second; the old dots barely move
  const before = xy(dot('main')).concat(xy(dot('01a1')));
  g.update(call([{ ts: ago(1), agent: '01a1', kind: 'msg', to: 'main', msgId: 'n1' }])); assert.equal(f.pulses().length, 1, 'a newer message: one dot travels the line');
  g.update(call([{ ts: ago(1), agent: '01a1', kind: 'msg', to: 'main', msgId: 'n1' }])); assert.equal(f.pulses().length, 1, 'the same data again: no second pulse');
  f.run(100, 6); assert.equal(f.pulses().length, 1, 'still travelling at 0.6 s'); f.run(100, 6); assert.equal(f.pulses().length, 0, 'gone after its second');
  f.run(); assert.equal(f.frames.length, 0);
  const after = xy(dot('main')).concat(xy(dot('01a1'))); assert.ok(after.every((v, i) => Math.abs(v - before[i]) < 30), 'update keeps the positions');
  // click and hover come back with the agent's id; destroy takes everything away
  const label = dot('01a1').children[1].children[1]; f.svg.on.click[0]({ target: label }); assert.deepEqual(clicks, ['01a1']);
  f.svg.on.mouseover[0]({ target: label }); f.svg.on.mouseover[0]({ target: f.svg }); assert.deepEqual(hovers, ['01a1', null]);
  g.destroy(); assert.equal(f.svg.children.length, 0); assert.equal(f.svg.on.click.length, 0); assert.doesNotThrow(() => g.update(call()));
  // a second graph on the page shares the one style
  const g2 = G.createGraph(Object.assign(f.svg, { ownerDocument: f.doc }), {}); assert.equal(f.styles.length, 1); g2.destroy();
});

test('reduced motion: the settled picture at once, no animation frame and no pulse', () => {
  const f = fakeDom({ reduce: true }), g = G.createGraph(f.svg, {});
  g.update(call()); assert.equal(f.frames.length, 0, 'laid out synchronously'); assert.ok(f.dots().every((n) => xy(n).length === 2));
  g.update(call([{ ts: ago(1), agent: 'main', kind: 'msg', to: '01a1', msgId: 'n2' }])); assert.equal(f.pulses().length, 0); assert.equal(f.frames.length, 0);
  g.destroy();
});
