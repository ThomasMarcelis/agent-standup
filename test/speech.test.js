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
  assert.equal(speechOf({ kind: 'msg', to: 'a1', text: 'message to Socrates (#1)', label: true, note: 'body not readable, Codex encrypts it' }), '');   // a routing label only: silence
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
const live = new Function(grab(/const SPK = new Set[^\n]*/) + '\n' + grab(/const STALE_MS = [\s\S]*?\n\}/) + '\n' + grab(/const SPEECH_MAX = [^\n]*/) + '\n' + grab(/function clipSpeech\(t, cap\) \{[\s\S]*?\n\}/) + '\nreturn { freshPlan, clipSpeech, STALE_MS };')();

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
  assert.deepEqual(tri.localPick(items).map((o) => o.items[0].id), [2, 1]);   // fallback: what needs Tom first, then the most important of the rest: two lines
  assert.deepEqual(tri.localPick(items.filter((it) => it.kind !== 'needs_you')).map((o) => o.items[0].id), [1, 3]);   // the report before the message
});

test('guests: an agent of another session is on the line only while the exchange is current (10 min)', () => {
  const { guestsAt } = new Function(grab(/const GUEST_MS = [\s\S]*?\n\}/) + '\nreturn { guestsAt };')();
  const m = 60e3, T = 1.79e12, agents = { main: { type: 'main' }, p_tip: { type: 'peer' }, p_live: { type: 'peer' } };
  const evs = [{ kind: 'msg', agent: 'main', to: 'p_tip', ts: T }, { kind: 'msg', agent: 'p_tip', to: 'main', ts: T + 1 * m }, { kind: 'say', agent: 'main', ts: T + 50 * m }, { kind: 'msg', agent: 'p_live', to: 'main', ts: T + 58 * m }];
  assert.deepEqual(guestsAt(evs, 3, T + 60 * m, agents).map((g) => [g.id, g.n]), [['p_live', 1]]);   // the tip asked an hour ago is gone; the current exchange is there
  assert.deepEqual(guestsAt(evs, 1, T + 2 * m, agents).map((g) => [g.id, g.n]), [['p_tip', 2]]);     // in a replay, at the time of the tip, it was on the line
  assert.deepEqual(guestsAt(evs, 3, T + 69 * m, agents), []);                                          // and every exchange expires
});

test('live speech: with no cap (a replay) a long line still ends at a sentence under the server\'s 600-character voice limit', () => {
  const { clipSpeech } = live, long = 'The pinsetter assembly passed its static checks. ' + 'Every rake, table and lift was measured against the saved source and the clearances hold everywhere it matters. '.repeat(8);
  const out = clipSpeech(long, 0); assert.ok(out.length <= 560, out.length); assert.match(out, /[.!?]$/); assert.ok(long.startsWith(out.slice(0, -1).replace(/[,;:]$/, '')));
  const one = 'A single sentence that runs on ' + 'and on, '.repeat(120) + 'until it ends.';
  const o2 = clipSpeech(one, 0); assert.ok(o2.length <= 561, o2.length); assert.match(o2, /and on\.$/);   // one runaway sentence ends at a clause break, whole words
});

test('board: a busy one-off run stays in its project; quiet rows fold into one line', () => {
  const { boardKey, splitGroup } = new Function(grab(/const boardKey = [^\n]*/) + '\n' + grab(/const isQuiet = [^\n]*/) + '\n' + grab(/const splitGroup = [^\n]*/) + '\nreturn { boardKey, splitGroup };')();
  const ms = { key: '/w/MarketSimulator', name: 'MarketSimulator' };
  assert.equal(boardKey({ oneshot: true, state: 'working', group: ms }), '/w/MarketSimulator');   // a working codex exec in MarketSimulator
  assert.equal(boardKey({ oneshot: true, state: 'idle', group: ms }), '_other');                  // a finished one-off: "Other / single"
  assert.equal(boardKey({ state: 'idle', group: { key: '_other', other: true } }), '_other'); assert.equal(boardKey({ state: 'working' }), '_other');
  const rows = ['working', 'idle', 'turn', 'done', 'idle'].map((state, i) => ({ state, i }));
  const sp = splitGroup(rows, false); assert.deepEqual(sp.cards.map((r) => r.state), ['working', 'turn']); assert.deepEqual(sp.quiet.map((r) => r.state), ['idle', 'done', 'idle']);
  assert.equal(splitGroup(rows, true).cards.length, 5);
});

