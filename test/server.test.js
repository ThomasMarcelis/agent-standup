// test/server.test.js: the settings file, session stickiness, the cross-site guard and the pictures of a session, against a real server on a free port
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-test-'));
process.env.AGENT_STANDUP_PREFS = path.join(tmp, 'prefs.json'); process.env.AGENT_STANDUP_KOKORO_DIR = path.join(tmp, 'kokoro'); process.env.AGENT_STANDUP_PROJECTS = path.join(tmp, 'projects');
const get = (port, p, headers = {}, method = 'GET', body) => new Promise((res, rej) => { const r = http.request({ port, path: p, method, headers }, (x) => { let b = '', n = 0; x.on('data', (d) => { b += d; n += d.length; }); x.on('end', () => res({ status: x.statusCode, body: b, type: x.headers['content-type'], bytes: n })); }); r.on('error', rej); if (body) r.write(body); r.end(); });
test('settings are kept in a file; cross-site writes are refused', async () => {
  const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port;
  try {
    assert.match((await get(port, '/api/prefs.js')).body, /SAVED_PREFS = null/);
    assert.equal((await get(port, '/api/prefs', { 'content-type': 'application/json' }, 'PUT', '{"lang":"fr","_t":5}')).status, 200);
    assert.match((await get(port, '/api/prefs.js')).body, /"lang":"fr"/);
    assert.equal((await get(port, '/api/prefs', { 'sec-fetch-site': 'cross-site' }, 'PUT', '{}')).status, 403);
    assert.equal((await get(port, '/api/prefs', {}, 'PUT', '[1]')).status, 400);
    assert.equal(JSON.parse((await get(port, '/api/kokoro')).body).installed, false);
    assert.equal((await get(port, '/api/kokoro/install', { 'sec-fetch-site': 'cross-site' }, 'POST')).status, 403);
    const owner = async (q, m) => JSON.parse((await get(port, '/api/audio?' + q, {}, m)).body).owner;   // one window has the sound; a closing one gives it back at once
    assert.equal(await owner('cid=win-a&claim=1'), 'win-a'); assert.equal(await owner('cid=win-b&release=1', 'POST'), 'win-a', 'only the owner can give it back');
    assert.equal(await owner('cid=win-a&release=1', 'POST'), null); assert.equal(await owner('cid=win-c'), null);
  } finally { srv.close(); require('../server.js').shutdown(); }
});
test('pictures returned by tools are counted in the timeline and served from the transcript only', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', pic = (type, data) => ({ type: 'image', source: { type: 'base64', media_type: type, data } });
  const rec = (id, content) => [{ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x/shot.png' } }] } }, { type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const dir = path.join(tmp, 'projects', '-p'); fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), rec('toolu_pic', [pic('image/png', png), pic('image/svg+xml', 'PHN2Zy8+')])); fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a1.jsonl'), rec('toolu_sub', [pic('image/png', png)]));
  const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); const port = srv.address().port, media = (q) => get(port, '/api/media?proj=-p&id=s1&' + q);
  try {
    const items = JSON.parse((await get(port, '/api/session?proj=-p&id=s1')).body).events.filter((e) => e.kind === 'results').flatMap((e) => e.items);
    assert.deepEqual(items.map((it) => [it.id, it.img]).sort(), [['toolu_pic', 1], ['toolu_sub', 1]]);   // the SVG is not a picture we show
    const ok = await media('agent=main&tool=toolu_pic&n=0'); assert.equal(ok.status, 200); assert.equal(ok.type, 'image/png'); assert.equal(ok.bytes, Buffer.from(png, 'base64').length);
    assert.equal((await media('agent=a1&tool=toolu_sub&n=0')).status, 200);
    assert.equal((await media('agent=main&tool=toolu_pic&n=1')).status, 404);
    assert.equal((await media('agent=main&tool=toolu_sub&n=0')).status, 404);
    assert.equal((await media('agent=..&tool=toolu_pic&n=0')).status, 400);
    assert.equal((await get(port, '/api/media?proj=..&id=s1&agent=main&tool=toolu_pic&n=0')).status, 400);
    assert.equal((await get(port, '/api/media?proj=-p&id=s1&agent=main&tool=toolu_pic&n=0', { 'sec-fetch-site': 'cross-site' })).status, 403);
  } finally { srv.close(); require('../server.js').shutdown(); }
});

