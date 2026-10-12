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
  const env = { S, TTS, fetch: triage, speakServer, speakBrowser: async () => { log.browser++; return true; }, AUD: { off: () => false, ctx: { state: 'running' }, murmur() {} }, prefs: { voice: true, vstyle: 'elevenlabs' }, ELEVEN_KEY: true, sleep: idle,
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
  const TTS = new Function('fetch', 'AUD', '$', 'setTimeout', 'const ELEVEN_KEY = true;\n' + grab(/const TTS_WAIT = [^\n]*/) + '\n' + grab(/const TTS = \{[\s\S]*?\n\};/) + '\nreturn TTS;')(async () => { calls++; await sleep(30); return { ok: true, status: 204, headers: { get: () => 'elevenlabs 429 limit' } }; }, { ctx: { decodeAudioData: async (b) => b } }, () => null, later);
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
test('triage: a message item reaches Luna with its route, and the rule says to start the line with it', () => {
  assert.match(srv.triageInput({ items: [{ id: 1, age: 3, kind: 'message', project: 'gladiator-game', lead: true, role: 'Claude, Lead', route: 'To Hermes', text: 'The armour numbers are in.' }], said: [], viewing: 'gladiator-game' }), /route "To Hermes"\): The armour numbers are in\./);
  assert.match(srv.TRIAGE_SYS, /starts with that route exactly as given/);
  assert.match(srv.TRIAGE_SYS, /he wants to hear almost everything/); assert.match(srv.TRIAGE_SYS, /drop an item only when it repeats what was already said, duplicates another item, or when the queue is longer than the lines allowed can carry/);
});
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

// ---- the page's switches: none of them cuts the line being said (Tom: "the audio still often gets cut off")
function pageScope(over) {   // run page functions with the names they use stubbed: what is not given is a no-op (DOM painting), the rest is real
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {}, dataset: {}, selectedOptions: [], querySelector: () => null, querySelectorAll: () => [] });
  const noop = () => el();
  return new Proxy(over, { has: () => true, get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : k in globalThis ? globalThis[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
}
test('switches: loading another session (every switch path) lets the line being said finish, then switches; only a pause cuts', async () => {
  const src = [grab(/const voiceBusy = [^\n]*/), grab(/const VLOG = [^\n]*/), grab(/function vlog\(what\) \{[^\n]*\}/), grab(/function stopVoice\(reason\) \{[^\n]*\}/), grab(/async function finishLine\(cap = 20000\) \{[\s\S]*?\n\}/), grab(/function pause\(reason = 'pause'\) \{[^\n]*\}/), grab(/async function loadSession\(proj, id\) \{[\s\S]*?\n\}/)].join('\n');
  const cuts = [], live = new Set([{}]), S = { playing: true, speakers: new Set(), loadN: 0, token: 1, cur: { proj: 'a', id: '1' }, agents: {}, events: [] };
  const AUD = { live, stopAll() { if (live.size) cuts.push('stopped while playing'); live.clear(); } };
  const scope = pageScope({ S, AUD, Q: new URLSearchParams(''), window: {}, synth: { speaking: false, cancel() {} }, sleep, fetch: async () => ({ json: async () => ({ agents: [], events: [{ ts: 1, kind: 'say', agent: 'main', text: 'x' }], rev: 1, group: null }) }), });
  const page = new Function('scope', 'with (scope) { ' + src + '\nreturn { loadSession, pause, finishLine, VLOG: window.__voiceLog }; }')(scope);
  setTimeout(() => live.clear(), 300);   // the line ends 300 ms from now
  const t0 = Date.now(); assert.equal(await page.loadSession('b', '2'), true);
  assert.deepEqual(cuts, [], 'no line was cut'); assert.ok(Date.now() - t0 >= 280, 'the switch waited for the end of the line: ' + (Date.now() - t0) + ' ms');
  assert.deepEqual(S.cur, { proj: 'b', id: '2' }); assert.ok(page.VLOG.some((e) => e.what === 'wait for the line to end'));
  // two switches asked while one line plays: the last one goes ahead (Astra)
  live.add({}); S.playing = true; setTimeout(() => live.clear(), 200);
  const [a, b] = await Promise.all([page.loadSession('c', '3'), page.loadSession('d', '4')]);
  assert.deepEqual([a, b, S.cur], [false, true, { proj: 'd', id: '4' }]); assert.deepEqual(cuts, []);
  // a line longer than the 20 s guard is still waited for: its known end counts (scaled: a 100 ms guard, a 350 ms line)
  live.add({}); S.playing = true; S.lineEndsAt = Date.now() + 350; setTimeout(() => live.clear(), 350); const t1 = Date.now(); await page.finishLine(100);
  assert.ok(Date.now() - t1 >= 330, 'waited for the end of the long line: ' + (Date.now() - t1) + ' ms'); assert.deepEqual(cuts, []); S.lineEndsAt = 0;
  live.add({}); S.playing = true; page.pause('pause'); assert.deepEqual(cuts, ['stopped while playing'], 'an explicit pause does stop it'); assert.ok(page.VLOG.some((e) => e.what === 'cut: pause'));
  assert.ok(!/AUD\.stopAll\(\)|synth\.cancel\(\)/.test(html.replace(/function stopVoice\(reason\) \{[^\n]*\}/, '').replace(/function speakBrowser[\s\S]*?\n\}/, '').replace(/stopAll\(\) \{[^\n]*\}/, '')), 'nothing else stops a voice');
  assert.ok(/await finishLine\(\); pause\('mode'\)/.test(html) && (html.match(/await finishLine\(\); pause\('mode'\)/g) || []).length === 2, 'a mode change waits too');
});

// ---- the shared screen (Tom: "the share screen was amazing, don't remove that")
test('shared screen: a call with terminal history shows it, even when opened in a quiet moment (the latest screen, dimmed and labelled)', () => {
  const src = [grab(/function termModel\(id\) \{[\s\S]*?\n\}/), grab(/const lineHtml = [\s\S]*?\n(?=function renderPresent)/), grab(/function renderPresent\(\) \{[\s\S]*?\n\}/), grab(/function hidePresent\(full, at\) \{[\s\S]*?\n\}/), grab(/function showLastScreen\(\) \{[\s\S]*?\n\}/)].join('\n');
  const els = {}, fake = () => { const cls = new Set(); return { cls, classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; v ? cls.add(c) : cls.delete(c); return v; }, contains: (c) => cls.has(c) }, style: {}, dataset: {}, innerHTML: '', textContent: '', scrollHeight: 0, get firstChild() { return this.innerHTML ? {} : null; }, querySelector: () => null }; };
  const $ = (q) => els[q] || (els[q] = fake()), ts = Date.now() - 60000;
  const S = { present: null, agents: { main: { id: 'main', name: 'Claude', gid: 'main' } }, term: { main: [{ k: 'cmd', ts, end: ts + 900, out: 'Gate passed.', tool: { name: 'Bash', d: { kind: 'cmd', text: 'npm test' } } }] }, todos: {}, speakers: new Set(), cur: { proj: 'p', id: 's' }, live: true };
  const page = new Function('scope', 'with (scope) { ' + src + '\nreturn { showLastScreen }; }')(pageScope({ S, $, document: { body: fake() }, esc: (t) => String(t), L: (fr, en) => en, base: (f) => String(f).split('/').pop(), nameOf: () => 'Claude', prefs: { lang: 'en' }, spd: () => 1, performance }));
  assert.equal(page.showLastScreen(), true);
  assert.ok($('#present').cls.has('on'), 'the shared screen is on'); assert.ok($('#present').cls.has('idle'), 'dimmed: the last screen, not a live one');
  assert.match($('#pbody').innerHTML, /npm test/); assert.match($('#pbody').innerHTML, /Gate passed\./);
  assert.match($('#pbadge').textContent, /Claude, last shared screen/); assert.equal($('#ptitle').textContent, 'Claude');
});