test('calls rail: "Follow: everything" goes to a session that needs Tom; following a project goes to its most urgent session', () => {
  const { followTarget } = new Function(grab(/const BORDER = [^\n]*/) + '\n' + grab(/const boardKey = [^\n]*/) + '\n' + grab(/function followTarget\(rows, follow\) \{[\s\S]*?\n\}/) + '\nreturn { followTarget };')();
  const gg = { key: '/w/gladiator-game', name: 'gladiator-game' }, ms = { key: '/w/MarketSimulator', name: 'MarketSimulator' };
  const rows = [{ id: 'a', state: 'working', mtime: 3, group: ms }, { id: 'b', state: 'blocked', mtime: 1, group: gg }, { id: 'c', state: 'turn', mtime: 5, group: ms }, { id: 'd', state: 'idle', mtime: 9, group: ms }];
  assert.equal(followTarget(rows, 'all').id, 'b');                                     // the one that needs Tom, wherever it is
  assert.equal(followTarget(rows.filter((r) => r.id !== 'b'), 'all'), null);           // nobody needs Tom: the server's most active session
  assert.equal(followTarget(rows, 'g:/w/MarketSimulator').id, 'a');                     // in a project: working before your turn before idle
});

// the page's own label helpers (round 5: L1 "(#2)" stays "(#2)", L2 a shell script or a JS wrapper is not a label)
const plain = new Function(grab(/const plain = \(t\) =>[^\n]*/) + '\nreturn plain;')();
const cmdLabel = new Function(grab(/function cmdLabel\(text\) \{[\s\S]*?\n\}/) + '\nreturn cmdLabel;')();
test('plain keeps "(#2)" and drops markdown headers; cmdLabel says what a command is', () => {
  assert.equal(plain('message to integration recovery (#2) and ## Heading\n# Title'), 'message to integration recovery (#2) and Heading Title');
  assert.equal(cmdLabel("set -e;\ncd /home/user/work && npm test"), 'npm test');
  assert.equal(cmdLabel("python3 - <<'PY'\nfrom pathlib import Path"), 'python3 script');
  assert.equal(cmdLabel('const names=ALL_TOOLS.map((t) => t.name);'), '');   // a Codex exec script's JS wrapper is nothing to read out
  assert.equal(cmdLabel('text("TR-89-01 source", await tools.exec_command({ cmd: "ls" }))'), '');
  assert.equal(cmdLabel('git status --short'), 'git status --short');
  assert.equal(cmdLabel('agent-peers send "uds:/run/user/1000/cc-socks/hermes-23420a452cbc448e92f373954024120c.sock" --file brief.md'), 'agent-peers send --file brief.md');   // an inbox address is no label
});