test('ElevenLabs needs no setup: started as agent-standup from any folder, with HERMES_HOME unset, the key is found in the gaming profile or in ~/.hermes', async () => {
  const { spawn } = require('child_process'), os = require('os'), path = require('path'), fs = require('fs');
  const run = (home) => new Promise((done, fail) => {
    const env = { ...process.env, HOME: home, PORT: '0', AGENT_STANDUP_PREFS: path.join(home, 'prefs.json'), AGENT_STANDUP_PROJECTS: path.join(home, 'none'), AGENT_STANDUP_HERMES: path.join(home, 'none'), CODEX_HOME: path.join(home, 'none') }; delete env.HERMES_HOME;
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: os.tmpdir(), env }); let out = '';
    const t = setTimeout(() => { p.kill(); fail(new Error('no start: ' + out)); }, 8000);
    p.stdout.on('data', async (d) => { out += d; const m = /localhost:(\d+)/.exec(out); if (!m) return; clearTimeout(t);
      try { const js = (await get(+m[1], '/api/prefs.js')).body, v = JSON.parse((await get(+m[1], '/api/voices?engine=elevenlabs')).body); done({ key: /SERVER_VOICES = \{"elevenlabs":true\}/.test(js), error: v.error || '' }); } catch (e) { fail(e); } finally { p.kill(); } });
  });
  const home = (files) => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-home-')); for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(h, f)), { recursive: true }); fs.writeFileSync(path.join(h, f), body); } return h; };
  assert.equal((await run(home({ '.hermes/profiles/gaming/.env': 'ELEVENLABS_API_KEY=sk_test_gaming\n' }))).key, true, 'the gaming profile');
  assert.equal((await run(home({ '.hermes/.env': 'export ELEVENLABS_API_KEY="sk_test_default"\n' }))).key, true, 'the default ~/.hermes');
  const none = await run(home({ '.hermes/.env': 'OTHER=1\n' }));
  assert.equal(none.key, false); assert.match(none.error, /no ELEVENLABS_API_KEY in .*profiles\/gaming\/\.env or .*\.hermes\/\.env/, 'without a key it says where it looked');
});