// ---- what the call follows (Tom: "as soon as I click Everything it jumps to something else, so I don't even know if I'm on Everything")
test('follow mode: the header says it (everything, a project, a pinned call), each with its icon', () => {
  const { modeLabel } = new Function('L', grab(/function modeLabel\(m\) \{[\s\S]*?\n\}/) + '\nreturn { modeLabel };')((fr, en) => en);
  assert.deepEqual(modeLabel({ follow: 'all', project: 'gladiator-game', call: 'Combat simulation realism gaps' }), { kind: 'all', icon: '🌐', main: 'Following everything', sub: 'gladiator-game, Combat simulation realism gaps' });
  assert.deepEqual(modeLabel({ follow: 'g:/w/ms', followed: 'MarketSimulator', project: 'MarketSimulator', call: 'Build Act 2 environments' }), { kind: 'project', icon: '📁', main: 'Following MarketSimulator', sub: 'Build Act 2 environments' });
  assert.deepEqual(modeLabel({ pinned: true, follow: 'all', project: 'gladiator-game', call: 'Combat simulation realism gaps' }), { kind: 'pin', icon: '📌', main: 'Pinned: Combat simulation realism gaps', sub: 'gladiator-game' });
});
test('follow mode: picking Everything stays on the call on screen; picking a project goes to its most urgent call', async () => {
  const src = grab(/async function followProject\(key\) \{[\s\S]*?\n\}/), calls = [];
  const S = { live: true, demo: false, cur: { proj: 'p', id: 'combat' }, pin: 'combat', autoPin: null }, prefs = { follow: 'g:/w/gl', pin: 'combat' };
  const rows = [{ id: 'busy', proj: '_codex', state: 'working', mtime: Date.now(), group: { key: '/w/ms', name: 'MarketSimulator' } }];
  const scope = pageScope({ S, prefs, Q: new URLSearchParams(''), document: { body: { classList: { contains: () => false } } }, boardNow: async () => (calls.push('board'), rows), boardKey: (r) => r.group.key,
    followTarget: (rs, f) => rs.find((r) => 'g:' + r.group.key === f) || null, followCurrent: async () => { calls.push('followCurrent'); }, setMode: async () => calls.push('setMode'),
    paintSubtitle: () => calls.push('header ' + (S.pin ? 'pinned' : prefs.follow)), $: () => ({}) });
  const { followProject } = new Function('scope', 'with (scope) { ' + src + '\nreturn { followProject }; }')(scope);
  const p = followProject('');
  assert.deepEqual(calls, ['header all'], 'the header says it at once, before anything is fetched');
  await p;
  assert.deepEqual([S.cur, S.pin, prefs.follow, calls], [{ proj: 'p', id: 'combat' }, '', 'all', ['header all']], 'everything: the same call, no load');
  assert.ok(Date.now() - S.switchAt < 1000, 'and the hold starts, so it does not move at once either');
  calls.length = 0; await followProject('/w/ms');
  assert.deepEqual([prefs.follow, S.autoPin, calls], ['g:/w/ms', { proj: '_codex', id: 'busy' }, ['header g:/w/ms', 'board', 'followCurrent']]);
});
test('follow mode: an automatic switch waits out the hold when this call merely went quiet, and always says why', async () => {
  const { followReason } = new Function('L', grab(/function followReason\(r\) \{[\s\S]*?\n\}/) + '\nreturn { followReason };')((fr, en) => en);
  assert.equal(followReason({ follow: 'all', why: 'needs', to: 'gladiator-game' }), 'Following everything: gladiator-game needs you');
  assert.equal(followReason({ follow: 'all', why: 'quiet', to: 'MarketSimulator', from: 'Combat simulation realism gaps' }), 'Following everything: MarketSimulator is busy, Combat simulation realism gaps went quiet');
  assert.equal(followReason({ follow: 'g:/w/gl', followed: 'gladiator-game', why: 'busy', toTitle: 'Respond to greeting' }), 'Following gladiator-game: Respond to greeting is the most active');
  assert.equal(followReason({ follow: 'all', why: 'pin' }), 'Following everything: the pinned call ended');
  const notes = [], loads = [], S = { cur: { proj: 'p', id: 'combat' }, title: 'gladiator-game, Combat simulation realism gaps', pin: '', autoPin: null, switchAt: Date.now(), events: [], userPaused: true }, prefs = { follow: 'all' };
  const src = [grab(/function followReason\(r\) \{[\s\S]*?\n\}/), grab(/const inCall = [^\n]*/), grab(/async function followCurrent\(\) \{[\s\S]*?\n\}/)].join('\n');
  const scope = pageScope({ S, prefs, Q: new URLSearchParams(''), FOLLOW_HOLD: 20000, L: (fr, en) => en, fetch: async () => ({ json: async () => ({ proj: '_codex', id: 'busy' }) }),
    loadSession: async (proj, id) => { loads.push(id); S.cur = { proj, id }; S.group = { key: '/w/ms', name: 'MarketSimulator' }; S.title = 'MarketSimulator, Build Act 2 environments'; return true; }, noteSwitch: (t) => notes.push(t), $: () => ({ classList: { add() {}, remove() {} } }) });
  const { followCurrent } = new Function('scope', 'with (scope) { ' + src + '\nreturn { followCurrent }; }')(scope);
  assert.equal(await followCurrent(), false); assert.deepEqual(loads, [], 'within the hold: it stays');
  S.switchAt = Date.now() - 25000; assert.equal(await followCurrent(), true);
  assert.deepEqual([loads, notes], [['busy'], ['Following everything: MarketSimulator is busy, Combat simulation realism gaps went quiet']]);
});