// the calls rail and the agents list (Tom, round 5): plain words, one vocabulary, only what is live
const rail = new Function('L', 'esc', 'S', grab(/const base = \(f\) =>[^\n]*/) + '\n' + grab(/function cmdLabel\(text\) \{[\s\S]*?\n\}/) + '\n' + grab(/function cmdVerb\(cmd\) \{[\s\S]*?\nfunction activityLabel/).replace(/\nfunction activityLabel$/, '') + '\n' + grab(/const agoStr = [^\n]*/) + '\n' + grab(/const boardKey = [^\n]*/) + '\n' + grab(/const LIVE_MS = [\s\S]*?\nconst railGroup = [^\n]*/) + '\nreturn { cmdVerb, plainAct, callStatus, agentStatus, railSplit, railGroup };')((fr, en) => en, (t) => t, { act: { a1: 'Reading spec.md' } });
test('rail: what a session does is said in words, never as the command line', () => {
  assert.equal(rail.plainAct('Bash', "sed -n '385,430p' /home/user/work/agent-standup/public/index.html"), 'Reading index.html');
  assert.equal(rail.plainAct('Bash', 'cd /home/user/work && npm test'), 'Running tests');
  assert.equal(rail.plainAct('exec_command', 'python3 -c "'), 'Running a script');
  assert.equal(rail.plainAct('exec_command', "D=/home/user/runs/x; cd $D/harness && python3 - <<'EOF'"), 'Running a script');
  assert.equal(rail.plainAct('Bash', 'L=/home/user/work/g\nfor f in a b; do echo $f; done'), 'Running a script');
  assert.equal(rail.plainAct('Bash', 'ps -eo pid,ppid,etime,args | grep -E dotnet'), 'Searching files');
  assert.equal(rail.plainAct('mcp__plugin_playwright_playwright__browser_run_code_unsafe', ''), 'Using the browser');
  assert.equal(rail.plainAct('Edit', '/home/user/work/server.js'), 'Editing server.js');
  assert.equal(rail.plainAct('Bash', 'git status --short'), 'Checking changes');
  // never a binary's name (Tom): git add/commit is committing, sleep is waiting, anything else is a script or a command
  for (const [cmd, want] of [['git add -A && git commit -m x', 'Committing'], ['git commit -qF -', 'Committing'], ['git push origin main', 'Pushing'], ['sleep 30', 'Waiting'], ['echo hello', 'Running a command'], ['install -m 0755 a ~/.local/bin/a', 'Managing files'], ['node scripts/stats.js', 'Running a script'], ['tmux capture-pane -pt x', 'Using a terminal']]) assert.equal(rail.plainAct('Bash', cmd), want, cmd);
  assert.equal(rail.plainAct('Sleep', ''), 'Waiting'); assert.equal(rail.plainAct('apply_patch', "python3 - <<'PY'"), 'Editing files'); assert.equal(rail.plainAct('skill_manage', ''), 'Using a skill');
  for (const cmd of ['python3 x.py', 'sleep 5', 'git add .', 'echo x', 'dotnet build -c Release', 'jq .a f.json', 'awk 1 f', 'perl -e 1']) assert.ok(!/(python3?|sleep|git|echo|dotnet|awk|perl)/.test(rail.plainAct('Bash', cmd)), 'no binary name: ' + rail.plainAct('Bash', cmd));
  assert.equal(rail.plainAct('Bash', '"$D/run.sh" --fast'), 'Running a script'); assert.equal(rail.plainAct('Bash', '(cd x; make)'), 'Running a script');
});
test('rail: one vocabulary for calls and agents, "N agents" only past one', () => {
  const now = Date.now();
  assert.equal(rail.callStatus({ state: 'working', tool: 'Bash', arg: 'npm test', mtime: now, ageMs: 4000 }), 'Running tests');   // the green dot says working
  assert.equal(rail.callStatus({ state: 'blocked', tool: 'Edit', arg: 'src/a.ts', mtime: now, ageMs: 48000 }), 'Needs you: editing a.ts, 48s');
  assert.equal(rail.callStatus({ state: 'waiting', active: ['materials', 'stair artist'], mtime: now }), 'Waiting on materials, stair artist');
  assert.equal(rail.callStatus({ state: 'idle', mtime: now - 600e3 }), 'Idle 10 min');
  assert.equal(rail.callStatus({ state: 'turn', mtime: now - 120e3 }), 'Finished, 2 min');
  assert.equal(rail.agentStatus('a1', { k: 'working' }), 'Reading spec.md');
  assert.equal(rail.agentStatus('a2', { k: 'stalled', on: ['b1'] }), 'Waiting on b1, no news');
  assert.equal(rail.agentStatus('main', { k: 'done' }), 'Finished'); assert.equal(rail.agentStatus('a3', { k: 'done' }), 'Done');
});
test('a session that ended its turn is finished, then idle after 5 minutes, never "needs you"; "needs you" is a real ask', () => {
  const now = Date.now(), { isQuiet, BSTATE } = new Function('L', grab(/const isQuiet = [^\n]*/) + '\n' + grab(/const BSTATE = [^\n]*/) + '\nreturn { isQuiet, BSTATE };')((fr, en) => en);
  assert.equal(rail.callStatus({ state: 'turn', mtime: now - 600e3 }), 'Idle 10 min');
  assert.deepEqual([isQuiet({ state: 'turn', mtime: now - 60e3 }, now), isQuiet({ state: 'turn', mtime: now - 600e3 }, now)], [false, true]);
  assert.ok(!/your turn/i.test(JSON.stringify(BSTATE)) && !/your turn/i.test(html.replace(/\/\/[^\n]*/g, '')), 'the words "your turn" are gone');
  const sp = rail.railSplit([{ id: 'x', state: 'turn', mtime: now - 60e3, group: { key: 'k', name: 'p' } }], '', now); assert.deepEqual([sp.needs.length, sp.live.length], [0, 1]);   // finished is not needs you
  assert.equal(rail.callStatus({ state: 'blocked', tool: 'AskUserQuestion', mtime: now, ageMs: 5000 }), 'Needs you: asking a question, 5s');
  assert.equal(rail.plainAct('mcp__codex_tui__read_thread', '01a12b06-a451-7000-8000-000000000000'), 'Read thread', 'a tool in words, no id');
  assert.equal(rail.plainAct('SubagentHandback', ''), 'Reporting back'); assert.equal(rail.plainAct('cronjob_manage', ''), 'Cronjob manage');
});
test('rail: only what is live (busy, active in the last 5 min, needs Tom, on screen); stopped, done, old and one-offs are not shown; the rest is quiet', () => {
  const now = Date.now(), g = { key: 'repo:/w/game', name: 'gladiator-game' }, r = (id, state, ago, x = {}) => ({ id, state, mtime: now - ago, group: g, ...x });
  const rows = [r('ask', 'blocked', 30e3), r('busy', 'working', 20e3), r('fresh', 'turn', 120e3), r('sat', 'turn', 600e3), r('idle', 'idle', 1800e3), r('here', 'idle', 7200e3),
    r('stopped', 'idle', 60e3, { stopped: true }), r('done', 'done', 30e3), r('cron', 'turn', 60e3, { oneshot: true }), r('old', 'idle', 3 * 3600e3), r('ping', 'working', 5e3, { oneshot: true, group: { key: '_other', other: true, name: 'Other' } })];
  const sp = rail.railSplit(rows, 'here', now), ids = (l) => l.map((x) => x.id);
  assert.deepEqual([ids(sp.needs), ids(sp.live), ids(sp.quiet)], [['ask'], ['busy', 'fresh', 'here'], ['sat', 'idle', 'ping']]);   // a running one-off outside any project (a test ping) is quiet
  assert.equal(rail.railGroup({ group: { key: 'hermes:gaming:t1', name: 'Hermes gaming, Plan the roguelike', hermes: true } }), 'Hermes gaming');   // the thread is said once, on its row
});

// a message between agents is heard with a very short route (Tom, round 5): project and role, at most 4 words; other lines stay content only
test('route: who to whom in project and role, never more than 4 words, the project left out inside the project on screen', () => {
  const S = { group: { key: 'repo:/w/gladiator-game', name: 'gladiator-game' }, agents: {
    main: { id: 'main', role: 'Lead' }, sub: { id: 'sub', role: 'general-purpose', name: 'Build parrying decision page' },
    herm: { id: 'herm', type: 'peer', name: 'hermes:gaming:218dccb6', role: 'Hermes gaming, Plan gladiator roguelike autobattler', group: { key: 'hermes:gaming:t', name: 'Hermes gaming, Plan gladiator roguelike autobattler', hermes: true } },
    cdx: { id: 'cdx', type: 'peer', name: 'codex:respond-to-greeting-8d76', role: 'Codex, gladiator-game', group: { key: 'repo:/w/gladiator-game', name: 'gladiator-game' } },
    ms: { id: 'ms', type: 'peer', name: 'codex:marketsimulator-44d9', role: 'Codex, MarketSimulator', group: { key: 'repo:/w/MarketSimulator', name: 'MarketSimulator' } },
    astra: { id: 'astra', type: 'peer', name: 'Astra', role: 'Codex, agent-standup', group: { key: 'repo:/w/agent-standup', name: 'agent-standup' } } } };
  const { routeOf, ROUTE_MAX } = new Function('S', 'L', grab(/const projWord = [^\n]*/) + '\n' + grab(/function party\(p\) \{[\s\S]*?\n\}/) + '\n' + grab(/function routeOf\(ev\) \{[\s\S]*?\n\}/) + '\nconst ROUTE_MAX = 4;\nreturn { routeOf, ROUTE_MAX };')(S, (fr, en) => en);
  const cases = [[{ agent: 'main', to: 'herm' }, 'To Hermes'], [{ agent: 'main', to: 'cdx' }, 'To Codex'], [{ agent: 'ms', to: 'main' }, 'Gladiator lead, from Codex'], [{ agent: 'sub', to: 'main' }, 'To the lead'],
    [{ agent: 'main', to: 'astra' }, 'To Astra'], [{ agent: 'herm', to: 'sub' }, 'Gladiator sub-agent, from Hermes'], [{ agent: 'main', to: 'ms' }, 'To MarketSimulator Codex']];
  for (const [ev, want] of cases) { const r = routeOf(ev); assert.equal(r, want); assert.ok(r.split(/\s+/).length <= ROUTE_MAX, r); assert.ok(!/218dccb6|respond-to-greeting|Build parrying|roguelike|#\d/.test(r), 'no title, session name or id: ' + r); }
});
test('route: the director starts a message line with its route, whatever the model wrote; a mixed line or a report has none', () => {
  const ev = { ts: Date.now(), kind: 'msg', agent: 'a', text: 'The armour numbers are in.' }, its = [{ id: 1, kind: 'message', ev, text: ev.text, route: 'To gladiator Hermes' }, { id: 2, kind: 'report', ev: { ts: Date.now() }, text: 'Done.' }];
  const say = (line, ids) => tri.applyTriage(its, { say: [{ line, ids }], drop: [] })[0].line;
  assert.equal(say('The armour numbers are in.', [1]), 'To gladiator Hermes: The armour numbers are in.');
  assert.equal(say('From the game director of the gladiator project to Hermes: the armour numbers are in.', [1]), 'To gladiator Hermes: the armour numbers are in.');
  assert.equal(say('Results: the armour numbers are in, and the report is done.', [1, 2]), 'Results: the armour numbers are in, and the report is done.');
  assert.equal(tri.localPick([its[0]])[0].line, 'To gladiator Hermes: The armour numbers are in.');
});

test('no chatter level (Tom, round 5): the setting is gone, a saved Quiet is migrated once, the director narrates everything it can carry', () => {
  assert.ok(!/chatSel|Chatter between agents/.test(html), 'no chatter setting in the page');
  const prefs = { chat: 'quiet' }; new Function('prefs', grab(/if \(!prefs\.chatOnce\) [^\n]*/))(prefs); assert.deepEqual(prefs, { chatOnce: true });
  const now = Date.now(), it = (id, kind, ago) => ({ id, kind, ev: { ts: now - ago }, text: 'Line ' + id + '.' });
  assert.equal(tri.localPick([it(1, 'message', 3000), it(2, 'report', 2000), it(3, 'order', 1000)]).length, 2, 'without the model, two lines, not one');
});

test('denoise: a peer is named by what it is, never by an inbox id (a Hermes thread by its title, a Codex thread by its words)', () => {
  const peerWords = new Function(grab(/const peerWords = [\s\S]*?\n  return [^\n]*/) + '\nreturn peerWords;')();
  assert.equal(peerWords('hermes:gaming:218dccb6', { key: 'hermes:gaming:t', name: 'Hermes gaming, Plan gladiator roguelike autobattler', hermes: true }), 'Plan gladiator roguelike autobattler');
  assert.equal(peerWords('hermes:gaming:8f1d7b26'), 'Hermes gaming');
  assert.equal(peerWords('codex:respond-to-greeting-8d76'), 'respond to greeting');
  assert.equal(peerWords('standup-round5-opus'), 'standup-round5-opus');
});

test('project switcher: per project, its live calls, agents working and who needs Tom; those that need him first, then the most active; quiet projects have no live call', () => {
  const sw = new Function('L', grab(/const boardKey = [^\n]*/) + '\n' + grab(/const LIVE_MS = [\s\S]*?\nfunction railSplit\(rows, curId, now = Date\.now\(\)\) \{[\s\S]*?\n\}/) + '\n' + grab(/function projectCounts\(rows, now = Date\.now\(\)\) \{[\s\S]*?\n\}/) + '\n' + grab(/const projLine = [^\n]*/) + '\nreturn { projectCounts, projLine };')((fr, en) => en);
  const now = Date.now(), G = (k, n) => ({ key: k, name: n }), r = (id, g, state, ago, x = {}) => ({ id, group: g, state, mtime: now - ago, ...x });
  const ms = G('repo:/w/ms', 'MarketSimulator'), gl = G('repo:/w/gl', 'gladiator-game'), st = G('repo:/w/as', 'agent-standup');
  const rows = [r('m1', ms, 'working', 5e3, { subActive: 12 }), r('m2', ms, 'working', 9e3), r('m3', ms, 'blocked', 30e3), r('m4', ms, 'idle', 1800e3),
    r('g1', gl, 'working', 3e3, { subActive: 30 }), r('s1', st, 'idle', 1200e3), r('s2', st, 'done', 60e3), r('o1', { key: '_other', other: true, name: 'Other' }, 'working', 1e3, { oneshot: true })];
  const list = sw.projectCounts(rows, now);
  assert.deepEqual(list.map((p) => [p.name, p.calls, p.agents, p.needs]), [['MarketSimulator', 3, 15, 1], ['gladiator-game', 1, 31, 0], ['agent-standup', 0, 0, 0]]);   // needs Tom first, though gladiator has more agents; the quiet one last; no "Other"
  assert.equal(sw.projLine(list[0]), '3 calls, 15 agents working, 1 needs you'); assert.equal(sw.projLine(list[2]), '0 calls, 0 agents working');
  assert.ok(!/·/.test(list.map(sw.projLine).join(' ')));
});

test('a shirt says its role in whole words, short enough to be read on a small tile', () => {
  const shirtRole = new Function(grab(/const shirtRole = [^\n]*/) + '\nreturn shirtRole;')();
  assert.equal(shirtRole('Build parrying decision page'), 'Build parrying'); assert.equal(shirtRole('Build target-picking decision page'), 'Build target');
  assert.equal(shirtRole('Second cold read of page'), 'Second cold'); assert.equal(shirtRole('materials'), 'materials'); assert.equal(shirtRole('Supercalifragilisticexpialidocious'), 'Supercalifragi');
  for (const t of ['Research real target picking', 'Initialize Codex peer inbox at session start']) { const r = shirtRole(t); assert.ok(r.length <= 14 && !/…$/.test(r) && t.startsWith(r), r); }
});

test('board card (denoised): who, what now, talks to whom, needs you, in plain words; nothing twice, no raw tool name, id or counter', () => {
  const src = [grab(/const base = \(f\) =>[^\n]*/), grab(/function cmdLabel\(text\) \{[\s\S]*?\n\}/), grab(/function cmdVerb\(cmd\) \{[\s\S]*?\nfunction activityLabel/).replace(/\nfunction activityLabel$/, ''), grab(/const agoStr = [^\n]*/), grab(/const LIVE_MS = [^\n]*/), grab(/const peerWords = [\s\S]*?\n  return [^\n]*/), grab(/function boardCard\(r\) \{[\s\S]*?\n\}/)].join('\n');
  const boardCard = new Function('L', 'esc', 'S', src + '\nreturn boardCard;')((fr, en) => en, (t) => String(t), { act: {} }), now = Date.now();
  const codex = boardCard({ proj: '_codex', id: 'x1', title: 'Respond to greeting', state: 'working', tool: 'exec_command', arg: "python3 - <<'PY'", mtime: now, ageMs: 54000, source: 'codex', subTotal: 5, active: ['materials', 'stair artist'], peers: ['hermes:gaming:218dccb6', 'codex:respond-to-greeting-8d76'], group: { key: 'repo:/w/g', name: 'gladiator-game' } });
  assert.match(codex, /Running a script/); assert.match(codex, /Codex, 6 agents, working: materials, stair artist/); assert.match(codex, /Talks to Hermes gaming, respond to greeting/);
  assert.ok(!/exec_command|218dccb6|8d76|✉|👥|gladiator-game|·|54s/.test(codex), 'no raw tool, id, counter, repeated project or timing: ' + codex);
  const herm = boardCard({ proj: '_hermes-default', id: 'h1', title: 'Initialize Codex peer inbox', state: 'blocked', tool: 'clarify', mtime: now, ageMs: 48000, source: 'hermes', group: { key: 'hermes:default:t', name: 'Hermes default, Initialize Codex peer inbox', hermes: true } });
  assert.ok(!/<div class="bt">/.test(herm), 'the thread is the header, not said again on the card'); assert.match(herm, /class="needs">Needs you: asking a question, 48s/); assert.match(herm, /class="bcard needs"/);
});

test('the page script parses (a syntax error anywhere would leave the page blank; the other tests only take pieces of it)', () => {
  const i = html.lastIndexOf('<script>'), j = html.lastIndexOf('</script>');
  assert.doesNotThrow(() => new Function(html.slice(i + 8, j)));   // compiled, not run
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.equal((css.match(/\/\*/g) || []).length, (css.match(/\*\//g) || []).length, 'every CSS comment is closed (an open one hides the rules after it)');
});