test("a call is the project's: a Claude lead, a Codex thread and a Hermes session of one project are one call, each under its own lead; guests are other projects only", () => {
  const { mergeCall, callMates } = require('../server.js'), G = { key: '/w/gladiator-game', name: 'gladiator-game' };
  const claude = { proj: '-w-gladiator-game', id: 'c1', tl: { id: 'c1', title: 'Combat simulation realism gaps', group: G, agents: [{ id: 'main', name: 'Claude', role: 'Lead', type: 'main', model: 'claude-opus-5-5' }, { id: 'a1', name: 'wounds', type: 'subagent' },
    { id: 'p_hermes_h1', name: 'hermes:gaming:h1', type: 'peer', link: { proj: '_hermes-gaming', id: 'h1' } }, { id: 'p_claude_x', name: 'marketsimulator-3e', type: 'peer', link: { proj: '-w-MarketSimulator', id: 'x' }, group: { key: '/w/MarketSimulator' } },
    { id: 'p_old', name: 'gladiator-game-c3', type: 'peer', link: { proj: '-w-gladiator-game', id: 'old' }, group: G }],
    events: [{ ts: 10, agent: 'main', kind: 'msg', to: 'p_hermes_h1', msgId: 'm1', text: 'The armour numbers are in.' }, { ts: 30, agent: 'p_claude_x', kind: 'msg', to: 'main', msgId: 'm2', text: 'From another project.' }] } };
  const codex = { proj: '_codex', id: '01a12cbd-82fd-7253-9633-522e7ef9434f', tl: { title: 'Reorient', group: G, agents: [{ id: 'main', name: 'Codex', role: 'Lead', type: 'main', model: 'gpt-6-astra' }, { id: 'w1', name: 'buckler writer', type: 'worker' }, { id: 'p_claude_c1', name: 'gladiator-c1', type: 'peer', link: { proj: '-w-gladiator-game', id: 'c1' } }],
    events: [{ ts: 15, agent: 'main', kind: 'order', to: 'w1', title: 'buckler_writer' }, { ts: 20, agent: 'w1', kind: 'tools', tools: [{ name: 'exec_command', arg: 'python3 make.py' }] }, { ts: 25, agent: 'main', kind: 'msg', to: 'p_claude_c1', msgId: 'm3', text: 'Buckler done.' }] } };
  const hermes = { proj: '_hermes-gaming', id: 'h1', tl: { title: 'Plan gladiator roguelike autobattler', group: G, agents: [{ id: 'main', name: 'Hermes', role: 'Lead', type: 'main' }, { id: 'p_claude_c1', name: 'gladiator-c1', type: 'peer', link: { proj: '-w-gladiator-game', id: 'c1' } }],
    events: [{ ts: 11, agent: 'p_claude_c1', kind: 'msg', to: 'main', msgId: 'm1', text: 'The armour numbers are in.' }] } };
  const tl = mergeCall(claude, [codex, hermes]), X = 'sf9434f__', H = 'sh1__';
  assert.deepEqual(tl.agents.map((a) => [a.id, a.lead || false, (a.team || {}).source || '']), [['main', false, 'claude'], ['a1', false, 'claude'], ['p_claude_x', false, ''], ['p_old', false, ''], [X + 'main', true, 'codex'], [X + 'w1', false, 'codex'], [H + 'main', true, 'hermes']], 'every session under its own lead; the other project stays a guest');
  assert.deepEqual(tl.agents.filter((a) => a.type === 'peer').map((a) => [a.id, !!a.kin]), [['p_claude_x', false], ['p_old', true]], 'a past session of this project is kin, never a guest');
  assert.deepEqual(mergeCall(codex, [{ ...claude, tl: { ...claude.tl, agents: [{ id: 'main', role: 'Lead', type: 'main' }] } }]).agents.find((a) => a.lead).name, 'Claude', 'a lead with no name of its own is named by its harness');
  const withTom = mergeCall(codex, [{ ...hermes, tl: { ...hermes.tl, events: [{ ts: 12, agent: 'user', kind: 'user', text: 'Please fix the release.' }, { ts: 13, agent: 'main', kind: 'msg', to: 'user', text: 'On it.' }] } }]);
  assert.deepEqual(withTom.events.filter((e) => e.sess === 'h1').map((e) => [e.agent, e.to || '']), [['user', ''], ['sh1__main', 'user']], "Tom is one person in every session of the call (Astra P1: a prefixed user had no persona)");
  assert.ok(!tl.agents.some((a) => a.id === 'p_hermes_h1' || a.id === 'p_claude_c1'), 'a session of the call is not a guest of it');
  const msgs = tl.events.filter((e) => e.kind === 'msg').map((e) => [e.msgId, e.agent, e.to]);
  assert.deepEqual(msgs, [['m1', 'main', H + 'main'], [ 'm3', X + 'main', 'main'], ['m2', 'p_claude_x', 'main']], 'one message from two logs is kept once, between the leads; in time order');
  assert.deepEqual(tl.events.filter((e) => e.kind === 'order').map((e) => [e.agent, e.to]), [[X + 'main', X + 'w1']]);
  assert.ok(tl.events.every((e) => typeof e.sess === 'string' && Number.isInteger(e.si)), 'every event knows its session and its place in it');
  assert.deepEqual(tl.members.map((m) => [m.id, m.lead, m.n]), [['c1', 'main', 2], [codex.id, X + 'main', 3], ['h1', H + 'main', 1]]);
  const now = Date.now(), row = (proj, id, state, ago, extra = {}) => ({ proj, id, state, mtime: now - ago * 60e3, group: G, ...extra });
  const rows = [row('-w-gladiator-game', 'c1', 'working', 0), row('_codex', codex.id, 'turn', 3), row('_hermes-gaming', 'h1', 'waiting', 30), row('-w-gladiator-game', 'old', 'idle', 45), row('-w-gladiator-game', 'gone', 'idle', 2, { stopped: true }),
    row('_hermes-gaming', 'cron', 'done', 1, { oneshot: true }), { ...row('-w-MarketSimulator', 'x', 'working', 0), group: { key: '/w/MarketSimulator', name: 'MarketSimulator' } }];
  assert.deepEqual(callMates('-w-gladiator-game', 'c1', G, rows, now).map((r) => r.id), [codex.id, 'h1'], 'live sessions of the same project (working, or written in the last 10 min); not stopped, not a finished one-shot, not another project');
});

