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
