// test/speech.test.js: what the voice reads, taken from the page's own functions: content only, cleaned of what cannot be spoken
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = (re) => { const m = re.exec(html); if (!m) throw new Error('function not found in index.html: ' + re); return m[0]; };
const src = grab(/const speakable = \(t\) =>[\s\S]*?\.trim\(\);/) + '\n' + grab(/function speechOf\(ev\) \{[^\n]*\}/);
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