test('a project call does not silently omit workers after six live sessions', () => {
  const { callMates } = require('../server.js'), now = Date.now(), group = { key: '/w/game', name: 'game' };
  const rows = Array.from({ length: 9 }, (_, i) => ({ proj: '_codex', id: 'worker-' + i, state: 'working', mtime: now - i * 1000, group }));
  const mates = callMates('_codex', 'worker-0', group, rows, now);
  assert.equal(mates.length, 8);
  assert.equal(new Set(mates.map(r => r.id)).size, 8);
});

test('everything: the feed has the newest events of the other live projects (not the one on screen, never a one-shot), named and cheap', () => {
  const { feed } = require('../server.js'), now = Date.now(), gg = { key: '/w/gladiator-game', name: 'gladiator-game' }, ms = { key: '/w/MarketSimulator', name: 'MarketSimulator' };
  const tls = { 'ms-claude': { title: 'Review the news gate', agents: [{ id: 'main', name: 'Claude', type: 'main' }, { id: 'a1', name: 'news polish', role: 'general-purpose', type: 'subagent' }],
      events: [{ ts: now - 400000, agent: 'main', kind: 'say', text: 'Old.' }, { ts: now - 9000, agent: 'a1', kind: 'tools', tools: [{ name: 'Bash', arg: 'pytest tests/news', d: { kind: 'cmd', text: 'pytest', note: 'news gate' } }] }, { ts: now - 8000, agent: 'a1', kind: 'results', items: [{ out: 'collected 9\n9 passed in 2.1s' }, { out: 'no tests here' }] }, { ts: now - 5000, agent: 'main', kind: 'usage', u: {} }, { ts: now - 4000, agent: 'main', kind: 'say', text: 'The gate passes.' }] },
    'glad-claude': { title: 'Combat', agents: [{ id: 'main', name: 'Claude', type: 'main' }], events: [{ ts: now - 3000, agent: 'main', kind: 'say', text: 'On screen already.' }] },
    'glad-cron': { title: 'Gladiator: 30-min progress report', agents: [{ id: 'main', name: 'Hermes', type: 'main' }], events: [{ ts: now - 2000, agent: 'main', kind: 'say', text: 'Progress report.' }] } };
  const row = (id, group, x = {}) => ({ proj: '-w-' + id, id, group, state: 'working', mtime: now - 3000, ...x });
  const rows = [row('ms-claude', ms), row('glad-claude', gg), row('glad-cron', gg, { oneshot: true }), row('ms-old', ms, { mtime: now - 900000 })];
  const f = feed('/w/gladiator-game', rows, now, (proj, id) => ({ tl: tls[id] }));
  assert.deepEqual(f.map((p) => p.name), ['MarketSimulator'], 'the call on screen and the one-shot are not in it; a session quiet for 15 min neither');
  const p = f[0], A = 'sclaude__';
  assert.deepEqual(p.events.map((e) => [e.kind, e.agent]), [['tools', A + 'a1'], ['results', A + 'a1'], ['say', A + 'main']], 'speakable kinds within 2 min, every agent with its session in front');
  assert.deepEqual(p.events[1].items, [{ out: 'collected 9\n9 passed in 2.1s' }], 'a result only when it holds a test summary');
  assert.deepEqual(p.agents[A + 'main'], { name: 'Claude', role: '', type: 'main', lead: true, task: 'Review the news gate' });
  assert.deepEqual(rows.filter((r) => true) && require('../server.js').callMates('-w-glad-claude', 'glad-claude', gg, rows, now).map((r) => r.id), [], 'a one-shot run never joins a call');
});
