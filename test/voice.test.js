// test/voice.test.js: the voice at eleven_v4_turbo latency (about 1 s a line, flash was 0.25 s), with the network mocked. Time is scaled: 100 ms stands for 1 s.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-voice-'));
fs.writeFileSync(path.join(tmp, '.env'), 'ELEVENLABS_API_KEY=test-key\n');
fs.writeFileSync(path.join(tmp, 'config.yaml'), 'tts:\n  provider: elevenlabs\n  elevenlabs:\n    voice_id: pNInz6obpgDQGcFmaJgB\n    model_id: eleven_v4_turbo\n');
Object.assign(process.env, { HERMES_HOME: tmp, AGENT_STANDUP_PREFS: path.join(tmp, 'prefs.json'), AGENT_STANDUP_PROJECTS: path.join(tmp, 'projects'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), AGENT_STANDUP_HERMES: path.join(tmp, 'hermes'), AGENT_STANDUP_ELEVEN_RETRY_MS: '10' });
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VOICE = 'pNInz6obpgDQGcFmaJgB';

// the page's own queue
const m = /async function speakQueue\(lines, io\) \{[\s\S]*?\n\}/.exec(html); if (!m) throw new Error('speakQueue not found in index.html');
const speakQueue = new Function(m[0] + '\nreturn speakQueue;')();

test('queue: every line is made as soon as it is picked, so line two starts when line one ends (v4 latency mocked)', async () => {
  const t0 = Date.now(), SYNTH = 100, PLAY = 150, started = [], ended = [];
  const mk = (name) => ({ name, ready: sleep(SYNTH) });   // both are picked together: synthesis runs in parallel, from the moment of the pick
  const lines = [mk('A'), mk('B')];
  await speakQueue(lines, { synthMs: SYNTH, fresh: () => true, say: async (ln) => { started.push([ln.name, Date.now() - t0]); await sleep(PLAY); ended.push([ln.name, Date.now() - t0]); } });
  const total = Date.now() - t0, gap = started[1][1] - ended[0][1];
  assert.ok(started[0][1] >= SYNTH - 15, 'the first line waits for its audio: ' + started[0][1]);
  assert.ok(gap < 40, 'the second line is ready when the first ends, gap ' + gap + ' ms');   // sequential synthesis would leave a gap of one synthesis (100 ms here)
  assert.ok(total < SYNTH + 2 * PLAY + 60, 'total ' + total + ' ms');
});

test('queue: a line that would go stale while being made is not made; one that went stale during synthesis is not said', async () => {
  const said = [], stale = new Set(), made = [];
  const lines = [{ name: 'early', ready: sleep(10).then(() => made.push('early')) }, { name: 'late', ready: sleep(30).then(() => { made.push('late'); stale.add('late'); }) }, { name: 'ok', ready: null }];
  await speakQueue(lines, { synthMs: 100, fresh: (ln, ahead) => !stale.has(ln.name) && !(ln.name === 'early' && ahead > 0), say: async (ln) => { said.push(ln.name); } });
  assert.deepEqual(said, ['ok']);   // early: stale before it could be heard (its window is shorter than the synthesis); late: stale by the time its audio existed
  assert.ok(made.includes('late'));
});

// the server's ElevenLabs path
function mockFetch(handler) {
  const real = global.fetch, calls = [], busy = { now: 0, max: 0 };
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: VOICE, name: 'Adam', category: 'premade' }] }), { status: 200 });
    const body = JSON.parse(init.body); calls.push({ url: u, body }); busy.now++; busy.max = Math.max(busy.max, busy.now);
    try { await sleep(100); return handler(calls.length, body); } finally { busy.now--; }   // v4: about 1 s, scaled
  };
  return { calls, busy, restore: () => { global.fetch = real; } };
}
const ok = () => new Response(Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]), { status: 200 });
const srv = require('../server.js');

test('server: the model comes from the Hermes config, the request carries the text and the model and nothing expressive, a 429 is retried once', async () => {
  const net = mockFetch((n) => (n === 1 ? new Response('{"detail":{"status":"too_many_concurrent_requests"}}', { status: 429 }) : ok()));
  try {
    const text = 'The gate passed. Nothing else changed ' + Date.now(), t0 = Date.now();
    const file = await srv.tts(text, VOICE, 180, 'elevenlabs');
    assert.match(file, /\.mp3$/); assert.equal(net.calls.length, 2);
    assert.deepEqual(Object.keys(net.calls[1].body).sort(), ['model_id', 'text']);   // no voice_settings, no style, no tags
    assert.equal(net.calls[1].body.model_id, 'eleven_v4_turbo'); assert.equal(net.calls[1].body.text, text); assert.ok(!/\[[a-z ]+\]/i.test(net.calls[1].body.text));
    assert.ok(Date.now() - t0 >= 200, 'two requests of v4 latency');
    const again = Date.now(); assert.equal(await srv.tts(text, VOICE, 250, 'elevenlabs'), file); assert.ok(Date.now() - again < 50, 'a line is paid for once, at any pace');
  } finally { net.restore(); }
});

test('server: still refused after the retry, the line goes to the system voice (or fails cleanly where there is none); never a third request', async () => {
  const net = mockFetch(() => new Response('{"detail":"limit"}', { status: 429 })), before = srv.elevenStats.fallbacks;
  try {
    const r = await srv.tts('Another line that cannot be made ' + Date.now(), VOICE, 180, 'elevenlabs').then((f) => ({ f }), (e) => ({ e: String(e.message) }));
    assert.equal(net.calls.length, 2, 'one try and one retry');
    assert.equal(srv.elevenStats.fallbacks, before + 1);
    assert.ok(r.f ? /\.(wav|mp3)$/.test(r.f) : /elevenlabs 429/.test(r.e), JSON.stringify(r));
  } finally { net.restore(); }
});

test('server: at most two requests are in flight, the rest wait for a slot', async () => {
  const net = mockFetch(() => ok());
  try {
    const stamp = Date.now(); await Promise.all([1, 2, 3, 4, 5].map((i) => srv.tts(`Concurrency line ${i} ${stamp}`, VOICE, 180, 'elevenlabs')));
    assert.equal(net.calls.length, 5); assert.ok(net.busy.max <= 2, 'in flight ' + net.busy.max);
  } finally { net.restore(); }
});

test.after(() => srv.shutdown());
