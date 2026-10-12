// test/liveness.test.js: how long a sub-agent stays in the call, from the page's own status rules (index.html), the shared timeline assembly and the Codex board.
// Shapes from a real gladiator-game tree (2026-10-12): a worker given a follow-up after it finished, workers whose spawn record is older than the lead's read budget.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-live-'));
process.env.CODEX_HOME = path.join(tmp, 'codex'); process.env.AGENT_PEERS_HOME = path.join(tmp, 'peers'); process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = (re) => { const m = re.exec(html); if (!m) throw new Error('not found in index.html: ' + re); return m[0]; };
const src = [grab(/const VANISH_MS = [^\n]*/), grab(/const applyStatus = \(ev\) => \{[\s\S]*?\n\};/), grab(/function recomputeStatus\(upTo\) \{[\s\S]*?\n\}/)].join('\n');
const T0 = Date.parse('2026-10-12T11:15:36Z'), min = 60e3, at = (m) => T0 + m * min;
function call(agents, events, now) {   // the call as a live page builds it on load or after a skip: every event applied, then who has already left; id → 'working' | 'done' | 'hidden'
  const S = { agents: Object.fromEntries(agents.map((a) => [a.id, a])), events: events.map((e) => ({ ...e, t: e.ts - T0 })), status: {}, tc: {}, doneAt: {}, gone: new Set(), leaving: new Set(), clock: 0, live: true, seen: {} };
  const recompute = new Function('S', 'prefs', 'document', '$', 'later', 'hidePresent', 'renderTokens', 'renderBadges', 'pushTerm', 'applyResults', 'tally', 'performance', 'Date', src + '\nreturn recomputeStatus;')(
    S, { vanish: true }, { querySelectorAll: () => [] }, () => null, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, { now: () => 0 }, { now: () => now });
  recompute(S.events.length); return (id) => (S.status[id] && !S.gone.has(id) ? S.status[id] : 'hidden');
}
const team = [{ id: 'main', type: 'main' }, { id: 'fig', type: 'worker' }, { id: 'fat', type: 'worker' }];

test('a worker that finished, then got a follow-up and works again, is in the call (it was hidden while it worked)', () => {
  const evs = [{ ts: at(0), agent: 'main', kind: 'order', to: 'fig', bg: true }, { ts: at(1), agent: 'fig', kind: 'tools', tools: [] },
    { ts: at(7), agent: 'fig', kind: 'report', to: 'main', text: 'Route ready.' }, { ts: at(7), agent: 'fig', kind: 'finish', to: 'main' },
    { ts: at(13), agent: 'main', kind: 'msg', to: 'fig', native: true, text: '' }, { ts: at(13.2), agent: 'fig', kind: 'tools', tools: [] }];
  assert.equal(call(team, evs, at(14))('fig'), 'working');
});

test('a worker whose spawn record was not read (older than the lead\'s budget) is in the call as soon as it acts', () => {
  const evs = [{ ts: at(0), agent: 'main', kind: 'tools', tools: [] }, { ts: at(0.5), agent: 'fat', kind: 'tools', tools: [] }, { ts: at(1), agent: 'fat', kind: 'say', text: 'Tests pass.' }];
  const who = call(team, evs, at(1.5)); assert.equal(who('fat'), 'working'); assert.equal(who('fig'), 'hidden');   // an agent with nothing in the call is not shown
});

test('a finished worker stays in the call until 10 minutes after its own last event, whatever the lead does meanwhile', () => {
  const evs = [{ ts: at(0), agent: 'main', kind: 'order', to: 'fig', bg: true }, { ts: at(2), agent: 'fig', kind: 'report', to: 'main', text: 'Done.' }, { ts: at(2), agent: 'fig', kind: 'finish', to: 'main' }, { ts: at(6), agent: 'main', kind: 'tools', tools: [] }];
  assert.equal(call(team, evs, at(6))('fig'), 'done');   // 4 min after its report: still there (it left after 2 min)
  assert.equal(call(team, evs.concat({ ts: at(12.5), agent: 'main', kind: 'tools', tools: [] }), at(12.5))('fig'), 'hidden');   // 10 min after: gone
});

test('timeline: a sub-agent silent for 5 minutes (a long build) is still working; silent for 11 it is finished, closed after its last call', () => {
  const { assemble } = require('../adapters/timeline.js'), now = Date.now();
  const build = (silentMin) => { const last = now - silentMin * min; return assemble({ id: 's', proj: '_codex', now, agents: { main: { id: 'main' }, kid: { id: 'kid', name: 'fatigue build', mtime: last } },
    states: [{ agent: 'main', raw: [] }, { agent: 'kid', raw: [{ ts: last - 30e3, agent: 'kid', kind: 'say', text: 'Running the campaign tests.' }, { ts: last, agent: 'kid', kind: 'tool', tool: { id: 't1', name: 'exec_command' } }] }] }); };
  const busy = build(5); assert.ok(!busy.events.some((e) => e.agent === 'kid' && (e.kind === 'finish' || e.kind === 'report')), 'not finished after 5 min'); assert.ok(busy.recentUntil > now);
  const quiet = build(11).events.filter((e) => e.agent === 'kid'); assert.equal(quiet[quiet.length - 1].kind, 'finish');   // a report followed by more work would revive it on the page: the finish comes last
});

test('codex board: a lead whose turn ended while its worker still writes is waiting on it, and the worker counts as active for 10 minutes', () => {
  const pad = (n) => String(n).padStart(2, '0'), d = new Date(), dir = path.join(tmp, 'codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())); fs.mkdirSync(dir, { recursive: true });
  const LEAD = '01a12cbd-0000-7000-8000-00000000000a', KID = '01a12fd3-0000-7000-8000-00000000000b', now = Date.now(), r = (o) => JSON.stringify(o) + '\n', iso = (t) => new Date(t).toISOString();
  const lead = path.join(dir, `rollout-x-${LEAD}.jsonl`), kid = path.join(dir, `rollout-y-${KID}.jsonl`);
  fs.writeFileSync(lead, r({ timestamp: iso(now - 9 * min), type: 'session_meta', payload: { id: LEAD, timestamp: iso(now - 9 * min), cwd: '/home/user', originator: 'codex-tui' } }) + r({ timestamp: iso(now - 9 * min), type: 'event_msg', payload: { type: 'task_started' } }) + r({ timestamp: iso(now - 6 * min), type: 'event_msg', payload: { type: 'task_complete' } }));
  fs.writeFileSync(kid, r({ timestamp: iso(now - 8 * min), type: 'session_meta', payload: { id: KID, timestamp: iso(now - 8 * min), cwd: '/home/user', originator: 'codex-tui', parent_thread_id: LEAD, thread_source: 'subagent', agent_path: '/root/figure_route' } }) + r({ timestamp: iso(now - 8 * min), type: 'event_msg', payload: { type: 'task_started' } }));
  fs.utimesSync(lead, (now - 6 * min) / 1000, (now - 6 * min) / 1000); fs.utimesSync(kid, (now - 3 * min) / 1000, (now - 3 * min) / 1000);   // the worker last wrote 3 minutes ago (a render)
  const row = require('../adapters/codex.js').board(now).find((x) => x.id === LEAD); assert.ok(row);
  assert.deepEqual([row.state, row.subActive, row.active], ['waiting', 1, ['figure route']]);
});
