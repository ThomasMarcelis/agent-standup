// test/adapters.test.js: the Codex and Hermes adapters against trimmed, anonymised copies of real logs (test/fixtures), and the peer-message helpers
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-adapters-'));
process.env.CODEX_HOME = path.join(tmp, 'codex'); process.env.AGENT_STANDUP_HERMES = path.join(tmp, 'hermes'); process.env.AGENT_PEERS_HOME = path.join(tmp, 'peers'); process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude'); process.env.AGENT_STANDUP_PROJECTS = path.join(tmp, 'claude', 'projects');
const peers = require('../adapters/peers.js'), codex = require('../adapters/codex.js'), hermes = require('../adapters/hermes.js');
const fix = (f) => path.join(__dirname, 'fixtures', f), pad = (n) => String(n).padStart(2, '0');
const PARENT = '01a129a4-2285-7570-bb72-7ee60fd76f49', CHILD = '01a129a4-a0dd-7271-a213-51d0e57eeeff';
{   // the rollouts go where Codex would have written them today (the index lists the last days' folders), before anything scans
  const d = new Date(), dir = path.join(tmp, 'codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fix('codex-parent.jsonl'), path.join(dir, `rollout-2026-10-11T08-26-25-${PARENT}.jsonl`)); fs.copyFileSync(fix('codex-child.jsonl'), path.join(dir, `rollout-2026-10-11T08-26-57-${CHILD}.jsonl`));
}

test('peer message helpers: addresses, both frames, delivery states', () => {
  assert.deepEqual(peers.parseAddress('uds:/run/user/1000/cc-socks/codex-9f73ec26c5009ae5.sock'), { addr: 'uds:/run/user/1000/cc-socks/codex-9f73ec26c5009ae5.sock', key: 'codex-9f73ec26c5009ae5', kind: 'codex' });
  assert.equal(peers.parseAddress('uds:/run/user/1000/cc-socks/773260.sock').kind, 'claude'); assert.equal(peers.parseAddress('uds:/x/hermes-' + 'a'.repeat(32) + '.sock').kind, 'hermes'); assert.equal(peers.parseAddress('claude:bob'), null);
  assert.match(peers.peerId('codex:a.b/c'), /^p_[\w-]+$/);
  const cc = peers.incoming('Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/hermes-' + 'b'.repeat(32) + '.sock" from-name="hermes:gaming:cb050161">\nHello there\n\n(From hermes:gaming:cb050161, a Hermes profile with a private reply inbox. Use your peer messaging tool to reply to the sender address.)\n</cross-session-message>\n\nThis came from another Claude session');
  assert.deepEqual(cc, { addr: 'uds:/run/user/1000/cc-socks/hermes-' + 'b'.repeat(32) + '.sock', name: 'hermes:gaming:cb050161', msgId: '', text: 'Hello there' });
  const pm = peers.incoming('Another agent session (marketsimulator-c1) sent you a message. It is not from your user.\n<peer_message from="marketsimulator-c1" reply_to="uds:/run/user/1000/cc-socks/20178.sock" id="61b7a887-aa09-4081-ab19-feecbd08dee1">\nTwo follow-ups\n</peer_message>\nCollaborate within');
  assert.deepEqual(pm, { addr: 'uds:/run/user/1000/cc-socks/20178.sock', name: 'marketsimulator-c1', msgId: '61b7a887-aa09-4081-ab19-feecbd08dee1', text: 'Two follow-ups' });
  assert.equal(peers.incoming('plain text'), null);
  assert.equal(peers.sendState("Delivered to claude:x's inbox. Any reply arrives as a message in this conversation."), 'accepted');
  assert.equal(peers.sendState("Delivered to claude:x's inbox; its session is holding it for its user's approval."), 'held');
  assert.equal(peers.sendState('Not delivered to claude:x: rejected.'), 'failed'); assert.equal(peers.sendState('connect ENOENT', true), 'failed');
  assert.equal(peers.peerAgent('uds:/run/user/1000/cc-socks/codex-9f73ec26c5009ae5.sock').link, null);   // nothing on this machine owns it
  const book = new Map([['gladiator-game-c3', 'uds:/run/user/1000/cc-socks/2055838.sock']]);
  assert.equal(peers.peerAgent('claude:gladiator-game-c3', '', book).id, peers.peerAgent('uds:/run/user/1000/cc-socks/2055838.sock').id);   // a send by name meets the arrival from that address
});

test('codex: rollouts become sessions, a board and a timeline with sub-agents, commands, patches and peer messages', () => {
  const rows = codex.list(); assert.equal(rows.length, 1);   // the child is part of its parent's session, not a session of its own
  assert.deepEqual([rows[0].proj, rows[0].id, rows[0].agents, rows[0].source, rows[0].project], ['_codex', PARENT, 1, 'codex', '/home/user']);
  assert.match(rows[0].title, /^I have applications stopping because of out of memory/);   // the prompt, not the AGENTS.md or environment wrapper
  const b = codex.board(); assert.equal(b.length, 1); assert.equal(b[0].subTotal, 1); assert.deepEqual(b[0].peers, ['marketsimulator-c1']); assert.equal(b[0].msgs, 2);
  assert.ok(codex.exists('_codex', PARENT) && codex.exists('_codex', CHILD) && !codex.exists('_codex', '01a129a4-0000-7000-8000-000000000000'));
  assert.ok(codex.stamp('_codex', PARENT) > 0 && codex.mtime('_codex', PARENT) > 0);
  const tl = codex.timeline('_codex', PARENT), kinds = {}; for (const e of tl.events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  assert.equal(tl.agents.find((a) => a.id === 'main').name, 'Codex');
  const child = tl.agents.find((a) => a.id === CHILD); assert.ok(child); assert.deepEqual([child.name, child.role, child.nick], ['oom timeline', '/root', 'Socrates']);   // its path segment as its name, the parent path as the role, the invented nickname aside
  assert.deepEqual(tl.group, { key: '_other', name: 'user', other: true });   // the fixture's cwd (/home/user) is no repository on this machine
  const order = tl.events.find((e) => e.kind === 'order'); assert.deepEqual([order.agent, order.to, order.title], ['main', CHILD, 'oom_timeline']);
  assert.ok(tl.events.some((e) => e.kind === 'finish' && e.agent === CHILD), 'SubAgentActivity completed → finish');
  assert.ok(tl.events.some((e) => e.kind === 'report' && e.agent === CHILD && /OOM kill/.test(e.text)), 'the child\'s last message is its report');
  const tools = tl.events.filter((e) => e.kind === 'tools').flatMap((e) => e.tools);
  const cmd = tools.find((t) => t.d.kind === 'cmd'); assert.match(cmd.d.text, /^pwd; date/); assert.equal(cmd.name, 'exec_command');   // the shell command inside the exec script, not the JavaScript
  const res = tl.events.filter((e) => e.kind === 'results').flatMap((e) => e.items).find((it) => it.id === cmd.id); assert.match(res.out, /^\$ pwd; date[\s\S]*\n\/home\/user/);
  assert.ok(tools.some((t) => t.name === 'send_message' || t.name === 'wait_agent') === false, 'collaboration calls are edges or waits, not shown as tools when they are messages');
  const native = tl.events.filter((e) => e.kind === 'msg' && e.native); assert.ok(native.length >= 2); assert.ok(native.every((e) => e.to === CHILD || e.agent === CHILD || e.to === 'x_oom_controls'));   // the second agent's rollout is not in the fixture, so it is a placeholder
  assert.ok(native.some((e) => e.to === CHILD) && native.some((e) => e.agent === CHILD && e.to === 'main')); assert.equal(tl.agents.find((a) => a.id === 'x_oom_controls').type, 'peer');
  // the bodies are encrypted: every edge still gets a readable summary (the verb, target and count, or the child's own words) and a note, never the ciphertext
  assert.ok(native.every((e) => e.text && e.note === 'body not readable (Codex encrypts it)' && !/gAAAAA/.test(e.text)));
  assert.match(native.find((e) => e.to === CHILD).text, /^message to oom timeline \(#1\)$/); assert.match(native.find((e) => e.to === 'x_oom_controls').text, /^message to oom_controls \(#1\)$/);
  const fromChild = native.find((e) => e.agent === CHILD && e.to === 'main'); assert.ok(/^(Journal evidence|message to Codex)/.test(fromChild.text), fromChild.text);   // its report, when the message is its last word
  assert.deepEqual([order.text, order.note], ['task "oom_timeline" (default)', 'body not readable (Codex encrypts it)']);
  const { assemble } = require('../adapters/timeline.js');   // a nested agent's relative target resolves against its own path; an agent outside the files still gets an edge
  const deep = assemble({ id: 'x', proj: '_codex', agents: { main: { id: 'main', role: 'Lead', type: 'main' }, k: { id: 'k', role: '/root/kitchen', type: 'worker' }, p: { id: 'p', role: '/root/kitchen/pizza', type: 'worker' } }, childByPath: { '/root': 'main', '/root/kitchen': 'k', '/root/kitchen/pizza': 'p' }, pathOf: { main: '/root', k: '/root/kitchen', p: '/root/kitchen/pizza' },
    states: [{ agent: 'k', raw: [{ ts: 1, agent: 'k', kind: 'msg', native: true, target: 'pizza', text: '' }, { ts: 2, agent: 'k', kind: 'msg', native: true, target: '/root', text: '' }, { ts: 3, agent: 'k', kind: 'msg', native: true, target: 'ghost', text: '' }] }, { agent: 'p', raw: [{ ts: 4, agent: 'p', kind: 'msg', native: true, target: 'kitchen', text: '' }] }] });
  assert.deepEqual(deep.events.map((e) => [e.agent, e.to]), [['k', 'p'], ['k', 'main'], ['k', 'x_ghost'], ['p', 'k']]); assert.equal(deep.agents.find((a) => a.id === 'x_ghost').type, 'peer');
  const usage = tl.events.filter((e) => e.kind === 'usage'); assert.ok(usage.length >= 5 && usage.every((u) => u.model === 'gpt-6-astra' && u.u.i >= 0));
  const seen = new Set(fs.readFileSync(fix('codex-parent.jsonl'), 'utf8').split('\n').filter((l) => l.includes('token_usage_record')).map((l) => JSON.parse(l).payload.response_id)); assert.equal(usage.filter((u) => u.agent === 'main').length, seen.size);   // one per API response, duplicates dropped
  const out = tl.events.find((e) => e.kind === 'msg' && !e.native && e.agent === 'main'), inn = tl.events.find((e) => e.kind === 'msg' && !e.native && e.to === 'main');
  assert.equal(out.to, inn.agent, 'the send to the address and the arrival from it are the same peer'); assert.equal(out.state, 'accepted'); assert.equal(inn.state, 'received');
  const peer = tl.agents.find((a) => a.id === out.to); assert.deepEqual([peer.type, peer.name, peer.role], ['peer', 'marketsimulator-c1', 'Claude Code']);
  assert.match(out.text, /^Starting user-authorized/); assert.match(inn.text, /^Lakeshore build coordination/);
  assert.ok(!JSON.stringify(tl).includes('gAAAAA'), 'no encrypted payload reaches the page');
});

test('hermes: the SQLite store becomes sessions, a board and a timeline with delegations, tools and peer messages', () => {
  const f = JSON.parse(fs.readFileSync(fix('hermes-rows.json'), 'utf8')), dir = path.join(tmp, 'hermes', 'profiles', 'gaming'); fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`create table sessions (id text primary key, source text, title text, started_at real, ended_at real, end_reason text, last_activity_at real, model text, parent_session_id text, display_name text, cwd text, message_count integer default 0, input_tokens integer default 0, output_tokens integer default 0, cache_read_tokens integer default 0, cache_write_tokens integer default 0, hidden integer default 0, chat_id text, thread_id text);
    create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, display_kind text, finish_reason text, platform_message_id text, active integer default 1, compacted integer default 0);
    create table session_model_usage (session_id text, model text, task text default '', input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer);`);
  const main = f.sessions.find((s) => s.source !== 'subagent'), kids = f.sessions.filter((s) => s.source === 'subagent'), MAIN = main.id, K = kids[0].id;
  const shift = Date.now() / 1000 - Math.max(...f.messages.map((m) => m.timestamp));   // the real rows are days old: slide them to now so the board sees them
  const ins = db.prepare('insert into sessions (id, source, title, started_at, ended_at, end_reason, last_activity_at, model, parent_session_id, display_name, cwd, message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, chat_id, thread_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const s of f.sessions) ins.run(s.id, s.source, s.title, s.started_at + shift, s.ended_at == null ? null : s.ended_at + shift, s.end_reason, s.last_activity_at == null ? null : s.last_activity_at + shift, s.model, s.parent_session_id, s.display_name, s.cwd, s.message_count, s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens, s.source === 'discord' ? '155598' : null, s.source === 'discord' ? '155598' : null);   // a Discord thread id on the conversation
  const im = db.prepare('insert into messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, display_kind, finish_reason, platform_message_id, active, compacted) values (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const m of f.messages) im.run(m.id, m.session_id, m.role, m.content, m.tool_call_id, m.tool_calls, m.tool_name, m.timestamp + shift, m.display_kind, m.finish_reason, m.platform_message_id, m.active, m.compacted);
  const firstPrompt = f.messages.find((m) => m.session_id === K && m.role === 'user').content.replace(/^\[[^\]]+\]\s*/, '');   // a child's first user row is its task's goal
  const t0 = kids[0].started_at + shift - 1, tasks = JSON.stringify({ tasks: [{ goal: 'Task 1: a child session this fixture does not have' }, { goal: firstPrompt }, { goal: 'Task 3: no child either' }] });   // a delegation of three tasks; only the second one's child is in the fixture, and it is not the first child by start time
  im.run(34000, MAIN, 'assistant', '', null, JSON.stringify([{ id: 'toolu_deleg', type: 'function', function: { name: 'delegate_task', arguments: tasks } }]), null, t0, null, 'tool_calls', null, 1, 0);
  im.run(34001, MAIN, 'tool', JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'done A' }, { task_index: 1, status: 'completed', summary: 'done B' }, { task_index: 2, status: 'completed', summary: 'done C' }] }), 'toolu_deleg', null, 'delegate_task', t0 + 100, null, null, null, 1, 0);
  const t1 = Date.now() / 1000 - 20;   // the last exchange, 20 s ago: a question left unanswered that long means "needs you"
  im.run(34010, MAIN, 'assistant', '', null, JSON.stringify([{ id: 'toolu_t', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'ls -la /tmp' }) } }, { id: 'toolu_p', type: 'function', function: { name: 'patch', arguments: JSON.stringify({ path: '/home/user/a.py', old_string: 'x = 1', new_string: 'x = 2' }) } }]), null, t1, null, 'tool_calls', null, 1, 0);
  im.run(34011, MAIN, 'tool', JSON.stringify({ output: 'total 0\ndrwx------ 2 user user 40 .' }), 'toolu_t', null, 'terminal', t1 + 1, null, null, null, 1, 0);
  im.run(34012, MAIN, 'tool', JSON.stringify({ error: 'old_string not found' }), 'toolu_p', null, 'patch', t1 + 2, null, null, null, 1, 0);
  im.run(34013, MAIN, 'user', '[Sam] superseded copy', null, null, null, t1 + 3, null, null, null, 0, 0);   // neither active nor compacted: not part of the conversation
  im.run(34014, MAIN, 'assistant', '', null, JSON.stringify([{ id: 'toolu_c', type: 'function', function: { name: 'clarify', arguments: JSON.stringify({ questions: [{ question: 'Which colour?', choices: ['red', 'blue'] }] }) } }]), null, t1 + 4, null, 'tool_calls', null, 1, 0);
  for (const u of f.usage) db.prepare('insert into session_model_usage (session_id, model, task, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) values (?,?,?,?,?,?,?)').run(u.session_id, u.model, u.task, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens);
  db.close();
  const rows = hermes.list(); assert.equal(rows.length, 1); assert.deepEqual([rows[0].proj, rows[0].id, rows[0].agents, rows[0].source, rows[0].title], ['_hermes-gaming', MAIN, kids.length, 'hermes', main.title]);
  const b = hermes.board(); assert.equal(b.length, 1); assert.equal(b[0].state, 'blocked'); assert.equal(b[0].tool, 'clarify'); assert.ok(b[0].peers.includes('gladiator-game-c3'));
  assert.ok(hermes.exists('_hermes-gaming', MAIN) && !hermes.exists('_hermes-gaming', 'nope') && !hermes.exists('_hermes', MAIN));
  const tl = hermes.timeline('_hermes-gaming', MAIN);
  assert.deepEqual(tl.group, { key: 'hermes:gaming:155598', name: 'Hermes · gaming · ' + main.title.slice(0, 48), hermes: true });   // the project of a Hermes conversation: its profile and Discord thread, named by its title
  assert.deepEqual(rows[0].group, tl.group); assert.equal(b[0].group.key, tl.group.key);
  assert.ok(tl.agents.some((a) => a.id === K && a.type === 'subagent' && /^Research what real wounds/.test(a.name) && a.role === 'delegate'));   // a child is named by its task (its first user row), under its parent's thread
  const orders = tl.events.filter((e) => e.kind === 'order'); assert.equal(orders.length, 1); assert.equal(orders[0].to, K); assert.equal(orders[0].toolId, 'toolu_deleg|delegate_task#1'); assert.match(orders[0].text, /^Research what real wounds/);   // matched by goal, not by start order
  assert.ok(tl.events.some((e) => e.kind === 'finish' && e.agent === K) && tl.events.some((e) => e.kind === 'results' && e.items.some((it) => /#1 completed: done A/.test(it.out))));
  const tools = tl.events.filter((e) => e.kind === 'tools').flatMap((e) => e.tools), term = tools.find((t) => t.id.startsWith('toolu_t|')), patch = tools.find((t) => t.id.startsWith('toolu_p|'));
  assert.deepEqual(term.d, { kind: 'cmd', text: 'ls -la /tmp' }); assert.deepEqual(patch.d, { kind: 'edit', file: '/home/user/a.py', old: 'x = 1', new: 'x = 2' });
  const items = tl.events.filter((e) => e.kind === 'results').flatMap((e) => e.items); assert.match(items.find((it) => it.id === term.id).out, /^total 0/); assert.equal(items.find((it) => it.id === patch.id).err, true);
  assert.ok(tools.some((t) => t.name === 'web_search' && t.d.kind === 'web') && tools.some((t) => t.name === 'skill_view'));
  assert.ok(!tl.events.some((e) => e.kind === 'user' && /superseded/.test(e.text)));
  const msgs = tl.events.filter((e) => e.kind === 'msg'); assert.ok(msgs.length >= 4);
  const sent = msgs.find((e) => e.agent === 'main' && e.msgId === '43959df8-8a70-457f-974e-2b25a2b1f794'), got = msgs.find((e) => e.msgId === 'a906360e-c7ad-4400-aeba-1f9398cfce75');   // the real pair with the Claude session
  assert.equal(sent.state, 'accepted'); assert.equal(got.state, 'received'); assert.equal(sent.to, got.agent, 'the send by name and the arrival by address meet on one peer');
  const peer = tl.agents.find((a) => a.id === got.agent); assert.deepEqual([peer.type, peer.name, peer.role], ['peer', 'gladiator-game-kickoff', 'Claude Code']);
  assert.ok(msgs.some((e) => e.state === 'received' && /^From the game director/.test(e.text)), 'the steered variant of an arrival is read too');
  const u = tl.events.find((e) => e.kind === 'usage' && e.agent === 'main'); assert.ok(u && u.total && u.u.i > 0 && /claude/.test(u.model), 'one usage event with the session total');
  assert.ok(peers.resolve('uds:/run/user/1000/cc-socks/hermes-cabd730df330409780738c20f30f3a72.sock'), 'a Hermes inbox is found through its own send_peer result rows');
  assert.equal(peers.resolve('uds:/run/user/1000/cc-socks/hermes-cabd730df330409780738c20f30f3a72.sock').id, MAIN);
});

test('names: a first prompt becomes a readable title, names are cut at a word (real prompts from this machine)', () => {
  const t = codex.tidyTitle;
  assert.equal(t('GPT-6-Astra ultra correction artist for a bounded already-authored Lakeshore source. You are asked'), 'Correction artist for a bounded already-authored Lakeshore source');
  assert.equal(t('Use GPT-6-Astra at ultra/max reasoning. You are a dedicated artist for the complete Lakeshore interior'), 'Artist for the complete Lakeshore interior');
  assert.equal(t('Dedicated MAKEUP AIR SOURCE CONTINUATION only,inheritingAstraultra. Execute /home/x/y.md'), 'Dedicated MAKEUP AIR SOURCE CONTINUATION only');
  assert.equal(t('Tyler desk artist at inherited ultra, not director. Execute exact prepared commission /home/x'), 'Tyler desk artist, not director');
  assert.equal(t('Continue SAME original Senior14 artist from your own history, Astra ultra inherited. Read'), 'Continue SAME original Senior14 artist from your own history');
  assert.equal(t('Fix the login bug in auth.js'), 'Fix the login bug in auth.js');
  assert.equal(peers.label('Research what real wounds, blunt trauma and fatigue do to a fighter', 40), 'Research what real wounds, blunt trauma…');
  assert.equal(peers.label('short', 40), 'short');
});

test('talks to: a list_peers listing is not a message, a send_peer that echoes its target is one (real rollout lines)', () => {
  const listing = '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"agent-peers","tool":"list_peers","arguments":{},"result":{"content":[{"type":"text","text":"claude:x  busy\\n  bridge: send_peer {\\"to\\":\\"uds:/run/user/1000/cc-socks/20178.sock\\"}"}],"structuredContent":{"peers":[{"to":"uds:/run/user/1000/cc-socks/20178.sock"}]}}}}}';
  const send = '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"agent-peers","tool":"send_peer","arguments":{"to":"uds:/run/user/1000/cc-socks/1095048.sock","message":"hi"},"result":{"structuredContent":{"message_id":"bf","to":"uds:/run/user/1000/cc-socks/1095048.sock","name":"claude:standup-finish"}}}}}';
  const hermesListing = 'You are hermes:gaming:cb050161.\nclaude:x  busy\n  bridge: send_peer {"to":"uds:/run/user/1000/cc-socks/20178.sock"}';
  assert.equal(peers.tailPeers(listing + '\n' + hermesListing).n, 0);
  assert.equal(peers.tailPeers(listing + '\n' + send).n, 1);
});

test('a send_peer between two agents of the same session stays inside it (not "another session")', () => {
  const { assemble } = require('../adapters/timeline.js');
  const agents = { main: { id: 'main', name: 'Codex' }, kid: { id: 'kid', name: 'fryer' } };
  const states = [{ agent: 'kid', raw: [{ ts: 1, agent: 'kid', kind: 'msg', dir: 'out', to: 'codex:build-act-2-environments-3be2', text: 'released' }] }, { agent: 'main', raw: [{ ts: 2, agent: 'main', kind: 'msg', dir: 'in', from: 'uds:/x/codex-a6d06580b5d53be2.sock', name: 'codex:fryer', text: 'released' }] }];
  const own = (x) => (/3be2$|codex-a6d06580b5d53be2/.test(String(x)) ? 'main' : '');
  const tl = assemble({ id: 's', proj: '_codex', agents, states, own });
  assert.deepEqual(tl.events.filter((e) => e.kind === 'msg').map((e) => [e.agent, e.to]), [['kid', 'main']]);
  assert.equal(tl.agents.filter((a) => a.type === 'peer').length, 0);
});