// ---- one sound control (Tom: "it's also not clear if it's on mute or on loud"; his window was silent on voice:false and nothing said so)
const SOUND_SRC = () => [grab(/const soundHeld = [^\n]*/), grab(/function soundState\(s\) \{[\s\S]*?\n\}/), grab(/const talkingNow = [^\n]*/), grab(/const soundNow = [^\n]*/), grab(/function paintSound\(\) \{[\s\S]*?\n\}/), grab(/function toggleSound\(\) \{[\s\S]*?\n\}/)].join('\n');
test('sound: the control shows exactly one state, in words, in the order a person acts on it', () => {
  const { soundState } = new Function('L', grab(/function soundState\(s\) \{[\s\S]*?\n\}/) + '\nreturn { soundState };')((fr, en) => en);
  const on = { elsewhere: false, muted: false, voice: true, held: false, down: '', talking: false }, st = (x) => soundState({ ...on, ...x });
  const row = (x) => { const r = st(x); return [r.k, r.icon, r.text, r.hint, r.silent]; };
  assert.deepEqual(row({}), ['on', '🔊', 'Sound on', '', false]);
  assert.deepEqual(row({ talking: true }), ['talking', '🔊', 'Sound on', '', false], 'on and talking reads differently from on and idle');
  assert.deepEqual(row({ muted: true }), ['muted', '🔇', 'Muted', 'M to unmute', true]);
  assert.deepEqual(row({ voice: false }), ['off', '🔇', 'Voice off', 'click for sound', true], "Tom's case: voices off in the saved settings");
  assert.deepEqual(row({ held: true }), ['held', '⚠', 'Click anywhere for sound', '', true]);
  assert.deepEqual(row({ down: 'quota' }), ['eleven', '⚠', 'ElevenLabs: quota', '', true]);
  assert.deepEqual(row({ elsewhere: true }), ['elsewhere', '🔈', 'Sound in another window', 'click to play it here', true]);
  assert.equal(st({ muted: true, voice: false, held: true, down: 'quota' }).k, 'muted', 'one state at a time: muted wins over the rest');
  assert.equal(st({ voice: false, held: true }).k, 'off'); assert.equal(st({ held: true, down: 'quota' }).k, 'held');
  assert.equal(new Set([{}, { talking: true }, { muted: true }, { voice: false }, { held: true }, { down: 'x' }, { elsewhere: true }].map((x) => st(x).k)).size, 7, 'each state its own look');
});
test('sound: one click goes from any silent state to sound on, and from on to muted; the click that unlocks the browser never mutes', () => {
  const run = (setup) => {
    const calls = [], S = { owner: 'me' }, prefs = { voice: true }, AUD = { muted: false, live: new Set(), ctx: { state: 'running', resume: async () => {} }, init() {} };
    setup({ S, prefs, AUD });
    const scope = pageScope({ S, prefs, AUD, CID: 'me', synth: null, TTS: { down: '' }, L: (fr, en) => en, performance: { now: () => 10000 }, savePrefs: () => calls.push('save'),
      applyMute: () => calls.push('applyMute'), claimAudio: () => { S.owner = 'me'; calls.push('claim'); }, paintSound: () => {}, document: { querySelector: () => null } });
    new Function('scope', 'with (scope) { ' + SOUND_SRC().replace(/function paintSound\(\) \{[\s\S]*?\n\}/, '') + '\nreturn { toggleSound }; }')(scope).toggleSound();
    return { muted: AUD.muted, voice: prefs.voice, owner: S.owner, calls };
  };
  const ON = { muted: false, voice: true, owner: 'me', calls: ['save', 'claim'] };   // on, saved, and the sound taken for this window
  assert.deepEqual(run(() => {}), { muted: true, voice: true, owner: 'me', calls: ['save', 'applyMute'] }, 'on: muted, and saved (the one switch)');
  assert.deepEqual(run(({ AUD }) => { AUD.muted = true; }), ON, 'muted: on');
  assert.deepEqual(run(({ prefs }) => { prefs.voice = false; }), ON, 'voice off (an older window): on');
  assert.deepEqual(run(({ S }) => { S.owner = 'other'; }), ON, 'another window: taken here');
  assert.deepEqual(run(({ AUD, S }) => { AUD.ctx.state = 'suspended'; S.unlockHeld = false; }), ON, 'held by the browser: on');
  assert.deepEqual(run(({ S }) => { S.unlockHeld = true; S.unlockAt = 9800; }), ON, 'the click that just let the browser play (it is running by now): still on, not muted');
});
test('sound: the control paints its state and a silent state prefixes the tab title', () => {
  const el = () => ({ textContent: '' }), parts = { '.si': el(), '.st': el(), small: el() }, attrs = {};
  const b = { className: '', title: '', querySelector: (q) => parts[q], setAttribute: (k, v) => (attrs[k] = v) }, doc = { title: '' };
  const S = { owner: 'me', tabBase: '● 2 working' }, prefs = { voice: true }, AUD = { muted: true, live: new Set(), ctx: { state: 'running' } };
  const scope = pageScope({ S, prefs, AUD, CID: 'me', synth: null, TTS: { down: '' }, L: (fr, en) => en, $: () => b, document: doc });
  const { paintSound } = new Function('scope', 'with (scope) { ' + SOUND_SRC() + '\nreturn { paintSound }; }')(scope);
  paintSound(); assert.deepEqual([b.className, parts['.si'].textContent, parts['.st'].textContent, parts.small.textContent, doc.title], ['snd muted', '🔇', 'Muted', 'M to unmute', '🔇 ● 2 working']);
  AUD.muted = false; AUD.live.add({}); paintSound(); assert.deepEqual([b.className, parts['.st'].textContent, doc.title], ['snd talking', 'Sound on', '● 2 working'], 'talking: the pulse, no prefix');
  AUD.live.clear(); AUD.ctx.state = 'suspended'; paintSound(); assert.deepEqual([b.className, doc.title], ['snd held', '⚠ ● 2 working']);
});
test('sound: ElevenLabs chosen, voices turned on from voice:false: the first line goes to /api/tts and the browser voice never speaks', async () => {
  const urls = [], spoken = [], S = { token: 1, level: {}, owner: 'me', live: true, group: { key: '/w/gladiator-game' } }, prefs = { voice: false, vstyle: 'elevenlabs' };
  const node = () => ({ connect: (d) => d, fftSize: 0, gain: { value: 1 }, getByteTimeDomainData() {} });
  const ctx = { state: 'running', resume: async () => {}, createGain: node, createAnalyser: node, decodeAudioData: async () => ({ duration: 0.02, sampleRate: 8000, getChannelData: () => new Float32Array(160).fill(0.05) }),
    createBufferSource: () => ({ ...node(), playbackRate: { value: 1 }, start() { setTimeout(() => this.onended && this.onended(), 20); }, stop() {} }) };
  const AUD = { ctx, muted: false, live: new Set(), voice: node(), init() {}, off() { return this.muted; } };
  const fetch = async (u) => { urls.push(String(u)); return /\/api\/voices/.test(u) ? { json: async () => ({ available: true, voices: [{ name: 'adam' }] }) } : { status: 200, ok: true, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(8) }; };
  const synth = { speaking: false, speak: (u) => { if (u.text) spoken.push(u.text); }, cancel() {}, getVoices: () => [{ name: 'espeak', lang: 'en-US' }] };
  const scope = pageScope({ S, prefs, AUD, fetch, synth, CID: 'me', EMBED: false, ELEVEN_KEY: true, SpeechSynthesisUtterance: function (t) { this.text = t; }, L: (fr, en) => en, FR: () => false,
    $: () => null, document: { querySelector: () => null }, performance: { now: () => 1e6 }, savePrefs() {}, liveProjectKeys: () => new Set(), hash: (x) => x.length, applyMute() {}, claimAudio() {}, paintSound() {}, captionRun() {}, vlog() {}, estMs: () => 10, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    speakable: (t) => t, rankVoices: (v) => v, spd: () => 1, lagFactor: () => 1, fxFor() {}, fxChain() {}, AbortSignal: { timeout: () => undefined }, TTS_WAIT: 10000, TTS_RETRY: 30000, setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (ms > 1000 && t.unref) t.unref(); return t; } });
  const src = [grab(/const soundHeld = [^\n]*/), grab(/const elevenWhy = [^\n]*/), grab(/const TTS = \{[\s\S]*?\n\};/), grab(/function soundState\(s\) \{[\s\S]*?\n\}/), grab(/const talkingNow = [^\n]*/), grab(/const soundNow = [^\n]*/),
    grab(/function toggleSound\(\) \{[\s\S]*?\n\}/), grab(/const LOUD_TARGET = [^\n]*/), grab(/function loudnessOf\(data, rate\) \{[\s\S]*?\n\}/), grab(/const normGain = [^\n]*/), grab(/const gainOf = [^\n]*/), grab(/const projKeyOf = [^\n]*/), grab(/const voicePool = [^\n]*/), grab(/function projectVoice\(key, pool, poolKey, live = liveProjectKeys\(\)\) \{[\s\S]*?\n\}/), grab(/async function speakServer\([\s\S]*?\n\}/), grab(/function speakBrowser\([\s\S]*?\n\}/), grab(/async function speakLine\([\s\S]*?\n\}/)].join('\n');
  const { TTS, toggleSound, speakLine } = new Function('scope', 'with (scope) { ' + src + '\nreturn { TTS, toggleSound, speakLine }; }')(scope);
  await TTS.init(); assert.deepEqual([TTS.engine, TTS.server], ['elevenlabs', true]);
  await speakLine('Said while the voices are off.', { id: 'main', vi: 0 }, true, 1); assert.deepEqual([urls.filter((u) => /\/api\/tts/.test(u)), spoken], [[], []], 'voices off: nothing is said or paid for');
  toggleSound(); assert.equal(prefs.voice, true, 'the sound control turned the voices on');
  const r = await speakLine('The build is green.', { id: 'main', vi: 0 }, true, 1);
  assert.equal(r, undefined, 'the line was said'); assert.match(urls.filter((u) => /\/api\/tts/.test(u))[0] || '', /engine=elevenlabs&voice=adam&.*text=The%20build%20is%20green\./);
  scope.fetch = async () => ({ status: 204, ok: false, headers: { get: () => 'elevenlabs quota_exceeded' } });   // the key is refused
  const skipped = await speakLine('A line ElevenLabs cannot make.', { id: 'main', vi: 0 }, true, 1);
  assert.ok(skipped && skipped.skipped, 'a line it cannot make is skipped and marked'); assert.deepEqual(spoken, [], 'and never said by the browser voice');
  const asked = []; scope.fetch = async (u) => { asked.push(String(u)); return { status: 200, ok: true, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(8) }; };
  TTS.engine = 'system'; TTS.server = true;   // a key, and yet an engine left on the system voices (an old style, the moment before init): still nobody else speaks
  const r2 = await speakLine('Never in another voice.', { id: 'main', vi: 0 }, true, 1);
  assert.ok(r2 && r2.skipped, 'skipped and marked'); assert.deepEqual([spoken, asked], [[], []], 'neither the browser voice nor the server system voice');
});
test('sound: no setup: a Hermes key makes ElevenLabs the voice whatever was saved (a system voice, voice:false), and voices come back on once', () => {
  const src = grab(/let prefs = \{[\s\S]*?prefs\.soundOnce = true; \}/);
  const load = (saved, key) => new Function('window', 'localStorage', src + '\nreturn { prefs, ELEVEN_KEY };')({ SAVED_PREFS: { _t: 2, ...saved }, SERVER_VOICES: { elevenlabs: key } }, { getItem: () => null });
  const tom = load({ vstyle: 'natural', voice: false, elevenOnce: true }, true);
  assert.deepEqual([tom.ELEVEN_KEY, tom.prefs.vstyle, tom.prefs.voice, tom.prefs.muted], [true, 'elevenlabs', true, false], "Tom's 4747: the system voice and voices off, saved by older pages");
  assert.equal(load({ vstyle: 'natural', elevenOnce: true, soundOnce: true }, true).prefs.vstyle, 'elevenlabs', 'with a key, every time');
  assert.deepEqual([load({ vstyle: 'natural', elevenOnce: true, soundOnce: true, muted: true }, true).prefs.muted], [true], 'a mute chosen since is kept');
  assert.equal(load({ vstyle: 'natural', elevenOnce: true }, false).prefs.vstyle, 'natural', 'without a key, the voice chosen in the settings');
});

