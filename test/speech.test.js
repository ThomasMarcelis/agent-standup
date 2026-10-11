// test/speech.test.js: what the voice reads, taken from the page's own functions: content only, cleaned of what cannot be spoken
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = (re) => { const m = re.exec(html); if (!m) throw new Error('function not found in index.html: ' + re); return m[0]; };
const src = grab(/const speakable = \(t\) =>[\s\S]*?\.trim\(\);/) + '\n' + grab(/const ATTR = [^\n]*/) + '\n' + grab(/function speechOf\(ev\) \{[^\n]*\}/);
const { speakable, speechOf } = new Function('baseText', 'FR', 'trMem', src + '\nreturn { speakable, speechOf };')((ev) => ev.text, () => false, new Map());

test('speakable: words only', () => {
  assert.equal(speakable('Pushed `05b296d` to `origin/main` 🎉, see https://example.com/x and /home/user/work/agent-standup/server.js'), 'Pushed to main , see link and server js');
  assert.equal(speakable('Run `npm test` then `node --test test/*.test.js`'), 'Run npm test then node test .test.js');   // flags and globs are not words
  assert.equal(speakable('ElevenLabs is ready ✓ — 25 voices (Adam first)'), 'Eleven Labs is ready, 25 voices , Adam first,');
  assert.equal(speakable('token sk-abcdefghijklmnopqrstuvwxyz0123456789 and a1b2c3d4e5f6a7b8 id'), 'token and id');
  assert.equal(speakable('ls -la /tmp && git status --short'), 'ls tmp && git status');
});

test('speechOf: the content of a line and nothing else; labels are shown, not read', () => {
  assert.equal(speechOf({ kind: 'order', to: 'a1', text: 'Review the plan and report back.' }), 'Review the plan and report back.');   // no "Socrates, " prefix
  assert.equal(speechOf({ kind: 'report', to: 'main', text: 'Found 12 record types.' }), 'Found 12 record types.');   // no "Done." prefix
  assert.equal(speechOf({ kind: 'msg', to: 'p_x', text: 'Scope update from Tom.', state: 'received' }), 'Scope update from Tom.');   // no sender name, no delivery state
  assert.equal(speechOf({ kind: 'msg', to: 'a1', text: 'message to Socrates (#1)', label: true, note: 'body not readable (Codex encrypts it)' }), '');   // a routing label only: silence
  assert.equal(speechOf({ kind: 'order', to: 'a1', text: 'task "oom_timeline" (default)', label: true }), '');
  assert.equal(speechOf({ kind: 'msg', to: 'a1', text: '', native: true }), '');
  assert.equal(speechOf({ kind: 'tools', agent: 'main', tools: [] }), ''); assert.equal(speechOf({ kind: 'finish', agent: 'a1', to: 'main' }), ''); assert.equal(speechOf(null), '');
  assert.equal(speechOf({ kind: 'say', text: 'Merged `main`: tests 6/6 ✅' }), 'Merged main: tests 6 6');
});

test('speechOf: who a message is from or for is not read (real openers from this machine)', () => {
  const say = (text) => speechOf({ kind: 'msg', to: 'p', text });
  assert.equal(say('From Hermes (record keeper, Discord thread with Tom + co-designer). New answers to your campaign-shape questions.'), 'New answers to your campaign-shape questions.');
  assert.equal(say("From Hermes, on Tom's instruction: align with Hermes on the league format."), "align with Hermes on the league format.");
  assert.equal(say('From the game director, for Tom: the half-hour duels, cause and proposal.'), 'the half-hour duels, cause and proposal.');
  assert.equal(say('From Tom via Hermes: just let it finish and merge.'), 'just let it finish and merge.');
  assert.equal(say('From Hermes. Tom, verbatim: the current voice is really ununderstandable.'), 'Tom, verbatim: the current voice is really ununderstandable.');
  assert.equal(say('To standup-fable: your diff is ready for review.'), 'your diff is ready for review.');
  assert.equal(say('Hi Astra, two follow-ups on your review.'), 'two follow-ups on your review.');
  assert.equal(say('Fable here (reply to uds:/run/user/1000/cc-socks/773260.sock). Plan + findings; please challenge.'), 'Plan + findings; please challenge.');
  assert.equal(say('From the logs, the OOM kill happened at 08:25 and the service restarted.'), 'From the logs, the OOM kill happened at 08:25 and the service restarted.');   // a sentence that starts with "From" is content
  assert.equal(say('Recorded your relayed league decisions in the gladiator-game repo.'), 'Recorded your relayed league decisions in the gladiator-game repo.');
});

