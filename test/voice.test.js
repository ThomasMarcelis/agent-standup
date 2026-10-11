// test/voice.test.js: the voice at eleven_v4_turbo latency (about 1 s a line, flash was 0.25 s; Luna about 3.5 s a batch), with the network mocked. Time is scaled: 100 ms stands for 1 s.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-voice-'));
fs.writeFileSync(path.join(tmp, '.env'), 'ELEVENLABS_API_KEY=test-key\n');
fs.writeFileSync(path.join(tmp, 'config.yaml'), 'tts:\n  provider: elevenlabs\n  elevenlabs:\n    voice_id: pNInz6obpgDQGcFmaJgB\n    model_id: eleven_v4_turbo\n');
Object.assign(process.env, { TMPDIR: tmp, HERMES_HOME: tmp, AGENT_STANDUP_PREFS: path.join(tmp, 'prefs.json'), AGENT_STANDUP_PROJECTS: path.join(tmp, 'projects'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), AGENT_STANDUP_HERMES: path.join(tmp, 'hermes'), AGENT_STANDUP_ELEVEN_RETRY_MS: '10' });   // TMPDIR: the test's audio stays out of the real cache
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = (re) => { const m = re.exec(html); if (!m) throw new Error('not found in index.html: ' + re); return m[0]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), idle = (ms) => new Promise((r) => setTimeout(r, ms).unref());   // idle: the page's own waits (a 20 s triage limit) do not hold the test process
const VOICE = 'pNInz6obpgDQGcFmaJgB';

// ---- the page's own queue
const speakQueue = new Function(grab(/async function speakQueue\(lines, io\) \{[\s\S]*?\n\}/) + '\nreturn speakQueue;')();

test('queue: lines made together at the pick play back to back (v4 latency mocked)', async () => {
  const t0 = Date.now(), SYNTH = 100, PLAY = 150, started = [], ended = [];
  const mk = (name) => ({ name, at: Date.now(), ready: sleep(SYNTH) });   // both are picked together: synthesis runs in parallel, from the moment of the pick
  const lines = [mk('A'), mk('B')];
  await speakQueue(lines, { synthMs: SYNTH, fresh: () => true, say: async (ln) => { started.push([ln.name, Date.now() - t0]); await sleep(PLAY); ended.push([ln.name, Date.now() - t0]); } });
  const total = Date.now() - t0, gap = started[1][1] - ended[0][1];
  assert.ok(started[0][1] >= SYNTH - 15, 'the first line waits for its audio: ' + started[0][1]);
  assert.ok(gap < 40, 'the second line is ready when the first ends, gap ' + gap + ' ms');   // sequential synthesis would leave a gap of one synthesis (100 ms here)
  assert.ok(total < SYNTH + 2 * PLAY + 60, 'total ' + total + ' ms');
});

test('queue: the look-ahead is only the synthesis still to come; stale before it is done or once it is done, a line is not said', async () => {
  const said = [], stale = new Set(), now = Date.now();
  const lines = [
    { name: 'early', at: now, ready: sleep(10) },   // its window ends before its audio can exist
    { name: 'late', at: now, ready: sleep(30).then(() => stale.add('late')) },   // fresh when asked, stale once made
    { name: 'made', at: now - 5000, made: true, ready: Promise.resolve() },   // already made, in the last moment of its window: still said
    { name: 'ok', ready: null },
  ];
  await speakQueue(lines, { synthMs: 100, fresh: (ln, ahead) => !stale.has(ln.name) && !(ahead > 0 && (ln.name === 'early' || ln.name === 'made')), say: async (ln) => { said.push(ln.name); } });
  assert.deepEqual(said, ['made', 'ok']);
});