// ---- more chatter (Tom: "I just expected a bit more chatter"; he wants it narrated 24/7, thinned only when there is too much): real content, never invented banter
function beatEnv(over = {}) {
  const src = [grab(/\nconst base = [^\n]*/), grab(/function cmdLabel\(text\) \{[\s\S]*?\n\}/), grab(/function cmdVerb\(cmd\) \{[\s\S]*?\n\}/), grab(/function plainAct\(tool, arg\) \{[\s\S]*?\n\}/), grab(/const projWord = [^\n]*/),
    grab(/function party\(p\) \{[\s\S]*?\n\}/), grab(/const TRIAGE_WAIT = [\s\S]*?\/\/ ---- end triage policy/), grab(/function whoDoes\(id\) \{[\s\S]*?\n\}/), grab(/const shirtRole = [^\n]*/), grab(/const DULL = [^\n]*/), grab(/const dullAct = [^\n]*/), grab(/const verbAct = [^\n]*/), grab(/const ing = [^\n]*/),
    grab(/function commitOf\(t\) \{[\s\S]*?\n\}/), grab(/function testsOf\(out\) \{[\s\S]*?\n\}/), grab(/const callEnv = [^\n]*/), grab(/function beatOf\(e, env = callEnv\(\)\) \{[\s\S]*?\n\}/), grab(/const STATUS_MS = [^\n]*/), grab(/function statusItems\(rows, now = Date\.now\(\)\) \{[\s\S]*?\n\}/),
    grab(/function statusNext\(now = Date\.now\(\)\) \{[\s\S]*?\n\}/), grab(/const SPEECH_MAX = [^\n]*/), grab(/function clipSpeech\(t, cap\) \{[\s\S]*?\n\}/), grab(/const lastSays = [^\n]*/), grab(/const FAR = \{[^\n]*/), grab(/const farOn = [^\n]*/), grab(/function farEnv\(p\) \{[\s\S]*?\n\}/), grab(/function collect\(\) \{[\s\S]*?\n\}/)].join('\n');
  const S = { agents: { main: { id: 'main', name: 'Codex', role: 'Codex, Lead' }, k1: { id: 'k1', name: 'kettle hat', role: 'worker' }, k2: { id: 'k2', name: 'buckler writer', role: 'worker' }, k3: { id: 'k3', name: 'Build the armour decision page', role: 'general-purpose' } }, group: { key: '/w/gladiator-game', name: 'gladiator-game' }, cur: { proj: '_codex', id: 'glad' }, pin: '', title: 'gladiator-game, Combat simulation realism gaps' };
  const env = { S, prefs: { follow: 'all' }, D: { quietAt: 0, statusSaid: [], pending: null, ctx: { main: 'The fatigue change landed; rerunning the armour sim to see if knockouts drop.' } }, decide: async (items, max) => ({ items, max }), L: (fr, en) => en, speechOf: (e) => e.text || '', speakable: (t) => t, boardMemo: { rows: [] }, boardKey: (r) => r.group.key, niceProj: (p) => p, LIVE_MS: 300000, warmLines: (l) => l, ...over };
  return new Function('scope', 'with (scope) { ' + src + '\nreturn { beatOf, testsOf, commitOf, triageItems, applyTriage, localPick, statusItems, statusNext, maxLines, GENERIC, collect, FAR }; }')(pageScope(env));
}
test('chatter: an event is worth a line in plain words: what an agent is doing, a sub-agent starting or finishing, a commit, a test result', () => {
  const b = beatEnv(), tools = (agent, name, arg) => ({ agent, kind: 'tools', ts: 1, tools: [{ name, arg }] });
  assert.deepEqual(b.beatOf(tools('main', 'exec_command', 'dotnet test Gladiator.Sim.Tests --filter Combat')), { kind: 'work', act: 'Running tests', text: 'Gladiator lead is running tests', hint: 'command: dotnet test Gladiator.Sim.Tests --filter Combat | it just said: The fatigue change landed; rerunning the armour sim to see if knockouts drop. | its task: Combat simulation realism gaps' }, 'the content behind it: the command, what it just said, the task');
  assert.equal(b.beatOf({ agent: 'k1', kind: 'tools', ts: 1, tools: [{ name: 'Bash', arg: 'python3 sim.py --seeds 150', d: { note: 'Measure 150 playthroughs for the difficulty report' } }] }).hint, 'command: python3 sim.py --seeds 150 | its purpose: Measure 150 playthroughs for the difficulty report | its task: kettle hat');
  assert.equal(b.beatOf(tools('k1', 'apply_patch', 'straps.py')).text, 'The kettle hat is editing straps.py', 'a sub-agent by its role, never "a sub-agent"');
  assert.equal(b.beatOf(tools('k3', 'apply_patch', 'page.html')).text, 'The Build armour is editing page.html', 'a long task name: its shirt words');
  assert.equal(b.beatOf(tools('main', 'exec_command', 'sed -n 1,80p server.js')), null, 'reading or searching is not news');
  assert.equal(b.beatOf(tools('main', 'followup_task', '')), null, 'a tool with no plain doing is not a line');
  assert.equal(b.beatOf(tools('main', 'exec_command', 'git commit -m "Wounds: pain shifts surrender to real injuries"')).text, 'Gladiator lead committed: Wounds: pain shifts surrender to real injuries');
  assert.equal(b.beatOf(tools('main', 'Bash', "git commit -q -F - <<'EOF'\nOne sound control in words\n\nmore\nEOF")).kind, 'commit');
  assert.deepEqual(b.beatOf({ agent: 'main', kind: 'order', ts: 1, to: 'k2', title: 'buckler_writer', label: true, text: 'task "buckler_writer" (worker)' }), { kind: 'order', text: 'Gladiator lead started the buckler writer', hint: '' });
  assert.deepEqual(b.beatOf({ agent: 'main', kind: 'order', ts: 1, to: 'k3', title: 'armour page', text: 'Build the armour decision page from the 25,920-fight matrix.' }), { kind: 'order', text: 'Build the armour decision page from the 25,920-fight matrix.' }, 'a readable brief is what it was started to do');
  assert.equal(b.beatOf({ agent: 'k1', kind: 'finish', ts: 1, to: 'main' }), null, 'a finish with nothing it concluded is not a line (its report says it)');
  assert.equal(beatEnv({ D: { ctx: { k1: 'Kettle hat fits all four heads; the strap is 2 mm short.' } } }).beatOf({ agent: 'k1', kind: 'finish', ts: 1, to: 'main' }).hint, 'it concluded: Kettle hat fits all four heads; the strap is 2 mm short.');
  assert.deepEqual(b.beatOf({ agent: 'main', kind: 'msg', ts: 1, text: 'The armour numbers are in.' }), { kind: 'message', text: 'The armour numbers are in.' }, 'what an agent wrote stays its own words');
  assert.equal(b.beatOf({ agent: 'main', kind: 'results', ts: 1, items: [{ out: 'ℹ tests 78\nℹ pass 78\nℹ fail 0' }] }).text, 'Gladiator lead: all 78 tests pass');
  for (const [out, said] of [['Tests:       2 failed, 76 passed, 78 total', '2 of 78 tests failed'], ['===== 25 passed, 1 warning in 1.20s =====', 'all 25 tests pass'], ['Passed!  - Failed:     0, Passed:   120, Skipped: 0, Total: 120', 'all 120 tests pass'],
    ['Failed!  - Failed:     3, Passed:   117, Skipped: 0', '3 of 120 tests failed'], ['test result: ok. 12 passed; 0 failed; 0 ignored', 'all 12 tests pass'], ['Saved closeup.png', '']]) assert.equal(b.testsOf(out), said, out);
});
test('chatter: the queue keeps only the newest of what an agent is doing (an older one is past), for 20 s; a short queue is said in up to 4 lines, a backlog in 2', () => {
  const b = beatEnv(), now = 1.79e12, done = new WeakSet(), ev = (agent, ago, arg) => ({ agent, kind: 'tools', ts: now - ago * 1000, tools: [{ name: 'exec_command', arg }] });
  const evs = [ev('main', 25, 'npm test'), ev('main', 12, 'npm run build'), { agent: 'main', kind: 'report', ts: now - 6000, text: 'Done.' }, ev('k1', 4, 'python3 make_parts.py'), ev('main', 3, 'npm test')];   // in time order, as they come
  const items = b.triageItems(evs, done, now, new Set(), {}, b.beatOf);
  assert.deepEqual(items.map((it) => [it.kind, it.agent, it.age]), [['report', 'main', 6], ['work', 'k1', 4], ['work', 'main', 3]]);
  assert.ok(done.has(evs[1]) && done.has(evs[0]), 'superseded beats are handled, never said later'); assert.ok(!done.has(evs[2]), 'the report waits to be picked');
  assert.deepEqual([b.maxLines(3), b.maxLines(8), b.maxLines(9)], [4, 4, 2]);
  const say = (n) => Array.from({ length: n }, (_, i) => ({ ids: [i + 1], line: 'Line ' + (i + 1) + '.' })), mk = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'work', ev: { ts: now }, text: 'x' }));
  assert.equal(b.applyTriage(mk(5), { drop: [], say: say(5) }).length, 4); assert.equal(b.applyTriage(mk(12), { drop: [], say: say(5) }).length, 2);
});
test('chatter: after 20 s of quiet while agents work, a status line from the busy calls\' real content (titles, commands, workers), in the scope followed, never asked twice for the same state', () => {
  const now = Date.now(), row = (name, state, tool, arg, ago, sub = 0, title = '') => ({ id: name, proj: '-w-' + name, group: { key: '/w/' + name, name }, state, tool, arg, mtime: now - ago * 1000, subActive: sub, active: sub ? ['fatigue build'] : [], title });
  const rows = [row('gladiator-game', 'working', 'exec_command', 'python3 sim.py --armour', 5, 4, 'Combat simulation realism gaps'), row('MarketSimulator', 'working', 'apply_patch', 'Ledger.cs', 9, 0, 'Review the news gate'), row('agent-standup', 'blocked', '', '', 30, 0, 'Polish the call'), row('twin-folder', 'done', '', '', 20), row('old-thing', 'working', 'Bash', 'ls', 900)];
  const b = beatEnv({ boardMemo: { rows } }), items = b.statusItems(rows, now);
  assert.deepEqual(items.map((it) => [it.kind, it.text, it.hint]), [['status', 'agent standup: Polish the call', ''], ['status', 'gladiator: Combat simulation realism gaps', 'now: exec_command python3 sim.py --armour | 4 sub-agents working: fatigue build'], ['status', 'MarketSimulator: Review the news gate', 'now: apply_patch Ledger.cs']], 'who needs Tom first, then in a steady order; finished and stale calls are out');
  assert.deepEqual(beatEnv({ boardMemo: { rows }, prefs: { follow: 'g:/w/MarketSimulator' } }).statusItems(rows, now).map((it) => it.text), ['MarketSimulator: Review the news gate'], 'following a project: that project only');
  const D = { quietAt: 0, statusSaid: [], pending: null }, s = beatEnv({ boardMemo: { rows }, D }); s.statusNext(now); assert.ok(D.pending, 'asked'); D.pending = null; s.statusNext(now + 30000); assert.equal(D.pending, null, 'the same state again: nothing new to say');
  assert.deepEqual(beatEnv().statusItems([row('x', 'done', '', '', 5)], now), [], 'nobody working: silence');
});
test("chatter: a generic line is never said (Tom: 'running a script, executing a command tells me nothing'); without the model, work and status are not said at all", () => {
  const b = beatEnv(), now = 1.79e12, it = (id, kind) => ({ id, kind, ev: { ts: now }, text: 'Gladiator lead is running a script' });
  for (const g of ['Gladiator lead is running a script.', 'The fatigue build sub-agent is executing a command.', 'Codex is editing files.', 'Gladiator is working, with 2 sub-agents.', 'MarketSimulator is busy.', 'Hermes is using a tool.', 'Claude is searching files.', 'A subagent is running a script.', 'A sub-agent is reporting back.', 'The armour builder is reporting back.', 'An agent finished.', 'The fatigue sim finished.']) assert.ok(b.GENERIC.test(g), g);   // Tom, twice: content, never these
  for (const ok of ['Gladiator lead is rerunning the armour sim after the fatigue change.', 'Fatigue build is measuring 150 playthroughs for the difficulty report.', 'All 78 tests pass.', 'To gladiator Hermes: the armour numbers are in.', 'The armour builder found plate cuts bleed 40 percent less; the decision page is ready.', 'The fatigue sim finished: knockouts fell from 113 to 0.']) assert.ok(!b.GENERIC.test(ok), ok);
  assert.deepEqual(b.applyTriage([it(1, 'work'), it(2, 'work')], { drop: [], say: [{ ids: [1], line: 'Gladiator lead is running a script.' }, { ids: [2], line: 'Gladiator lead is rerunning the armour sim after the fatigue change.' }] }).map((o) => o.line), ['Gladiator lead is rerunning the armour sim after the fatigue change.']);
  assert.deepEqual(b.localPick([it(1, 'work'), it(2, 'status'), { ...it(3, 'report'), text: 'Report: the armour library is committed.' }]).map((o) => o.items[0].id), [3], 'the fallback says what agents wrote, never a made-up work line');
});
test('chatter: Luna is told to say almost everything, how many lines it may use, and the command behind a work beat for the wording only', () => {
  const t = srv.triageInput({ items: [{ id: 1, age: 2, kind: 'work', project: 'gladiator-game', lead: true, role: 'Codex, Lead', text: 'Gladiator lead is running tests', hint: 'dotnet test --filter Combat' }], said: [], viewing: 'gladiator-game', max: 4 });
  assert.match(t, /Lines allowed: 4/); assert.match(t, /Gladiator lead is running tests \[dotnet test --filter Combat\]/);
  assert.match(srv.TRIAGE_SYS, /Kinds: needs_you.*tests.*commit.*finish.*work/); assert.match(srv.TRIAGE_SYS, /for the wording only/); assert.match(srv.TRIAGE_SYS, /no paths, ids or commands/);
});