// Live speech under load: the page's own freshness rule and sentence clipping
const live = new Function(grab(/const SPK = new Set[^\n]*/) + '\n' + grab(/const STALE_MS = [\s\S]*?\n\}/) + '\n' + grab(/function clipSpeech\(t, cap\) \{[\s\S]*?\n\}/) + '\nreturn { freshPlan, clipSpeech, STALE_MS };')();

test('live speech: nothing stale is read; when behind, the freshest line comes next, the most important first', () => {
  const { freshPlan } = live, s = 1000, T = 1.79e12;
  const evs = [{ kind: 'say', ts: T + 0 * s }, { kind: 'tools', ts: T + 2 * s }, { kind: 'say', ts: T + 5 * s }, { kind: 'msg', ts: T + 25 * s }, { kind: 'report', ts: T + 26 * s }, { kind: 'say', ts: T + 27 * s }, { kind: 'tools', ts: T + 30 * s }];
  const now = T + 31 * s;
  assert.deepEqual(freshPlan(evs, 0, now), { at: 4, silent: false });   // 30 s behind: skip to the fresh lines, and the report (a result) beats the message and the chatter
  assert.deepEqual(freshPlan(evs, 5, now), { at: 5, silent: false });   // 3 s old: read it
  assert.deepEqual(freshPlan(evs, 1, now), { at: 1, silent: false });   // not a line: nothing to decide
  const old = [{ kind: 'say', ts: T }, { kind: 'tools', ts: T + 40 * s }];
  assert.deepEqual(freshPlan(old, 0, T + 41 * s), { at: 0, silent: true });    // nothing fresher exists: shown, not read
  const tie = [{ kind: 'say', ts: T }, { kind: 'say', ts: T + 20 * s }, { kind: 'say', ts: T + 21 * s }, { kind: 'tools', ts: T + 22 * s }];
  assert.equal(freshPlan(tie, 0, T + 23 * s).at, 1);
  const quiet = [{ kind: 'say', ts: T }, { kind: 'say', ts: T + 2 * s }];
  assert.deepEqual(freshPlan(quiet, 1, T + 25 * s), { at: 1, silent: true });   // the newest line, but written 23 s ago by the clock: shown, not read
  assert.deepEqual(freshPlan(quiet, 1, T + 10 * s), { at: 1, silent: false });                            // same importance: the earliest fresh line
});

test('live speech: a line is never cut mid-sentence', () => {
  const { clipSpeech } = live;
  assert.equal(clipSpeech('Tests pass. Pushed to main. Next I review the board layout and fix the chips.', 30), 'Tests pass. Pushed to main.');
  assert.equal(clipSpeech('The fryer family recipe and inputs are frozen now and verified against the source.', 50), 'The fryer family recipe and inputs are frozen now and verified against the source.');   // one sentence longer than the cap (up to twice it): read whole
  const long = 'Ball revision four prepared, exact source verified, native jobs queued, ' + 'and more words follow here '.repeat(10);
  assert.equal(clipSpeech(long, 60), 'Ball revision four prepared, exact source verified, native jobs queued.');   // a runaway sentence ends at a clause break, not mid-word
  assert.equal(clipSpeech('Short.', 0), 'Short.');
});

test('live speech: the voice gets the whole line, not the bubble\'s cut (a long one is summarised, not truncated)', () => {
  const long = 'Seven of the nine window exports passed. ' + 'The two bay windows failed because their sill normals point inward, so they are being re-exported with flipped normals and validated again before the hand-back. '.repeat(2);
  assert.equal(speechOf({ kind: 'say', text: long }).length, speakable(long).length);
});