// ---- the page's director: its triage policy, decide, warmLines, speakQueue, directorStep and speakLine, with the network, the audio and the clock of a call mocked
function director({ triageMs, synthMs, playMs, refuse = () => false }) {
  const src = [grab(/const TRIAGE_WAIT = [\s\S]*?\/\/ ---- end triage policy/), grab(/const soundHeld = [^\n]*/), grab(/const elevenWhy = [^\n]*/), grab(/async function speakLine\([\s\S]*?\n\}/), grab(/const unsaidTag = [^\n]*/), grab(/function markUnsaid\(evs, why\) \{[\s\S]*?\n\}/), grab(/const D = \{ done[\s\S]*?\n(?=\(async \(\) => \{ for \(;;\))/)].join('\n');
  const t0 = Date.now(), at = () => Date.now() - t0, log = { asked: [], start: {}, end: {}, said: [], live: 0, most: 0, browser: 0, downs: [] }, memo = new Map();
  const S = { live: true, locked: false, playing: true, hurry: false, cur: { proj: 'p', id: 's' }, token: 1, needs: [], events: [], group: null, title: 'a call', agents: { main: { id: 'main', vi: 0 }, a: { id: 'a', vi: 4 } } };
  const TTS = { engine: 'elevenlabs', server: true, down: '', setDown(why) { this.down = why || ''; log.downs.push(this.down); }, voiceFor: () => VOICE, rate: () => 180,
    buf(text) { if (!memo.has(text)) { log.asked.push([text, at()]); const pr = sleep(synthMs).then(() => { if (refuse(text)) throw new Error('elevenlabs 429 too_many_concurrent_requests'); return { duration: playMs / 1000 }; }); pr.catch(() => {}); memo.set(text, pr); } return memo.get(text); } };
  const triage = async (url, init) => { const { items } = JSON.parse(init.body); await sleep(triageMs); return { json: async () => ({ say: items.map((it) => ({ line: it.text, ids: [it.id] })), drop: [] }) }; };   // Luna: one line per item
  const speakServer = async (text, p, gain, token, fr, still) => {   // the audio of the line (a cache hit when it was made at the pick), played to the end
    await TTS.buf(text); if (token !== S.token || (still && !still())) return;
    log.live++; log.most = Math.max(log.most, log.live); log.start[text] = at(); log.said.push(text); await sleep(playMs); log.end[text] = at(); log.live--; return true;
  };
  const env = { S, TTS, fetch: triage, speakServer, speakBrowser: async () => { log.browser++; return true; }, AUD: { off: () => false, ctx: { state: 'running' }, murmur() {} }, prefs: { voice: true, vstyle: 'elevenlabs' }, sleep: idle,
    speechOf: (ev) => ev.text, speakable: (t) => t, clipSpeech: (t) => t, teamOf: () => ({}), niceProj: () => '', startTalk() {}, stopTalk() {}, captionRun() {}, estMs: () => 10, speakBabble: async () => {}, synth: {}, EMBED: false, FR: () => false, L: (fr, en) => en, esc: (t) => t, $: () => null };
  const api = new Function(...Object.keys(env), src + '\nreturn { directorStep, speakLine, elevenWhy, freshIn, SYNTH_MS, KEEP_MS };')(...Object.values(env));
  api.SYNTH_MS.elevenlabs = synthMs * 1.2;   // the page's estimate, scaled like the latency
  return { S, TTS, AUD: env.AUD, log, at, ...api };
}
const loop = (d, tick) => { let stop = false; (async () => { while (!stop) { await sleep(tick); d.directorStep().catch(() => {}); } })(); return () => { stop = true; }; };

test('director: synthesis starts at the pick, the next batch is decided and made while a line plays, no gap, no overlap, nothing stale (v4 latency mocked)', async () => {
  const TRIAGE = 300, SYNTH = 100, PLAY = 600, TICK = 30;   // Luna 3 s, v4 1 s, a 6 s line, the page's 300 ms loop
  const d = director({ triageMs: TRIAGE, synthMs: SYNTH, playMs: PLAY }), ev = (agent, text, ago = 0) => ({ ts: Date.now() - ago, agent, kind: 'msg', text });
  d.S.events.push(ev('a', 'Old news.', d.KEEP_MS - 380), ev('a', 'First news.'));   // the old one leaves its window (45 s) 380 ms from now: before the pick plus its synthesis
  setTimeout(() => d.S.events.push(ev('a', 'Third news.'), ev('main', 'Fourth news.')), 450);   // arrives while the first line plays
  const stop = loop(d, TICK);
  for (let i = 0; i < 120 && d.log.said.length < 3; i++) await sleep(25);
  await sleep(PLAY + 100); stop();
  const { asked, start, end, said, most } = d.log, askedAt = Object.fromEntries(asked);
  assert.deepEqual(said, ['First news.', 'Third news.', 'Fourth news.'], 'what was said');
  assert.ok(!('Old news.' in askedAt), 'a line that would be stale before it is made is not made (nor paid for)');
  assert.ok(askedAt['First news.'] <= TICK + TRIAGE + 40, 'made at the pick: asked at ' + askedAt['First news.'] + ' ms');
  assert.ok(askedAt['Third news.'] < end['First news.'] && askedAt['Fourth news.'] < end['First news.'], 'the next batch is made while the first line plays');
  assert.ok(start['Third news.'] - end['First news.'] <= TICK + 40, 'no triage or synthesis between batches: gap ' + (start['Third news.'] - end['First news.']) + ' ms');   // the old loop waited for the queue to end: a triage and a synthesis (400 ms here)
  assert.ok(start['Fourth news.'] - end['Third news.'] < 40, 'no synthesis between lines of a batch: gap ' + (start['Fourth news.'] - end['Third news.']) + ' ms');
  assert.equal(most, 1, 'one voice at a time');
});

test('director: ElevenLabs refuses a line (429 after its retry): the line is skipped and marked, never said in another voice; the next line is said', async () => {
  const d = director({ triageMs: 50, synthMs: 20, playMs: 100, refuse: (t) => /Refused/.test(t) }), ev = (text) => ({ ts: Date.now(), agent: 'a', kind: 'msg', text });
  const refused = ev('Refused news.'), fine = ev('Fine news.'); d.S.events.push(refused, fine);
  const stop = loop(d, 20);
  for (let i = 0; i < 60 && !d.log.said.length; i++) await sleep(10);
  await sleep(150); stop();
  assert.deepEqual(d.log.said, ['Fine news.']); assert.equal(d.log.browser, 0, 'no system voice');
  assert.equal(refused.unsaid, 'busy (429)', 'the transcript says why'); assert.ok(!fine.unsaid);
  assert.ok(d.log.downs.includes('line skipped, busy (429)'), 'the voice button says so: ' + JSON.stringify(d.log.downs)); assert.equal(d.TTS.down, '', 'and clears once a line is heard');
});

test('speakLine: with ElevenLabs chosen and unavailable (no key), nothing is said in another voice; the reasons read as words', async () => {
  const d = director({ triageMs: 10, synthMs: 10, playMs: 10 }); d.TTS.server = false; d.TTS.down = 'unavailable, no key';
  assert.deepEqual(await d.speakLine('Hello.', d.S.agents.a, true, d.S.token), { skipped: 'unavailable, no key' }); assert.equal(d.log.browser, 0);
  const why = d.elevenWhy, timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  assert.deepEqual(['elevenlabs no key', 'elevenlabs 401 quota_exceeded', 'elevenlabs 401', 'elevenlabs 429 too_many_concurrent_requests', 'elevenlabs timeout', timeout, 'elevenlabs fetch failed'].map(why), ['no key', 'quota', 'error 401', 'busy (429)', 'timeout', 'timeout', 'error']);
});

test('director: while the browser holds the sound back (no click yet), nothing is queued or made; once it plays, only what is new is said', async () => {
  const d = director({ triageMs: 30, synthMs: 20, playMs: 50 }), ev = (text) => ({ ts: Date.now(), agent: 'a', kind: 'msg', text });
  d.AUD.ctx.state = 'suspended'; d.S.events.push(ev('Said while nobody could hear.'));
  const stop = loop(d, 20); await sleep(200);
  assert.deepEqual(d.log.asked, [], 'no triage, no synthesis while held');
  d.AUD.ctx.state = 'running'; d.S.events.push(ev('After the click.'));   // the first click anywhere
  for (let i = 0; i < 60 && !d.log.said.length; i++) await sleep(10);
  await sleep(120); stop();
  assert.deepEqual(d.log.said, ['After the click.'], 'no backlog');
});

test('director: a switch waiting for the voice lets the line finish and starts no other', async () => {
  const d = director({ triageMs: 50, synthMs: 20, playMs: 200 }), ev = (text) => ({ ts: Date.now(), agent: 'a', kind: 'msg', text });
  d.S.events.push(ev('One.'), ev('Two.'));
  const stop = loop(d, 20);
  for (let i = 0; i < 60 && !d.log.said.length; i++) await sleep(10);
  d.S.token++;   // what loadSession(…, gentle) does before it waits for the speakers
  await sleep(500); stop();
  assert.deepEqual(d.log.said, ['One.']); assert.ok(d.log.end['One.'], 'the line being said was finished');
});

test('a merged line is fresh only while every item in it is; a follow switch waits for the voice itself, not only the speaking flag', () => {
  const d = director({ triageMs: 10, synthMs: 10, playMs: 10 }), now = Date.now(), item = (ago) => ({ kind: 'message', ev: { ts: now - ago } });
  assert.equal(d.freshIn({ items: [item(45500), item(2500)] }, 0), false, 'one item out of its 45 s window: the whole sentence is stale');
  assert.equal(d.freshIn({ items: [item(30000), item(2500)] }, 0), true);
  const S = { speakers: new Set() }, AUD = { live: new Set() }, voiceBusy = new Function('S', 'AUD', 'synth', grab(/const voiceBusy = [^\n]*/) + '\nreturn voiceBusy;')(S, AUD, { speaking: false });
  assert.equal(voiceBusy(), false); AUD.live.add({}); assert.equal(voiceBusy(), true, 'audio still sounding after a silent beat cleared the speaking flag');
});

// ---- the page's TTS cache: a line that could not be made is not waited for twice
test('TTS.buf: a failed line fails at once on the next ask, with its reason (no second request, no second wait)', async () => {
  let calls = 0; const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  const TTS = new Function('fetch', 'AUD', '$', 'setTimeout', grab(/const TTS_WAIT = [^\n]*/) + '\n' + grab(/const TTS = \{[\s\S]*?\n\};/) + '\nreturn TTS;')(async () => { calls++; await sleep(30); return { ok: true, status: 204, headers: { get: () => 'elevenlabs 429 limit' } }; }, { ctx: { decodeAudioData: async (b) => b } }, () => null, later);
  TTS.engine = 'elevenlabs';
  await assert.rejects(TTS.buf('A line.', VOICE, 180), /elevenlabs 429 limit/);
  const t = Date.now(); await assert.rejects(TTS.buf('A line.', VOICE, 200));
  assert.equal(calls, 1); assert.ok(Date.now() - t < 15, 'failed at once');
});

// ---- the server's ElevenLabs path
function mockFetch(handler) {
  const real = global.fetch, calls = [], busy = { now: 0, max: 0 };
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return real(url, init);   // the test's own requests to the server
    if (u.endsWith('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: VOICE, name: 'Adam', category: 'premade' }] }), { status: 200 });
    const body = JSON.parse(init.body); calls.push({ url: u, body }); busy.now++; busy.max = Math.max(busy.max, busy.now);
    try { await sleep(100); return await handler(calls.length, body, init); } finally { busy.now--; }   // v4: about 1 s, scaled
  };
  return { calls, busy, restore: () => { global.fetch = real; } };
}
const ok = () => new Response(Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]), { status: 200 });
const ttsDir = path.join(tmp, 'agent-standup-tts-' + process.getuid()); fs.mkdirSync(ttsDir, { recursive: true });
fs.writeFileSync(path.join(ttsDir, 'old-stand-in.mp3'), Buffer.from('RIFF\0\0\0\0WAVEfmt ')); fs.writeFileSync(path.join(ttsDir, 'real.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0]));   // what an older version left behind
const srv = require('../server.js');
test('server: at start, a system voice an older version kept under an ElevenLabs name is dropped, real ElevenLabs audio is kept', () => {
  assert.ok(!fs.existsSync(path.join(ttsDir, 'old-stand-in.mp3'))); assert.ok(fs.existsSync(path.join(ttsDir, 'real.mp3')));
});

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

test('server: still refused after the retry, the line is not made by another voice: it fails with its reason (a 204 with the reason for the page), and is asked again next time', async () => {
  const text = 'Another line that cannot be made ' + Date.now();
  let net = mockFetch(() => new Response('{"detail":{"status":"too_many_concurrent_requests"}}', { status: 429 }));
  try {
    await assert.rejects(srv.tts(text, VOICE, 180, 'elevenlabs'), /^Error: elevenlabs 429 too_many_concurrent_requests$/);
    assert.equal(net.calls.length, 2, 'one try and one retry, never a third');
    assert.ok(!fs.readdirSync(ttsDir).some((f) => f.endsWith('.wav')), 'no system voice made');
  } finally { net.restore(); }
  net = mockFetch(() => ok());   // the limit is gone: the same line is asked of ElevenLabs again
  try { assert.match(await srv.tts(text, VOICE, 180, 'elevenlabs'), /\.mp3$/); assert.equal(net.calls.length, 1); } finally { net.restore(); }
  net = mockFetch(() => new Response('{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota."}}', { status: 401 }));
  const server = srv.start(0); await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/tts?engine=elevenlabs&voice=${VOICE}&rate=180&text=${encodeURIComponent('A line over quota ' + Date.now())}`);
    assert.equal(r.status, 204); assert.equal(r.headers.get('x-tts-error'), 'elevenlabs 401 quota_exceeded'); assert.equal(net.calls.length, 1, 'a 401 is not retried');
  } finally { net.restore(); server.closeAllConnections(); server.close(); }
});

test('server: no key, no request; a request that hangs gives up after the timeout; neither is retried or made by another voice', async () => {
  const net = mockFetch((n, body, init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(init.signal.reason))));   // never answers
  const home = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = fs.mkdtempSync(path.join(tmp, 'nokey-'));
    await assert.rejects(srv.tts('A line with no key ' + Date.now(), VOICE, 180, 'elevenlabs'), /elevenlabs no key/); assert.equal(net.calls.length, 0);
    process.env.HERMES_HOME = home; process.env.AGENT_STANDUP_ELEVEN_TIMEOUT_MS = '150';
    const t0 = Date.now(); await assert.rejects(srv.tts('A line nobody answers ' + Date.now(), VOICE, 180, 'elevenlabs'), /elevenlabs timeout/);
    assert.equal(net.calls.length, 1); assert.ok(Date.now() - t0 < 1500, 'gave up in ' + (Date.now() - t0) + ' ms');
  } finally { net.restore(); process.env.HERMES_HOME = home; delete process.env.AGENT_STANDUP_ELEVEN_TIMEOUT_MS; }
});

test('server: a whole line has one time budget (its slot, a try, a retry); a line that runs out gives its slot back', async () => {
  Object.assign(process.env, { AGENT_STANDUP_ELEVEN_BUDGET_MS: '300', AGENT_STANDUP_ELEVEN_TIMEOUT_MS: '250' });   // 8 s and 5 s, scaled
  const hang = (init) => new Promise((_, no) => (init.signal.aborted ? no(init.signal.reason) : init.signal.addEventListener('abort', () => no(init.signal.reason))));
  let net = mockFetch((n, body, init) => (n === 1 ? new Response('{}', { status: 429 }) : hang(init)));   // a 429, then a retry that never answers
  try {
    const t0 = Date.now(); await assert.rejects(srv.tts('A line out of time ' + t0, VOICE, 180, 'elevenlabs'), /elevenlabs timeout/);
    assert.equal(net.calls.length, 2); assert.ok(Date.now() - t0 < 420, 'the retry is cut at the budget, not given a full timeout: ' + (Date.now() - t0) + ' ms');
  } finally { net.restore(); }
  net = mockFetch((n, body, init) => hang(init));   // two lines hold both slots for 250 ms; a third, with 100 ms left, waits for one and runs out
  try {
    const stamp = Date.now(), held = [1, 2].map((i) => srv.tts(`Held line ${i} ${stamp}`, VOICE, 180, 'elevenlabs'));
    process.env.AGENT_STANDUP_ELEVEN_BUDGET_MS = '100'; await assert.rejects(srv.tts(`Queued line ${stamp}`, VOICE, 180, 'elevenlabs'), /elevenlabs timeout/);
    assert.equal(net.calls.length, 2, 'the third never got a slot'); assert.ok(Date.now() - stamp < 200, 'it gave up at its budget: ' + (Date.now() - stamp) + ' ms');
    assert.deepEqual((await Promise.allSettled(held)).map((x) => x.status), ['rejected', 'rejected']);
  } finally { net.restore(); }
  net = mockFetch(() => ok());   // and every slot came back
  try { const stamp = Date.now(); await Promise.all([1, 2].map((i) => srv.tts(`After line ${i} ${stamp}`, VOICE, 180, 'elevenlabs'))); assert.equal(net.busy.max, 2); } finally { net.restore(); delete process.env.AGENT_STANDUP_ELEVEN_BUDGET_MS; delete process.env.AGENT_STANDUP_ELEVEN_TIMEOUT_MS; }
});

test('server: at most two requests are in flight, the rest wait for a slot', async () => {
  const net = mockFetch(() => ok());
  try {
    const stamp = Date.now(); await Promise.all([1, 2, 3, 4, 5].map((i) => srv.tts(`Concurrency line ${i} ${stamp}`, VOICE, 180, 'elevenlabs')));
    assert.equal(net.calls.length, 5); assert.ok(net.busy.max <= 2, 'in flight ' + net.busy.max);
  } finally { net.restore(); }
});

test.after(() => { srv.shutdown(); fs.rmSync(tmp, { recursive: true, force: true }); });