// ---- the main view is the shared screens (Tom: "maybe 4 screenshares active at the same time as maximum"), labelled by who shares them
test('screens: up to 4 at once, picked by real activity, each keeping its place; a quiet one gives way after the hold; labelled by who shares it', () => {
  const now = 1.79e12, src = [grab(/const SCREEN_HOLD = [^\n]*/), grab(/function screenPicks\(now, max\) \{[\s\S]*?\n\}/), grab(/const lc1 = [^\n]*/), grab(/function screenWho\(id\) \{[\s\S]*?\n\}/)].join('\n');
  const agents = { main: { id: 'main' }, a: { id: 'a', name: 'fatigue build' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' }, e: { id: 'e' }, se7a982__main: { id: 'se7a982__main', lead: true }, se7a982__r: { id: 'se7a982__r', name: 'research the 2D fight view' }, p_x: { id: 'p_x', type: 'peer' } };
  const S = { agents, term: {}, run: {}, seen: {}, gone: new Set(), screens: [] }; for (const id in agents) { S.term[id] = [{ k: 'cmd' }]; S.seen[id] = now - 60000; }
  const who = { main: 'Gladiator lead', se7a982__main: 'Gladiator Claude' };
  const f = new Function('scope', 'with (scope) { ' + src + '\nreturn { screenPicks, screenWho, screenGrid }; }')(pageScope({ S, L: (fr, en) => en, nameOf: (id) => agents[id].name || id, whoDoes: (id) => who[id] || id }));
  Object.assign(S.seen, { a: now - 1000, b: now - 2000, c: now - 3000, d: now - 4000, e: now - 5000, p_x: now }); S.run.main = { name: 'Bash' };   // main runs a long command (no event for a minute); a guest is never a screen
  assert.deepEqual(f.screenPicks(now, 4), ['main', 'a', 'b', 'c'], 'running first, then the most recent: four at most');
  S.seen.e = now; assert.deepEqual(f.screenPicks(now, 4), ['main', 'a', 'b', 'c'], 'a newer one waits: the four keep their slots while active');
  S.seen.b = now - 25000; assert.deepEqual(f.screenPicks(now, 4), ['main', 'a', 'c', 'e'], 'b went quiet past the 20 s hold: it gives way');
  delete S.run.main; assert.deepEqual(f.screenPicks(now, 2), ['a', 'c'], 'a narrow centre has room for two');
  assert.deepEqual([1, 2, 3, 4].map((n) => f.screenGrid(n, 900).cols), [1, 2, 2, 2]); assert.deepEqual([f.screenGrid(2, 600).cols, f.screenGrid(0, 600).max, f.screenGrid(0, 900).max], [1, 2, 4], '2 stacked when narrow; 2 or 4 by width');
  assert.deepEqual(['main', 'a', 'se7a982__main', 'se7a982__r'].map(f.screenWho), ['Gladiator lead', 'Fatigue build, sub-agent of gladiator lead', 'Gladiator Claude', 'Research the 2D fight view, sub-agent of gladiator Claude']);
});

test('director: a work beat never takes a needs-you or a message down with it; the fallback drops a generic message (Astra P1s)', () => {
  const b = beatEnv(), now = Date.now(), freshIn = new Function('keepOf', grab(/const freshIn = [^\n]*/) + '\nreturn freshIn;')(new Function(grab(/const TRIAGE_WAIT = [^\n]*/) + '\n' + grab(/const keepOf = [^\n]*/) + '\nreturn keepOf;')());
  const it = (kind, ago) => ({ kind, ev: { ts: now - ago * 1000 } });
  assert.equal(freshIn({ items: [it('needs_you', 1), it('work', 19)] }, 1200), true, 'a 1 s old approval merged with 19 s old work: still said');
  assert.equal(freshIn({ items: [it('work', 19)] }, 1200), false, 'work alone is news for 20 s');
  assert.equal(freshIn({ items: [it('message', 50), it('work', 1)] }, 0), false, 'the content itself out of date: stale');
  assert.deepEqual(b.localPick([{ id: 1, kind: 'message', ev: { ts: now }, text: 'The lead is running a script.' }, { id: 2, kind: 'report', ev: { ts: now }, text: 'The armour page is ready.' }]).map((o) => o.items[0].id), [2]);
});

// ---- round 12 (Tom: "when doing follow everything, I feel it's not appropriately telling me everything from ALL projects, it also gets stuck in one project")
test('everything: the director hears every live project; a line about another project starts with its name; a pinned call hears only itself', () => {
  const now = Date.now(), D = { done: new WeakSet(), beat: new Map(), quietAt: now, statusSaid: [], pending: null, ctx: {} };
  const S = { live: true, demo: false, pin: '', agents: { main: { id: 'main', name: 'Codex', role: 'Lead' } }, group: { key: '/w/gladiator-game', name: 'gladiator-game' }, title: 'gladiator-game, Combat simulation', events: [{ ts: now - 3000, agent: 'main', kind: 'report', text: 'The armour page is ready.' }], needs: [] };
  const b = beatEnv({ S, D, prefs: { follow: 'all', voice: true }, AUD: { off: () => false }, routeOf: () => '' });
  b.FAR.projects = [{ key: '/w/MarketSimulator', name: 'MarketSimulator', agents: { 's6a5c159__main': { name: 'Claude', lead: true, task: 'Review the news gate' }, 's6a5c159__a1': { name: 'news polish', role: 'general-purpose' } },
    events: [{ ts: now - 2000, kind: 'tools', agent: 's6a5c159__a1', sess: 'x', tools: [{ name: 'Bash', arg: 'python3 -m pytest tests/news' }] }, { ts: now - 1000, kind: 'say', agent: 's6a5c159__main', sess: 'x', text: 'The cohort gate passes for all 268 openings.' }], ctx: {} }];
  const items = b.collect();
  assert.deepEqual(items.map((it) => [it.kind, it.far || '', it.text]), [['report', '', 'The armour page is ready.'], ['work', '/w/MarketSimulator', 'The news polish is running tests'], ['message', '/w/MarketSimulator', 'The cohort gate passes for all 268 openings.']]);
  const lines = b.applyTriage(items, { drop: [], say: [{ ids: [1], line: 'The armour page is ready.' }, { ids: [3], line: 'The cohort gate passes for all 268 openings.' }, { ids: [2], line: 'MarketSimulator news polish is running the news tests.' }] }).map((o) => o.line);
  assert.deepEqual(lines, ['The armour page is ready.', 'MarketSimulator: The cohort gate passes for all 268 openings.', 'MarketSimulator news polish is running the news tests.'], 'the call on screen as is; another project by its name, once');
  assert.deepEqual(b.localPick(items).map((o) => o.line), ['The armour page is ready.', 'MarketSimulator: The cohort gate passes for all 268 openings.'], 'the fallback too');
  const pinned = beatEnv({ S: { ...S, pin: 'combat' }, D: { ...D, done: new WeakSet() }, prefs: { follow: 'all', voice: true }, AUD: { off: () => false }, routeOf: () => '' }); pinned.FAR.projects = b.FAR.projects;
  assert.deepEqual(pinned.collect().map((it) => it.text), ['The armour page is ready.'], 'pinned: only the call on screen');
});
test('liveness: a lead whose own sub-agents are working is waiting on them, never finished; a lead whose turn ended with nothing running is finished', () => {
  const now = Date.now(), src = [grab(/const teamOf2 = [^\n]*/), grab(/function agentState\(id, now\) \{[\s\S]*?\n\}/)].join('\n');
  const S = { live: true, status: { a1: 'working', a2: 'done', 'sx__w1': 'working' }, run: {}, waitOn: {}, lastAct: { main: now - 600000, 'sx__main': now - 600000 }, seen: { a1: now - 60000, a2: now - 30000, 'sx__w1': now - 900000 }, gone: new Set(), speakers: new Set(), act: {}, orderTs: {},
    agents: { main: { id: 'main' }, a1: { id: 'a1', name: 'wounds' }, a2: { id: 'a2', name: 'grips' }, 'sx__main': { id: 'sx__main', lead: true }, 'sx__w1': { id: 'sx__w1', name: 'figure route' }, user: { id: 'user' }, p_x: { id: 'p_x', type: 'peer' } } };
  const f = new Function('scope', 'with (scope) { ' + src + '\nreturn { agentState }; }')(pageScope({ S, L: (fr, en) => en, VANISH_MS: 600000, nameOf: (id) => S.agents[id].name || id, atTail: () => true, NEEDS_OK: /^$/, ASKS: /^$/, fmtShort: () => '' }));
  assert.deepEqual([f.agentState('main', now).k, f.agentState('main', now).txt], ['waiting', '⏳ waiting on wounds'], "gladiator 15:20: the Claude lead's turn ended while two sub-agents wrote: waiting, and they show");
  assert.equal(f.agentState('sx__main', now).k, 'done', 'another lead whose only worker went quiet 15 min ago: finished');
  S.seen['sx__w1'] = now - 5000; assert.equal(f.agentState('sx__main', now).k, 'waiting', 'its worker wrote 5 s ago: waiting');
});
test("everything: the screen moves to a clearly busier project only after the 20 s hold, says why, then holds that project's call", () => {
  const now = Date.now(), gg = { key: '/w/gladiator-game', name: 'gladiator-game' }, ms = { key: '/w/MarketSimulator', name: 'MarketSimulator' }, calls = [];
  const rows = [{ proj: '-w-glad', id: 'glad-claude', state: 'working', mtime: now - 5000, group: gg, subActive: 1, title: 'Combat' }, { proj: '-w-ms', id: 'ms-claude', state: 'waiting', mtime: now - 20000, group: ms, subActive: 6, title: 'Review the news gate' }];
  const S = { live: true, pin: '', cur: { proj: '-w-glad', id: 'glad-claude' }, group: gg, members: [{ proj: '-w-glad', id: 'glad-claude' }], autoPin: null, switchAt: now - 5000 }, prefs = { follow: 'all' };
  const src = [grab(/const BORDER = [^\n]*/), grab(/const boardKey = [^\n]*/), grab(/const ACT_MS = [^\n]*/), grab(/function projectActivity\(rows, now = Date\.now\(\)\) \{[\s\S]*?\n\}/), grab(/function followTarget\(rows, follow, curKey = '', now = Date\.now\(\)\) \{[\s\S]*?\n\}/), grab(/const inCall = [^\n]*/), grab(/function updateFollow\(rows\) \{[\s\S]*?\n\}/)].join('\n');
  const { updateFollow } = new Function('scope', 'with (scope) { ' + src + '\nreturn { updateFollow }; }')(pageScope({ S, prefs, FOLLOW_HOLD: 20000, followCurrent: () => calls.push(S.autoPin && S.autoPin.id) }));
  updateFollow(rows); assert.deepEqual(calls, [], 'within the hold: it stays');
  S.switchAt = now - 25000; updateFollow(rows); assert.deepEqual([calls, S.switchWhy.why, S.switchWhy.to], [['ms-claude'], 'busy', 'MarketSimulator'], 'after the hold: to MarketSimulator, saying why');
  Object.assign(S, { cur: { proj: '-w-ms', id: 'ms-claude' }, group: ms, members: [{ proj: '-w-ms', id: 'ms-claude' }], autoPin: null }); calls.length = 0;
  updateFollow(rows); assert.deepEqual([calls, S.autoPin], [[], { proj: '-w-ms', id: 'ms-claude' }], 'there: the busiest project holds the call, not the most recently written session anywhere');
});

// ---- round 13 (Tom: "the messages should be a bit volume normalized"; "I have no idea what voice is what tbh, maybe it's better voice per project")
function voiceEnv(over = {}) {
  const src = [grab(/const projKeyOf = [^\n]*/), grab(/const voicePool = [^\n]*/), grab(/function projectVoice\(key, pool, poolKey, live = liveProjectKeys\(\)\) \{[\s\S]*?\n\}/), grab(/const voiceOf = [^\n]*/)].join('\n');
  const env = { S: { group: { key: '/w/gladiator-game' }, agents: {} }, prefs: {}, TTS: { engine: 'elevenlabs' }, savePrefs() {}, hash: (x) => [...x].reduce((a, c) => a + c.charCodeAt(0), 0), ...over };
  const api = new Function('scope', 'with (scope) { ' + src + '\nreturn { projKeyOf, voicePool, projectVoice, voiceOf }; }')(pageScope(env));
  return { ...api, env, voiceFor: (p, live = new Set(['/w/gladiator-game', '/w/MarketSimulator'])) => api.projectVoice(api.projKeyOf(p), POOL, api.voicePool(false), live) };
}
const POOL = ['adam', 'roger', 'sarah', 'laura'];
test('voices: one per project, the same every time and after a restart; live projects get different ones; every agent of a project speaks in it', () => {
  const v = voiceEnv(), glad = v.voiceFor({ id: 'main' });
  assert.equal(glad, 'adam', 'the first project takes the first voice');
  assert.deepEqual(['a1', 'se7a982__main', 'se7a982__r1'].map((id) => v.voiceFor({ id })), ['adam', 'adam', 'adam'], 'its lead, its sub-agents, another session of it: one voice');
  const ms = v.voiceFor({ id: 'p_x', type: 'peer', group: { key: '/w/MarketSimulator' } }); assert.equal(ms, 'roger', 'another live project: another voice (a guest speaks in its own project\'s)');
  assert.equal(v.voiceFor({ id: 'far', projKey: '/w/MarketSimulator' }), 'roger', 'a line about MarketSimulator in Everything: its voice');
  assert.equal(v.voiceOf({ items: [{ far: '/w/MarketSimulator', agent: 'x' }] }).projKey, '/w/MarketSimulator');
  const saved = JSON.parse(JSON.stringify(v.env.prefs)), again = voiceEnv({ prefs: saved, S: { group: { key: '/w/MarketSimulator' }, agents: {} } });
  assert.deepEqual([again.voiceFor({ id: 'main' }), again.voiceFor({ id: 'p', type: 'peer', group: { key: '/w/gladiator-game' } })], ['roger', 'adam'], 'after a restart (the saved prefs): the same voices');
  v.env.prefs.projVoice.elevenlabs['/w/gladiator-game'] = 'laura'; assert.equal(v.voiceFor({ id: 'main' }), 'laura', 'a voice chosen in the settings sticks');
  const full = voiceEnv(); for (const k of ['a', 'b', 'c', 'd']) full.projectVoice('/w/' + k, POOL, 'elevenlabs', new Set(['/w/a', '/w/b', '/w/c', '/w/d', '/w/e']));
  assert.ok(POOL.includes(full.projectVoice('/w/e', POOL, 'elevenlabs', new Set(['/w/a', '/w/b', '/w/c', '/w/d', '/w/e']))), 'more live projects than voices: one is shared, never none');
  const sys = voiceEnv({ prefs: saved, TTS: { engine: 'system' } }); assert.equal(sys.projectVoice('/w/gladiator-game', ['fr-a', 'fr-b'], sys.voicePool(true), new Set()), 'fr-a', 'another pool (French system voices) has its own choice');
  assert.equal(saved.projVoice.elevenlabs['/w/gladiator-game'], 'adam', 'and leaves the ElevenLabs one alone');
});
test('loudness: every clip is brought to the same level, never clipped, silence ignored', () => {
  const src = [grab(/const LOUD_TARGET = [^\n]*/), grab(/function loudnessOf\(data, rate\) \{[\s\S]*?\n\}/), grab(/const normGain = [^\n]*/)].join('\n');
  const { loudnessOf, normGain, LOUD_TARGET, LOUD_PEAK } = new Function(src + '\nreturn { loudnessOf, normGain, LOUD_TARGET, LOUD_PEAK };')();
  const rate = 8000, tone = (amp, secs, lead = 0) => { const d = new Float32Array(Math.round(rate * (secs + lead))); for (let i = Math.round(rate * lead); i < d.length; i++) d[i] = amp * Math.sin(i * 0.3); return d; };
  const after = (d) => { const m = loudnessOf(d, rate), g = normGain(m); return { db: m.db + 20 * Math.log10(g), peak: m.peak * g }; };
  const quiet = after(tone(0.03, 1)), loud = after(tone(0.6, 1)), late = after(tone(0.1, 1, 2));
  assert.ok(Math.abs(quiet.db - LOUD_TARGET) < 0.5 && Math.abs(loud.db - LOUD_TARGET) < 0.5, `a quiet and a loud voice meet at the target: ${quiet.db.toFixed(1)} / ${loud.db.toFixed(1)} dB`);
  assert.ok(Math.abs(late.db - LOUD_TARGET) < 0.5, 'two seconds of silence first do not count');
  const spiky = new Float32Array(rate).fill(0.01); spiky[100] = 0.9; const s2 = after(spiky); assert.ok(20 * Math.log10(s2.peak) <= LOUD_PEAK + 0.01, 'a clip with a loud peak is raised only until its peak would clip');
  assert.equal(normGain(loudnessOf(new Float32Array(rate), rate)), 1, 'silence: left alone');
});