// The live voice director's policy (triage by a small model, held to rules it cannot break), with the model's answer mocked
const tri = new Function('speechOf', 'speakable', 'clipSpeech', grab(/const TRIAGE_WAIT = [\s\S]*?\/\/ ---- end triage policy/) + '\nreturn { triageItems, applyTriage, localPick, KEEP_MS, KEEP_LONG_MS };')((ev) => ev.text, speakable, live.clipSpeech);

test('voice director: stale lines are never sent, needs-you is never dropped, a malformed answer falls back', () => {
  const now = 1.79e12, s = 1000, ev = (agent, kind, ago, text) => ({ agent, kind, ts: now - ago * s, text });
  const evs = [ev('a1', 'say', 300, 'Old news from five minutes ago.'), ev('a1', 'report', 100, 'Report: all 412 tests pass after the auth race fix.'), ev('a2', 'say', 60, 'Chatter a minute old.'), ev('a3', 'say', 30, 'Waiting for approval to push to production.'), ev('a2', 'tools', 5, ''), ev('main', 'msg', 3, 'Fresh message from another session.')];
  const items = tri.triageItems(evs, new WeakSet(), now, new Set(['a3']));
  assert.deepEqual(items.map((it) => [it.id, it.kind, it.age]), [[1, 'report', 100], [2, 'needs_you', 30], [3, 'message', 3]]);   // 5 min old and 1 min old chatter: never sent; a report keeps 2 min; tool beats are not lines
  const done = new WeakSet(); items.forEach((it) => done.add(it.ev)); assert.equal(tri.triageItems(evs, done, now, new Set(['a3'])).length, 0);   // nothing is triaged twice
  const ok = tri.applyTriage(items, { drop: [2, 3], say: [{ ids: [1], line: 'All 412 tests pass after the **auth race** fix.' }, { ids: [99], line: 'invented' }, { ids: [3], line: 'third line' }] });
  assert.deepEqual(ok.map((o) => [o.line, o.items.map((it) => it.id)]), [['All 412 tests pass after the auth race fix.', [1]], ['third line', [3]], ['Waiting for approval to push to production.', [2]]]);   // unknown ids ignored, max 2 from the model, the dropped needs-you put back
  assert.equal(tri.applyTriage(items, 'not json'), null); assert.equal(tri.applyTriage(items, { say: 'x' }), null); assert.equal(tri.applyTriage(items, null), null);
  assert.deepEqual(tri.localPick(items).map((o) => o.items[0].id), [2]);   // fallback: what needs Tom first
  assert.deepEqual(tri.localPick(items.filter((it) => it.kind !== 'needs_you')).map((o) => o.items[0].id), [1]);   // else the report before the message
});

test('guests: an agent of another session is on the line only while the exchange is current (10 min)', () => {
  const { guestsAt } = new Function(grab(/const GUEST_MS = [\s\S]*?\n\}/) + '\nreturn { guestsAt };')();
  const m = 60e3, T = 1.79e12, agents = { main: { type: 'main' }, p_tip: { type: 'peer' }, p_live: { type: 'peer' } };
  const evs = [{ kind: 'msg', agent: 'main', to: 'p_tip', ts: T }, { kind: 'msg', agent: 'p_tip', to: 'main', ts: T + 1 * m }, { kind: 'say', agent: 'main', ts: T + 50 * m }, { kind: 'msg', agent: 'p_live', to: 'main', ts: T + 58 * m }];
  assert.deepEqual(guestsAt(evs, 3, T + 60 * m, agents).map((g) => [g.id, g.n]), [['p_live', 1]]);   // the tip asked an hour ago is gone; the current exchange is there
  assert.deepEqual(guestsAt(evs, 1, T + 2 * m, agents).map((g) => [g.id, g.n]), [['p_tip', 2]]);     // in a replay, at the time of the tip, it was on the line
  assert.deepEqual(guestsAt(evs, 3, T + 69 * m, agents), []);                                          // and every exchange expires
});
