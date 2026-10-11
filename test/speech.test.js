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
  assert.deepEqual(freshPlan(evs, 0), { at: 4, silent: false });   // 30 s behind: skip to the fresh lines, and the report (a result) beats the message and the chatter
  assert.deepEqual(freshPlan(evs, 5), { at: 5, silent: false });   // 3 s old: read it
  assert.deepEqual(freshPlan(evs, 1), { at: 1, silent: false });   // not a line: nothing to decide
  const old = [{ kind: 'say', ts: T }, { kind: 'tools', ts: T + 40 * s }];
  assert.deepEqual(freshPlan(old, 0), { at: 0, silent: true });    // nothing fresher exists: shown, not read
  const tie = [{ kind: 'say', ts: T }, { kind: 'say', ts: T + 20 * s }, { kind: 'say', ts: T + 21 * s }, { kind: 'tools', ts: T + 22 * s }];
  assert.equal(freshPlan(tie, 0).at, 1);                            // same importance: the earliest fresh line
});

test('live speech: a line is never cut mid-sentence', () => {
  const { clipSpeech } = live;
  assert.equal(clipSpeech('Tests pass. Pushed to main. Next I review the board layout and fix the chips.', 30), 'Tests pass. Pushed to main.');
  assert.equal(clipSpeech('The fryer family recipe and inputs are frozen now and verified against the source.', 50), 'The fryer family recipe and inputs are frozen now and verified against the source.');   // one sentence longer than the cap (up to twice it): read whole
  const long = 'Ball revision four prepared, exact source verified, native jobs queued, ' + 'and more words follow here '.repeat(10);
  assert.equal(clipSpeech(long, 60), 'Ball revision four prepared, exact source verified, native jobs queued.');   // a runaway sentence ends at a clause break, not mid-word
  assert.equal(clipSpeech('Short.', 0), 'Short.');
});
